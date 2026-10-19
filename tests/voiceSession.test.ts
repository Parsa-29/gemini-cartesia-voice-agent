import { beforeEach, describe, expect, it } from 'vitest';
import type { ServerMessage } from '../src/shared/protocol.js';
import { VoiceSession, type VoiceSessionOptions } from '../src/server/session/VoiceSession.js';
import type {
  Brain,
  BrainEvents,
  SessionOutput,
  Voice,
  VoiceTurn,
  VoiceTurnHandlers,
} from '../src/server/session/types.js';

class FakeBrain implements Brain {
  events!: BrainEvents;
  audio: Buffer[] = [];
  connected = false;
  closed = false;
  async connect(): Promise<void> {
    this.connected = true;
  }
  sendAudio(pcm: Buffer): void {
    this.audio.push(pcm);
  }
  close(): void {
    this.closed = true;
  }
}

class FakeTurn implements VoiceTurn {
  texts: string[] = [];
  finished = false;
  cancelled = false;
  constructor(private readonly handlers: VoiceTurnHandlers) {}
  push(text: string): void {
    this.texts.push(text);
  }
  finish(): void {
    this.finished = true;
  }
  cancel(): void {
    this.cancelled = true;
  }
  emitAudio(byte = 1, length = 480): void {
    this.handlers.onAudio(Buffer.alloc(length, byte));
  }
  done(): void {
    this.handlers.onDone();
  }
}

class FakeVoice implements Voice {
  turns: FakeTurn[] = [];
  connected = false;
  closed = false;
  async connect(): Promise<void> {
    this.connected = true;
  }
  startTurn(handlers: VoiceTurnHandlers): VoiceTurn {
    const turn = new FakeTurn(handlers);
    this.turns.push(turn);
    return turn;
  }
  close(): void {
    this.closed = true;
  }
}

class RecordingOutput implements SessionOutput {
  messages: ServerMessage[] = [];
  audio: Buffer[] = [];
  closed = false;
  send(message: ServerMessage): void {
    this.messages.push(message);
  }
  sendAudio(pcm: Buffer): void {
    this.audio.push(pcm);
  }
  close(): void {
    this.closed = true;
  }
  ofType<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.messages.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }
}

function pcm(amplitude: number, samples = 320): Buffer {
  const data = new Int16Array(samples).fill(amplitude);
  return Buffer.from(data.buffer);
}

