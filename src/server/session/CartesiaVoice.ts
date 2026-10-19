import Cartesia from '@cartesia/cartesia-js';
import type { Voice, VoiceTurn, VoiceTurnHandlers } from './types.js';

type TtsSocket = Awaited<ReturnType<Cartesia['tts']['websocket']>>;
type TtsContext = ReturnType<TtsSocket['context']>;
type ContextOptions = Parameters<TtsSocket['context']>[0];
type OutputSampleRate = ContextOptions['output_format']['sample_rate'];

export interface CartesiaVoiceOptions {
  apiKey: string;
  model: string;
  voiceId: string;
  language: string;
  sampleRate: number;
  speed: number;
  volume: number;
  pronunciationDictId?: string;
  /**
   * How long Cartesia may hold text waiting for more context. 0 = speak each
   * pushed chunk at once (SpeechChunker already decides where to cut).
   */
  maxBufferDelayMs: number;
  log?: (message: string) => void;
}

/**
 * Cartesia Sonic as the agent's voice: one WebSocket per call, one streaming
 * context per utterance. Text pushed into a context is spoken as a continuation,
 * so prosody stays natural across chunks. The SDK reconnects the socket on the
 * next send if it was closed while idle.
 */
export class CartesiaVoice implements Voice {
  private socket: TtsSocket | null = null;

  constructor(private readonly options: CartesiaVoiceOptions) {}

  async connect(): Promise<void> {
    const client = new Cartesia({ apiKey: this.options.apiKey });
    this.socket = await client.tts.websocket();
    this.socket.on('error', (error: Error) => {
      // Cartesia answers late messages for a context we already cancelled with an error; harmless.
      if (/does not exist|already been cancelled/i.test(error.message)) return;
      this.options.log?.(`socket error: ${error.message}`);
    });
    await this.socket.connect();
  }

  startTurn(handlers: VoiceTurnHandlers): VoiceTurn {
    if (!this.socket) throw new Error('CartesiaVoice.connect() must be called first');
    const { model, voiceId, language, sampleRate, pronunciationDictId } = this.options;
    const context = this.socket.context({
      model_id: model,
      voice: voiceId,
      language: language as ContextOptions['language'],
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: sampleRate as OutputSampleRate },
      max_buffer_delay_ms: this.options.maxBufferDelayMs,
      ...(pronunciationDictId ? { pronunciation_dict_id: pronunciationDictId } : {}),
    });
    return new CartesiaTurn(context, handlers, { speed: this.options.speed, volume: this.options.volume });
  }

  close(): void {
    try {
      this.socket?.close();
    } catch {
      // already closed
    }
    this.socket = null;
  }
}

class CartesiaTurn implements VoiceTurn {
  /** Sends are serialised so `no_more_inputs` never overtakes pending text. */
  private chain: Promise<void> = Promise.resolve();
  private pushed = false;
  private finished = false;
  private cancelled = false;
  private settled = false;

  constructor(
    private readonly context: TtsContext,
    private readonly handlers: VoiceTurnHandlers,
    private readonly generationConfig: { speed: number; volume: number },
  ) {
    void this.pump();
  }

  push(text: string): void {
    if (this.finished || this.cancelled || !text.trim()) return;
    this.pushed = true;
    this.enqueue(() => this.context.push({ transcript: text, generation_config: this.generationConfig }));
  }

  finish(): void {
    if (this.finished || this.cancelled) return;
    this.finished = true;
    if (!this.pushed) {
      // Nothing to say: close the context locally instead of sending an empty request.
      void this.context.cancel();
      this.settle();
      return;
    }
    this.enqueue(() => this.context.no_more_inputs());
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.settled = true;
    void this.context.cancel();
  }

  private enqueue(task: () => Promise<unknown>): void {
    this.chain = this.chain.then(async () => {
      if (this.cancelled) return;
      try {
        await task();
      } catch (error) {
        if (!this.cancelled) this.handlers.onError(toError(error));
      }
    });
  }

  private async pump(): Promise<void> {
    try {
      for await (const event of this.context.receive()) {
        if (this.cancelled) return;
        if (event.type === 'chunk' && event.audio) {
          const { buffer, byteOffset, byteLength } = event.audio;
          this.handlers.onAudio(Buffer.from(buffer, byteOffset, byteLength));
        }
      }
    } catch (error) {
      if (!this.cancelled) this.handlers.onError(toError(error));
    } finally {
      this.settle();
    }
  }

  private settle(): void {
    if (this.settled) return;
    this.settled = true;
    this.handlers.onDone();
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
