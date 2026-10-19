import {
  EndSensitivity,
  GoogleGenAI,
  Modality,
  StartSensitivity,
  VoiceActivityType,
  type AutomaticActivityDetection,
  type LiveConnectConfig,
  type LiveServerMessage,
} from '@google/genai';
import { MIC_SAMPLE_RATE } from '../../shared/protocol.js';
import type { Brain, BrainEvents } from './types.js';

const MIC_MIME_TYPE = `audio/pcm;rate=${MIC_SAMPLE_RATE}`;
/** Mic audio kept while (re)connecting: ~3 s. */
const DEFAULT_MAX_BUFFERED_BYTES = MIC_SAMPLE_RATE * 2 * 3;

export interface LiveSessionLike {
  sendRealtimeInput(params: { audio: { data: string; mimeType: string } }): void;
  close(): void;
}

export interface LiveConnectArgs {
  model: string;
  config: LiveConnectConfig;
  callbacks: {
    onmessage(message: LiveServerMessage): void;
    onerror(event: { message?: string }): void;
    onclose(event: { code?: number; reason?: string }): void;
  };
}

/** Opens a Gemini Live connection (swappable for tests). */
export type LiveConnector = (args: LiveConnectArgs) => Promise<LiveSessionLike>;

export interface VadOptions {
  silenceDurationMs?: number;
  prefixPaddingMs?: number;
  startSensitivity?: 'LOW' | 'HIGH';
  endSensitivity?: 'LOW' | 'HIGH';
}

export interface GeminiBrainOptions {
  apiKey: string;
  model: string;
  systemInstruction: string;
  /** Language code of the user's speech (e.g. `ka`); improves transcripts. Omit for auto-detect. */
  inputLanguage?: string;
  vad?: VadOptions;
  connector?: LiveConnector;
  maxBufferedBytes?: number;
  log?: (message: string) => void;
}

/**
 * Gemini Live as the agent's brain: hears the user, decides when they finished,
 * and writes the reply. Live models only answer in audio, so the reply text is
 * taken from the output transcription and Gemini's own audio is ignored.
 *
 * Keeps a call alive past Gemini's connection limits: context-window compression
 * lifts the session length cap, and on `goAway` (or an unexpected close) the
 * session resumes on a new connection with the latest resumption handle.
 */
export class GeminiBrain implements Brain {
  private session: LiveSessionLike | null = null;
  private readonly connector: LiveConnector;
  private connectionId = 0;
  private resumeHandle: string | undefined;
  /** The latest handle covers everything that has happened so far. */
  private handleFresh = false;
  private generating = false;
  private goAwayPending = false;
  private reconnecting = false;
  private closed = false;
  private buffered: Buffer[] = [];
  private bufferedBytes = 0;

  constructor(
    private readonly options: GeminiBrainOptions,
    private readonly events: BrainEvents,
  ) {
    this.connector = options.connector ?? googleConnector(options.apiKey);
  }

  async connect(): Promise<void> {
    this.session = await this.open();
    this.flushBuffered();
  }

