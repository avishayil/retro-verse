import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { log, redact } from '../diagnostics/Log';
import { fingerprintOf, type SaveFingerprint, type SaveStore } from '../storage/SaveStore';
import { Adb, AdbError, type RemoteFile } from './Adb';
import { isRemotePath, validatePackage, validateRemotePath } from './remote';

/** Largest save RetroVerse copies either way (DS flash saves are at most 8 MiB). */
export const MAX_SAVE_BYTES = 16 * 1024 * 1024;

export type SaveApp = 'retroarch' | 'melonds' | 'custom';

/** Where a game's save lives on the phone. Kept in extension global state, keyed by ROM hash. */
export interface PhoneLocation {
  app: SaveApp;
  path: string;
  /** App to force-stop before a push, so it cannot write its old in-memory save over ours. */
  pkg?: string;
  /** sha256 both sides had after the last successful sync. */
  baseline?: string;
}

export interface SyncGame {
  romId: string;
  coreId: string;
  title: string;
  /** Local ROM file name without extension, used to rank candidate saves on the phone. */
  romStem: string;
}

export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface PickItem<T> {
  label: string;
  description?: string;
  value: T;
}

/** The few prompts sync needs, so the logic can be tested without VS Code. */
export interface SyncUi {
  pick<T>(title: string, items: PickItem<T>[]): Promise<T | undefined>;
  input(prompt: string, value: string, validate: (v: string) => string | undefined): Promise<string | undefined>;
  /** Modal question; resolves to the chosen action or undefined for Cancel. */
  ask(message: string, detail: string, actions: string[]): Promise<string | undefined>;
  info(message: string): void;
}

export type SyncDecision = 'nothing' | 'same' | 'pull' | 'push' | 'ask';

/**
 * Three-way decision. The baseline is the hash both sides had after the last sync: if only one side moved away
 * from it, copy that side. If both moved (or there is no baseline yet), the user decides.
 */
export function decide(local: SaveFingerprint | undefined, phone: SaveFingerprint | undefined, baseline: string | undefined): SyncDecision {
  if (!local && !phone) return 'nothing';
  if (local && phone && local.sha256 === phone.sha256) return 'same';
  if (!local) return 'pull';
  if (!phone) return 'push';
  if (baseline && phone.sha256 === baseline) return 'push';
  if (baseline && local.sha256 === baseline) return 'pull';
  return 'ask';
}

const APPS: Record<Exclude<SaveApp, 'custom'>, { label: string; packages: (installed: string[]) => string[]; extensions: string[]; roots: (pkg: string) => string[] }> = {
  retroarch: {
    label: 'RetroArch',
    packages: (all) => all.filter((p) => /^com\.retroarch(\.|$)/.test(p)),
    extensions: ['.srm'],
    roots: (pkg) => ['/storage/emulated/0/Roms', '/storage/emulated/0/RetroArch', `/storage/emulated/0/Android/data/${pkg}/files`],
  },
  melonds: {
    label: 'melonDS',
    packages: (all) => all.filter((p) => p === 'me.magnum.melonds' || p.startsWith('me.magnum.melonds.')),
    extensions: ['.sav'],
    roots: () => ['/storage/emulated/0/Roms', '/storage/emulated/0/melonDS'],
  },
};

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/** Rank phone files by how well their name matches the local ROM name, then newest first. */
export function rankCandidates(files: RemoteFile[], romStem: string): RemoteFile[] {
  const want = norm(romStem);
  const score = (f: RemoteFile) => {
    const stem = norm(path.posix.basename(f.path, path.posix.extname(f.path)));
    if (stem === want) return 3;
    if (want && stem && (stem.includes(want) || want.includes(stem))) return 2;
    return 0;
  };
  return [...files].sort((a, b) => score(b) - score(a) || b.mtime - a.mtime || a.path.localeCompare(b.path));
}

const when = (t: number) => new Date(t * 1000).toLocaleString();

const stateKey = (romId: string) => `android.location.${romId}`;

