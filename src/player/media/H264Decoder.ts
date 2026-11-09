/** WebCodecs H.264 (AVCC) decoder that paints the newest frame to a canvas and drops stale ones. */
export class H264Decoder {
  private decoder: VideoDecoder | undefined;
  private waitingForKey = true;
  private readonly ctx: CanvasRenderingContext2D;
  private pendingFrame: VideoFrame | undefined;
  private raf = 0;
  decoded = 0;
  dropped = 0;
  lastDecodeMs = 0;
  private submitted = new Map<number, number>();
  /** Chunks received while configure() is still resolving; flushed once configured so the first keyframe is not lost. */
  private queued: { data: Uint8Array; key: boolean; ts: number }[] | undefined;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })!;
  }

  static supported(): boolean {
    return typeof VideoDecoder !== 'undefined';
  }

  async configure(codec: string, description: Uint8Array, width: number, height: number): Promise<void> {
    this.queued = [];
    try {
      this.decoder?.close();
    } catch {
      /* already closed */
    }
    this.decoder = undefined;
    const config: VideoDecoderConfig = { codec, description, codedWidth: width, codedHeight: height, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' };
    const support = await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
    if (!support.supported) {
      config.hardwareAcceleration = 'no-preference';
    }
    this.decoder = new VideoDecoder({
      output: (frame) => this.onFrame(frame),
      error: (e) => {
        console.warn('decoder error', e);
        this.waitingForKey = true;
      },
    });
    this.decoder.configure(config);
    this.canvas.width = width;
    this.canvas.height = height;
    this.waitingForKey = true;
    const pending = this.queued ?? [];
    this.queued = undefined;
    for (const c of pending) this.decode(c.data, c.key, c.ts);
  }

  decode(data: Uint8Array, key: boolean, tsMicros: number): void {
    if (this.queued) {
      if (this.queued.length < 120) this.queued.push({ data: data.slice(), key, ts: tsMicros });
      return;
    }
    const d = this.decoder;
    if (!d || d.state !== 'configured') return;
    if (this.waitingForKey && !key) {
      this.dropped++;
      return;
    }
    // Keep the decode queue shallow: if we fall behind, skip to the next keyframe.
    if (!key && d.decodeQueueSize > 3) {
      this.dropped++;
      this.waitingForKey = true;
      return;
    }
    this.waitingForKey = false;
    this.submitted.set(tsMicros, performance.now());
    if (this.submitted.size > 60) this.submitted.delete(this.submitted.keys().next().value!);
    d.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: tsMicros, data }));
  }

  private onFrame(frame: VideoFrame): void {
    const t0 = this.submitted.get(frame.timestamp);
    if (t0 !== undefined) {
      this.lastDecodeMs = performance.now() - t0;
      this.submitted.delete(frame.timestamp);
    }
    this.decoded++;
    if (this.pendingFrame) {
      this.pendingFrame.close();
      this.dropped++;
    }
    this.pendingFrame = frame;
    if (!this.raf) this.raf = requestAnimationFrame(() => this.paint());
  }

  private paint(): void {
    this.raf = 0;
    const f = this.pendingFrame;
    if (!f) return;
    this.pendingFrame = undefined;
    if (this.canvas.width !== f.displayWidth || this.canvas.height !== f.displayHeight) {
      this.canvas.width = f.displayWidth;
      this.canvas.height = f.displayHeight;
    }
    this.ctx.drawImage(f, 0, 0);
    f.close();
  }

  close(): void {
    cancelAnimationFrame(this.raf);
    this.pendingFrame?.close();
    try {
      this.decoder?.close();
    } catch {
      /* already closed */
    }
  }
}
