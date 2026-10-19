import './styles.css';
import type { AgentState, PublicConfig, ServerMessage, SessionOverrides } from '../shared/protocol.js';
import { AudioEngine } from './audio/AudioEngine.js';
import { VoiceClient } from './VoiceClient.js';
import { clearOverrides, effectiveSettings, loadOverrides, saveOverrides } from './settings.js';

type Phase = 'idle' | AgentState;

const STATUS: Record<Phase, string> = {
  idle: 'დააჭირე და დაიწყე საუბარი',
  connecting: 'უკავშირდება…',
  listening: 'გისმენ…',
  thinking: 'ფიქრობს…',
  speaking: 'ლაპარაკობს…',
};

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const ui = {
  callButton: $<HTMLButtonElement>('call-button'),
  callLabel: $('call-label'),
  status: $('status'),
  mute: $<HTMLButtonElement>('mute-button'),
  latency: $('latency'),
  transcript: $('transcript'),
  empty: $('empty'),
  error: $('error'),
  meta: $('meta'),
  customBadge: $('custom-badge'),
  settingsButton: $<HTMLButtonElement>('settings-button'),
  settings: $<HTMLDialogElement>('settings'),
  settingsNote: $('settings-note'),
  prompt: $<HTMLTextAreaElement>('field-prompt'),
  greeting: $<HTMLInputElement>('field-greeting'),
  voice: $<HTMLInputElement>('field-voice'),
  speed: $<HTMLInputElement>('field-speed'),
  speedValue: $<HTMLOutputElement>('speed-value'),
  reset: $<HTMLButtonElement>('reset-button'),
};

let config: PublicConfig;
let overrides: SessionOverrides = loadOverrides();
let call: Call | null = null;
let errorTimer: number | undefined;

/** One conversation: audio engine + socket + the transcript/latency view for it. */
class Call {
  private readonly engine: AudioEngine;
  private readonly client: VoiceClient;
  private state: AgentState = 'connecting';
  private playing = false;
  private muted = false;
  private ended = false;
  private userBubble: HTMLElement | null = null;
  private agentTurn = 0;
  private readonly agentBubbles = new Map<number, HTMLElement>();
  /** Reply waiting for its first audio: when did the user stop talking? */
  private pendingLatency: { turn: number; voiceEnd: number } | null = null;
  private readonly measured = new Map<number, { totalMs?: number; brainMs?: number | null; ttsMs?: number }>();
  private level = 0;
  private frame = 0;

  constructor() {
    this.engine = new AudioEngine({
      onMicFrame: (pcm) => {
        if (!this.muted) this.client.sendAudio(pcm);
      },
      onPlaybackChange: (playing) => {
        this.playing = playing;
        this.client.send({ type: 'playback', playing });
        if (playing && this.pendingLatency) {
          const { turn, voiceEnd } = this.pendingLatency;
          this.pendingLatency = null;
          if (voiceEnd > 0) this.recordLatency(turn, { totalMs: Math.round(performance.now() - voiceEnd) });
        }
        this.render();
      },
    });
    this.client = new VoiceClient({
      onMessage: (message) => this.handle(message),
      onAudio: (pcm) => this.engine.play(pcm),
      onClose: (expected) => {
        if (!expected && !this.ended) {
          showError('კავშირი გაწყდა.');
          void this.end();
        }
      },
    });
  }

  async start(): Promise<void> {
    this.render();
    await this.engine.start(config.outputSampleRate);
    await this.client.connect();
    this.client.send({ type: 'start', overrides: config.allowOverrides ? overrides : undefined });
    this.frame = requestAnimationFrame(() => this.animate());
  }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    cancelAnimationFrame(this.frame);
    this.client.close();
    await this.engine.stop();
    ui.callButton.style.setProperty('--level', '0');
    if (call === this) call = null;
    setIdle();
  }

  toggleMute(): void {
    this.muted = !this.muted;
    this.render();
  }

  private handle(message: ServerMessage): void {
    switch (message.type) {
      case 'ready':
        break;
      case 'state':
        this.state = message.state;
        break;
      case 'transcript':
        if (message.role === 'user') {
          this.userBubble ??= addBubble('user');
          appendText(this.userBubble, message.delta);
        } else {
          const bubble = this.agentBubbles.get(this.agentTurn);
          if (bubble) appendText(bubble, message.delta);
        }
        break;
      case 'agent_turn_start':
        this.agentTurn = message.turn;
        this.agentBubbles.set(message.turn, addBubble('agent'));
        this.userBubble = null;
        if (message.kind === 'reply') {
          this.pendingLatency = { turn: message.turn, voiceEnd: this.engine.lastVoiceAt };
        }
        break;
      case 'agent_turn_end':
        if (message.interrupted) this.agentBubbles.get(message.turn)?.classList.add('interrupted');
        break;
      case 'agent_audio_end':
        this.engine.endOfTurn();
        break;
      case 'clear':
        this.engine.flush();
        this.pendingLatency = null;
        break;
      case 'metrics':
        this.recordLatency(message.turn, { brainMs: message.brainMs, ttsMs: message.ttsMs });
        break;
      case 'error':
        showError(message.message);
        if (message.fatal) void this.end();
        break;
    }
    this.render();
  }

  private recordLatency(turn: number, values: { totalMs?: number; brainMs?: number | null; ttsMs?: number }): void {
    const entry = { ...this.measured.get(turn), ...values };
    this.measured.set(turn, entry);
    const parts: string[] = [];
    if (entry.totalMs !== undefined) parts.push(`პასუხი ${entry.totalMs} ms`);
    if (entry.brainMs != null) parts.push(`Gemini ${entry.brainMs} ms`);
    if (entry.ttsMs !== undefined) parts.push(`Cartesia ${entry.ttsMs} ms`);
    ui.latency.textContent = parts.join(' · ');
    ui.latency.hidden = parts.length === 0;
  }

  private render(): void {
    if (this.ended) return;
    const phase: Phase = this.playing ? 'speaking' : this.state;
    ui.callButton.dataset.phase = phase;
    ui.callLabel.textContent = 'დასრულება';
    ui.callButton.setAttribute('aria-label', 'ზარის დასრულება');
    ui.status.textContent = this.muted && phase === 'listening' ? 'მიკროფონი გათიშულია' : STATUS[phase];
    ui.mute.hidden = false;
    ui.mute.setAttribute('aria-pressed', String(this.muted));
    ui.mute.textContent = this.muted ? 'მიკროფონის ჩართვა' : 'მიკროფონის გათიშვა';
  }

  private animate(): void {
    const target = this.playing
      ? Math.min(1, this.engine.agentLevel() * 5)
      : this.muted
        ? 0
        : Math.min(1, this.engine.micLevel * 8);
    this.level += (target - this.level) * 0.3;
    ui.callButton.style.setProperty('--level', this.level.toFixed(3));
    this.frame = requestAnimationFrame(() => this.animate());
  }
}

