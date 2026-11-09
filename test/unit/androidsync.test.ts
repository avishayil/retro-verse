import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Adb, adbCandidates } from '../../src/extension/sync/Adb';
import { AndroidSync, decide, rankCandidates, SyncCancelled, type PhoneLocation, type SyncUi } from '../../src/extension/sync/AndroidSync';
import { q, validatePackage, validateRemotePath } from '../../src/extension/sync/remote';
import { fingerprintOf, SaveStore } from '../../src/extension/storage/SaveStore';

describe('remote path validation', () => {
  it('accepts normal save paths, including accented names', () => {
    expect(validateRemotePath('/storage/emulated/0/Roms/SkyEmu/Pokemon Leaf Green.srm')).toBe('/storage/emulated/0/Roms/SkyEmu/Pokemon Leaf Green.srm');
    expect(validateRemotePath('/sdcard/Roms/Pokémon - HeartGold (USA) [v1.1].sav')).toBeTruthy();
    expect(q('/sdcard/a b.sav')).toBe("'/sdcard/a b.sav'");
  });

  it.each([
    "/sdcard/x'; rm -rf / #.srm",
    '/sdcard/$(reboot).srm',
    '/sdcard/`id`.srm',
    '/sdcard/a\nreboot',
    '/sdcard/a;reboot',
    '/sdcard/a|sh',
    '/sdcard/../data/data/x',
    '/sdcard/./a.srm',
    '/data/data/com.retroarch/x.srm',
    'relative/x.srm',
    '/sdcard/dir/',
    '/sdcard/a\\b',
    '/sdcard/*.srm',
    '',
  ])('refuses %j', (p) => {
    expect(() => validateRemotePath(p)).toThrow();
  });

  it('checks package names', () => {
    expect(validatePackage('com.retroarch.aarch64')).toBe('com.retroarch.aarch64');
    for (const bad of ['com.retroarch;reboot', 'retroarch', '-p', 'com.x y', 'com.$(id)']) expect(() => validatePackage(bad)).toThrow();
  });
});

describe('sync decision', () => {
  const a = fingerprintOf(new Uint8Array([1]));
  const b = fingerprintOf(new Uint8Array([2]));
  const c = fingerprintOf(new Uint8Array([3]));
  it.each([
    [undefined, undefined, undefined, 'nothing'],
    [a, a, undefined, 'same'],
    [undefined, a, undefined, 'pull'],
    [a, undefined, undefined, 'push'],
    [b, a, a.sha256, 'push'],
    [a, b, a.sha256, 'pull'],
    [b, c, a.sha256, 'ask'],
    [a, b, undefined, 'ask'],
  ] as const)('local=%o phone=%o baseline=%s -> %s', (l, p, base, want) => {
    expect(decide(l, p, base)).toBe(want);
  });

  it('ranks saves whose name matches the game first, newest first among equals', () => {
    const f = (p: string, mtime: number) => ({ path: p, mtime, size: 131072 });
    const files = [
      f('/sdcard/Roms/Zelda.srm', 900),
      f('/sdcard/RetroArch/saves/SkyEmu/Pokemon Leaf Green.srm', 100),
      f('/sdcard/Roms/SkyEmu/Pokemon Leaf Green.srm', 500),
      f('/sdcard/Roms/Pokemon Leaf Green (Hack).srm', 800),
    ];
    const ranked = rankCandidates(files, 'Pokémon Leaf Green').map((x) => x.path);
    expect(ranked).toEqual(['/sdcard/Roms/SkyEmu/Pokemon Leaf Green.srm', '/sdcard/RetroArch/saves/SkyEmu/Pokemon Leaf Green.srm', '/sdcard/Roms/Pokemon Leaf Green (Hack).srm', '/sdcard/Roms/Zelda.srm']);
  });

  it('looks for adb in the SDK and Homebrew before PATH', () => {
    const c = adbCandidates('/Users/me', { PATH: '/usr/bin:relative' });
    expect(c[0]).toBe('/Users/me/Library/Android/sdk/platform-tools/adb');
    expect(c.indexOf('/opt/homebrew/bin/adb')).toBeLessThan(c.indexOf('/usr/bin/adb'));
    expect(c.some((p) => p.startsWith('relative'))).toBe(false);
  });
});