describe('VoiceSession', () => {
  let brain: FakeBrain;
  let voice: FakeVoice;
  let output: RecordingOutput;
  let clock: number;
  /** The session most recently started by `startedSession`. */
  let current: VoiceSession;
  const session = (): VoiceSession => current;

  function createSession(overrides: Partial<VoiceSessionOptions> = {}): VoiceSession {
    return new VoiceSession({
      brainFactory: (events) => {
        brain.events = events;
        return brain;
      },
      voice,
      output,
      greeting: '',
      outputSampleRate: 24000,
      language: 'en',
      bargeInMinChars: 3,
      now: () => clock,
      ...overrides,
    });
  }

  async function startedSession(overrides: Partial<VoiceSessionOptions> = {}): Promise<VoiceSession> {
    current = createSession(overrides);
    await current.start();
    return current;
  }

  beforeEach(() => {
    brain = new FakeBrain();
    voice = new FakeVoice();
    output = new RecordingOutput();
    clock = 0;
  });

  it('announces the output format, connects both services, then listens', async () => {
    await startedSession();
    expect(output.messages[0]).toEqual({ type: 'ready', outputSampleRate: 24000 });
    expect(brain.connected).toBe(true);
    expect(voice.connected).toBe(true);
    expect(output.ofType('state').at(-1)).toEqual({ type: 'state', state: 'listening' });
    expect(voice.turns).toHaveLength(0);
  });

  it('speaks the greeting through the voice and reports it as an agent turn', async () => {
    await startedSession({ greeting: 'Hello there' });
    const [turn] = voice.turns;
    expect(turn?.texts).toEqual(['Hello there. ']);
    expect(turn?.finished).toBe(true);
    expect(output.ofType('agent_turn_start')).toEqual([
      { type: 'agent_turn_start', turn: 1, kind: 'greeting' },
    ]);
    expect(output.ofType('transcript')).toEqual([
      { type: 'transcript', role: 'agent', delta: 'Hello there' },
    ]);
    turn!.emitAudio();
    turn!.done();
    expect(output.audio).toHaveLength(1);
    expect(output.ofType('agent_audio_end')).toEqual([{ type: 'agent_audio_end', turn: 1 }]);
  });

  it('streams a reply from Gemini text into one TTS turn', async () => {
    await startedSession();
    brain.events.onAgentText('Sure thing. Let');
    brain.events.onAgentText(' me check.');
    const [turn] = voice.turns;
    expect(voice.turns).toHaveLength(1);
    expect(turn?.texts).toEqual(['Sure thing. ', 'Let me check. ']);
    expect(output.ofType('transcript').map((m) => m.delta)).toEqual(['Sure thing. Let', ' me check.']);

    brain.events.onGenerationComplete();
    expect(turn?.finished).toBe(true);
    expect(output.ofType('agent_turn_end')).toEqual([
      { type: 'agent_turn_end', turn: 1, interrupted: false },
    ]);

    turn!.emitAudio();
    expect(output.audio).toHaveLength(1);
    expect(output.ofType('state').at(-1)?.state).toBe('speaking');
    turn!.done();
    expect(output.ofType('agent_audio_end')).toEqual([{ type: 'agent_audio_end', turn: 1 }]);
  });

  it('flushes unpunctuated text when the turn completes', async () => {
    await startedSession();
    brain.events.onAgentText('ok then');
    brain.events.onTurnComplete();
    expect(voice.turns[0]?.texts).toEqual(['ok then. ']);
    expect(voice.turns[0]?.finished).toBe(true);
  });

  it('treats turnComplete after generationComplete as the same turn end', async () => {
    await startedSession();
    brain.events.onAgentText('Done.');
    brain.events.onGenerationComplete();
    brain.events.onTurnComplete();
    expect(output.ofType('agent_turn_end')).toHaveLength(1);
    expect(voice.turns).toHaveLength(1);
  });

  it('cuts the agent off when Gemini reports an interruption', async () => {
    await startedSession();
    brain.events.onAgentText('A long answer that');
    const [turn] = voice.turns;
    turn!.emitAudio();
    brain.events.onInterrupted();

    expect(turn?.cancelled).toBe(true);
    expect(output.ofType('clear')).toHaveLength(1);
    expect(output.ofType('agent_turn_end')).toEqual([
      { type: 'agent_turn_end', turn: 1, interrupted: true },
    ]);
    expect(output.ofType('state').at(-1)?.state).toBe('listening');

    // Late audio from the cancelled turn must not reach the browser.
    turn!.emitAudio();
    expect(output.audio).toHaveLength(1);

    // The next reply is a fresh turn.
    brain.events.onAgentText('Yes?');
    expect(voice.turns).toHaveLength(2);
    expect(voice.turns[1]?.texts).toEqual(['Yes? ']);
  });

  it('ignores an interruption when nothing is audible', async () => {
    await startedSession();
    brain.events.onInterrupted();
    expect(output.ofType('clear')).toHaveLength(0);
  });

  it('barges in on user speech while finished-but-still-playing audio is audible', async () => {
    await startedSession();
    brain.events.onAgentText('Here is a long story.');
    brain.events.onGenerationComplete();
    const [turn] = voice.turns;
    turn!.emitAudio();

    brain.events.onUserTranscript('ab');
    expect(output.ofType('clear')).toHaveLength(0);
    brain.events.onUserTranscript(' c');
    expect(output.ofType('clear')).toHaveLength(1);
    expect(turn?.cancelled).toBe(true);
  });

  it('barges in while only the browser is still playing', async () => {
    await startedSession();
    brain.events.onAgentText('Short.');
    brain.events.onGenerationComplete();
    voice.turns[0]!.emitAudio();
    voice.turns[0]!.done();
    session().handleClientPlayback(true);

    brain.events.onUserTranscript('wait');
    expect(output.ofType('clear')).toHaveLength(1);
    // The turn the browser was still playing is reported as cut off.
    expect(output.ofType('agent_turn_end').at(-1)).toEqual({
      type: 'agent_turn_end',
      turn: 1,
      interrupted: true,
    });
  });

  it('does not barge in on a trailing user transcript while Gemini is still generating', async () => {
    await startedSession();
    brain.events.onAgentText('Answering');
    voice.turns[0]!.emitAudio();
    brain.events.onUserTranscript('the end of my question');
    expect(output.ofType('clear')).toHaveLength(0);
    expect(voice.turns[0]?.cancelled).toBe(false);
  });

  it('does not barge in when the agent is silent', async () => {
    await startedSession();
    brain.events.onUserTranscript('hello agent');
    expect(output.ofType('clear')).toHaveLength(0);
    expect(output.ofType('transcript')).toEqual([
      { type: 'transcript', role: 'user', delta: 'hello agent' },
    ]);
  });

  it('barges in when Gemini VAD hears speech over the greeting', async () => {
    await startedSession({ greeting: 'Welcome' });
    voice.turns[0]!.emitAudio();
    brain.events.onUserSpeechStart();
    expect(output.ofType('clear')).toHaveLength(1);
    expect(voice.turns[0]?.cancelled).toBe(true);
    expect(output.ofType('agent_turn_end').at(-1)).toEqual({
      type: 'agent_turn_end',
      turn: 1,
      interrupted: true,
    });
  });

  it('handles a second interruption signal for the same speech as a no-op', async () => {
    await startedSession();
    brain.events.onAgentText('Long answer.');
    brain.events.onGenerationComplete();
    voice.turns[0]!.emitAudio();
    session().handleClientPlayback(true);
    brain.events.onUserSpeechStart();
    brain.events.onInterrupted();
    expect(output.ofType('clear')).toHaveLength(1);
  });

  it('plays consecutive turns in order without interleaving their audio', async () => {
    await startedSession();
    brain.events.onAgentText('First.');
    brain.events.onGenerationComplete();
    brain.events.onAgentText('Second.');
    brain.events.onGenerationComplete();
    const [first, second] = voice.turns;

    second!.emitAudio(2);
    first!.emitAudio(1);
    expect(output.audio.map((b) => b[0])).toEqual([1]);

    first!.done();
    expect(output.audio.map((b) => b[0])).toEqual([1, 2]);
    second!.emitAudio(3);
    second!.done();
    expect(output.audio.map((b) => b[0])).toEqual([1, 2, 3]);
    expect(output.ofType('agent_audio_end').map((m) => m.turn)).toEqual([1, 2]);
  });

  it('forwards mic audio and measures reply latency from the last voiced frame', async () => {
    await startedSession();
    clock = 1000;
    session().handleMicAudio(pcm(8000));
    clock = 1500;
    session().handleMicAudio(pcm(10));
    expect(brain.audio).toHaveLength(2);

    clock = 1800;
    brain.events.onAgentText('Hi.');
    clock = 1900;
    voice.turns[0]!.emitAudio();
    expect(output.ofType('metrics')).toEqual([{ type: 'metrics', turn: 1, brainMs: 800, ttsMs: 100 }]);
  });

  it('shows thinking once Gemini hears the user stop', async () => {
    await startedSession();
    brain.events.onUserSpeechEnd();
    expect(output.ofType('state').at(-1)?.state).toBe('thinking');
  });

  it('ends the call on a fatal brain error', async () => {
    await startedSession();
    brain.events.onError(new Error('boom'), true);
    expect(output.ofType('error')).toEqual([{ type: 'error', message: 'boom', fatal: true }]);
    expect(output.closed).toBe(true);
    expect(brain.closed).toBe(true);
    expect(voice.closed).toBe(true);
  });

  it('close() cancels speech and releases both services', async () => {
    const s = await startedSession();
    brain.events.onAgentText('Talking');
    s.close();
    expect(voice.turns[0]?.cancelled).toBe(true);
    expect(brain.closed).toBe(true);
    expect(voice.closed).toBe(true);
    s.handleMicAudio(pcm(8000));
    expect(brain.audio).toHaveLength(0);
  });
});
