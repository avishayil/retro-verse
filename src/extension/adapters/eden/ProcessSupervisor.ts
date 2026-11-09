import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readLines } from '../../util/proc';

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string[];
  expected: boolean;
}

/**
 * Supervises one native child process: no shell, bounded stderr capture, graceful stop
 * (SIGTERM, then SIGKILL after a grace period), and pause/resume via SIGSTOP/SIGCONT on POSIX.
 */
export class ProcessSupervisor extends EventEmitter {
  private child: ChildProcess | undefined;
  private readonly tail: string[] = [];
  private stopping = false;
  private exited: Promise<ExitInfo> | undefined;

  constructor(
    readonly executable: string,
    readonly args: readonly string[],
    private readonly options: Omit<SpawnOptions, 'shell'> = {},
    private readonly tailLines = 40,
  ) {
    super();
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get running(): boolean {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null;
  }

  get stdin() {
    return this.child?.stdin ?? undefined;
  }

  get stdout() {
    return this.child?.stdout ?? undefined;
  }

  start(): Promise<number> {
    if (this.child) throw new Error('already started');
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, [...this.args], { stdio: ['pipe', 'pipe', 'pipe'], ...this.options, shell: false, windowsHide: true });
      this.child = child;
      if (child.stderr) {
        readLines(child.stderr, (line) => {
          if (!line.trim()) return;
          this.tail.push(line.slice(0, 500));
          if (this.tail.length > this.tailLines) this.tail.shift();
          this.emit('stderr', line);
        });
      }
      this.exited = new Promise((res) => {
        child.once('exit', (code, signal) => {
          const info: ExitInfo = { code, signal, stderrTail: [...this.tail], expected: this.stopping };
          this.emit('exit', info);
          res(info);
        });
      });
      child.once('error', (err) => {
        if (!child.pid) reject(err);
        else this.emit('error', err);
      });
      child.once('spawn', () => resolve(child.pid!));
    });
  }

  signal(sig: NodeJS.Signals): boolean {
    if (!this.running) return false;
    try {
      return this.child!.kill(sig);
    } catch {
      return false;
    }
  }

  pause(): boolean {
    return process.platform !== 'win32' && this.signal('SIGSTOP');
  }

  resume(): boolean {
    return process.platform !== 'win32' && this.signal('SIGCONT');
  }

  async stop(graceMs = 3000): Promise<ExitInfo | undefined> {
    if (!this.child || !this.exited) return undefined;
    this.stopping = true;
    if (!this.running) return this.exited;
    this.resume(); // a stopped process cannot handle SIGTERM
    this.signal('SIGTERM');
    const timer = setTimeout(() => this.signal('SIGKILL'), graceMs);
    try {
      return await this.exited;
    } finally {
      clearTimeout(timer);
    }
  }
}
