// AudioWorklet: jitter-buffered playback of interleaved float32 PCM pushed over the port.
// Bundled separately (IIFE) and loaded with audioWorklet.addModule().

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, ctor: unknown): void;
declare const sampleRate: number;

class PcmProcessor extends AudioWorkletProcessor {
  private buf: Float32Array;
  private read = 0;
  private write = 0;
  private filled = 0;
  private channels = 2;
  private primed = false;
  private targetFrames: number;
  private maxFrames: number;
  private underruns = 0;
  private quanta = 0;

  constructor() {
    super();
    this.targetFrames = Math.round(sampleRate * 0.06);
    this.maxFrames = Math.round(sampleRate * 0.2);
    this.buf = new Float32Array(sampleRate * 2 * 2); // 1 s stereo ring
    this.port.onmessage = (e: MessageEvent) => {
      const d = e.data as { pcm?: Float32Array; channels?: number; reset?: boolean; targetMs?: number };
      if (d.reset) {
        this.read = this.write = this.filled = 0;
        this.primed = false;
      }
      if (d.channels) this.channels = d.channels;
      if (d.targetMs) this.targetFrames = Math.round((sampleRate * d.targetMs) / 1000);
      if (d.pcm) this.push(d.pcm);
    };
  }

  private push(pcm: Float32Array): void {
    const cap = this.buf.length;
    for (let i = 0; i < pcm.length; i++) {
      this.buf[this.write] = pcm[i];
      this.write = (this.write + 1) % cap;
    }
    this.filled += pcm.length;
    // Latency cap: drop the oldest audio rather than drifting behind the video.
    const maxSamples = this.maxFrames * this.channels;
    if (this.filled > maxSamples) {
      const drop = this.filled - this.targetFrames * this.channels;
      this.read = (this.read + drop) % cap;
      this.filled -= drop;
    }
    if (!this.primed && this.filled >= this.targetFrames * this.channels) this.primed = true;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    // AudioWorkletGlobalScope has no timers: report buffer stats roughly once per second of render quanta.
    if (++this.quanta % 375 === 0) this.port.postMessage({ bufferedMs: (this.filled / this.channels / sampleRate) * 1000, underruns: this.underruns });
    const out = outputs[0];
    const frames = out[0].length;
    const cap = this.buf.length;
    if (!this.primed || this.filled < frames * this.channels) {
      if (this.primed) this.underruns++;
      this.primed = false;
      for (const ch of out) ch.fill(0);
      return true;
    }
    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < out.length; c++) {
        out[c][f] = this.buf[(this.read + (c < this.channels ? c : 0)) % cap];
      }
      this.read = (this.read + this.channels) % cap;
    }
    this.filled -= frames * this.channels;
    return true;
  }
}

registerProcessor('retroverse-pcm', PcmProcessor);
