import { mkdtemp, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkSavesDirectory, SaveStore } from '../../src/extension/storage/SaveStore';
import { realpathSync, statSync, symlinkSync, mkdirSync } from 'node:fs';
import { romIdentity } from '../../src/extension/storage/RomIdentity';
import { writeFile } from 'node:fs/promises';

describe('SaveStore', () => {
  it('isolates saves per ROM and core, and round-trips data', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rv-saves-'));
    const s = new SaveStore(root);
    await s.writeBattery('aaa', 'mgba', new Uint8Array([1, 2, 3]));
    await s.writeBattery('bbb', 'mgba', new Uint8Array([9]));
    await s.writeState('aaa', 'mgba', 0, new Uint8Array([4]));
    await s.writeState('aaa', 'mgba', 'suspend', new Uint8Array([5]));
    expect([...(await s.readBattery('aaa', 'mgba'))!]).toEqual([1, 2, 3]);
    expect([...(await s.readBattery('bbb', 'mgba'))!]).toEqual([9]);
    expect(await s.readBattery('aaa', 'melonds')).toBeUndefined();
    expect([...(await s.readState('aaa', 'mgba', 0))!]).toEqual([4]);
    expect([...(await s.readState('aaa', 'mgba', 'suspend'))!]).toEqual([5]);
    await s.clearState('aaa', 'mgba', 'suspend');
    expect(await s.readState('aaa', 'mgba', 'suspend')).toBeUndefined();
    // atomic writes leave no temp files behind
    expect((await readdir(path.join(root, 'aaa', 'mgba'))).some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('rejects path-like identities and invalid slots', async () => {
    const s = new SaveStore(os.tmpdir());
    expect(() => s.dirFor('../etc', 'mgba')).toThrow();
    expect(() => s.dirFor('abc', 'mg/ba')).toThrow();
    await expect(s.writeState('abc', 'mgba', 10, new Uint8Array(1))).rejects.toThrow();
    await expect(s.writeState('abc', 'mgba', -1, new Uint8Array(1))).rejects.toThrow();
  });
});

describe('romIdentity', () => {
  it('is a stable content hash', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rv-id-'));
    const a = path.join(dir, 'a.gba');
    const b = path.join(dir, 'renamed.gba');
    await writeFile(a, 'hello');
    await writeFile(b, 'hello');
    expect(await romIdentity(a, 5)).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(await romIdentity(b, 5)).toBe(await romIdentity(a, 5));
  });
});

describe('save file permissions and saves folder checks', () => {
  it('writes owner-only folders and files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rv-perm-'));
    const s = new SaveStore(root);
    await s.writeBattery('abc', 'mgba', new Uint8Array([1]));
    await s.writeBattery('abc', 'mgba', new Uint8Array([2])); // rewrite works with exclusive temp files
    const dir = path.join(root, 'abc', 'mgba');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(dir, 'battery.sav')).mode & 0o777).toBe(0o600);
  });

  it('accepts a plain absolute folder outside the workspace', async () => {
    const d = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'rv-saves-ok-')));
    expect(checkSavesDirectory(d, ['/some/workspace'], realpathSync)).toEqual({ ok: true, dir: d });
    expect(checkSavesDirectory(path.join(d, 'not-yet'), [], realpathSync)).toEqual({ ok: true, dir: path.join(d, 'not-yet') });
  });

  it('refuses relative paths, workspace folders and symlinks', async () => {
    const ws = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'rv-ws-')));
    mkdirSync(path.join(ws, 'saves'));
    expect(checkSavesDirectory('saves', [ws], realpathSync)).toMatchObject({ ok: false, reason: expect.stringMatching(/absolute/) });
    expect(checkSavesDirectory(path.join(ws, 'saves'), [ws], realpathSync)).toMatchObject({ ok: false, reason: expect.stringMatching(/workspace/) });
    const link = path.join(realpathSync(os.tmpdir()), `rv-link-${process.pid}`);
    symlinkSync(ws, link);
    expect(checkSavesDirectory(link, [], realpathSync)).toMatchObject({ ok: false, reason: expect.stringMatching(/symlink/) });
  });
});
