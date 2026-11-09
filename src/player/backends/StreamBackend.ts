import { decodeFrame, encodeFrame, encodeInput, WireType } from '../../protocol/bridgeWire';
import { maskFromButtons, type StreamTelemetry } from '../../protocol/types';
import type { InputSnapshot } from '../input/InputManager';
import { H264Decoder } from '../media/H264Decoder';
import { PcmPlayer } from '../media/PcmPlayer';
import { InertBackend, type BackendHooks } from './Backend';

interface StreamConfig {
  codec: string;
  width: number;
  height: number;
  description: string; // base64 avcC
  sampleRate?: number;
  channels?: number;
}

function b64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Plays the bridge's H.264 + PCM stream and sends controller snapshots back over the same socket. */
export class StreamBackend extends InertBackend {
  readonly kind = 'stream';
  private ws: WebSocket | undefined;
  private canvas: HTMLCanvasElement | undefined;
  private decoder: H264Decoder | undefined;
  private audio: PcmPlayer | undefined;
  private audioStarting = false;
  private disposed = false;
  private retries = 0;
  private seq = 0;
  private lastInput: InputSnapshot | undefined;
  private timers: number[] = [];
  private remote: StreamTelemetry = { fps: 0 };
  private rttMs = 0;
  private lastDecoded = 0;
  private status: HTMLElement | undefined;
  private turbo = false;
  override readonly supportsTurbo = true;

  constructor(
    private readonly init: { wsUrl: string; token: string; workletUrl: string },
    private readonly hooks: BackendHooks,
    private volume: number,
  ) {
    super();
  }

  async mount(stage: HTMLElement): Promise<void> {
    if (!H264Decoder.supported()) throw new Error('This VS Code build lacks WebCodecs; use external mode (retroverse.switch.streamMode).');
    const canvas = document.createElement('canvas');
    canvas.className = 'screen';
    canvas.dataset.aspect = '16/9';
    canvas.width = 1280;
    canvas.height = 720;
    stage.appendChild(canvas);
    this.canvas = canvas;
    this.status = document.createElement('div');
    this.status.className = 'stream-status';
    this.status.textContent = 'Connecting to stream…';
    stage.appendChild(this.status);
    this.decoder = new H264Decoder(canvas);
    this.connect();
    // Re-send the controller snapshot periodically so a dropped packet can never leave a key held.
    this.timers.push(window.setInterval(() => this.sendInput(), 250));
    this.timers.push(window.setInterval(() => this.ping(), 1000));
    this.timers.push(window.setInterval(() => this.reportStats(), 1000));
    this.hooks.onStatus('running');
  }

  private connect(): void {
    if (this.disposed) return;
    const ws = new WebSocket(this.init.wsUrl);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.retries = 0;
      ws.send(encodeFrame(WireType.Hello, 0, new TextEncoder().encode(this.init.token)));
      this.sendInput();
      this.sendTurbo(); // resync after reconnects
    };
    ws.onmessage = (e) => this.onMessage(e.data as ArrayBuffer);
    ws.onclose = () => {
      if (this.disposed) return;
      this.setStatusText('Stream disconnected — reconnecting…');
      const delay = Math.min(5000, 250 * 2 ** this.retries++);
      window.setTimeout(() => this.connect(), delay);
    };
  }

  private setStatusText(t: string | undefined): void {
    if (!this.status) return;
    this.status.textContent = t ?? '';
    this.status.hidden = !t;
  }

  private onMessage(buf: ArrayBuffer): void {
    const f = decodeFrame(buf);
    if (!f) return;
    switch (f.type) {
      case WireType.Config: {
        const cfg = JSON.parse(new TextDecoder().decode(f.payload)) as StreamConfig;
        void this.decoder?.configure(cfg.codec, b64(cfg.description), cfg.width, cfg.height);
        if (this.canvas) this.canvas.dataset.aspect = `${cfg.width}/${cfg.height}`;
        if (cfg.sampleRate && cfg.channels && !this.audio && !this.audioStarting) void this.startAudio(cfg.sampleRate, cfg.channels);
        this.setStatusText(undefined);
        break;
      }
      case WireType.Video:
        this.decoder?.decode(f.payload.subarray(1), (f.payload[0] & 1) === 1, f.ts);
        break;
      case WireType.Audio:
        if (this.audio) {
          const copy = new Float32Array(f.payload.byteLength / 4);
          new Uint8Array(copy.buffer).set(f.payload.subarray(0, copy.length * 4));
          this.audio.push(copy);
        }
        break;
      case WireType.Telemetry:
        this.remote = JSON.parse(new TextDecoder().decode(f.payload)) as StreamTelemetry;
        break;
      case WireType.Pong:
        this.rttMs = performance.now() - f.ts / 1000;
        break;
      case WireType.Error:
        this.setStatusText(new TextDecoder().decode(f.payload));
        break;
    }
  }

  private async startAudio(sampleRate: number, channels: number): Promise<void> {
    this.audioStarting = true;
    const player = new PcmPlayer(this.init.workletUrl, sampleRate, channels);
    try {
      const ctx = await player.start(this.volume);
      this.audio = player;
      if (ctx.state !== 'running') this.hooks.needsGesture(async () => void (await ctx.resume()));
    } catch (e) {
      this.hooks.toast('warn', `Audio unavailable: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.audioStarting = false;
    }
  }

  override setInput(s: InputSnapshot): void {
    this.lastInput = s;
    this.sendInput();
  }

  private sendInput(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const s = this.lastInput;
    const payload = encodeInput(++this.seq, s ? maskFromButtons(s.buttons) : 0, s?.axes ?? { lx: 0, ly: 0, rx: 0, ry: 0 });
    ws.send(encodeFrame(WireType.Input, performance.now() * 1000, payload));
  }

  private ping(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeFrame(WireType.Ping, performance.now() * 1000, new Uint8Array(0)));
  }

  private reportStats(): void {
    const d = this.decoder;
    if (!d) return;
    const fps = d.decoded - this.lastDecoded;
    this.lastDecoded = d.decoded;
    this.hooks.onStats({
      ...this.remote,
      fps,
      decodeMs: Math.round(d.lastDecodeMs * 10) / 10,
      droppedFrames: d.dropped,
      // Estimate: one-way network ≈ RTT/2 + capture + encode + decode (glass-to-glass needs an external probe).
      latencyMs: Math.round(this.rttMs / 2 + (this.remote.captureMs ?? 0) + (this.remote.encodeMs ?? 0) + d.lastDecodeMs),
    });
  }

  /** Speed comes from the emulator's own turbo setting (Eden: turbo_speed_limit); we only switch it on/off. */
  override setTurbo(on: boolean): void {
    this.turbo = on;
    this.sendTurbo();
  }

  private sendTurbo(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeFrame(WireType.Turbo, performance.now() * 1000, new Uint8Array([this.turbo ? 1 : 0])));
  }

  override setVolume(percent: number): void {
    this.volume = percent;
    this.audio?.setVolume(percent);
  }

  override async dispose(): Promise<void> {
    this.disposed = true;
    for (const t of this.timers) window.clearInterval(t);
    this.lastInput = undefined;
    this.sendInput(); // release everything before closing
    this.ws?.close();
    this.decoder?.close();
    await this.audio?.close();
    this.canvas?.remove();
    this.status?.remove();
  }
}
