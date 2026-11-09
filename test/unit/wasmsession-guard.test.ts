import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { WasmSession } from '../../src/extension/adapters/wasm/WasmSession';
import { SaveStore } from '../../src/extension/storage/SaveStore';
import type { LaunchContext } from '../../src/extension/sessions/Session';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stub = vscode as any;

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rv-wasm-guard-'));
  const rom = path.join(dir, 'Game.gba');
  await writeFile(rom, Buffer.alloc(1024, 1));
  const saves = new SaveStore(path.join(dir, 'saves'));
  const requests: string[] = [];
  const ctx = {
    document: { uri: { fsPath: rom, path: rom }, format: { extension: '.gba', platform: 'gba' }, title: 'Game', romId: undefined },
    channel: { webview: {}, post: async () => true, request: async (c: string) => (requests.push(c), { ok: true }) },
    saves,
    extensionUri: {},
    retainContextWhenHidden: true,
  } as unknown as LaunchContext;
  const session = new WasmSession(ctx, { coreId: 'mgba', platform: 'gba', backend: () => ({ kind: 'gba', coreJsUrl: 'x', romSize: 1024, romName: 'game.gba' }) });
  return { session, saves, ctx, requests };
}
const battery = (b: number) => ({ v: 1, type: 'save.battery', payload: { data: new Uint8Array([b, b]) } }) as never;

describe('WasmSession save guard', () => {
  beforeEach(() => {
    stub.__prompts.answer = undefined;
    stub.__prompts.seen.length = 0;
  });

  it('writes normally when nothing else touched the save', async () => {
    const { session, saves, ctx } = await setup();
    await session.init();
    await session.handleMessage(battery(1));
    await session.handleMessage(battery(2));
    expect([...(await saves.readBattery(ctx.document.romId!, 'mgba'))!]).toEqual([2, 2]);
    expect(stub.__prompts.seen).toHaveLength(0);
  });

  it('never overwrites a save that changed on disk while the game was open', async () => {
    const { session, saves, ctx } = await setup();
    await session.init();
    const romId = ctx.document.romId!;
    await saves.writeState(romId, 'mgba', 'suspend', new Uint8Array([9]));
    await saves.writeBattery(romId, 'mgba', new Uint8Array([7, 7])); // e.g. pulled from a phone
    await session.handleMessage(battery(1));
    await session.handleMessage(battery(2));
    expect([...(await saves.readBattery(romId, 'mgba'))!]).toEqual([7, 7]);
    const dir = saves.dirFor(romId, 'mgba');
    const conflicts = (await readdir(dir)).filter((f) => f.startsWith('battery.conflict-'));
    expect(conflicts).toHaveLength(1);
    expect([...(await readFile(path.join(dir, conflicts[0]!)))]).toEqual([2, 2]);
    await new Promise((r) => setTimeout(r, 10));
    expect(await saves.readState(romId, 'mgba', 'suspend')).toBeUndefined();
    expect(stub.__prompts.seen.join('\n')).toMatch(/changed outside this session/);
  });

  it("can keep the session's save, backing up the external one", async () => {
    const { session, saves, ctx } = await setup();
    await session.init();
    const romId = ctx.document.romId!;
    await saves.writeBattery(romId, 'mgba', new Uint8Array([7, 7]));
    await session.handleMessage(battery(1));
    await session.keepSessionSave();
    expect([...(await saves.readBattery(romId, 'mgba'))!]).toEqual([1, 1]);
    const backups = await readdir(path.join(saves.dirFor(romId, 'mgba'), 'backups'));
    expect(backups.some((f) => f.endsWith('-external.sav'))).toBe(true);
    await session.handleMessage(battery(3)); // back to normal writes
    expect([...(await saves.readBattery(romId, 'mgba'))!]).toEqual([3, 3]);
  });

  it('offers a restart when the save changes on disk, and the restart loads the new save', async () => {
    const { session, saves, ctx, requests } = await setup();
    await session.init();
    const romId = ctx.document.romId!;
    await session.handleMessage(battery(1));
    await session.onSaveChanged(); // our own write: no prompt
    expect(stub.__prompts.seen).toHaveLength(0);
    await saves.writeBattery(romId, 'mgba', new Uint8Array([7, 7]));
    stub.__prompts.answer = 'Restart';
    await session.onSaveChanged();
    expect(stub.__prompts.seen.join('\n')).toMatch(/changed on disk/);
    expect(requests).toContain('flush');
    await session.handleMessage(battery(8)); // after restart the session follows the new file
    expect([...(await saves.readBattery(romId, 'mgba'))!]).toEqual([8, 8]);
  });
});
