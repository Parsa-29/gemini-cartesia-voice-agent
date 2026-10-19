/**
 * Wire protocol between the browser and the server: one WebSocket on `/ws`.
 *
 * Binary frames carry raw PCM16 little-endian mono audio:
 *   browser → server: microphone at MIC_SAMPLE_RATE
 *   server → browser: agent voice at the `outputSampleRate` announced in `ready`
 * Text frames carry the JSON messages below.
 */

export const MIC_SAMPLE_RATE = 16000;
export const WS_PATH = '/ws';

/** Per-call overrides from the browser settings panel (ignored when the server disallows them). */
export interface SessionOverrides {
  systemPrompt?: string;
  greeting?: string;
  voiceId?: string;
  speed?: number;
}

export type ClientMessage =
  | { type: 'start'; overrides?: SessionOverrides }
  /** The browser player started or stopped producing agent audio. */
  | { type: 'playback'; playing: boolean }
  | { type: 'stop' };

export type AgentState = 'connecting' | 'listening' | 'thinking' | 'speaking';

export type AgentTurnKind = 'greeting' | 'reply';

export type ServerMessage =
  | { type: 'ready'; outputSampleRate: number }
  | { type: 'state'; state: AgentState }
  | { type: 'transcript'; role: 'user' | 'agent'; delta: string }
  | { type: 'agent_turn_start'; turn: number; kind: AgentTurnKind }
  /**
   * No more text for this turn. Sent again with `interrupted: true` if the user
   * cuts the agent off before the turn's audio finished playing.
   */
  | { type: 'agent_turn_end'; turn: number; interrupted: boolean }
  /** Every audio frame of this turn has been sent. */
  | { type: 'agent_audio_end'; turn: number }
  /** Barge-in: drop all queued agent audio now. */
  | { type: 'clear' }
  /** Server-side latency of one reply: user voice end → first Gemini text → first Cartesia audio. */
  | { type: 'metrics'; turn: number; brainMs: number | null; ttsMs: number }
  | { type: 'error'; message: string; fatal: boolean };

/** Defaults the browser shows in its settings panel (GET /api/config). */
export interface PublicConfig {
  systemPrompt: string;
  greeting: string;
  voiceId: string;
  speed: number;
  language: string;
  geminiModel: string;
  cartesiaModel: string;
  outputSampleRate: number;
  allowOverrides: boolean;
}
