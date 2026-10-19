import type { ServerMessage } from '../../shared/protocol.js';

/** What the "brain" (Gemini Live) reports back to the session. */
export interface BrainEvents {
  /** Incremental transcript of the user's speech. */
  onUserTranscript(delta: string): void;
  /** Gemini's VAD heard the user start speaking. */
  onUserSpeechStart(): void;
  /** Gemini's VAD decided the user stopped speaking. */
  onUserSpeechEnd(): void;
  /** Incremental text of the agent's reply (Gemini's output transcription). */
  onAgentText(delta: string): void;
  /** Gemini finished generating the current reply. */
  onGenerationComplete(): void;
  /** Gemini closed the turn (may arrive after `onGenerationComplete`, or alone). */
  onTurnComplete(): void;
  /** Gemini stopped its reply because the user started talking. */
  onInterrupted(): void;
  onError(error: Error, fatal: boolean): void;
}

export interface Brain {
  connect(): Promise<void>;
  /** Raw PCM16 LE mono 16 kHz microphone audio. */
  sendAudio(pcm: Buffer): void;
  close(): void;
}

export type BrainFactory = (events: BrainEvents) => Brain;

export interface VoiceTurnHandlers {
  /** Raw PCM16 LE mono audio at the voice's output sample rate. */
  onAudio(pcm: Buffer): void;
  /** Called exactly once when the turn ends for any reason other than `cancel()`. */
  onDone(): void;
  onError(error: Error): void;
}

/** One utterance streamed into the TTS. */
export interface VoiceTurn {
  push(text: string): void;
  /** No more text will be pushed for this turn. */
  finish(): void;
  /** Stop generating now; `onDone` will not be called. */
  cancel(): void;
}

export interface Voice {
  connect(): Promise<void>;
  startTurn(handlers: VoiceTurnHandlers): VoiceTurn;
  close(): void;
}

/** Where the session sends things for the browser (or any other transport). */
export interface SessionOutput {
  send(message: ServerMessage): void;
  sendAudio(pcm: Buffer): void;
  /** The session ended on its own (fatal error). */
  close(): void;
}
