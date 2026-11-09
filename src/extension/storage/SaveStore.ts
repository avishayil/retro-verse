import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

const SAFE_ID = /^[a-z0-9:_-]{1,80}$/i;

export type StateSlot = number | 'suspend';

/** Identifies the contents of a battery save. `undefined` means the file does not exist. */
export interface SaveFingerprint {
  sha256: string;
  size: number;
}

export type GuardedWrite = { written: true; fp: SaveFingerprint } | { written: false; conflictPath: string; fp: SaveFingerprint | undefined };

const MAX_BACKUPS = 20;

export function fingerprintOf(data: Uint8Array): SaveFingerprint {
  return { sha256: createHash('sha256').update(data).digest('hex'), size: data.byteLength };
}

export function sameFingerprint(a: SaveFingerprint | undefined, b: SaveFingerprint | undefined): boolean {
  return a === b || (!!a && !!b && a.sha256 === b.sha256 && a.size === b.size);
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Per-game, per-core persistence. Layout:
 *   <root>/<romId>/<coreId>/battery.sav
 *   <root>/<romId>/<coreId>/state-<slot>.ss
 *   <root>/<romId>/<coreId>/suspend.ss
 *   <root>/<romId>/<coreId>/screenshots/<timestamp>.png
 */
export class SaveStore {
  constructor(private readonly root: string) {}

  dirFor(romId: string, coreId: string): string {
    if (!SAFE_ID.test(romId) || !SAFE_ID.test(coreId)) throw new Error('Invalid save identity.');
    return path.join(this.root, romId.replace(':', '_'), coreId);
  }

  async readBattery(romId: string, coreId: string): Promise<Uint8Array | undefined> {
    return readOptional(path.join(this.dirFor(romId, coreId), 'battery.sav'));
  }

  async writeBattery(romId: string, coreId: string, data: Uint8Array): Promise<void> {
    await atomicWrite(path.join(this.dirFor(romId, coreId), 'battery.sav'), data);
  }

  batteryPath(romId: string, coreId: string): string {
    return path.join(this.dirFor(romId, coreId), 'battery.sav');
  }

  async batteryFingerprint(romId: string, coreId: string): Promise<SaveFingerprint | undefined> {
    const data = await this.readBattery(romId, coreId);
    return data ? fingerprintOf(data) : undefined;
  }

  /**
   * Write the battery save only if the file on disk is still the one this session expects. If something else
   * changed it (another window, a phone sync, a manual copy), the data goes to a conflict file next to it and
   * battery.sav is left alone. The check and the rename are a few milliseconds apart; that window is accepted.
   * Pass `conflictPath` to keep updating the same conflict file on later writes.
   */
  async writeBatteryGuarded(romId: string, coreId: string, data: Uint8Array, expected: SaveFingerprint | undefined, conflictPath?: string): Promise<GuardedWrite> {
    const current = await this.batteryFingerprint(romId, coreId);
    if (!conflictPath && sameFingerprint(current, expected)) {
      await this.writeBattery(romId, coreId, data);
      return { written: true, fp: fingerprintOf(data) };
    }
    const target = conflictPath ?? path.join(this.dirFor(romId, coreId), `battery.conflict-${stamp()}.sav`);
    await atomicWrite(target, data);
    return { written: false, conflictPath: target, fp: current };
  }

  /** Copy the current battery save into backups/ (newest 20 kept). Returns the backup path, if there was a save. */
  async backupBattery(romId: string, coreId: string, label: string): Promise<string | undefined> {
    const data = await this.readBattery(romId, coreId);
    return data ? this.writeBackup(romId, coreId, label, data) : undefined;
  }

  /** Store `data` in backups/ as <timestamp>-<label>.sav and prune to the newest 20. */
  async writeBackup(romId: string, coreId: string, label: string, data: Uint8Array): Promise<string> {
    if (!/^[a-z0-9-]{1,32}$/.test(label)) throw new Error('Invalid backup label.');
    const dir = path.join(this.dirFor(romId, coreId), 'backups');
    const p = path.join(dir, `${stamp()}-${label}.sav`);
    await atomicWrite(p, data);
    const old = (await readdir(dir)).filter((f) => f.endsWith('.sav')).sort().slice(0, -MAX_BACKUPS);
    await Promise.all(old.map((f) => rm(path.join(dir, f), { force: true })));
    return p;
  }

  async readState(romId: string, coreId: string, slot: StateSlot): Promise<Uint8Array | undefined> {
    return readOptional(this.statePath(romId, coreId, slot));
  }

  async writeState(romId: string, coreId: string, slot: StateSlot, data: Uint8Array): Promise<void> {
    await atomicWrite(this.statePath(romId, coreId, slot), data);
  }

  async clearState(romId: string, coreId: string, slot: StateSlot): Promise<void> {
    await rm(this.statePath(romId, coreId, slot), { force: true });
  }

  async writeScreenshot(romId: string, coreId: string, png: Uint8Array): Promise<string> {
    const p = path.join(this.dirFor(romId, coreId), 'screenshots', `${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
    await atomicWrite(p, png);
    return p;
  }

  private statePath(romId: string, coreId: string, slot: StateSlot): string {
    if (slot !== 'suspend' && (!Number.isInteger(slot) || slot < 0 || slot > 9)) throw new Error('Invalid state slot.');
    return path.join(this.dirFor(romId, coreId), slot === 'suspend' ? 'suspend.ss' : `state-${slot}.ss`);
  }
}

async function readOptional(p: string): Promise<Uint8Array | undefined> {
  try {
    const b = await readFile(p);
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/** Write to a temp file and rename so a crash never leaves a truncated save. */
export async function atomicWrite(p: string, data: Uint8Array): Promise<void> {
  // Saves are personal data: owner-only folders and files.
  await mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(p), 0o700).catch(() => undefined); // also tighten folders created by older versions
  // Unpredictable name + exclusive create: a pre-planted file or symlink at the temp path is never followed.
  const tmp = `${p}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(tmp, data, { mode: 0o600, flag: 'wx' });
  await rename(tmp, p);
}

/**
 * Check a user-chosen saves folder: it must be absolute, must not be inside an open workspace (a repository could
 * otherwise collect or plant save files), and must not be a symlink to somewhere else. Returns the folder to use
 * or a reason it was refused.
 */
export function checkSavesDirectory(dir: string, workspaceFolders: readonly string[], realpath: (p: string) => string): { ok: true; dir: string } | { ok: false; reason: string } {
  if (!dir) return { ok: false, reason: 'empty' };
  if (!path.isAbsolute(dir)) return { ok: false, reason: 'the path is not absolute' };
  const resolved = path.resolve(dir);
  let real = resolved;
  try {
    real = realpath(resolved);
  } catch {
    // Does not exist yet: it will be created as given.
  }
  if (real !== resolved) return { ok: false, reason: 'the path is a symlink to another location' };
  for (const w of workspaceFolders) {
    const rel = path.relative(w, real);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return { ok: false, reason: 'the folder is inside an open workspace' };
  }
  return { ok: true, dir: real };
}
