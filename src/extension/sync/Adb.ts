import { homedir } from 'node:os';
import path from 'node:path';
import { usableExecutable, validateExecutable } from '../security/paths';
import { run, type RunResult } from '../util/proc';
import { isRemotePath, q, validatePackage, validateRemotePath } from './remote';

export interface AdbDevice {
  serial: string;
  state: string;
  model?: string;
}

export function adbCandidates(home = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  const fromPath = (env.PATH ?? '')
    .split(path.delimiter)
    .filter((d) => d && path.isAbsolute(d))
    .map((d) => path.join(d, 'adb'));
  const sdk = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT].filter((d): d is string => !!d && path.isAbsolute(d)).map((d) => path.join(d, 'platform-tools', 'adb'));
  return [...new Set([path.join(home, 'Library', 'Android', 'sdk', 'platform-tools', 'adb'), ...sdk, '/opt/homebrew/bin/adb', '/usr/local/bin/adb', ...fromPath])];
}

/** Resolve adb. A configured path wins and must pass the executable checks; otherwise standard locations, then PATH. */
export async function locateAdb(configured: string): Promise<string | undefined> {
  if (configured.trim()) return validateExecutable(configured.trim());
  for (const c of adbCandidates()) {
    const exe = await usableExecutable(c);
    if (exe) return exe;
  }
  return undefined;
}

export class AdbError extends Error {}

export interface RemoteFile {
  path: string;
  /** Seconds since the epoch. */
  mtime: number;
  size: number;
}

/** adb, run without a local shell. Remote shell commands are built only from fixed text and validated, quoted paths. */
export class Adb {
  constructor(
    readonly exe: string,
    readonly serial?: string,
  ) {
    if (serial !== undefined && !/^[\w.:-]{1,64}$/.test(serial)) throw new AdbError('Invalid device serial.');
  }

  withDevice(serial: string): Adb {
    return new Adb(this.exe, serial);
  }

  private exec(args: string[], timeoutMs = 20_000): Promise<RunResult> {
    return run(this.exe, this.serial ? ['-s', this.serial, ...args] : args, { timeoutMs });
  }

  private async ok(args: string[], what: string, timeoutMs?: number): Promise<RunResult> {
    const r = await this.exec(args, timeoutMs);
    if (r.timedOut) throw new AdbError(`adb timed out while trying to ${what}.`);
    if (r.code !== 0) throw new AdbError(`adb could not ${what}: ${(r.stderr || r.stdout).trim().split('\n').pop()?.slice(0, 200) ?? 'unknown error'}`);
    return r;
  }

  async devices(): Promise<AdbDevice[]> {
    const r = await this.ok(['devices', '-l'], 'list devices', 10_000);
    return r.stdout
      .split('\n')
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [serial = '', state = '', ...rest] = l.split(/\s+/);
        const model = rest.find((x) => x.startsWith('model:'))?.slice(6);
        return { serial, state, model };
      })
      .filter((d) => /^[\w.:-]{1,64}$/.test(d.serial));
  }

  private shell(command: string, what: string, timeoutMs?: number): Promise<RunResult> {
    return this.ok(['shell', command], what, timeoutMs);
  }

  /** Size and modification time (seconds) of a phone file, or undefined if it does not exist. */
  async stat(remote: string): Promise<{ size: number; mtime: number } | undefined> {
    const r = await this.exec(['shell', `stat -c '%s %Y' ${q(remote)} 2>/dev/null || echo missing`]);
    if (r.timedOut || r.code !== 0) throw new AdbError('adb could not read the save on the phone.');
    const m = /^(\d+) (\d+)\s*$/.exec(r.stdout.trim());
    return m ? { size: Number(m[1]), mtime: Number(m[2]) } : undefined;
  }

  async pull(remote: string, local: string): Promise<void> {
    await this.ok(['pull', validateRemotePath(remote), local], 'copy the save from the phone', 60_000);
  }

  /** Push to a temporary name, then move it into place and touch it (Android sometimes keeps the old time). */
  async pushInto(local: string, remote: string): Promise<void> {
    const tmp = `${validateRemotePath(remote)}.retroverse-tmp`;
    await this.ok(['push', local, tmp], 'copy the save to the phone', 60_000);
    await this.shell(`mv -f ${q(tmp)} ${q(remote)} && touch ${q(remote)}`, 'replace the save on the phone');
  }

  async forceStop(pkg: string): Promise<void> {
    await this.shell(`am force-stop ${validatePackage(pkg)}`, `stop ${pkg}`);
  }

  async packages(): Promise<string[]> {
    const r = await this.shell('pm list packages', 'list installed apps');
    return r.stdout
      .split('\n')
      .map((l) => l.trim().replace(/^package:/, ''))
      .filter((p) => /^[a-zA-Z][\w.]{1,119}$/.test(p));
  }

  /** Files under `roots` whose names end in one of `extensions`, with size and time (bounded depth and output). */
  async find(roots: string[], extensions: string[], maxDepth = 4): Promise<RemoteFile[]> {
    const names = extensions.map((e) => {
      if (!/^\.[a-z0-9]{1,5}$/.test(e)) throw new AdbError('Invalid extension.');
      return `-iname '*${e}'`;
    });
    const depth = Math.min(6, Math.max(1, maxDepth | 0));
    const cmd = `find ${roots.map(q).join(' ')} -maxdepth ${depth} -type f \\( ${names.join(' -o ')} \\) -exec stat -c '%Y %s %n' {} + 2>/dev/null | head -n 400`;
    const r = await this.exec(['shell', cmd], 30_000);
    if (r.timedOut) throw new AdbError('Searching the phone took too long.');
    const out: RemoteFile[] = [];
    for (const line of r.stdout.split('\n')) {
      const m = /^(\d+) (\d+) (\/.+)$/.exec(line.trim());
      if (m && isRemotePath(m[3]!)) out.push({ path: m[3]!, mtime: Number(m[1]), size: Number(m[2]) });
    }
    return out;
  }
}
