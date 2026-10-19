import { WS_PATH, type ClientMessage, type ServerMessage } from '../shared/protocol.js';

export interface VoiceClientEvents {
  onMessage(message: ServerMessage): void;
  /** Agent voice: PCM16 at the `ready` message's output sample rate. */
  onAudio(pcm: ArrayBuffer): void;
  /** The socket closed; `expected` is true after `close()`. */
  onClose(expected: boolean): void;
}

/** The call's WebSocket: JSON control messages plus binary audio both ways. */
export class VoiceClient {
  private socket: WebSocket | null = null;
  private closing = false;

  constructor(private readonly events: VoiceClientEvents) {}

  connect(): Promise<void> {
    const url = new URL(WS_PATH, window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
      if (typeof event.data === 'string') this.events.onMessage(JSON.parse(event.data) as ServerMessage);
      else this.events.onAudio(event.data);
    };

    return new Promise((resolve, reject) => {
      socket.onopen = () => {
        socket.onclose = () => this.events.onClose(this.closing);
        resolve();
      };
      socket.onerror = () => reject(new Error('Could not connect to the voice server'));
    });
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  sendAudio(pcm: ArrayBuffer): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(pcm);
  }

  close(): void {
    this.closing = true;
    this.send({ type: 'stop' });
    this.socket?.close();
    this.socket = null;
  }
}
