import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bridgeArgs, parseBridgeLine } from '../../src/extension/adapters/eden/BridgeClient';
import { buildEdenArgs, candidatePaths, edenDataDir, edenFlavor, locateEden } from '../../src/extension/adapters/eden/EdenLocator';
import { effectiveKeymap } from '../../src/extension/adapters/eden/keyboardMap';
import { ProcessSupervisor } from '../../src/extension/adapters/eden/ProcessSupervisor';

describe('EdenLocator', () => {
  it('classifies frontends', () => {
    expect(edenFlavor('/opt/eden/eden-cli')).toBe('cli');
    expect(edenFlavor('C:/eden/eden-cli.exe')).toBe('cli');
    expect(edenFlavor('/Applications/Eden.app/Contents/MacOS/eden')).toBe('qt');
  });

  it('prefers eden-cli and searches standard macOS locations', () => {
    const c = candidatePaths('darwin', { PATH: '/usr/local/bin:relative/dir' }, '/Users/me');
    expect(c[0].endsWith('eden-cli')).toBe(true);
    expect(c).toContain('/Applications/Eden.app/Contents/MacOS/eden');
    expect(c.some((p) => p.startsWith('relative'))).toBe(false);
  });

  it('builds argv without a shell and keeps the ROM a single argument', () => {
    const rom = `/games/My "Game"; rm -rf ~.nsp`;
    expect(buildEdenArgs({ executable: '/x/eden-cli', flavor: 'cli' }, rom)).toEqual(['--game', rom]);
    expect(buildEdenArgs({ executable: '/x/eden-cli', flavor: 'cli' }, rom, { configPath: '/c.ini', extraArgs: ['-f', '', 'a\0b'] })).toEqual(['-f', '--config', '/c.ini', '--game', rom]);
    expect(buildEdenArgs({ executable: '/x/eden', flavor: 'qt' }, rom)).toEqual(['-g', rom]);
    expect(() => buildEdenArgs({ executable: '/x/eden', flavor: 'qt' }, 'rel.nsp')).toThrow();
  });

  it('honours a configured executable and probes the CLI version', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rv-eden-'));
    const exe = path.join(dir, 'eden-cli');
    await writeFile(exe, '#!/bin/sh\necho "eden 0.0.9-test"\n');
    await chmod(exe, 0o755);
    const r = await locateEden(exe);
    expect(r?.flavor).toBe('cli');
    expect(r?.version).toBe('eden 0.0.9-test');
    await expect(locateEden(path.join(dir, 'missing'))).rejects.toThrow();
  });

  it('knows the Eden data directory per OS', () => {
    expect(edenDataDir('darwin', '/Users/me', {}, () => false)).toBe('/Users/me/.local/share/eden');
    expect(edenDataDir('darwin', '/Users/me', {}, (p) => p.includes('Application Support'))).toBe('/Users/me/Library/Application Support/eden');
    expect(edenDataDir('linux', '/home/me', {})).toBe('/home/me/.local/share/eden');
  });
});

describe('ProcessSupervisor', () => {
  it('stops a process that ignores SIGTERM by escalating to SIGKILL', async () => {
    const p = new ProcessSupervisor('/bin/sh', ['-c', 'trap "" TERM; echo started >&2; while true; do sleep 0.05; done']);
    await p.start();
    await new Promise((r) => setTimeout(r, 150));
    const t0 = Date.now();
    const info = await p.stop(300);
    expect(info?.expected).toBe(true);
    expect(info?.signal).toBe('SIGKILL');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(info?.stderrTail).toContain('started');
  });

  it('pauses and resumes with SIGSTOP/SIGCONT', async () => {
    const p = new ProcessSupervisor('/bin/sleep', ['5']);
    await p.start();
    expect(p.pause()).toBe(true);
    expect(p.resume()).toBe(true);
    const info = await p.stop(1000);
    expect(info?.signal).toBe('SIGTERM');
  });

  it('reports unexpected exits', async () => {
    const p = new ProcessSupervisor('/bin/sh', ['-c', 'echo boom >&2; exit 3']);
    const exited = new Promise((r) => p.once('exit', r));
    await p.start();
    const info = (await exited) as { code: number; expected: boolean; stderrTail: string[] };
    expect(info.code).toBe(3);
    expect(info.expected).toBe(false);
    expect(info.stderrTail).toEqual(['boom']);
  });
});

describe('bridge protocol', () => {
  it('parses known events and rejects junk / bad ports', () => {
    expect(parseBridgeLine('{"type":"ready","port":50123}')).toEqual({ type: 'ready', port: 50123 });
    expect(parseBridgeLine('{"type":"ready","port":80}')).toBeUndefined();
    expect(parseBridgeLine('{"type":"exec"}')).toBeUndefined();
    expect(parseBridgeLine('not json')).toBeUndefined();
  });
  it('never puts the token on the command line', () => {
    const args = bridgeArgs({ pid: 42, token: 'SECRET', fps: 30, height: 720, bitrateKbps: 8000, keymap: { A: 'C' } });
    expect(args.join(' ')).not.toContain('SECRET');
    expect(args).toContain('42');
  });
  it('merges keymap overrides safely', () => {
    const m = effectiveKeymap({ A: 'P', 'B; rm': 'x', X: 'not valid!' });
    expect(m.A).toBe('P');
    expect(m.X).toBe('V');
    expect(Object.keys(m)).not.toContain('B; rm');
  });
});

import { edenEnvironment } from '../../src/extension/adapters/eden/edenEnv';

