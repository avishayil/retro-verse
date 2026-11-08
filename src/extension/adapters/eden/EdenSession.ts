import * as vscode from 'vscode';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { InitPayload } from '../../../protocol/messages';
import { log, redact } from '../../diagnostics/Log';
import { validateRomPath } from '../../security/paths';
import type { CommandResult, LaunchContext, SessionCommand } from '../../sessions/Session';
import { cfg } from '../../settings';
import { buildEdenArgs, edenDataDir, locateEden, type EdenInstall } from './EdenLocator';
import { readEdenKeymap, readEdenTurboHotkey, readGdbStubConfig } from './EdenConfig';
import { edenEnvironment } from './edenEnv';
import { GdbStubPump } from './GdbStubPump';
import { ProcessSupervisor, type ExitInfo } from './ProcessSupervisor';
import { StreamSession } from './StreamSession';

export class EdenSession extends StreamSession {
  private eden: ProcessSupervisor | undefined;
  private install: EdenInstall | undefined;
  private gdb: GdbStubPump | undefined;

  constructor(
    ctx: LaunchContext,
    private readonly storageDir: string,
  ) {
    super(ctx);
  }

  async init(): Promise<InitPayload> {
    // A webview reload while Eden is running re-attaches to the current stream instead of relaunching.
    if (this.eden?.running) return { ...this.base(), backend: this.backend };

    if (!vscode.workspace.isTrusted) {
      return { ...this.base(), backend: { kind: 'setup', problem: 'untrusted', detail: 'Launching the native Eden emulator requires a trusted workspace.' } };
    }
    if (this.ctx.document.uri.scheme !== 'file' || vscode.env.uiKind === vscode.UIKind.Web) {
      return { ...this.base(), backend: { kind: 'setup', problem: 'remote', detail: 'Switch games need VS Code Desktop with the game on this machine.' } };
    }
    try {
      this.install = await locateEden(cfg().get<string>('switch.edenPath', ''));
    } catch (e) {
      return { ...this.base(), backend: { kind: 'setup', problem: 'eden-missing', detail: e instanceof Error ? e.message : String(e) } };
    }
    if (!this.install) {
      return { ...this.base(), backend: { kind: 'setup', problem: 'eden-missing', detail: 'Eden was not found. Install Eden (https://eden-emu.dev) or set retroverse.switch.edenPath. RetroVerse never downloads emulators, keys or firmware for you.' } };
    }

    this.setStatus('starting');
    try {
      await this.launch(this.install);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.error(`[${this.id}] failed to start Eden`, e);
      // If Eden did get spawned before the failure, don't leave it parked on "Launching…".
      await this.stop().catch(() => undefined);
      this.setStatus('error', message);
      return { ...this.base(), backend: { kind: 'error', message: `Failed to start Eden: ${message}` } };
    }
    return { ...this.base(), backend: this.backend };
  }

  private async launch(install: EdenInstall): Promise<void> {
    const rom = await validateRomPath(this.ctx.document.uri.fsPath, 'switch');
    let configPath: string | undefined;
    if (cfg().get('switch.isolatedConfig', false) && install.flavor === 'cli') {
      await mkdir(this.storageDir, { recursive: true });
      configPath = path.join(this.storageDir, 'eden-cli.ini');
    }
    const args = buildEdenArgs(install, rom.realPath, { configPath, extraArgs: cfg().get<string[]>('switch.extraArgs', []) });
    const { env, applied, rejected } = edenEnvironment(process.env, cfg().get<Record<string, unknown>>('switch.environment', {}));
    if (rejected.length) this.toast('warn', `Ignored unsafe or invalid environment variables for Eden: ${rejected.join(', ')}`);
    if (Object.keys(applied).length) log.info(`[${this.id}] Eden environment: ${Object.entries(applied).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    const eden = new ProcessSupervisor(install.executable, args, { stdio: ['ignore', 'ignore', 'pipe'], env });
    this.eden = eden;
    eden.on('exit', (info: ExitInfo) => void this.onEdenExit(eden, info));
    const pid = await eden.start();
    log.info(`[${this.id}] Eden (${install.flavor}${install.version ? ' ' + install.version : ''}) pid=${pid} rom=${redact(rom.realPath)}`);
    await this.startGdbPump(pid);

    const mode = cfg().get<'stream' | 'external'>('switch.streamMode', 'stream');
    if (mode === 'external') {
      this.publish({ kind: 'external', reason: 'Eden is running in its own window (external mode).' });
      this.setStatus('running');
      return;
    }
    this.publish({ kind: 'external', reason: 'Waiting for the Eden window…' });
    await this.startBridge(pid);
    // Eden runs regardless of whether streaming works.
    if (!this.bridge && this.status === 'starting') this.setStatus('running');
  }

  /**
   * With Eden's GDB stub enabled the guest is suspended at boot ("Launching…") until a debugger continues it.
   * In `pump` mode RetroVerse is that debugger: it continues the guest and keeps continuing on every stop.
   * In `leave` mode the stub is left for your own debugger (gdb/lldb: `target remote localhost:<port>`).
   */
  protected override async emulatorKeymap(): Promise<Record<string, string>> {
    const map = await readEdenKeymap();
    log.info(`[${this.id}] Eden keyboard bindings: ${Object.entries(map).map(([k, v]) => `${k}=${v}`).join(' ') || 'none found (using defaults)'}`);
    return map;
  }

  /** Eden's "Toggle Turbo Speed" shortcut (default Ctrl+Z, i.e. ⌘Z on macOS); turbo speed is Eden's turbo_speed_limit. */
  protected override async turboHotkey(): Promise<string | undefined> {
    const hk = await readEdenTurboHotkey();
    log.info(`[${this.id}] Eden turbo hotkey: ${hk ?? 'none configured'}`);
    return hk;
  }

  private async startGdbPump(pid: number): Promise<void> {
    const stub = await readGdbStubConfig();
    if (!stub.enabled) return;
    const mode = cfg().get<'pump' | 'leave'>('switch.gdbStub', 'pump');
    if (mode === 'leave') {
      log.info(`[${this.id}] Eden GDB stub enabled on port ${stub.port}; leaving it for an external debugger (retroverse.switch.gdbStub=leave)`);
      this.toast('info', `Eden's GDB stub is enabled: the game waits until a debugger connects to localhost:${stub.port} and continues.`);
      return;
    }
    log.info(`[${this.id}] Eden GDB stub enabled on port ${stub.port}; pumping it so the game runs`);
    const pump = new GdbStubPump({ port: stub.port, pid });
    pump.on('conflict', (pids: number[]) => {
      log.warn(`[${this.id}] GDB stub port ${stub.port} is held by pid ${pids.join(', ')}, not our Eden (${pid})`);
      this.toast('warn', `Another program (pid ${pids.join(', ')}) is using Eden's GDB stub port ${stub.port}. Usually that is another Eden window: close it, or this game stays on "Launching…".`);
    });
    this.gdb = pump;
    pump.on('connected', () => log.info(`[${this.id}] GDB stub connected`));
    pump.on('continued', (n: number) => (n === 1 ? log.info(`[${this.id}] GDB stub: guest continued`) : log.debug(`[${this.id}] GDB stub: continued after stop #${n - 1}`)));
    pump.on('stop', (p: string) => log.debug(`[${this.id}] GDB stub stop: ${p.slice(0, 60)}`));
    pump.on('error', (e: Error) => log.warn(`[${this.id}] GDB stub: ${e.message}`));
    pump.on('closed', () => log.info(`[${this.id}] GDB stub connection closed`));
    pump.start();
  }