export class AndroidSync {
  constructor(
    private readonly adb: Adb,
    private readonly saves: SaveStore,
    private readonly state: KeyValueStore,
    private readonly ui: SyncUi,
    private readonly configuredSerial = '',
  ) {}

  location(romId: string): PhoneLocation | undefined {
    const l = this.state.get<PhoneLocation>(stateKey(romId));
    if (!l || !['retroarch', 'melonds', 'custom'].includes(l.app) || !isRemotePath(l.path)) return undefined;
    if (l.pkg) {
      try {
        validatePackage(l.pkg);
      } catch {
        return undefined;
      }
    }
    return l;
  }

  private async saveLocation(romId: string, l: PhoneLocation): Promise<void> {
    await this.state.update(stateKey(romId), l);
  }

  /** Pick the phone, honouring retroverse.android.device. */
  async device(): Promise<Adb> {
    const all = await this.adb.devices();
    const ready = all.filter((d) => d.state === 'device');
    if (this.configuredSerial) {
      const d = ready.find((x) => x.serial === this.configuredSerial);
      if (!d) throw new AdbError(`The phone ${this.configuredSerial} from retroverse.android.device is not connected.`);
      return this.adb.withDevice(d.serial);
    }
    if (ready.length === 0) {
      if (all.some((d) => d.state === 'unauthorized')) throw new AdbError('The phone has not allowed USB debugging from this computer yet. Unlock it and accept the prompt.');
      throw new AdbError('No Android device found. Connect the phone with USB debugging on (or pair it over Wi-Fi) and try again.');
    }
    if (ready.length === 1) return this.adb.withDevice(ready[0]!.serial);
    const serial = await this.ui.pick(
      'Which device?',
      ready.map((d) => ({ label: d.model?.replace(/_/g, ' ') ?? d.serial, description: d.serial, value: d.serial })),
    );
    if (!serial) throw new SyncCancelled();
    return this.adb.withDevice(serial);
  }

  /** Ask where the game's save is on the phone and remember it. */
  async chooseLocation(game: SyncGame, dev?: Adb): Promise<PhoneLocation> {
    const adb = dev ?? (await this.device());
    const app = await this.ui.pick<SaveApp>(`Which app plays ${game.title} on the phone?`, [
      { label: 'RetroArch', description: '.srm saves', value: 'retroarch' },
      { label: 'melonDS', description: '.sav saves (DS)', value: 'melonds' },
      { label: 'Another app or folder', description: 'type the path of the save on the phone', value: 'custom' },
    ]);
    if (!app) throw new SyncCancelled();
    let loc: PhoneLocation | undefined;
    if (app === 'custom') {
      const p = await this.ui.input('Path of the save file on the phone', '/storage/emulated/0/', (v) => {
        try {
          validateRemotePath(v);
          return undefined;
        } catch (e) {
          return (e as Error).message;
        }
      });
      if (!p) throw new SyncCancelled();
      const pkg = await this.ui.input('Android package to stop before RetroVerse writes the save (optional)', '', (v) => {
        if (!v) return undefined;
        try {
          validatePackage(v);
          return undefined;
        } catch (e) {
          return (e as Error).message;
        }
      });
      if (pkg === undefined) throw new SyncCancelled();
      loc = { app, path: validateRemotePath(p), pkg: pkg || undefined };
    } else {
      const spec = APPS[app];
      const pkgs = spec.packages(await adb.packages());
      if (pkgs.length === 0) throw new AdbError(`${spec.label} is not installed on the phone.`);
      const pkg = pkgs.length === 1 ? pkgs[0]! : await this.ui.pick(`Which ${spec.label}?`, pkgs.map((p) => ({ label: p, value: p })));
      if (!pkg) throw new SyncCancelled();
      const found = rankCandidates(await adb.find(spec.roots(pkg), spec.extensions), game.romStem);
      const other = '\0other';
      const chosen = await this.ui.pick(`Which ${spec.label} save belongs to ${game.title}?`, [
        ...found.map((f) => ({ label: path.posix.basename(f.path), description: `${path.posix.dirname(f.path)}  ·  ${when(f.mtime)}  ·  ${f.size} bytes`, value: f.path })),
        { label: 'Type a path...', description: found.length ? undefined : `no ${spec.extensions.join(', ')} files found`, value: other },
      ]);
      if (!chosen) throw new SyncCancelled();
      let p = chosen;
      if (chosen === other) {
        const typed = await this.ui.input('Path of the save file on the phone', '/storage/emulated/0/', (v) => (isRemotePath(v) ? undefined : 'Enter an absolute path under /storage/ or /sdcard/ without quotes or shell characters.'));
        if (!typed) throw new SyncCancelled();
        p = typed;
      }
      loc = { app, path: validateRemotePath(p), pkg };
    }
    await this.saveLocation(game.romId, loc);
    log.info(`android: ${game.romId.slice(0, 12)} save location set (${loc.app}, ${redact(loc.path)})`);
    return loc;
  }

