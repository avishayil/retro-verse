import * as vscode from 'vscode';
import { open } from 'node:fs/promises';
import path from 'node:path';
import type { BackendInit, InitPayload, PlayerToHost } from '../../../protocol/messages';
import type { Capabilities, Platform } from '../../../protocol/types';
import { log, redact } from '../../diagnostics/Log';
import { validateRomPath } from '../../security/paths';
import { BaseSession } from '../../sessions/BaseSession';
import type { CommandResult, LaunchContext, SessionCommand } from '../../sessions/Session';
import { playerSettings } from '../../settings';
import { romIdentity } from '../../storage/RomIdentity';
import { fingerprintOf, sameFingerprint, type SaveFingerprint } from '../../storage/SaveStore';

export const WASM_CAPABILITIES: Capabilities = {
  saveStates: true,
  batterySave: true,
  pause: true,
  reset: true,
  screenshots: true,
  mods: false,
  audio: true,
  gamepad: true,
};

export interface WasmCoreSpec {
  coreId: string;
  platform: Extract<Platform, 'gba' | 'nds'>;
  backend(webview: vscode.Webview, extensionUri: vscode.Uri, romSize: number, romName: string): BackendInit;
}

const QUICK_SLOT = 0;
/** ROM transfer chunk size: large enough to be fast, small enough not to stall the webview message queue. */
export const ROM_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * Host half of a webview-hosted emulator. The emulator itself runs in the webview; the host owns
 * persistence (battery saves, states, screenshots), ROM validation and lifecycle.
 */
export class WasmSession extends BaseSession {
  private romId = '';
  private realPath = '';
  private romSize = 0;
  private streaming = false;
  private watcher: vscode.FileSystemWatcher | undefined;
  private restartPrompted = false;
  private saveWatcher: vscode.FileSystemWatcher | undefined;
  /** What battery.sav held when the game loaded it, updated after each of our own writes. */
  private batteryFp: SaveFingerprint | undefined;
  /** Set once battery.sav changed under this session: further flushes go to this file instead. */
  private conflictPath: string | undefined;
  private lastSessionSave: Uint8Array | undefined;
  private savePrompted = false;
  /** Serialises persistence so a command that follows a save always observes the written file. */
  private persist: Promise<void> = Promise.resolve();

  constructor(
    ctx: LaunchContext,
    private readonly spec: WasmCoreSpec,
  ) {
    super(spec.platform, ctx, WASM_CAPABILITIES);
  }

  get gamePath(): string | undefined {
    return this.realPath || undefined;
  }

  async init(): Promise<InitPayload> {
    this.setStatus('starting');
    const base = { platform: this.platform, title: this.title, capabilities: this.caps, settings: playerSettings() };
    try {
      const rom = await validateRomPath(this.ctx.document.uri.fsPath, this.platform);
      this.realPath = rom.realPath;
      this.romSize = rom.size;
      this.romId = this.ctx.document.romId ?? (await romIdentity(rom.realPath, rom.size));
      this.ctx.document.romId = this.romId;
      this.watch();
      // The core only sees a sanitised synthetic name, never the user's path; the bytes arrive via rom.request.
      const romName = `game${this.ctx.document.format.extension}`;
      const backend = this.spec.backend(this.ctx.channel.webview, this.ctx.extensionUri, rom.size, romName);
      if (backend.kind === 'gba' || backend.kind === 'nds') {
        backend.battery = await this.ctx.saves.readBattery(this.romId, this.spec.coreId);
        this.batteryFp = backend.battery ? fingerprintOf(backend.battery) : undefined;
        this.conflictPath = undefined;
        this.lastSessionSave = undefined;
        this.watchSave();
        if (!this.ctx.retainContextWhenHidden) backend.resumeState = await this.ctx.saves.readState(this.romId, this.spec.coreId, 'suspend');
      }
      log.info(`[${this.id}] init ${this.spec.coreId} rom=${redact(rom.realPath)} size=${rom.size} battery=${backend.kind !== 'error' && 'battery' in backend && !!backend.battery}`);
      return { ...base, backend, suspendOnHide: !this.ctx.retainContextWhenHidden };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.error(`[${this.id}] failed to start`, e);
      this.setStatus('error', message);
      return { ...base, backend: { kind: 'error', message } };
    }
  }

