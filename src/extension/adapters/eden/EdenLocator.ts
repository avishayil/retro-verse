import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { usableExecutable, validateExecutable } from '../../security/paths';
import { run } from '../../util/proc';

export interface EdenInstall {
  executable: string;
  /** `cli` = SDL3 eden-cli (documented --game/--config); `qt` = desktop frontend (-g). */
  flavor: 'cli' | 'qt';
  version?: string;
}

export function edenFlavor(executable: string): 'cli' | 'qt' {
  return /(^|[-_])cli(\.exe)?$/i.test(path.basename(executable)) ? 'cli' : 'qt';
}

export function candidatePaths(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  const names = platform === 'win32' ? ['eden-cli.exe', 'eden.exe'] : ['eden-cli', 'eden'];
  const fromPath = (env.PATH ?? '')
    .split(path.delimiter)
    .filter((d) => d && path.isAbsolute(d))
    .flatMap((d) => names.map((n) => path.join(d, n)));
  const extra: string[] = [];
  if (platform === 'darwin') {
    for (const base of ['/Applications', path.join(home, 'Applications')]) {
      extra.push(path.join(base, 'Eden.app', 'Contents', 'MacOS', 'eden-cli'), path.join(base, 'Eden.app', 'Contents', 'MacOS', 'eden'));
    }
  } else if (platform === 'linux') {
    extra.push('/usr/bin/eden-cli', '/usr/local/bin/eden-cli', path.join(home, '.local', 'bin', 'eden-cli'));
  }
  // eden-cli preferred over the Qt frontend wherever both exist.
  // Standard install locations first, then PATH; within each group eden-cli before the Qt frontend.
  const byFlavor = (a: string, b: string) => Number(edenFlavor(b) === 'cli') - Number(edenFlavor(a) === 'cli');
  return [...new Set([...extra.sort(byFlavor), ...fromPath.sort(byFlavor)])];
}

async function probeVersion(executable: string): Promise<string | undefined> {
  const r = await run(executable, ['--version'], { timeoutMs: 4000 });
  if (r.code !== 0) return undefined;
  return `${r.stdout}\n${r.stderr}`.split('\n').map((s) => s.trim()).find(Boolean)?.slice(0, 120);
}

/**
 * Resolve the Eden executable. A configured path wins (and errors loudly if invalid); otherwise PATH and
 * standard install locations are searched. Only the CLI flavour is probed with --version, because running the
 * Qt frontend with unknown flags may open a window.
 */
export async function locateEden(configured: string | undefined): Promise<EdenInstall | undefined> {
  if (configured && configured.trim()) {
    const exe = await validateExecutable(configured.trim());
    const flavor = edenFlavor(exe);
    return { executable: exe, flavor, version: flavor === 'cli' ? await probeVersion(exe) : undefined };
  }
  for (const c of candidatePaths()) {
    const exe = await usableExecutable(c);
    if (exe) {
      const flavor = edenFlavor(exe);
      return { executable: exe, flavor, version: flavor === 'cli' ? await probeVersion(exe) : undefined };
    }
  }
  return undefined;
}

export interface EdenArgsOptions {
  configPath?: string;
  extraArgs?: readonly string[];
}

/** Build argv for Eden. Always an array passed with shell:false; the ROM path is a single argument. */
export function buildEdenArgs(install: EdenInstall, romPath: string, opts: EdenArgsOptions = {}): string[] {
  if (!path.isAbsolute(romPath)) throw new Error('ROM path must be absolute.');
  const extra = (opts.extraArgs ?? []).filter((a) => typeof a === 'string' && a.length > 0 && a.length < 512 && !a.includes('\0'));
  if (install.flavor === 'cli') {
    return [...extra, ...(opts.configPath ? ['--config', opts.configPath] : []), '--game', romPath];
  }
  return [...extra, '-g', romPath];
}

/** Eden user-data root (mods live in `load/`, saves under `nand/user/save`). */
export function edenDataDir(platform: NodeJS.Platform = process.platform, home = os.homedir(), env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string {
  if (platform === 'darwin') {
    // Eden's macOS builds use XDG-style ~/.local/share/eden; older builds used Application Support.
    const xdg = path.join(env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'eden');
    const legacy = path.join(home, 'Library', 'Application Support', 'eden');
    return exists(xdg) || !exists(legacy) ? xdg : legacy;
  }
  if (platform === 'win32') return path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'eden');
  return path.join(env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'eden');
}
