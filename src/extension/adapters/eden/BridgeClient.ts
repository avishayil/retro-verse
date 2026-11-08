import { EventEmitter } from 'node:events';
import { readLines, run } from '../../util/proc';
import type { StreamTelemetry } from '../../../protocol/types';
import { ProcessSupervisor, type ExitInfo } from './ProcessSupervisor';

/** Messages the bridge writes to stdout, one JSON object per line. */
export type BridgeEvent =
  | { type: 'hello'; version: string; protocol: number }
  | { type: 'permissions'; screen: boolean; accessibility: boolean }
  | { type: 'waiting'; reason: string }
  | { type: 'window'; width: number; height: number; title?: string }
  | { type: 'ready'; port: number }
  | { type: 'client'; connected: boolean }
  | { type: 'telemetry'; data: StreamTelemetry }
  | { type: 'error'; code: string; message: string; fatal?: boolean }
  | { type: 'log'; message: string }
  | { type: 'placement'; result: 'moved' | 'clear' | 'refocused' | 'noFreeDisplay' | 'noAccessibility' | 'failed'; x?: number; y?: number; reason?: string }
  | { type: 'covered'; covered: boolean };

export type BridgeCommand =
  | { type: 'releaseAll' }
  | { type: 'pause'; paused: boolean }
  | { type: 'keymap'; map: Record<string, string> }
  | { type: 'stop' };

export interface BridgeOptions {
  pid: number;
  token: string;
  fps: number;
  height: number;
  bitrateKbps: number;
  keymap: Record<string, string>;
  /** Emulator hotkey that toggles turbo, bridge syntax ("cmd+Z"). */
  turboHotkey?: string;
  /** VS Code processes: the emulator window is parked on a display without their windows. */
  avoidPids?: number[];
  /** Move the emulator window at all (default true). */
  place?: boolean;
}

const KNOWN = new Set(['hello', 'permissions', 'waiting', 'window', 'ready', 'client', 'telemetry', 'error', 'log', 'placement', 'covered']);

export function parseBridgeLine(line: string): BridgeEvent | undefined {
  try {
    const m = JSON.parse(line) as { type?: unknown };
    if (typeof m !== 'object' || m === null || typeof m.type !== 'string' || !KNOWN.has(m.type)) return undefined;
    if (m.type === 'ready') {
      const port = (m as { port?: unknown }).port;
      if (!Number.isInteger(port) || (port as number) < 1024 || (port as number) > 65535) return undefined;
    }
    return m as BridgeEvent;
  } catch {
    return undefined;
  }
}

export function bridgeArgs(o: BridgeOptions): string[] {
  return [
    '--pid', String(o.pid), '--fps', String(o.fps), '--height', String(o.height), '--bitrate', String(o.bitrateKbps), '--keymap', JSON.stringify(o.keymap),
    ...(o.turboHotkey ? ['--turbo-hotkey', o.turboHotkey] : []),
    ...(o.avoidPids ?? []).flatMap((p) => ['--avoid-pid', String(p)]),
    ...(o.place === false ? ['--no-place'] : []),
  ];
}

/** Spawns and talks to the native capture/encode/input agent (native/eden-bridge). */
export class BridgeClient extends EventEmitter {
  private readonly proc: ProcessSupervisor;

  constructor(
    readonly executable: string,
    opts: BridgeOptions,
  ) {
    super();
    // The token travels via the environment, not argv, so it is not visible in `ps`.
    this.proc = new ProcessSupervisor(executable, bridgeArgs(opts), { env: { ...process.env, RETROVERSE_BRIDGE_TOKEN: opts.token } });
    this.proc.on('exit', (info: ExitInfo) => this.emit('exit', info));
    this.proc.on('stderr', (line: string) => this.emit('event', { type: 'log', message: line } satisfies BridgeEvent));
  }

  async start(): Promise<void> {
    await this.proc.start();
    readLines(this.proc.stdout!, (line) => {
      const ev = parseBridgeLine(line);
      if (ev) this.emit('event', ev);
    });
  }

  send(cmd: BridgeCommand): void {
    const stdin = this.proc.stdin;
    if (stdin && !stdin.destroyed) stdin.write(JSON.stringify(cmd) + '\n');
  }

  get running(): boolean {
    return this.proc.running;
  }

  async stop(): Promise<void> {
    this.send({ type: 'stop' });
    await this.proc.stop(1500);
  }

  override on(event: 'event', l: (e: BridgeEvent) => void): this;
  override on(event: 'exit', l: (e: ExitInfo) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override on(event: string, l: (...a: any[]) => void): this {
    return super.on(event, l);
  }
}

export interface WindowInfo {
  pid: number;
  app: string;
  title: string;
  width: number;
  height: number;
}

export async function listWindows(executable: string): Promise<WindowInfo[]> {
  const r = await run(executable, ['--list-windows'], { timeoutMs: 8000 });
  if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
  const arr = JSON.parse(r.stdout) as WindowInfo[];
  return Array.isArray(arr) ? arr.filter((w) => Number.isInteger(w.pid)) : [];
}
