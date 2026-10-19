/** Mic frames at or above this RMS count as the user speaking (for latency metrics). */
const VOICE_RMS = 0.015;

export interface AudioEngineEvents {
  /** 20 ms of 16 kHz PCM16 mic audio. */
  onMicFrame(pcm: ArrayBuffer): void;
  /** The player started or stopped producing agent audio. */
  onPlaybackChange(playing: boolean): void;
}

/**
 * Browser audio: microphone capture (with the browser's echo cancellation, so
 * the user can talk over the agent) and gapless playback of the agent's voice.
 * Both run in AudioWorklets, off the main thread.
 */
export class AudioEngine {
  /** `performance.now()` of the last voiced mic frame. */
  lastVoiceAt = 0;
  micLevel = 0;

  private stream: MediaStream | null = null;
  private micContext: AudioContext | null = null;
  private playContext: AudioContext | null = null;
  private player: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private readonly levelBuffer = new Float32Array(512);

  constructor(private readonly events: AudioEngineEvents) {}

  /** Must be called from a user gesture (click) so audio is allowed to start. */
  async start(outputSampleRate: number): Promise<void> {
    // Create both contexts synchronously inside the gesture.
    this.playContext = new AudioContext({ sampleRate: outputSampleRate, latencyHint: 'interactive' });
    this.micContext = new AudioContext({ latencyHint: 'interactive' });

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });

    await Promise.all([
      this.micContext.audioWorklet.addModule('/capture-worklet.js'),
      this.playContext.audioWorklet.addModule('/player-worklet.js'),
    ]);

    const capture = new AudioWorkletNode(this.micContext, 'capture');
    capture.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
      const { pcm, rms } = event.data;
      this.micLevel = rms;
      if (rms >= VOICE_RMS) this.lastVoiceAt = performance.now();
      this.events.onMicFrame(pcm);
    };
    // The capture node outputs silence; connecting it keeps the graph pulling audio.
    this.micContext.createMediaStreamSource(this.stream).connect(capture).connect(this.micContext.destination);

    this.player = new AudioWorkletNode(this.playContext, 'player', { outputChannelCount: [1] });
    this.player.port.onmessage = (event: MessageEvent<{ type: string; playing: boolean }>) => {
      if (event.data.type === 'playing') this.events.onPlaybackChange(event.data.playing);
    };
    this.analyser = this.playContext.createAnalyser();
    this.analyser.fftSize = this.levelBuffer.length;
    this.player.connect(this.analyser).connect(this.playContext.destination);

    await Promise.all([this.micContext.resume(), this.playContext.resume()]);
  }

  /** Queue agent audio (PCM16 at the output sample rate). */
  play(pcm: ArrayBuffer): void {
    this.player?.port.postMessage({ type: 'audio', pcm }, [pcm]);
  }

  /** The server sent the last audio of this turn: play out whatever is buffered. */
  endOfTurn(): void {
    this.player?.port.postMessage({ type: 'end' });
  }

  /** Barge-in: silence the agent immediately. */
  flush(): void {
    this.player?.port.postMessage({ type: 'flush' });
  }

  /** Current agent output level, 0–1. */
  agentLevel(): number {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.levelBuffer);
    let sum = 0;
    for (const sample of this.levelBuffer) sum += sample * sample;
    return Math.sqrt(sum / this.levelBuffer.length);
  }

  async stop(): Promise<void> {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.player = null;
    this.analyser = null;
    this.micLevel = 0;
    await Promise.allSettled([this.micContext?.close(), this.playContext?.close()]);
    this.micContext = null;
    this.playContext = null;
  }
}
