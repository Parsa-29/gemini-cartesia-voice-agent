import type { RawData, WebSocket } from 'ws';
import { z } from 'zod';
import type { ClientMessage, ServerMessage, SessionOverrides } from '../shared/protocol.js';
import type { SessionOutput } from './session/types.js';
import type { VoiceSession } from './session/VoiceSession.js';

const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('start'),
    overrides: z
      .object({
        systemPrompt: z.string().max(50_000).optional(),
        greeting: z.string().max(1_000).optional(),
        voiceId: z.string().max(100).optional(),
        speed: z.number().min(0.6).max(1.5).optional(),
      })
      .optional(),
  }),
  z.object({ type: z.literal('playback'), playing: z.boolean() }),
  z.object({ type: z.literal('stop') }),
]);

export type SessionFactory = (overrides: SessionOverrides | undefined, output: SessionOutput) => VoiceSession;

/** Browser transport: one WebSocket = one call. Binary frames are mic audio, text frames are JSON. */
export function handleBrowserSocket(ws: WebSocket, createSession: SessionFactory, log: (m: string) => void): void {
  let session: VoiceSession | null = null;

  const output: SessionOutput = {
    send: (message: ServerMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    },
    sendAudio: (pcm) => {
      if (ws.readyState === ws.OPEN) ws.send(pcm, { binary: true });
    },
    close: () => ws.close(1011, 'session ended'),
  };

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      session?.handleMicAudio(toBuffer(data));
      return;
    }
    const message = parse(data);
    if (!message) {
      log('ignored malformed client message');
      return;
    }
    switch (message.type) {
      case 'start':
        if (session) return;
        session = createSession(message.overrides, output);
        void session.start();
        break;
      case 'playback':
        session?.handleClientPlayback(message.playing);
        break;
      case 'stop':
        session?.close();
        ws.close(1000, 'stopped');
        break;
    }
  });

  ws.on('close', () => session?.close());
  ws.on('error', (error) => log(`socket error: ${error.message}`));
}

function parse(data: RawData): ClientMessage | null {
  try {
    const result = clientMessageSchema.safeParse(JSON.parse(toBuffer(data).toString('utf8')));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
