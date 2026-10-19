import type { AgentState, AgentTurnKind } from '../../shared/protocol.js';
import { SpeechChunker, finishSentence } from './SpeechChunker.js';
import type { Brain, BrainEvents, BrainFactory, SessionOutput, Voice, VoiceTurn } from './types.js';

export interface VoiceSessionOptions {
  brainFactory: BrainFactory;
  voice: Voice;
  output: SessionOutput;
  /** Spoken by the voice as soon as it connects; empty = wait for the user. */
  greeting: string;
  outputSampleRate: number;
  language: string;
  /** Letters of user speech, heard while the agent is audible, that cut the agent off. */
  bargeInMinChars: number;
  /** Mic frames at or above this RMS (0–1) count as the user speaking. */
  voiceRmsThreshold?: number;
  now?: () => number;
  log?: (message: string) => void;
}

/** One agent utterance: a TTS turn plus the bookkeeping to play it in order. */
interface SpeechTurn {
  id: number;
  kind: AgentTurnKind;
  tts: VoiceTurn;
  /** Audio that arrived while an earlier turn was still being sent. */
  pending: Buffer[];
  /** Everything the agent said in this turn (for logs). */
  text: string;
  textDone: boolean;
  audioDone: boolean;
  firstTextAt: number;
  firstPushAt: number | null;
  /** Last voiced mic frame before this reply started (for latency metrics). */
  voiceEndAt: number | null;
  firstAudioAt: number | null;
}

/**
 * One call. Gemini Live hears the user and writes the reply (its own audio is
 * discarded); the reply text streams into Cartesia, whose audio goes to the
 * browser. Owns turn-taking: ordering of agent turns and barge-in.
 *
 * Barge-in has three triggers:
 *  - Gemini `interrupted`: the user spoke while Gemini was still generating.
 *  - Gemini VAD speech start while the agent is audible and Gemini is idle.
 *  - User transcript (≥ bargeInMinChars letters) while the agent is audible and
 *    Gemini is idle. Gemini generates faster than real time, so most of a reply
 *    is still playing after Gemini considers it finished.
 */
export class VoiceSession {
  private brain: Brain | null = null;
  private readonly chunker: SpeechChunker;
  /** Turns whose audio is not fully sent yet, in playback order. */
  private readonly queue: SpeechTurn[] = [];
  /** The turn currently receiving Gemini text. */
  private reply: SpeechTurn | null = null;
  /** Last turn whose audio was fully sent (it may still be playing in the browser). */
  private lastSentTurn: SpeechTurn | null = null;
  private nextTurnId = 1;
  private clientPlaying = false;
  private bargeInChars = 0;
  /** User transcript since the last agent reply started (for logs). */
  private userText = '';
  private lastVoiceAt: number | null = null;
  private state: AgentState | null = null;
  private started = false;
  private closed = false;
  private readonly now: () => number;
  private readonly voiceRmsThreshold: number;

  constructor(private readonly options: VoiceSessionOptions) {
    this.chunker = new SpeechChunker({ language: options.language });
    this.now = options.now ?? Date.now;
    this.voiceRmsThreshold = options.voiceRmsThreshold ?? 0.02;
  }

  async start(): Promise<void> {
    if (this.started || this.closed) return;
    this.started = true;
    const { output, voice, greeting } = this.options;

    output.send({ type: 'ready', outputSampleRate: this.options.outputSampleRate });
    this.setState('connecting');

    try {
      this.brain = this.options.brainFactory(this.brainEvents());
      // Greet as soon as the voice is up; Gemini may still be connecting.
      const voiceReady = voice.connect().then(() => {
        if (greeting.trim() && !this.closed) this.speakGreeting(greeting.trim());
      });
      await Promise.all([this.brain.connect(), voiceReady]);
      if (this.closed) return;
      if (!this.isAgentAudible()) this.setState('listening');
      this.log('ready');
    } catch (error) {
      this.fail(toError(error));
    }
  }

