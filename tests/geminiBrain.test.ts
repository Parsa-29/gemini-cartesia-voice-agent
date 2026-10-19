import { Modality, StartSensitivity, type LiveServerMessage } from '@google/genai';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  GeminiBrain,
  type LiveConnectArgs,
  type LiveConnector,
  type LiveSessionLike,
} from '../src/server/session/GeminiBrain.js';
import type { BrainEvents } from '../src/server/session/types.js';

class FakeLive implements LiveSessionLike {
  sent: { audio: { data: string; mimeType: string } }[] = [];
  closed = false;
  sendRealtimeInput(params: { audio: { data: string; mimeType: string } }): void {
    this.sent.push(params);
  }
  close(): void {
    this.closed = true;
  }
}

interface Connection {
  args: LiveConnectArgs;
  live: FakeLive;
}

function message(value: object): LiveServerMessage {
  return value as LiveServerMessage;
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('GeminiBrain', () => {
  let connections: Connection[];
  let calls: string[];
  let errors: { message: string; fatal: boolean }[];
  let connector: LiveConnector;

  const events: BrainEvents = {
    onUserTranscript: (d) => calls.push(`user:${d}`),
    onUserSpeechStart: () => calls.push('speech-start'),
    onUserSpeechEnd: () => calls.push('speech-end'),
    onAgentText: (d) => calls.push(`agent:${d}`),
    onGenerationComplete: () => calls.push('generation-complete'),
    onTurnComplete: () => calls.push('turn-complete'),
    onInterrupted: () => calls.push('interrupted'),
    onError: (e, fatal) => errors.push({ message: e.message, fatal }),
  };

  function createBrain(): GeminiBrain {
    return new GeminiBrain(
      {
        apiKey: 'test',
        model: 'gemini-test-live',
        systemInstruction: 'Be helpful.',
        vad: { silenceDurationMs: 600, startSensitivity: 'LOW' },
        connector,
      },
      events,
    );
  }

  const latest = (): Connection => connections.at(-1)!;
  const deliver = (value: object, connection = latest()): void =>
    connection.args.callbacks.onmessage(message(value));

  beforeEach(() => {
    connections = [];
    calls = [];
    errors = [];
    connector = async (args) => {
      const live = new FakeLive();
      connections.push({ args, live });
      return live;
    };
  });

  it('connects with audio output, transcriptions, compression, resumption and VAD settings', async () => {
    await createBrain().connect();
    const { model, config } = latest().args;
    expect(model).toBe('gemini-test-live');
    expect(config.responseModalities).toEqual([Modality.AUDIO]);
    expect(config.systemInstruction).toBe('Be helpful.');
    expect(config.inputAudioTranscription).toEqual({});
    expect(config.outputAudioTranscription).toEqual({});
    expect(config.contextWindowCompression).toEqual({ slidingWindow: {} });
    expect(config.sessionResumption).toEqual({});
    expect(config.realtimeInputConfig?.automaticActivityDetection).toEqual({
      silenceDurationMs: 600,
      startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
    });
  });

  it('pins the user transcription language when one is given', async () => {
    await new GeminiBrain(
      { apiKey: 'test', model: 'm', systemInstruction: '', inputLanguage: 'ka', connector },
      events,
    ).connect();
    expect(latest().args.config.inputAudioTranscription).toEqual({ languageCodes: ['ka'] });
  });

  it('sends mic audio as base64 PCM at 16 kHz', async () => {
    const brain = createBrain();
    await brain.connect();
    brain.sendAudio(Buffer.from([1, 2, 3, 4]));
    expect(latest().live.sent).toEqual([
      { audio: { data: Buffer.from([1, 2, 3, 4]).toString('base64'), mimeType: 'audio/pcm;rate=16000' } },
    ]);
  });

  it('routes server content to brain events in order', async () => {
    await createBrain().connect();
    // What gemini-3.8-live actually sends (the SDK types call the field `voiceActivityType`).
    deliver({ voiceActivity: { type: 'ACTIVITY_START', audioOffset: '0.240s' } });
    deliver({ serverContent: { inputTranscription: { text: 'hi there' } } });
    deliver({ voiceActivity: { voiceActivityType: 'ACTIVITY_END' } });
    deliver({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
    deliver({ serverContent: { outputTranscription: { text: 'Hello!' } } });
    deliver({ serverContent: { generationComplete: true } });
    deliver({ serverContent: { turnComplete: true } });
    deliver({ serverContent: { interrupted: true } });
    expect(calls).toEqual([
      'speech-start',
      'user:hi there',
      'speech-end',
      'agent:Hello!',
      'generation-complete',
      'turn-complete',
      'interrupted',
    ]);
  });

  it('on goAway mid-reply, resumes with the newest handle once Gemini is idle', async () => {
    const brain = createBrain();
    await brain.connect();
    const first = latest();
    deliver({ sessionResumptionUpdate: { resumable: true, newHandle: 'h1' } });
    deliver({ serverContent: { outputTranscription: { text: 'Talking' } } });
    deliver({ goAway: { timeLeft: '10s' } });
    await tick();
    expect(connections).toHaveLength(1);

    deliver({ serverContent: { generationComplete: true } });
    deliver({ sessionResumptionUpdate: { resumable: true, newHandle: 'h2' } });
    // Audio sent while the new connection opens must not be lost.
    brain.sendAudio(Buffer.from([9, 9]));
    await tick();

    expect(connections).toHaveLength(2);
    expect(latest().args.config.sessionResumption).toEqual({ handle: 'h2' });
    expect(first.live.closed).toBe(true);
    expect(latest().live.sent).toHaveLength(1);

    // The old connection is now stale.
    deliver({ serverContent: { outputTranscription: { text: 'ghost' } } }, first);
    expect(calls).not.toContain('agent:ghost');
  });

  it('on goAway while idle with a resumable handle, reconnects right away', async () => {
    await createBrain().connect();
    deliver({ sessionResumptionUpdate: { resumable: true, newHandle: 'h1' } });
    deliver({ goAway: { timeLeft: '10s' } });
    await tick();
    expect(connections).toHaveLength(2);
    expect(latest().args.config.sessionResumption).toEqual({ handle: 'h1' });
  });

  it('resumes after an unexpected close and closes any reply that was cut', async () => {
    await createBrain().connect();
    deliver({ sessionResumptionUpdate: { resumable: true, newHandle: 'h1' } });
    deliver({ serverContent: { outputTranscription: { text: 'Half a' } } });
    connections[0]!.args.callbacks.onclose({ code: 1011, reason: 'internal' });
    await tick();
    expect(connections).toHaveLength(2);
    expect(latest().args.config.sessionResumption).toEqual({ handle: 'h1' });
    expect(calls.at(-1)).toBe('turn-complete');
    expect(errors).toEqual([]);
  });

  it('reports a fatal error when the connection drops and cannot be resumed', async () => {
    await createBrain().connect();
    latest().args.callbacks.onclose({ code: 1008, reason: 'policy' });
    await tick();
    expect(connections).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.fatal).toBe(true);
    expect(errors[0]?.message).toContain('1008');
  });

  it('close() stops audio and ignores the resulting close event', async () => {
    const brain = createBrain();
    await brain.connect();
    const connection = latest();
    brain.close();
    expect(connection.live.closed).toBe(true);
    connection.args.callbacks.onclose({ code: 1000, reason: '' });
    brain.sendAudio(Buffer.from([1, 2]));
    await tick();
    expect(connections).toHaveLength(1);
    expect(connection.live.sent).toHaveLength(0);
    expect(errors).toEqual([]);
  });
});
