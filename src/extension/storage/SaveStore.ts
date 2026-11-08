import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

const SAFE_ID = /^[a-z0-9:_-]{1,80}$/i;

export type StateSlot = number | 'suspend';

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
  await mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, p);
}