  /** Raw PCM16 LE mono 16 kHz from the browser microphone. */
  handleMicAudio(pcm: Buffer): void {
    if (this.closed) return;
    if (rms(pcm) >= this.voiceRmsThreshold) this.lastVoiceAt = this.now();
    this.brain?.sendAudio(pcm);
  }

  /** The browser player started or stopped producing agent audio. */
  handleClientPlayback(playing: boolean): void {
    if (this.closed) return;
    this.clientPlaying = playing;
    if (!playing) {
      if (this.queue.length === 0) this.lastSentTurn = null;
      this.maybeIdle();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const turn of this.queue.splice(0)) turn.tts.cancel();
    this.reply = null;
    this.brain?.close();
    this.brain = null;
    this.options.voice.close();
    this.log('closed');
  }

  private brainEvents(): BrainEvents {
    return {
      onUserTranscript: (delta) => {
        if (!delta || this.closed) return;
        this.userText += delta;
        this.options.output.send({ type: 'transcript', role: 'user', delta });
        if (this.canBargeIn()) {
          this.bargeInChars += countLetters(delta);
          if (this.bargeInChars >= this.options.bargeInMinChars) this.bargeIn('user transcript');
        }
      },
      onUserSpeechStart: () => {
        if (this.canBargeIn()) this.bargeIn('vad speech start');
      },
      onUserSpeechEnd: () => {
        if (!this.isAgentAudible()) this.setState('thinking');
      },
      onAgentText: (delta) => {
        if (!delta || this.closed) return;
        const turn = this.reply ?? (this.reply = this.openTurn('reply'));
        turn.text += delta;
        this.options.output.send({ type: 'transcript', role: 'agent', delta });
        for (const piece of this.chunker.push(delta)) this.speak(turn, piece);
      },
      onGenerationComplete: () => this.finishReply(),
      onTurnComplete: () => this.finishReply(),
      onInterrupted: () => {
        if (this.reply || this.isAgentAudible()) this.bargeIn('gemini interrupted');
      },
      onError: (error, fatal) => {
        if (fatal) this.fail(error);
        else this.options.output.send({ type: 'error', message: error.message, fatal: false });
      },
    };
  }

  private speakGreeting(text: string): void {
    const turn = this.openTurn('greeting');
    turn.text = text;
    this.options.output.send({ type: 'transcript', role: 'agent', delta: text });
    this.speak(turn, finishSentence(text, this.options.language));
    turn.tts.finish();
    this.endTurnText(turn, false);
  }

  private speak(turn: SpeechTurn, piece: string): void {
    turn.firstPushAt ??= this.now();
    // Trailing space: Cartesia joins continuation chunks verbatim.
    turn.tts.push(`${piece} `);
  }

  private openTurn(kind: AgentTurnKind): SpeechTurn {
    const wasAudible = this.isAgentAudible();
    const turn: SpeechTurn = {
      id: this.nextTurnId++,
      kind,
      tts: null as unknown as VoiceTurn,
      pending: [],
      text: '',
      textDone: false,
      audioDone: false,
      firstTextAt: this.now(),
      firstPushAt: null,
      voiceEndAt: kind === 'reply' ? this.lastVoiceAt : null,
      firstAudioAt: null,
    };
    if (kind === 'reply' && this.userText.trim()) {
      this.log(`user: ${JSON.stringify(this.userText.trim())}`);
      this.userText = '';
    }
    turn.tts = this.options.voice.startTurn({
      onAudio: (pcm) => this.handleTurnAudio(turn, pcm),
      onDone: () => this.handleTurnDone(turn),
      onError: (error) => {
        this.log(`tts error (turn ${turn.id}): ${error.message}`);
        this.options.output.send({ type: 'error', message: `TTS: ${error.message}`, fatal: false });
      },
    });
    this.queue.push(turn);
    this.bargeInChars = 0;
    this.options.output.send({ type: 'agent_turn_start', turn: turn.id, kind });
    if (kind === 'reply' && !wasAudible) this.setState('thinking');
    return turn;
  }