  private async ensureLocation(game: SyncGame, adb: Adb): Promise<PhoneLocation> {
    return this.location(game.romId) ?? (await this.chooseLocation(game, adb));
  }

  /** Read the phone's save into memory (via a private temp folder). */
  private async readPhone(adb: Adb, loc: PhoneLocation): Promise<{ data: Uint8Array; mtime: number } | undefined> {
    const st = await adb.stat(loc.path);
    if (!st) return undefined;
    if (st.size === 0 || st.size > MAX_SAVE_BYTES) throw new AdbError(`The save on the phone is ${st.size} bytes, which does not look like a battery save.`);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'retroverse-adb-'));
    try {
      const local = path.join(dir, 'phone.sav');
      await adb.pull(loc.path, local);
      const b = await readFile(local);
      if (b.byteLength !== st.size) throw new AdbError('The save changed on the phone while it was being copied. Close the app on the phone and try again.');
      return { data: new Uint8Array(b.buffer, b.byteOffset, b.byteLength), mtime: st.mtime };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async localMtime(game: SyncGame): Promise<number | undefined> {
    return stat(this.saves.batteryPath(game.romId, game.coreId)).then(
      (s) => Math.floor(s.mtimeMs / 1000),
      () => undefined,
    );
  }

  private async writePhone(adb: Adb, loc: PhoneLocation, data: Uint8Array): Promise<void> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'retroverse-adb-'));
    try {
      const local = path.join(dir, 'push.sav');
      await writeFile(local, data, { mode: 0o600 });
      await adb.pushInto(local, loc.path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Copy the phone's save into RetroVerse. The current RetroVerse save goes to backups/ first. */
  async pull(game: SyncGame, dev?: Adb): Promise<void> {
    const adb = dev ?? (await this.device());
    const loc = await this.ensureLocation(game, adb);
    const phone = await this.readPhone(adb, loc);
    if (!phone) throw new AdbError('There is no save at that location on the phone yet.');
    const local = await this.saves.readBattery(game.romId, game.coreId);
    if (local && !(await this.confirmSize(local.byteLength, phone.data.byteLength, 'phone'))) throw new SyncCancelled();
    await this.saves.backupBattery(game.romId, game.coreId, 'before-pull');
    await this.saves.writeBattery(game.romId, game.coreId, phone.data);
    await this.saveLocation(game.romId, { ...loc, baseline: fingerprintOf(phone.data).sha256 });
    log.info(`android: pulled ${phone.data.byteLength} bytes for ${game.romId.slice(0, 12)}`);
    this.ui.info(`RetroVerse: copied the save for ${game.title} from the phone.`);
  }

  /**
   * Copy RetroVerse's save to the phone: back up the phone's save locally, stop the app so it cannot write its
   * own copy back, push to a temporary name and move it into place, then read it back to verify. A failed
   * verification restores the phone's previous save.
   */
  async push(game: SyncGame, dev?: Adb): Promise<void> {
    const adb = dev ?? (await this.device());
    const loc = await this.ensureLocation(game, adb);
    const data = await this.saves.readBattery(game.romId, game.coreId);
    if (!data) throw new AdbError(`RetroVerse has no save for ${game.title} yet.`);
    const before = await this.readPhone(adb, loc);
    if (before) {
      if (!(await this.confirmSize(before.data.byteLength, data.byteLength, 'VS Code'))) throw new SyncCancelled();
      await this.saves.writeBackup(game.romId, game.coreId, 'phone', before.data);
    }
    if (loc.pkg) await adb.forceStop(loc.pkg);
    await this.writePhone(adb, loc, data);
    const after = await this.readPhone(adb, loc).catch(() => undefined);
    const want = fingerprintOf(data).sha256;
    if (!after || fingerprintOf(after.data).sha256 !== want) {
      if (before) await this.writePhone(adb, loc, before.data).catch((e) => log.error('android: could not restore the phone save', e));
      throw new AdbError('The save on the phone did not match after copying, so the previous phone save was put back.');
    }
    await this.saveLocation(game.romId, { ...loc, baseline: want });
    log.info(`android: pushed ${data.byteLength} bytes for ${game.romId.slice(0, 12)}`);
    this.ui.info(`RetroVerse: copied the save for ${game.title} to the phone.`);
  }

  /** Compare both sides and copy whichever changed since the last sync; ask when both did. */
  async sync(game: SyncGame): Promise<SyncDecision> {
    const adb = await this.device();
    const loc = await this.ensureLocation(game, adb);
    const localData = await this.saves.readBattery(game.romId, game.coreId);
    const phone = await this.readPhone(adb, loc);
    const local = localData ? fingerprintOf(localData) : undefined;
    const remote = phone ? fingerprintOf(phone.data) : undefined;
    const d = decide(local, remote, loc.baseline);
    log.info(`android: sync ${game.romId.slice(0, 12)} -> ${d}`);
    switch (d) {
      case 'nothing':
        this.ui.info(`RetroVerse: there is no save for ${game.title} on either side yet.`);
        return d;
      case 'same':
        if (loc.baseline !== local!.sha256) await this.saveLocation(game.romId, { ...loc, baseline: local!.sha256 });
        this.ui.info(`RetroVerse: the save for ${game.title} is already in sync.`);
        return d;
      case 'pull':
        await this.pull(game, adb);
        return d;
      case 'push':
        await this.push(game, adb);
        return d;
      case 'ask': {
        const lm = await this.localMtime(game);
        const fmt = (t: number | undefined) => (t ? when(t) : 'unknown time');
        const phoneNewer = (phone!.mtime ?? 0) > (lm ?? 0);
        const usePhone = 'Use the Phone Save';
        const useLocal = 'Use the VS Code Save';
        const pick = await this.ui.ask(
          `The save for ${game.title} is different on the phone and in VS Code.`,
          `Phone: ${remote!.size} bytes, changed ${fmt(phone!.mtime)}${phoneNewer ? ' (newer)' : ''}.\nVS Code: ${local!.size} bytes, changed ${fmt(lm)}${phoneNewer ? '' : ' (newer)'}.\nThe save that is replaced is kept in the backups folder.`,
          phoneNewer ? [usePhone, useLocal] : [useLocal, usePhone],
        );
        if (pick === usePhone) await this.pull(game, adb);
        else if (pick === useLocal) await this.push(game, adb);
        else throw new SyncCancelled();
        return pick === usePhone ? 'pull' : 'push';
      }
    }
  }

  private async confirmSize(oldSize: number, newSize: number, from: string): Promise<boolean> {
    if (oldSize === newSize) return true;
    const go = 'Copy Anyway';
    const pick = await this.ui.ask(
      'The two saves have different sizes.',
      `The ${from} save is ${newSize} bytes and the one it replaces is ${oldSize} bytes. This usually means the two emulators use different save types for this game, and the game may not read the copied save.`,
      [go],
    );
    return pick === go;
  }
}

export class SyncCancelled extends Error {
  constructor() {
    super('Cancelled.');
  }
}
