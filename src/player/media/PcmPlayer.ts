export class PcmPlayer {
  private ctx: AudioContext | undefined;
  private node: AudioWorkletNode | undefined;
  private gain: GainNode | undefined;
  stats = { bufferedMs: 0, underruns: 0 };

  constructor(
    private readonly workletUrl: string,
    private readonly sampleRate: number,
    private readonly channels: number,
  ) {}

  async start(volume: number): Promise<AudioContext> {
    const ctx = new AudioContext({ sampleRate: this.sampleRate, latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(this.workletUrl);
    const node = new AudioWorkletNode(ctx, 'retroverse-pcm', { outputChannelCount: [Math.min(2, this.channels)] });
    node.port.postMessage({ channels: this.channels });
    node.port.onmessage = (e) => {
      this.stats = e.data;
      (globalThis as { __rvAudioStats?: unknown }).__rvAudioStats = e.data; // diagnostics / test harness
    };
    const gain = ctx.createGain();
    node.connect(gain).connect(ctx.destination);
    this.ctx = ctx;
    this.node = node;
    this.gain = gain;
    this.setVolume(volume);
    return ctx;
  }

  push(pcm: Float32Array): void {
    this.node?.port.postMessage({ pcm }, [pcm.buffer]);
  }

  setVolume(percent: number): void {
    if (this.gain) this.gain.gain.value = Math.max(0, Math.min(1, percent / 100));
  }

  reset(): void {
    this.node?.port.postMessage({ reset: true });
  }

  async close(): Promise<void> {
    await this.ctx?.close().catch(() => undefined);
    this.ctx = undefined;
  }
}