  private watch(): void {
    if (this.watcher) return;
    const dir = vscode.Uri.file(path.dirname(this.realPath));
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, path.basename(this.realPath)));
    this.watcher.onDidChange(() => void this.onRomChanged());
  }

  private watchSave(): void {
    if (this.saveWatcher) return;
    const file = this.ctx.saves.batteryPath(this.romId, this.spec.coreId);
    this.saveWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file)));
    const changed = () => void this.onSaveChanged();
    this.saveWatcher.onDidChange(changed);
    this.saveWatcher.onDidCreate(changed);
  }

  /** battery.sav changed on disk. Our own writes match batteryFp and are ignored. */
  async onSaveChanged(): Promise<void> {
    await this.persist;
    if (this.conflictPath || this.savePrompted || !this.romId) return;
    const fp = await this.ctx.saves.batteryFingerprint(this.romId, this.spec.coreId);
    if (sameFingerprint(fp, this.batteryFp)) return;
    log.warn(`[${this.id}] battery save changed outside this session`);
    // A suspend state made from the old save would bring the old progress back on the next start.
    await this.ctx.saves.clearState(this.romId, this.spec.coreId, 'suspend');
    this.savePrompted = true;
    try {
      const pick = await vscode.window.showWarningMessage(
        `RetroVerse: the save for ${this.title} changed on disk. Restart the game with it? If you keep playing, RetroVerse will not overwrite it; your progress goes to a separate file.`,
        'Restart',
        'Keep Playing',
      );
      if (pick === 'Restart') await this.command('restart');
    } finally {
      this.savePrompted = false;
    }
  }

  private async onSaveConflict(conflictPath: string): Promise<void> {
    log.warn(`[${this.id}] battery save changed outside this session; session save kept in ${redact(conflictPath)}`);
    await this.ctx.saves.clearState(this.romId, this.spec.coreId, 'suspend');
    if (this.savePrompted) return;
    this.savePrompted = true;
    try {
      const pick = await vscode.window.showWarningMessage(
        `RetroVerse: the save for ${this.title} changed outside this session, so it was not overwritten. This session's progress was kept in a separate file.`,
        'Restart with the Newer Save',
        "Keep This Session's Save",
        'Reveal',
      );
      if (pick === 'Restart with the Newer Save') await this.command('restart');
      else if (pick === "Keep This Session's Save") await this.keepSessionSave();
      else if (pick === 'Reveal') void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(conflictPath));
    } finally {
      this.savePrompted = false;
    }
  }

  /** Replace battery.sav with this session's data, after backing up the version that replaced it. */
  async keepSessionSave(): Promise<void> {
    await this.enqueue(async () => {
      const data = this.lastSessionSave;
      if (!data) return;
      await this.ctx.saves.backupBattery(this.romId, this.spec.coreId, 'external');
      await this.ctx.saves.writeBattery(this.romId, this.spec.coreId, data);
      this.batteryFp = fingerprintOf(data);
      this.conflictPath = undefined;
      log.info(`[${this.id}] kept this session's save; the other version is in backups/`);
    });
  }

  private async onRomChanged(): Promise<void> {
    if (this.restartPrompted) return;
    this.restartPrompted = true;
    try {
      const pick = await vscode.window.showInformationMessage('RetroVerse: the game file changed on disk. Restart it? Your battery save is flushed first.', 'Restart', 'Ignore');
      if (pick === 'Restart') await this.command('restart');
    } finally {
      this.restartPrompted = false;
    }
  }

  private enqueue(write: () => Promise<void>): Promise<void> {
    this.persist = this.persist.then(write).catch((e) => log.error(`[${this.id}] save failed`, e));
    return this.persist;
  }

  /**
   * Stream the validated ROM to the player. Reads the canonical path captured at validation, re-checks that it is
   * still a regular file of the validated size, and never sends more than that many bytes.
   */
  private async streamRom(): Promise<void> {
    if (this.streaming || !this.realPath) return;
    this.streaming = true;
    const post = (payload: { offset: number; total: number; data: Uint8Array; done: boolean; error?: string }) =>
      this.ctx.channel.post({ v: 1, type: 'rom.chunk', payload });
    let fh;
    try {
      const current = await validateRomPath(this.realPath, this.platform);
      if (current.realPath !== this.realPath || current.size !== this.romSize) throw new Error('The game file changed while it was being opened.');
      fh = await open(this.realPath, 'r');
      let offset = 0;
      while (offset < this.romSize) {
        const len = Math.min(ROM_CHUNK_BYTES, this.romSize - offset);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, offset);
        if (bytesRead !== len) throw new Error('The game file is shorter than expected.');
        offset += len;
        await post({ offset: offset - len, total: this.romSize, data: new Uint8Array(buf.buffer, buf.byteOffset, len), done: offset >= this.romSize });
      }
    } catch (e) {
      log.error(`[${this.id}] ROM transfer failed`, e);
      await post({ offset: 0, total: this.romSize, data: new Uint8Array(0), done: true, error: e instanceof Error ? e.message : String(e) });
    } finally {
      await fh?.close();
      this.streaming = false;
    }
  }

  async handleMessage(msg: PlayerToHost): Promise<void> {
    switch (msg.type) {
      case 'rom.request':
        await this.streamRom();
        break;
      case 'status':
        this.setStatus(msg.payload.status, msg.payload.detail);
        break;
      case 'save.battery':
        if (!this.romId) return;
        await this.enqueue(async () => {
          const data = msg.payload.data;
          this.lastSessionSave = data;
          const r = await this.ctx.saves.writeBatteryGuarded(this.romId, this.spec.coreId, data, this.batteryFp, this.conflictPath);
          if (r.written) {
            this.batteryFp = r.fp;
            log.debug(`[${this.id}] battery save ${data.byteLength} bytes`);
          } else if (!this.conflictPath) {
            this.conflictPath = r.conflictPath;
            void this.onSaveConflict(r.conflictPath);
          }
        });
        break;
      case 'save.state':
        if (!this.romId) return;
        await this.enqueue(() => this.ctx.saves.writeState(this.romId, this.spec.coreId, msg.payload.suspend ? 'suspend' : msg.payload.slot, msg.payload.data));
        if (!msg.payload.suspend) this.toast('info', `State saved to slot ${msg.payload.slot}.`);
        break;
      case 'screenshot': {
        if (!this.romId) return;
        const p = await this.ctx.saves.writeScreenshot(this.romId, this.spec.coreId, msg.payload.png);
        const pick = await vscode.window.showInformationMessage('RetroVerse: screenshot saved.', 'Reveal');
        if (pick === 'Reveal') void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(p));
        break;
      }
    }
  }

  async command(command: SessionCommand): Promise<CommandResult> {
    const ch = this.ctx.channel;
    switch (command) {
      case 'pause':
      case 'resume':
      case 'reset':
      case 'screenshot':
        return ch.request(command);
      case 'quickSave': {
        const r = await ch.request('saveState', { slot: QUICK_SLOT });
        await this.persist; // the state message precedes the reply; make sure it is on disk
        return r;
      }
      case 'quickLoad': {
        const data = await this.ctx.saves.readState(this.romId, this.spec.coreId, QUICK_SLOT);
        if (!data) return { ok: false, message: 'No quick save for this game yet.' };
        return ch.request('loadState', { slot: QUICK_SLOT, data });
      }
      case 'openSaves': {
        const dir = this.ctx.saves.dirFor(this.romId, this.spec.coreId);
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
        return { ok: true };
      }
      case 'openMods':
        return { ok: false, message: 'Mods are not supported for this platform.' };
      case 'stop':
        await this.stop();
        return { ok: true };
      case 'restart': {
        await ch.request('flush', undefined, 2000).catch(() => undefined);
        await this.persist; // the flushed save must be on disk (or in the conflict file) before init re-reads it
        const init = await this.init();
        await ch.post({ v: 1, type: 'init', payload: init });
        return { ok: true };
      }
    }
  }

  async stop(): Promise<void> {
    if (this.status === 'stopped' || this.status === 'idle') return;
    this.setStatus('stopping');
    await this.ctx.channel.request('stop', undefined, 2500).catch(() => undefined);
    await this.persist;
    this.setStatus('stopped');
  }

  override dispose(): void {
    this.watcher?.dispose();
    this.saveWatcher?.dispose();
    super.dispose();
  }
}
