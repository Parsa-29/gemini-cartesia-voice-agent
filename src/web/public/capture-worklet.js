// Microphone → 16 kHz mono PCM16 frames for Gemini Live.
//
// Runs at the device sample rate (usually 48 kHz). A windowed-sinc low-pass
// removes everything above ~7 kHz before resampling, so speech doesn't alias;
// samples are then linearly interpolated at 16 kHz and posted in 20 ms frames
// together with their RMS level.

const TARGET_RATE = 16000;
const FRAME_SAMPLES = 320; // 20 ms at 16 kHz
const FILTER_TAPS = 63;

function lowPass(rate, cutoff, taps) {
  const coefficients = new Float32Array(taps);
  const m = taps - 1;
  const fc = cutoff / rate;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const n = i - m / 2;
    const sinc = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
    const blackman = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / m) + 0.08 * Math.cos((4 * Math.PI * i) / m);
    coefficients[i] = sinc * blackman;
    sum += coefficients[i];
  }
  for (let i = 0; i < taps; i++) coefficients[i] /= sum;
  return coefficients;
}

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / TARGET_RATE; // input samples per output sample
    this.taps = this.step > 1 ? lowPass(sampleRate, TARGET_RATE * 0.45, FILTER_TAPS) : new Float32Array([1]);
    this.history = new Float32Array(this.taps.length);
    this.cursor = 0;
    this.previous = 0;
    // Position of the next output sample, in input samples after `previous`.
    this.phase = 1;
    this.frame = new Int16Array(FRAME_SAMPLES);
    this.filled = 0;
    this.energy = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      const current = this.filter(channel[i]);
      while (this.phase <= 1) {
        this.emit(this.previous + (current - this.previous) * this.phase);
        this.phase += this.step;
      }
      this.phase -= 1;
      this.previous = current;
    }
    return true;
  }

  filter(sample) {
    const { history, taps } = this;
    history[this.cursor] = sample;
    this.cursor = (this.cursor + 1) % history.length;
    let sum = 0;
    for (let k = 0, j = this.cursor; k < taps.length; k++, j = j + 1 === history.length ? 0 : j + 1) {
      sum += taps[k] * history[j];
    }
    return sum;
  }

  emit(sample) {
    const s = sample > 1 ? 1 : sample < -1 ? -1 : sample;
    this.energy += s * s;
    this.frame[this.filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    if (this.filled === FRAME_SAMPLES) {
      const rms = Math.sqrt(this.energy / FRAME_SAMPLES);
      this.port.postMessage({ pcm: this.frame.buffer, rms }, [this.frame.buffer]);
      this.frame = new Int16Array(FRAME_SAMPLES);
      this.filled = 0;
      this.energy = 0;
    }
  }
}

registerProcessor('capture', CaptureProcessor);
