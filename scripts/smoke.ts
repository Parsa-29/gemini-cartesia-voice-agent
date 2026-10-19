/**
 * End-to-end smoke test against the real Gemini Live + Cartesia APIs.
 *
 * Starts the server, connects like a browser would, and plays Georgian speech
 * (synthesised by Cartesia at 16 kHz) into the "microphone" in real time:
 *   1. greeting plays
 *   2. a short question → expects a spoken reply, prints latency
 *   3. a long request, then an interruption while the reply is playing → expects `clear`
 * Agent audio is saved to .smoke/*.wav so you can listen to it.
 *
 *   npm run smoke
 */
import Cartesia from '@cartesia/cartesia-js';
import { mkdirSync, writeFileSync } from 'node:fs';
import WebSocket from 'ws';
import { startServer } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { MIC_SAMPLE_RATE, WS_PATH, type ClientMessage, type ServerMessage } from '../src/shared/protocol.js';

const FRAME_MS = 20;
const FRAME_BYTES = (MIC_SAMPLE_RATE * 2 * FRAME_MS) / 1000;
const OUT_DIR = new URL('../.smoke/', import.meta.url);

const config = loadConfig();
const cartesia = new Cartesia({ apiKey: config.cartesia.apiKey });
const t0 = Date.now();
const elapsed = (): string => `${String(Date.now() - t0).padStart(6)}ms`;
const failures: string[] = [];

async function synthesize(text: string): Promise<Buffer> {
  const response = await cartesia.tts.generate({
    model_id: config.cartesia.model,
    transcript: text,
    voice: config.cartesia.voiceId,
    language: config.cartesia.language as never,
    output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: MIC_SAMPLE_RATE },
  });
  return Buffer.from(await response.arrayBuffer());
}

function wav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const voice = await cartesia.voices.get(config.cartesia.voiceId);
console.log(`Voice: ${voice.name} (${voice.language}) — ${voice.description}`);

console.log('Synthesising test utterances…');
const [question, longRequest, interruption] = await Promise.all([
  synthesize('გამარჯობა. მითხარით, რამდენი დღეა კვირაში?'),
  synthesize('მომიყევით დეტალურად, როგორ მზადდება აჭარული ხაჭაპური, ნაბიჯ-ნაბიჯ.'),
  synthesize('მოიცადეთ, გაჩერდით. სხვა რამე მაინტერესებს.'),
]);

const server = await startServer(config, { port: 0, serveWeb: false });
const ws = new WebSocket(`ws://localhost:${server.port}${WS_PATH}`);
await new Promise<void>((resolve, reject) => {
  ws.once('open', () => resolve());
  ws.once('error', reject);
});
const send = (message: ClientMessage): void => ws.send(JSON.stringify(message));

// ── Simulated browser: real-time mic + a player that reports playback ────────
let outputRate = 24000;
const micQueue: Buffer[] = [];
let micSentFrames = 0;
const micStart = Date.now();
let lastSpeechFrameAt = 0;
const micTimer = setInterval(() => {
  const due = Math.floor((Date.now() - micStart) / FRAME_MS);
  while (micSentFrames < due && ws.readyState === ws.OPEN) {
    const speech = micQueue[0];
    let frame: Buffer;
    if (speech) {
      frame = speech.subarray(0, FRAME_BYTES);
      micQueue[0] = speech.subarray(FRAME_BYTES);
      if (micQueue[0].length === 0) {
        micQueue.shift();
        lastSpeechFrameAt = Date.now();
      }
      if (frame.length < FRAME_BYTES) frame = Buffer.concat([frame, Buffer.alloc(FRAME_BYTES - frame.length)]);
    } else {
      frame = Buffer.alloc(FRAME_BYTES);
    }
    ws.send(frame, { binary: true });
    micSentFrames++;
  }
}, 5);

function say(pcm: Buffer): Promise<void> {
  micQueue.push(pcm);
  return waitFor(() => micQueue.length === 0, 30_000, 'utterance sent');
}

let playing = false;
let playUntil = 0;
let audioEnded = true;
let turnAudio: Buffer[] = [];
const savedTurns = new Map<number, Buffer>();
let currentTurn = 0;
const playerTimer = setInterval(() => {
  if (playing && audioEnded && Date.now() >= playUntil) {
    playing = false;
    send({ type: 'playback', playing: false });
  }
}, 10);

const messages: { at: number; message: ServerMessage }[] = [];
const agentDeltas: string[] = [];
const userDeltas: string[] = [];

