// Agent voice playback: a queue of PCM16 chunks played gaplessly.
//
// Messages in:  { type: 'audio', pcm: ArrayBuffer }  PCM16 mono at the context rate
//               { type: 'end' }    the server sent the last chunk of this turn
//               { type: 'flush' }  barge-in: drop everything queued, now
// Messages out: { type: 'playing', playing: boolean }
//
// A short pre-buffer at the start of each burst absorbs network jitter. If the
// queue runs dry mid-turn the player keeps "playing" (silence) for a while,
// so the server keeps treating the agent as audible.

const PREBUFFER_MS = 40;
const STALL_MS = 1500;

class PlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.offset = 0;
    this.buffered = 0;
    this.playing = false;
    this.ended = true;
    this.starved = 0;
    this.prebuffer = Math.round((sampleRate * PREBUFFER_MS) / 1000);
    this.stallLimit = Math.round((sampleRate * STALL_MS) / 1000);
    this.port.onmessage = (event) => this.receive(event.data);
  }

  receive(message) {
    if (message.type === 'audio') {
      const pcm = new Int16Array(message.pcm);
      const samples = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768;
      this.chunks.push(samples);
      this.buffered += samples.length;
      this.ended = false;
    } else if (message.type === 'end') {
      this.ended = true;
    } else if (message.type === 'flush') {
      this.chunks = [];
      this.offset = 0;
      this.buffered = 0;
      this.ended = true;
      this.setPlaying(false);
    }
  }

  setPlaying(playing) {
    if (this.playing === playing) return;
    this.playing = playing;
    this.starved = 0;
    this.port.postMessage({ type: 'playing', playing });
  }

  process(_inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;

    if (!this.playing) {
      if (this.buffered > 0 && (this.buffered >= this.prebuffer || this.ended)) this.setPlaying(true);
      else return true; // output stays silent
    }

    let written = 0;
    while (written < out.length && this.chunks.length > 0) {
      const chunk = this.chunks[0];
      const count = Math.min(out.length - written, chunk.length - this.offset);
      out.set(chunk.subarray(this.offset, this.offset + count), written);
      written += count;
      this.offset += count;
      this.buffered -= count;
      if (this.offset >= chunk.length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }

    if (written < out.length) {
      if (this.ended) {
        this.setPlaying(false);
      } else {
        this.starved += out.length - written;
        if (this.starved > this.stallLimit) {
          this.ended = true;
          this.setPlaying(false);
        }
      }
    } else {
      this.starved = 0;
    }
    return true;
  }
}

registerProcessor('player', PlayerProcessor);
