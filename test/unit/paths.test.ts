import { mkdtemp, mkdir, symlink, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { isWithin, validateExecutable, validateRomPath } from '../../src/extension/security/paths';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'rv-paths-'));
  await mkdir(path.join(dir, 'roms'));
  await mkdir(path.join(dir, 'outside'));
  await writeFile(path.join(dir, 'roms', 'ok.gba'), Buffer.alloc(1024, 1));
  await writeFile(path.join(dir, 'roms', `we"ird <name>'; rm -rf $(x).gba`), Buffer.alloc(16, 1));
  await writeFile(path.join(dir, 'outside', 'secret.gba'), Buffer.alloc(16, 1));
  await writeFile(path.join(dir, 'roms', 'empty.gba'), Buffer.alloc(0));
  await symlink(path.join(dir, 'outside', 'secret.gba'), path.join(dir, 'roms', 'link.gba'));
  await writeFile(path.join(dir, 'tool'), '#!/bin/sh\n');
  await chmod(path.join(dir, 'tool'), 0o755);
  await writeFile(path.join(dir, 'notexec'), 'x');
});

describe('validateRomPath', () => {
  it('accepts a regular file and returns its canonical path', async () => {
    const r = await validateRomPath(path.join(dir, 'roms', 'ok.gba'), 'gba');
    expect(r.size).toBe(1024);
    expect(path.isAbsolute(r.realPath)).toBe(true);
  });

  it('treats shell/HTML metacharacters in names as plain data', async () => {
    const r = await validateRomPath(path.join(dir, 'roms', `we"ird <name>'; rm -rf $(x).gba`), 'gba');
    expect(r.realPath.endsWith(`we"ird <name>'; rm -rf $(x).gba`)).toBe(true);
  });

  it('rejects relative paths, NUL bytes, directories, empty and missing files', async () => {
    await expect(validateRomPath('roms/ok.gba', 'gba')).rejects.toThrow(/absolute/);
    await expect(validateRomPath(path.join(dir, 'a\0b.gba'), 'gba')).rejects.toThrow();
    await expect(validateRomPath(path.join(dir, 'roms'), 'gba')).rejects.toThrow(/regular file/);
    await expect(validateRomPath(path.join(dir, 'roms', 'empty.gba'), 'gba')).rejects.toThrow(/empty/);
    await expect(validateRomPath(path.join(dir, 'roms', 'missing.gba'), 'gba')).rejects.toThrow(/not found/);
  });

  it('rejects traversal and symlink escapes outside allowed roots', async () => {
    const roots = [path.join(dir, 'roms')];
    await expect(validateRomPath(path.join(dir, 'roms', '..', 'outside', 'secret.gba'), 'gba', roots)).rejects.toThrow(/outside/);
    await expect(validateRomPath(path.join(dir, 'roms', 'link.gba'), 'gba', roots)).rejects.toThrow(/outside/);
    await expect(validateRomPath(path.join(dir, 'roms', 'ok.gba'), 'gba', roots)).resolves.toBeTruthy();
  });

  it('enforces platform size caps', async () => {
    const big = path.join(dir, 'roms', 'big.gba');
    await writeFile(big, Buffer.alloc(64 * 1024 * 1024 + 1));
    await expect(validateRomPath(big, 'gba')).rejects.toThrow(/too large/);
  });
});

describe('isWithin', () => {
  it('handles prefixes correctly', () => {
    expect(isWithin('/a/b', '/a/b/c')).toBe(true);
    expect(isWithin('/a/b', '/a/b')).toBe(true);
    expect(isWithin('/a/b', '/a/bc')).toBe(false);
    expect(isWithin('/a/b', '/a/b/../c')).toBe(false);
  });
});

describe('validateExecutable', () => {
  it('requires an absolute, existing, executable file', async () => {
    await expect(validateExecutable(path.join(dir, 'tool'))).resolves.toContain('tool');
    await expect(validateExecutable(path.join(dir, 'notexec'))).rejects.toThrow(/Not executable/);
    await expect(validateExecutable('tool')).rejects.toThrow(/absolute/);
    await expect(validateExecutable(path.join(dir, 'nope'))).rejects.toThrow(/not found/);
  });
});