ws.on('message', (data, isBinary) => {
  if (isBinary) {
    const pcm = data as Buffer;
    turnAudio.push(pcm);
    audioEnded = false;
    const ms = (pcm.length / 2 / outputRate) * 1000;
    if (!playing) {
      playing = true;
      playUntil = Date.now();
      send({ type: 'playback', playing: true });
    }
    playUntil = Math.max(playUntil, Date.now()) + ms;
    return;
  }
  const message = JSON.parse(String(data)) as ServerMessage;
  messages.push({ at: Date.now(), message });
  switch (message.type) {
    case 'ready':
      outputRate = message.outputSampleRate;
      break;
    case 'transcript':
      (message.role === 'agent' ? agentDeltas : userDeltas).push(message.delta);
      break;
    case 'agent_turn_start':
      currentTurn = message.turn;
      console.log(`${elapsed()}  agent turn ${message.turn} (${message.kind})`);
      break;
    case 'agent_audio_end':
      audioEnded = true;
      savedTurns.set(message.turn, Buffer.concat(turnAudio));
      turnAudio = [];
      break;
    case 'clear':
      console.log(`${elapsed()}  CLEAR (barge-in)`);
      savedTurns.set(currentTurn, Buffer.concat(turnAudio));
      turnAudio = [];
      playing = false;
      audioEnded = true;
      send({ type: 'playback', playing: false });
      break;
    case 'metrics':
      console.log(`${elapsed()}  metrics turn ${message.turn}: gemini ${message.brainMs}ms, cartesia ${message.ttsMs}ms`);
      break;
    case 'error':
      console.log(`${elapsed()}  ERROR${message.fatal ? ' (fatal)' : ''}: ${message.message}`);
      if (message.fatal) failures.push(message.message);
      break;
    case 'state':
      break;
    default:
      break;
  }
});

function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for: ${label}`));
      }
    }, 10);
  });
}

const count = (type: ServerMessage['type']): number => messages.filter((m) => m.message.type === type).length;
const firstAudioAfter = (since: number): Promise<number> =>
  waitFor(() => playing && playUntil > since, 20_000, 'agent audio').then(() => Date.now());
const idle = (): Promise<void> => waitFor(() => !playing && audioEnded, 60_000, 'agent finished speaking');

try {
  send({ type: 'start' });

  // 1. Greeting
  const greetingAudio = await firstAudioAfter(0);
  console.log(`${elapsed()}  greeting audio started (${greetingAudio - t0}ms after connect)`);
  await idle();

  // 2. Question → reply
  console.log(`${elapsed()}  user: question`);
  agentDeltas.length = 0;
  await say(question);
  const questionEnd = lastSpeechFrameAt;
  const replyAudio = await firstAudioAfter(questionEnd);
  console.log(`${elapsed()}  reply audio started ${replyAudio - questionEnd}ms after the user stopped`);
  await idle();
  console.log(`  user transcript: ${JSON.stringify(userDeltas.join(''))}`);
  console.log(`  agent deltas:    ${JSON.stringify(agentDeltas)}`);
  if (agentDeltas.join('').trim().length === 0) failures.push('no agent reply text');

  // 3. Long reply, interrupted mid-playback
  console.log(`${elapsed()}  user: long request`);
  await say(longRequest);
  await firstAudioAfter(lastSpeechFrameAt);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const clearsBefore = count('clear');
  console.log(`${elapsed()}  user: interruption (agent still playing: ${playing})`);
  const interruptAt = Date.now();
  micQueue.push(interruption);
  await waitFor(() => count('clear') > clearsBefore, 8_000, 'barge-in clear');
  console.log(`${elapsed()}  barge-in took ${Date.now() - interruptAt}ms from the start of the interruption`);
  await waitFor(() => micQueue.length === 0, 10_000, 'interruption sent');
  await firstAudioAfter(lastSpeechFrameAt).catch(() => failures.push('no reply after interruption'));
  await idle().catch(() => undefined);
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  send({ type: 'stop' });
  clearInterval(micTimer);
  clearInterval(playerTimer);
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [turn, pcm] of savedTurns) {
    if (pcm.length > 0) writeFileSync(new URL(`turn-${turn}.wav`, OUT_DIR), wav(pcm, outputRate));
  }
  console.log(`Saved agent audio for turns [${[...savedTurns.keys()].join(', ')}] to .smoke/`);
  await server.close();
}

if (failures.length > 0) {
  console.error(`\nSMOKE FAILED:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\nSMOKE PASSED');
process.exit(0);