describe('Eden environment', () => {
  it('applies the MoltenVK stability defaults on macOS only', () => {
    const mac = edenEnvironment({ PATH: '/bin' }, {}, 'darwin');
    expect(mac.env.MVK_CONFIG_SYNCHRONOUS_QUEUE_SUBMITS).toBe('1');
    expect(mac.env.MVK_CONFIG_VK_SEMAPHORE_SUPPORT_STYLE).toBe('0');
    expect(mac.env.PATH).toBe('/bin');
    expect(edenEnvironment({}, {}, 'linux').env.MVK_CONFIG_SYNCHRONOUS_QUEUE_SUBMITS).toBeUndefined();
  });
  it('lets users override or remove defaults and add variables', () => {
    const r = edenEnvironment({}, { MVK_CONFIG_SYNCHRONOUS_QUEUE_SUBMITS: null, MVK_CONFIG_LOG_LEVEL: '1', FOO: 3 }, 'darwin');
    expect(r.env.MVK_CONFIG_SYNCHRONOUS_QUEUE_SUBMITS).toBeUndefined();
    expect(r.env.MVK_CONFIG_LOG_LEVEL).toBe('1');
    expect(r.env.FOO).toBe('3');
  });
  it('refuses code-injection variables and strips host-only ones', () => {
    const r = edenEnvironment({ ELECTRON_RUN_AS_NODE: '1', RETROVERSE_BRIDGE_TOKEN: 'secret' }, { DYLD_INSERT_LIBRARIES: '/tmp/x.dylib', LD_PRELOAD: 'x', 'BAD NAME': 'x' }, 'darwin');
    expect(r.env.DYLD_INSERT_LIBRARIES).toBeUndefined();
    expect(r.env.LD_PRELOAD).toBeUndefined();
    expect(r.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(r.env.RETROVERSE_BRIDGE_TOKEN).toBeUndefined();
    expect(r.rejected.sort()).toEqual(['BAD NAME', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD']);
  });
  it('strips VS Code internals and refuses PATH/HOME/XDG overrides from settings', () => {
    const r = edenEnvironment({ PATH: '/usr/bin', VSCODE_IPC_HOOK: '/tmp/x.sock', ELECTRON_NO_ATTACH_CONSOLE: '1', RETROVERSE_X: '1', LANG: 'en_US.UTF-8' }, { PATH: '/tmp/evil', HOME: '/tmp', XDG_CONFIG_HOME: '/tmp/cfg', NODE_OPTIONS: '--require x', MVK_CONFIG_LOG_LEVEL: '2' }, 'darwin');
    expect(r.env.PATH).toBe('/usr/bin');
    expect(r.env.HOME).toBeUndefined();
    expect(r.env.XDG_CONFIG_HOME).toBeUndefined();
    expect(r.env.VSCODE_IPC_HOOK).toBeUndefined();
    expect(r.env.ELECTRON_NO_ATTACH_CONSOLE).toBeUndefined();
    expect(r.env.RETROVERSE_X).toBeUndefined();
    expect(r.env.LANG).toBe('en_US.UTF-8');
    expect(r.env.MVK_CONFIG_LOG_LEVEL).toBe('2');
    expect(r.rejected.sort()).toEqual(['HOME', 'NODE_OPTIONS', 'PATH', 'XDG_CONFIG_HOME']);
  });
  it('gives the capture agent only an allow-listed environment', async () => {
    const { minimalEnvironment } = await import('../../src/extension/adapters/eden/edenEnv');
    const env = minimalEnvironment({ PATH: '/opt/evil:/usr/bin', HOME: '/Users/me', AWS_SECRET_ACCESS_KEY: 'x', VSCODE_PID: '1', LANG: 'C' });
    expect(Object.keys(env).sort()).toEqual(['HOME', 'LANG', 'PATH']);
    expect(env.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
  });
});

import { parseEdenKeymap, qtKeyName } from '../../src/extension/adapters/eden/EdenConfig';

describe('Eden keyboard bindings', () => {
  const ini = [
    'player_0_button_a\\default=true',
    'player_0_button_a="engine:keyboard,toggle:0,code:67"',
    'player_0_button_dup="engine:keyboard,toggle:0,code:16777235"',
    'player_0_button_plus="engine:keyboard,toggle:0,code:77"',
    'player_0_button_home="engine:keyboard,toggle:0,code:0"',
    'player_0_button_b="engine:sdl,port:0,guid:abc,button:1"',
    'player_0_lstick="engine:analog_from_button,modifier:engine$0keyboard$1toggle$00$1code$016777248,up:engine$0keyboard$1toggle$00$1code$087,down:engine$0keyboard$1toggle$00$1code$083,left:engine$0keyboard$1toggle$00$1code$065,right:engine$0keyboard$1toggle$00$1code$068,modifier_scale:0.500000"',
    'player_0_rstick="engine:mouse,axis_x:0,axis_y:1"',
    'player_1_button_a="engine:keyboard,toggle:0,code:80"',
  ].join('\n');
  it('maps buttons and keyboard-emulated sticks from player 1, skipping unbound/non-keyboard ones', () => {
    expect(parseEdenKeymap(ini)).toEqual({ A: 'C', Up: 'UpArrow', Start: 'M', LUp: 'W', LDown: 'S', LLeft: 'A', LRight: 'D' });
  });
  it('translates Qt key codes', () => {
    expect(qtKeyName(67)).toBe('C');
    expect(qtKeyName(16777234)).toBe('LeftArrow');
    expect(qtKeyName(0x01000030 + 4)).toBe('F5');
    expect(qtKeyName(0)).toBeUndefined();
  });
  it('config bindings override defaults; user settings override both', () => {
    expect(effectiveKeymap({}, { A: 'P' }).A).toBe('P');
    expect(effectiveKeymap({ A: 'K' }, { A: 'P' }).A).toBe('K');
    expect(effectiveKeymap({}, {}).LUp).toBe('W');
  });
});