  private stopGdbPump(): void {
    this.gdb?.stop();
    this.gdb = undefined;
  }

  private async onEdenExit(proc: ProcessSupervisor, info: ExitInfo): Promise<void> {
    if (this.eden !== proc) return;
    this.eden = undefined;
    this.stopGdbPump();
    await this.stopBridge();
    if (info.expected) return;
    const tail = info.stderrTail.slice(-6).join('\n');
    const message = info.code === 0 ? 'Eden exited.' : `Eden exited unexpectedly (code ${info.code ?? 'none'}${info.signal ? `, ${info.signal}` : ''}).`;
    log.warn(`[${this.id}] ${message}\n${tail}`);
    if (info.code === 0) this.setStatus('stopped');
    else this.setStatus('error', message);
    this.publish({ kind: 'error', message: tail ? `${message}\n\nLast output:\n${tail}` : message });
  }

  protected override onBridgeLost(): void {
    if (this.eden?.running) super.onBridgeLost();
  }

  async command(command: SessionCommand): Promise<CommandResult> {
    switch (command) {
      case 'pause':
        if (!this.eden?.pause()) return { ok: false, message: 'Pause is not available.' };
        this.bridge?.send({ type: 'pause', paused: true });
        this.setStatus('paused');
        return { ok: true };
      case 'resume':
        if (!this.eden?.resume()) return { ok: false, message: 'Resume is not available.' };
        this.bridge?.send({ type: 'pause', paused: false });
        this.setStatus('running');
        return { ok: true };
      case 'reset':
      case 'restart': {
        await this.stop();
        const init = await this.init();
        await this.ctx.channel.post({ v: 1, type: 'init', payload: init });
        return { ok: true };
      }
      case 'stop':
        await this.stop();
        this.publish({ kind: 'error', message: 'Eden was stopped. Use Restart to launch it again.' });
        return { ok: true };
      case 'openMods':
        return this.reveal(path.join(edenDataDir(), 'load'));
      case 'openSaves':
        return this.reveal(path.join(edenDataDir(), 'nand', 'user', 'save'));
      case 'quickSave':
      case 'quickLoad':
        return { ok: false, message: 'Save states are not supported for Switch. Use the in-game save.' };
      case 'screenshot':
        return { ok: false, message: 'Screenshots are not supported for Switch yet.' };
    }
  }

  private async reveal(dir: string): Promise<CommandResult> {
    // Opening a folder never modifies its contents; create only if missing so the OS can open it.
    await mkdir(dir, { recursive: true });
    await vscode.env.openExternal(vscode.Uri.file(dir));
    return { ok: true };
  }

  async stop(): Promise<void> {
    if (!this.eden && !this.bridge) return;
    this.setStatus('stopping');
    this.stopGdbPump();
    const eden = this.eden;
    this.eden = undefined;
    // In parallel and with a short grace: VS Code gives extensions only a few seconds to deactivate on reload,
    // and Eden does not act on SIGTERM, so a long sequential shutdown would orphan it.
    await Promise.all([this.stopBridge(), eden?.stop(1500)]);
    this.setStatus('stopped');
  }
}