describe('AndroidSync with a fake phone', () => {
  const REMOTE = '/storage/emulated/0/Roms/SkyEmu/Leaf Green.srm';
  const game = { romId: 'abc', coreId: 'mgba', title: 'Leaf Green', romStem: 'Leaf Green' };
  let phone: string;
  let logFile: string;
  let saves: SaveStore;
  let adb: Adb;
  let kv: Map<string, unknown>;
  let answers: (string | undefined)[];
  let messages: string[];
  const ui: SyncUi = {
    pick: async (_t, items) => {
      const a = answers.shift();
      return items.find((i) => i.label === a || i.value === a)?.value;
    },
    input: async () => answers.shift(),
    ask: async (m, d) => (messages.push(`${m}\n${d}`), answers.shift()),
    info: (m) => void messages.push(m),
  };
  const sync = () => new AndroidSync(adb, saves, { get: (k) => kv.get(k) as never, update: async (k, v) => void kv.set(k, v) }, ui);
  const phoneFile = () => path.join(phone, REMOTE);
  const writePhone = (bytes: number[]) => {
    mkdirSync(path.dirname(phoneFile()), { recursive: true });
    writeFileSync(phoneFile(), Buffer.from(bytes));
  };
  const calls = () => readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
  const setLocation = (extra: Partial<PhoneLocation> = {}) => kv.set('android.location.abc', { app: 'retroarch', path: REMOTE, pkg: 'com.retroarch', ...extra });

  beforeEach(async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rv-adb-'));
    phone = path.join(dir, 'phone');
    mkdirSync(phone);
    logFile = path.join(dir, 'adb.log');
    writeFileSync(logFile, '');
    const exe = path.join(dir, 'bin', 'adb');
    mkdirSync(path.dirname(exe));
    copyFileSync(path.join(__dirname, '..', 'fixtures', 'fake-adb.mjs'), exe);
    chmodSync(exe, 0o755);
    process.env.FAKE_PHONE = phone;
    process.env.FAKE_ADB_LOG = logFile;
    delete process.env.FAKE_CORRUPT_PUSH;
    delete process.env.FAKE_DEVICES;
    saves = new SaveStore(path.join(dir, 'saves'));
    adb = new Adb(exe);
    kv = new Map();
    answers = [];
    messages = [];
  });

  it('finds the save with the app picker and remembers it', async () => {
    writePhone([1, 1]);
    answers = ['retroarch', REMOTE];
    const loc = await sync().chooseLocation(game);
    expect(loc).toEqual({ app: 'retroarch', path: REMOTE, pkg: 'com.retroarch' });
    expect(kv.get('android.location.abc')).toEqual(loc);
  });

  it('pulls the phone save and backs up the old one', async () => {
    setLocation();
    writePhone([5, 5]);
    await saves.writeBattery('abc', 'mgba', new Uint8Array([1, 1]));
    await sync().pull(game);
    expect([...(await saves.readBattery('abc', 'mgba'))!]).toEqual([5, 5]);
    const backups = await readdir(path.join(saves.dirFor('abc', 'mgba'), 'backups'));
    expect(backups.some((f) => f.endsWith('-before-pull.sav'))).toBe(true);
    expect((kv.get('android.location.abc') as PhoneLocation).baseline).toBe(fingerprintOf(new Uint8Array([5, 5])).sha256);
  });

  it('pushes: backs up the phone save, stops the app first, then moves into place and verifies', async () => {
    setLocation();
    writePhone([5, 5]);
    await saves.writeBattery('abc', 'mgba', new Uint8Array([1, 1]));
    await sync().push(game);
    expect([...readFileSync(phoneFile())]).toEqual([1, 1]);
    const c = calls().map((a) => a.slice(2)); // drop -s <serial>
    const stop = c.findIndex((a) => a[0] === 'shell' && a[1]!.startsWith('am force-stop com.retroarch'));
    const push = c.findIndex((a) => a[0] === 'push');
    expect(stop).toBeGreaterThan(-1);
    expect(stop).toBeLessThan(push);
    expect(c[push]![2]).toBe(`${REMOTE}.retroverse-tmp`);
    expect(c.slice(push).some((a) => a[0] === 'pull')).toBe(true); // read back to verify
    const backups = await readdir(path.join(saves.dirFor('abc', 'mgba'), 'backups'));
    expect(backups.some((f) => f.endsWith('-phone.sav'))).toBe(true);
  });

  it('puts the old phone save back if verification fails', async () => {
    setLocation();
    writePhone([5, 5]);
    await saves.writeBattery('abc', 'mgba', new Uint8Array([1, 1]));
    process.env.FAKE_CORRUPT_PUSH = '1';
    await expect(sync().push(game)).rejects.toThrow(/did not match/);
    delete process.env.FAKE_CORRUPT_PUSH;
    // the restore push also went through the corrupting fake, so check that a restore was attempted
    expect(calls().filter((a) => a.includes('push')).length).toBe(2);
  });

  it('sync copies whichever side changed since the last sync', async () => {
    writePhone([1, 1]);
    await saves.writeBattery('abc', 'mgba', new Uint8Array([1, 1]));
    setLocation();
    expect(await sync().sync(game)).toBe('same');
    await saves.writeBattery('abc', 'mgba', new Uint8Array([2, 2]));
    expect(await sync().sync(game)).toBe('push');
    expect([...readFileSync(phoneFile())]).toEqual([2, 2]);
    writePhone([3, 3]);
    expect(await sync().sync(game)).toBe('pull');
    expect([...(await saves.readBattery('abc', 'mgba'))!]).toEqual([3, 3]);
  });

  it('asks when both sides changed, and Cancel changes nothing', async () => {
    setLocation({ baseline: 'f'.repeat(64) });
    writePhone([7, 7]);
    await saves.writeBattery('abc', 'mgba', new Uint8Array([8, 8]));
    answers = [undefined];
    await expect(sync().sync(game)).rejects.toBeInstanceOf(SyncCancelled);
    expect(messages[0]).toMatch(/different on the phone and in VS Code/);
    expect([...readFileSync(phoneFile())]).toEqual([7, 7]);
    expect([...(await saves.readBattery('abc', 'mgba'))!]).toEqual([8, 8]);
  });

  it('asks before copying a save of a different size', async () => {
    setLocation();
    writePhone([1, 1, 1, 1]);
    await saves.writeBattery('abc', 'mgba', new Uint8Array([2, 2]));
    answers = [undefined];
    await expect(sync().pull(game)).rejects.toBeInstanceOf(SyncCancelled);
    expect([...(await saves.readBattery('abc', 'mgba'))!]).toEqual([2, 2]);
  });

  it('explains unauthorized and missing devices', async () => {
    process.env.FAKE_DEVICES = 'R5CT1 unauthorized usb:1';
    await expect(sync().device()).rejects.toThrow(/allowed USB debugging/);
    process.env.FAKE_DEVICES = '';
    await expect(sync().device()).rejects.toThrow(/No Android device/);
  });

  it('ignores a stored location that fails validation', () => {
    kv.set('android.location.abc', { app: 'retroarch', path: "/sdcard/x'; reboot" });
    expect(sync().location('abc')).toBeUndefined();
  });
});