  private finishReply(): void {
    const turn = this.reply;
    if (!turn) return;
    this.reply = null;
    for (const piece of this.chunker.flush()) this.speak(turn, piece);
    this.chunker.reset();
    turn.tts.finish();
    this.endTurnText(turn, false);
    this.log(`agent ${turn.id}: ${JSON.stringify(turn.text.trim())}`);
  }

  private endTurnText(turn: SpeechTurn, interrupted: boolean): void {
    turn.textDone = true;
    this.options.output.send({ type: 'agent_turn_end', turn: turn.id, interrupted });
  }

  private handleTurnAudio(turn: SpeechTurn, pcm: Buffer): void {
    if (this.closed || !this.queue.includes(turn)) return;
    if (turn.firstAudioAt === null) {
      turn.firstAudioAt = this.now();
      if (turn.kind === 'reply') {
        const brainMs = turn.voiceEndAt === null ? null : turn.firstTextAt - turn.voiceEndAt;
        const ttsMs = turn.firstAudioAt - turn.firstTextAt;
        this.options.output.send({ type: 'metrics', turn: turn.id, brainMs, ttsMs });
        const firstPush = turn.firstPushAt === null ? '?' : turn.firstPushAt - turn.firstTextAt;
        this.log(
          `latency ${turn.id}: voice end → gemini text ${brainMs ?? '?'}ms → first chunk +${firstPush}ms → cartesia audio +${ttsMs}ms`,
        );
      }
    }
    if (this.queue[0] === turn) {
      this.options.output.sendAudio(pcm);
      this.setState('speaking');
    } else {
      turn.pending.push(pcm);
    }
  }

  private handleTurnDone(turn: SpeechTurn): void {
    if (this.closed || !this.queue.includes(turn)) return;
    turn.audioDone = true;
    while (this.queue[0]?.audioDone) {
      const done = this.queue.shift()!;
      this.lastSentTurn = done;
      this.options.output.send({ type: 'agent_audio_end', turn: done.id });
      const next = this.queue[0];
      if (next && next.pending.length > 0) {
        for (const pcm of next.pending) this.options.output.sendAudio(pcm);
        next.pending = [];
        this.setState('speaking');
      }
    }
    this.maybeIdle();
  }

  private bargeIn(reason: string): void {
    this.log(`barge-in (${reason})`);
    const cut = this.queue.splice(0);
    // A turn whose audio was all sent may still be playing in the browser.
    if (this.clientPlaying && this.lastSentTurn && !cut.includes(this.lastSentTurn)) cut.unshift(this.lastSentTurn);
    this.lastSentTurn = null;
    // The browser is told to clear now; until it says otherwise the agent is silent,
    // so a second signal for the same speech (VAD, then Gemini `interrupted`) is a no-op.
    this.clientPlaying = false;
    this.reply = null;
    this.chunker.reset();
    this.bargeInChars = 0;
    for (const turn of cut) {
      turn.tts.cancel();
      this.endTurnText(turn, true);
      this.log(`agent ${turn.id} cut off: ${JSON.stringify(turn.text.trim())}`);
    }
    this.options.output.send({ type: 'clear' });
    this.setState('listening');
  }

  /** User speech may cut the agent off only while it is audible and Gemini is idle. */
  private canBargeIn(): boolean {
    return !this.closed && this.reply === null && this.isAgentAudible();
  }

  private isAgentAudible(): boolean {
    return this.queue.length > 0 || this.clientPlaying;
  }

  private maybeIdle(): void {
    if (this.queue.length === 0 && !this.clientPlaying && !this.reply) {
      this.bargeInChars = 0;
      this.setState('listening');
    }
  }

  private setState(state: AgentState): void {
    if (this.state === state || this.closed) return;
    this.state = state;
    this.options.output.send({ type: 'state', state });
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.log(`fatal: ${error.message}`);
    this.options.output.send({ type: 'error', message: error.message, fatal: true });
    this.close();
    this.options.output.close();
  }

  private log(message: string): void {
    this.options.log?.(message);
  }
}

function rms(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const s = pcm.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / samples);
}

function countLetters(text: string): number {
  return text.match(/\p{L}/gu)?.length ?? 0;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
