import { EventEmitter } from 'node:events';
import net from 'node:net';
import { run } from '../../util/proc';

/** PIDs listening on a local TCP port (lsof; macOS/Linux). */
export async function listeningPids(port: number): Promise<number[]> {
  const r = await run('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { timeoutMs: 3000 });
  return r.stdout.split('\n').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
}

/** GDB Remote Serial Protocol framing: $<data>#<checksum>. */
export function rspPacket(data: string): string {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum = (sum + data.charCodeAt(i)) & 0xff;
  return `$${data}#${sum.toString(16).padStart(2, '0')}`;
}

/** Extracts complete packets from a receive buffer; returns the packets and the unconsumed remainder. */
export function rspParse(buffer: string): { packets: string[]; rest: string } {
  const packets: string[] = [];
  let rest = buffer;
  for (;;) {
    rest = rest.replace(/^[+-]+/, ''); // acks
    if (rest.startsWith('%')) {
      // async notification: %<data>#xx — ignore
      const end = rest.indexOf('#');
      if (end < 0 || rest.length < end + 3) break;
      rest = rest.slice(end + 3);
      continue;
    }
    const m = /^\$([^#]*)#[0-9a-fA-F]{2}/.exec(rest);
    if (!m) {
      const start = rest.indexOf('$');
      rest = start > 0 ? rest.slice(start) : rest; // drop garbage before the next packet
      if (start > 0) continue;
      break;
    }
    packets.push(m[1]);
    rest = rest.slice(m[0].length);
  }
  return { packets, rest };
}

export interface PumpOptions {
  port: number;
  /**
   * PID of the Eden process this pump belongs to. When set, the pump only connects once *that* process is
   * listening on the port (another Eden may still hold it, e.g. one shutting down after a window reload),
   * and reconnects if the connection drops while the guest's Eden is still alive.
   */
  pid?: number;
  /** Injectable for tests; defaults to lsof. */
  ownerOf?: (port: number) => Promise<number[]>;
  host?: string;
  /** How long to keep retrying the connection while Eden boots. */
  connectTimeoutMs?: number;
  retryMs?: number;
}

/**
 * Keeps an Eden guest running when Eden's GDB stub is enabled. With the stub on, Eden suspends the guest at
 * boot ("Launching…") until a debugger continues it; this client connects, continues, and then *pumps*:
 * every later stop (breakpoint, exception, interrupt) is answered with another continue.
 *
 * Order matters: Eden opens the stub port *before* it creates and suspends the guest, so a continue sent
 * too early is lost and the game then sits on "Launching…" forever. The pump therefore polls the thread list
 * until the guest's main thread exists (`qfThreadInfo` → `m<id>`), asks for the stop reason (`?`) and only then
 * continues (`c`).
 *
 * Events: 'connected', 'ready' (guest suspended, first thread id), 'continued' (count), 'stop' (reply packet),
 * 'exit' (guest exited), 'closed', 'conflict' (pids holding the port instead of ours), 'socketError' (transient,
 * followed by 'closed'), 'error' (gave up connecting; only emitted when someone listens).
 */
export class GdbStubPump extends EventEmitter {
  private sock: net.Socket | undefined;
  private buf = '';
  private stage: 'handshake' | 'waitThreads' | 'query' | 'running' | 'probing' = 'handshake';
  private pollTimer: NodeJS.Timeout | undefined;
  private probe: { resolve: (n: number) => void; reject: (e: Error) => void; step: 'stop' | 'threads'; timer: NodeJS.Timeout } | undefined;
  private stopped = false;
  private retryTimer: NodeJS.Timeout | undefined;
  continues = 0;

  constructor(private readonly opts: PumpOptions) {
    super();
  }

  private conflictReported = false;

  start(): void {
    const deadline = Date.now() + (this.opts.connectTimeoutMs ?? 120_000);
    const retry = () => {
      if (this.stopped) return;
      if (Date.now() < deadline) this.retryTimer = setTimeout(attempt, this.opts.retryMs ?? 250);
      else this.fail(new Error(`GDB stub on port ${this.opts.port} did not become available for pid ${this.opts.pid ?? '?'}`));
    };
    const attempt = async () => {
      if (this.stopped) return;
      if (this.opts.pid) {
        const owners = await (this.opts.ownerOf ?? listeningPids)(this.opts.port);
        if (this.stopped) return;
        if (!owners.includes(this.opts.pid)) {
          const others = owners.filter((p) => p !== this.opts.pid);
          if (others.length && !this.conflictReported) {
            this.conflictReported = true;
            this.emit('conflict', others);
          }
          return retry();
        }
      }
      const s = net.connect({ port: this.opts.port, host: this.opts.host ?? '127.0.0.1' });
      s.setNoDelay(true);
      s.once('connect', () => {
        this.sock = s;
        this.emit('connected');
        this.send('qSupported:multiprocess+;swbreak+;hwbreak+;vContSupported+');
      });
      s.on('data', (d) => this.onData(d.toString('latin1')));
      // `on`, not `once`: a socket can error more than once (e.g. ECONNRESET after a failed write), and an
      // unhandled 'error' would crash the extension host.
      let connectFailed = false;
      s.on('error', (e: NodeJS.ErrnoException) => {
        // Errors on an established connection are followed by 'close', which handles reconnecting.
        if (this.sock === s) return void this.emit('socketError', e);
        if (connectFailed) return;
        connectFailed = true;
        s.destroy();
        if (Date.now() < deadline && !this.stopped) this.retryTimer = setTimeout(attempt, this.opts.retryMs ?? 250);
        else if (!this.stopped) this.fail(new Error(`GDB stub on port ${this.opts.port} did not accept a connection (${e.code ?? e.message})`));
      });
      s.once('close', () => {
        if (this.sock === s) {
          this.sock = undefined;
          this.buf = '';
          this.stage = 'handshake';
          this.emit('closed');
          // Our Eden may still be alive (e.g. a foreign client was swapped in): reattach so it never stays parked.
          if (!this.stopped && this.opts.pid && isAlive(this.opts.pid)) this.retryTimer = setTimeout(attempt, this.opts.retryMs ?? 250);
        }
      });
    };
    void attempt();
  }

  /** Report a terminal failure. Never throws, even when nobody listens for 'error'. */
  private fail(e: Error): void {
    if (this.listenerCount('error') > 0) this.emit('error', e);
  }

  private send(data: string): void {
    this.sock?.write(rspPacket(data));
  }

  private onData(chunk: string): void {
    const { packets, rest } = rspParse(this.buf + chunk);
    this.buf = rest.slice(-65536);
    for (const p of packets) {
      this.sock?.write('+');
      this.onPacket(p);
    }
  }

  private continueGuest(): void {
    this.continues++;
    this.send('c');
    this.emit('continued', this.continues);
  }

  private onPacket(p: string): void {
    switch (this.stage) {
      case 'handshake':
        // qSupported answered; wait for the guest process to exist and be suspended.
        this.stage = 'waitThreads';
        this.pollThreads();
        return;
      case 'waitThreads':
        if (/^m[0-9a-fA-F]/.test(p)) {
          clearTimeout(this.pollTimer);
          this.emit('ready', p.slice(1).split(',')[0]);
          this.stage = 'query';
          this.send('?');
        } else {
          this.pollTimer = setTimeout(() => this.pollThreads(), this.opts.retryMs ?? 250);
        }
        return;
      case 'query':
        if (/^[ST]/.test(p)) {
          this.stage = 'running';
          this.continueGuest();
        } else if (/^[WX]/.test(p)) this.emit('exit', p);
        return;
      case 'probing':
        this.onProbePacket(p);
        return;
      case 'running':
        if (/^[WX]/.test(p)) return void this.emit('exit', p);
        if (/^[ST]/.test(p)) {
          // The guest stopped (breakpoint/exception/interrupt): keep it going.
          this.emit('stop', p);
          this.continueGuest();
        }
    }
  }

  private pollThreads(): void {
    if (this.stopped || this.stage !== 'waitThreads') return;
    this.send('qfThreadInfo');
  }

  /**
   * Diagnostics: briefly interrupt the guest, count its threads, and continue. A running game has many
   * threads; a guest still parked at boot has one.
   */
  probeThreads(timeoutMs = 3000): Promise<number> {
    if (this.stage !== 'running' || !this.sock) return Promise.reject(new Error('guest is not running under the pump'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.probe = undefined;
        this.stage = 'running';
        reject(new Error('probe timed out'));
      }, timeoutMs);
      this.probe = { resolve, reject, step: 'stop', timer };
      this.stage = 'probing';
      this.sock!.write('\x03'); // interrupt
    });
  }

  private onProbePacket(p: string): void {
    const pr = this.probe;
    if (!pr) return;
    if (pr.step === 'stop' && /^[ST]/.test(p)) {
      pr.step = 'threads';
      this.send('qfThreadInfo');
      return;
    }
    if (pr.step === 'threads' && /^[ml]/.test(p)) {
      clearTimeout(pr.timer);
      this.probe = undefined;
      this.stage = 'running';
      this.continueGuest();
      pr.resolve(p === 'l' ? 0 : p.slice(1).split(',').length);
    }
  }

  get connected(): boolean {
    return !!this.sock;
  }

  /** Detach (guest keeps running) and close. Safe to call repeatedly. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.pollTimer);
    const s = this.sock;
    this.sock = undefined;
    if (!s) return;
    try {
      s.write(rspPacket('D'));
    } catch {
      /* closing anyway */
    }
    s.end();
    setTimeout(() => s.destroy(), 500).unref();
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