  sendAudio(pcm: Buffer): void {
    if (this.closed) return;
    if (!this.session) {
      this.buffer(pcm);
      return;
    }
    try {
      this.session.sendRealtimeInput({ audio: { data: pcm.toString('base64'), mimeType: MIC_MIME_TYPE } });
    } catch (error) {
      this.log(`send failed: ${toError(error).message}`);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const session = this.session;
    this.session = null;
    this.buffered = [];
    try {
      session?.close();
    } catch {
      // already closed
    }
  }

  private open(): Promise<LiveSessionLike> {
    const id = ++this.connectionId;
    const isCurrent = (): boolean => id === this.connectionId && !this.closed;
    return this.connector({
      model: this.options.model,
      config: this.buildConfig(),
      callbacks: {
        onmessage: (message) => {
          if (isCurrent()) this.handleMessage(message);
        },
        onerror: (event) => {
          if (isCurrent()) this.log(`connection error: ${event.message ?? 'unknown'}`);
        },
        onclose: (event) => {
          if (isCurrent()) this.handleUnexpectedClose(event);
        },
      },
    });
  }

  private buildConfig(): LiveConnectConfig {
    const config: LiveConnectConfig = {
      responseModalities: [Modality.AUDIO],
      systemInstruction: this.options.systemInstruction,
      inputAudioTranscription: this.options.inputLanguage ? { languageCodes: [this.options.inputLanguage] } : {},
      outputAudioTranscription: {},
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: this.resumeHandle ? { handle: this.resumeHandle } : {},
    };
    const detection = vadConfig(this.options.vad);
    if (detection) config.realtimeInputConfig = { automaticActivityDetection: detection };
    return config;
  }

  private handleMessage(message: LiveServerMessage): void {
    const update = message.sessionResumptionUpdate;
    if (update) {
      if (update.resumable && update.newHandle) {
        this.resumeHandle = update.newHandle;
        this.handleFresh = true;
      } else {
        this.handleFresh = false;
      }
    }

    if (message.goAway) {
      this.log(`goAway (time left ${message.goAway.timeLeft ?? '?'})`);
      this.goAwayPending = true;
    }

    // The API sends `{ type }`; the SDK types call it `voiceActivityType`. Accept both.
    const voiceActivity = message.voiceActivity as { voiceActivityType?: string; type?: string } | undefined;
    const activity = voiceActivity?.voiceActivityType ?? voiceActivity?.type;
    if (activity === VoiceActivityType.ACTIVITY_START) this.events.onUserSpeechStart();
    else if (activity === VoiceActivityType.ACTIVITY_END) this.events.onUserSpeechEnd();

    const content = message.serverContent;
    if (content) {
      if (content.interrupted) {
        this.generating = false;
        this.handleFresh = false;
        this.events.onInterrupted();
      }
      const userText = content.inputTranscription?.text;
      if (userText) {
        this.handleFresh = false;
        this.events.onUserTranscript(userText);
      }
      if (content.modelTurn) {
        this.generating = true;
        this.handleFresh = false;
      }
      const agentText = content.outputTranscription?.text;
      if (agentText) {
        this.generating = true;
        this.handleFresh = false;
        this.events.onAgentText(agentText);
      }
      if (content.generationComplete) {
        this.generating = false;
        this.events.onGenerationComplete();
      }
      if (content.turnComplete) {
        this.generating = false;
        this.events.onTurnComplete();
      }
    }

    if (this.goAwayPending && !this.generating && this.handleFresh) void this.reconnect('goAway');
  }

  private handleUnexpectedClose(event: { code?: number; reason?: string }): void {
    const reason = `code ${event.code ?? '?'}${event.reason ? `: ${event.reason}` : ''}`;
    this.session = null;
    if (this.generating) {
      // The rest of this reply is lost; let the session speak what it has.
      this.generating = false;
      this.events.onTurnComplete();
    }
    void this.reconnect(`closed, ${reason}`);
  }

  private async reconnect(reason: string): Promise<void> {
    if (this.reconnecting || this.closed) return;
    if (!this.resumeHandle) {
      this.events.onError(new Error(`Gemini Live disconnected (${reason}) and cannot be resumed`), true);
      return;
    }
    this.reconnecting = true;
    this.goAwayPending = false;
    const previous = this.session;
    this.session = null; // mic audio is buffered until the new connection is up
    this.log(`resuming session (${reason})`);
    try {
      const next = await this.open();
      if (this.closed) {
        next.close();
        return;
      }
      this.session = next;
      try {
        previous?.close();
      } catch {
        // already closed
      }
      this.flushBuffered();
    } catch (error) {
      this.events.onError(new Error(`Gemini Live reconnect failed: ${toError(error).message}`), true);
    } finally {
      this.reconnecting = false;
    }
  }

  private buffer(pcm: Buffer): void {
    const max = this.options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.buffered.push(pcm);
    this.bufferedBytes += pcm.length;
    while (this.bufferedBytes > max && this.buffered.length > 0) {
      this.bufferedBytes -= this.buffered.shift()!.length;
    }
  }

  private flushBuffered(): void {
    const pending = this.buffered;
    this.buffered = [];
    this.bufferedBytes = 0;
    for (const pcm of pending) this.sendAudio(pcm);
  }

  private log(message: string): void {
    this.options.log?.(message);
  }
}

function vadConfig(vad: VadOptions | undefined): AutomaticActivityDetection | undefined {
  if (!vad) return undefined;
  const detection: AutomaticActivityDetection = {};
  if (vad.silenceDurationMs !== undefined) detection.silenceDurationMs = vad.silenceDurationMs;
  if (vad.prefixPaddingMs !== undefined) detection.prefixPaddingMs = vad.prefixPaddingMs;
  if (vad.startSensitivity) {
    detection.startOfSpeechSensitivity =
      vad.startSensitivity === 'LOW'
        ? StartSensitivity.START_SENSITIVITY_LOW
        : StartSensitivity.START_SENSITIVITY_HIGH;
  }
  if (vad.endSensitivity) {
    detection.endOfSpeechSensitivity =
      vad.endSensitivity === 'LOW' ? EndSensitivity.END_SENSITIVITY_LOW : EndSensitivity.END_SENSITIVITY_HIGH;
  }
  return Object.keys(detection).length > 0 ? detection : undefined;
}

function googleConnector(apiKey: string): LiveConnector {
  const ai = new GoogleGenAI({ apiKey });
  return ({ model, config, callbacks }) =>
    ai.live.connect({
      model,
      config,
      callbacks: {
        onmessage: callbacks.onmessage,
        onerror: (event) => callbacks.onerror({ message: event.message }),
        onclose: (event) => callbacks.onclose({ code: event.code, reason: event.reason }),
      },
    });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
