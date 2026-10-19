import { beforeAll, describe, expect, it } from 'vitest';

/** Minimal AudioWorkletGlobalScope so the real worklet files can run under Node. */
interface FakePort {
  sent: unknown[];
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
}
interface Processor {
  port: FakePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
type ProcessorClass = new () => Processor;

const registry = new Map<string, ProcessorClass>();
const scope = globalThis as unknown as Record<string, unknown>;

beforeAll(async () => {
  scope.AudioWorkletProcessor = class {
    port: FakePort = {
      sent: [],
      onmessage: null,
      postMessage(message: unknown) {
        this.sent.push(message);
      },
    };
  };
  scope.registerProcessor = (name: string, processor: ProcessorClass) => registry.set(name, processor);
  scope.sampleRate = 48000;
  // Plain JS served as-is to the browser; loaded by URL so TypeScript doesn't need types for it.
  for (const file of ['capture-worklet.js', 'player-worklet.js']) {
    await import(new URL(`../src/web/public/${file}`, import.meta.url).href);
  }
});

function create(name: string, rate: number): Processor {
  scope.sampleRate = rate;
  return new (registry.get(name)!)();
}

function sine(frequency: number, rate: number, seconds: number, amplitude = 0.5): Float32Array {
  const samples = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < samples.length; i++) samples[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / rate);
  return samples;
}

function feed(processor: Processor, signal: Float32Array): void {
  for (let i = 0; i < signal.length; i += 128) processor.process([[signal.subarray(i, i + 128)]], [[]]);
}

type Frame = { pcm: ArrayBuffer; rms: number };

describe('capture worklet', () => {
  it('turns 48 kHz input into 20 ms frames of 16 kHz PCM16', () => {
    const capture = create('capture', 48000);
    feed(capture, sine(440, 48000, 1));
    const frames = capture.port.sent as Frame[];
    expect(frames.length).toBeGreaterThanOrEqual(49);
    expect(frames.length).toBeLessThanOrEqual(50);
    expect(frames.every((f) => f.pcm.byteLength === 640)).toBe(true);
    // A 0.5-amplitude sine has RMS ≈ 0.354 once the filter has warmed up.
    expect(frames.at(-1)!.rms).toBeCloseTo(0.354, 2);
  });

  it('filters out frequencies that would alias at 16 kHz', () => {
    const capture = create('capture', 48000);
    feed(capture, sine(12000, 48000, 0.5));
    const frames = capture.port.sent as Frame[];
    expect(Math.max(...frames.slice(2).map((f) => f.rms))).toBeLessThan(0.01);
  });

  it('passes 16 kHz input straight through', () => {
    const capture = create('capture', 16000);
    const signal = new Float32Array(320).map((_, i) => (i % 2 === 0 ? 0.25 : -0.25));
    feed(capture, signal);
    const [frame] = capture.port.sent as Frame[];
    const pcm = new Int16Array(frame!.pcm);
    expect(Array.from(pcm.subarray(0, 4))).toEqual([8191, -8192, 8191, -8192]);
  });
});

describe('player worklet', () => {
  const RATE = 24000;

  function pcm(samples: number, value = 8192): ArrayBuffer {
    return new Int16Array(samples).fill(value).buffer;
  }
  function send(player: Processor, data: unknown): void {
    player.port.onmessage!({ data });
  }
  function render(player: Processor): Float32Array {
    const out = new Float32Array(128);
    player.process([], [[out]]);
    return out;
  }
  const playingEvents = (player: Processor): boolean[] =>
    (player.port.sent as { playing: boolean }[]).map((m) => m.playing);

  it('plays queued audio once the pre-buffer is filled', () => {
    const player = create('player', RATE);
    send(player, { type: 'audio', pcm: pcm(4800) });
    const out = render(player);
    expect(out[0]).toBeCloseTo(0.25);
    expect(playingEvents(player)).toEqual([true]);
  });

  it('waits for the pre-buffer unless the turn has ended', () => {
    const player = create('player', RATE);
    send(player, { type: 'audio', pcm: pcm(100) });
    expect(render(player)[0]).toBe(0);
    expect(playingEvents(player)).toEqual([]);
    send(player, { type: 'end' });
    expect(render(player)[0]).toBeCloseTo(0.25);
    expect(playingEvents(player)).toEqual([true, false]);
  });

  it('flush silences playback immediately', () => {
    const player = create('player', RATE);
    send(player, { type: 'audio', pcm: pcm(4800) });
    render(player);
    send(player, { type: 'flush' });
    expect(render(player).every((s) => s === 0)).toBe(true);
    expect(playingEvents(player)).toEqual([true, false]);
  });

  it('reports the end of playback after the last chunk of a turn', () => {
    const player = create('player', RATE);
    send(player, { type: 'audio', pcm: pcm(1280) });
    send(player, { type: 'end' });
    for (let i = 0; i < 11; i++) render(player);
    expect(playingEvents(player)).toEqual([true, false]);
  });

  it('stays audible through a short mid-turn gap, then gives up after a stall', () => {
    const player = create('player', RATE);
    send(player, { type: 'audio', pcm: pcm(1280) });
    for (let i = 0; i < 20; i++) render(player); // 1280 samples played, then ~1.3k of silence
    expect(playingEvents(player)).toEqual([true]);
    for (let i = 0; i < 300; i++) render(player); // > 1.5 s of starvation
    expect(playingEvents(player)).toEqual([true, false]);
  });
});