function addBubble(role: 'user' | 'agent'): HTMLElement {
  ui.empty.hidden = true;
  const bubble = document.createElement('div');
  bubble.className = `msg ${role}`;
  ui.transcript.append(bubble);
  scrollTranscript();
  return bubble;
}

function appendText(bubble: HTMLElement, delta: string): void {
  bubble.textContent = (bubble.textContent ?? '') + delta;
  scrollTranscript();
}

function scrollTranscript(): void {
  const { transcript } = ui;
  if (transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 120) {
    transcript.scrollTop = transcript.scrollHeight;
  }
}

function setIdle(): void {
  ui.callButton.dataset.phase = 'idle';
  ui.callLabel.textContent = 'დაწყება';
  ui.callButton.setAttribute('aria-label', 'ზარის დაწყება');
  ui.status.textContent = STATUS.idle;
  ui.mute.hidden = true;
}

function showError(message: string): void {
  ui.error.textContent = message;
  ui.error.hidden = false;
  window.clearTimeout(errorTimer);
  errorTimer = window.setTimeout(() => (ui.error.hidden = true), 6000);
}

async function toggleCall(): Promise<void> {
  if (call) {
    await call.end();
    return;
  }
  ui.transcript.querySelectorAll('.msg').forEach((el) => el.remove());
  ui.empty.hidden = false;
  ui.latency.hidden = true;
  const current = new Call();
  call = current;
  try {
    await current.start();
  } catch (error) {
    const denied = error instanceof DOMException && error.name === 'NotAllowedError';
    showError(denied ? 'მიკროფონზე წვდომა არ არის. დაუშვი ბრაუზერის პარამეტრებში.' : errorMessage(error));
    await current.end();
  }
}

// ── Settings ───────────────────────────────────────────

function fillSettings(): void {
  const values = effectiveSettings(config, overrides);
  ui.prompt.value = values.systemPrompt;
  ui.greeting.value = values.greeting;
  ui.voice.value = values.voiceId;
  ui.speed.value = String(values.speed);
  ui.speedValue.textContent = values.speed.toFixed(2);
  ui.customBadge.hidden = Object.keys(overrides).length === 0;
}

function setupSettings(): void {
  const editable = config.allowOverrides;
  for (const field of [ui.prompt, ui.greeting, ui.voice, ui.speed, ui.reset]) field.disabled = !editable;
  if (!editable) ui.settingsNote.textContent = 'სერვერზე პარამეტრების შეცვლა გამორთულია (ALLOW_CLIENT_OVERRIDES=false).';

  ui.settingsButton.addEventListener('click', () => {
    fillSettings();
    ui.settings.showModal();
  });
  ui.speed.addEventListener('input', () => (ui.speedValue.textContent = Number(ui.speed.value).toFixed(2)));
  ui.reset.addEventListener('click', () => {
    clearOverrides();
    overrides = {};
    fillSettings();
  });
  ui.settings.addEventListener('close', () => {
    if (ui.settings.returnValue !== 'save' || !editable) return;
    overrides = saveOverrides(
      {
        systemPrompt: ui.prompt.value,
        greeting: ui.greeting.value,
        voiceId: ui.voice.value,
        speed: Number(ui.speed.value),
      },
      config,
    );
    fillSettings();
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function init(): Promise<void> {
  try {
    const response = await fetch('/api/config');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    config = (await response.json()) as PublicConfig;
  } catch (error) {
    ui.status.textContent = 'სერვერთან დაკავშირება ვერ მოხერხდა.';
    showError(errorMessage(error));
    return;
  }
  ui.meta.textContent = `${config.geminiModel} · ${config.cartesiaModel} · ${config.language}`;
  setupSettings();
  fillSettings();
  setIdle();
  ui.callButton.disabled = false;
  ui.callButton.addEventListener('click', () => void toggleCall());
  ui.mute.addEventListener('click', () => call?.toggleMute());
}

void init();
