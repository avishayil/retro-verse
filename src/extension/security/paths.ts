import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Platform } from '../../protocol/types';

export const MAX_ROM_BYTES: Record<Platform, number> = {
  gba: 64 * 1024 * 1024,
  nds: 1024 * 1024 * 1024,
  switch: Number.MAX_SAFE_INTEGER, // never read by the extension; Eden opens it
};

export class PathValidationError extends Error {}

export interface ValidatedRom {
  /** Canonical absolute path (symlinks resolved). */
  realPath: string;
  size: number;
}

/**
 * Validate a game file before it is exposed to the webview or a native process.
 * - must be an absolute local path
 * - symlinks are resolved; the canonical target must be a regular file
 * - when allowedRoots is non-empty, the canonical path must lie within one of them
 * - must not exceed the platform size cap
 */
export async function validateRomPath(fsPath: string, platform: Platform, allowedRoots: readonly string[] = []): Promise<ValidatedRom> {
  if (!path.isAbsolute(fsPath)) throw new PathValidationError('Game path must be absolute.');
  if (fsPath.includes('\0')) throw new PathValidationError('Invalid game path.');
  let real: string;
  try {
    real = await realpath(fsPath);
  } catch {
    throw new PathValidationError('Game file not found.');
  }
  const st = await stat(real);
  if (!st.isFile()) throw new PathValidationError('Game path is not a regular file.');
  if (st.size === 0) throw new PathValidationError('Game file is empty.');
  if (st.size > MAX_ROM_BYTES[platform]) throw new PathValidationError(`Game file is too large for ${platform.toUpperCase()} (${st.size} bytes).`);
  if (allowedRoots.length > 0) {
    const roots = await Promise.all(allowedRoots.map((r) => realpath(r).catch(() => path.resolve(r))));
    if (!roots.some((r) => isWithin(r, real))) throw new PathValidationError('Game file resolves outside the allowed folders.');
  }
  return { realPath: real, size: st.size };
}

export function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Absolute path validation for user-configured executables. */
export async function validateExecutable(p: string): Promise<string> {
  if (!path.isAbsolute(p)) throw new PathValidationError('Executable path must be absolute.');
  const real = await realpath(p).catch(() => {
    throw new PathValidationError(`Executable not found: ${p}`);
  });
  const st = await stat(real);
  if (!st.isFile()) throw new PathValidationError(`Not a file: ${p}`);
  if ((st.mode & 0o111) === 0) throw new PathValidationError(`Not executable: ${p}`);
  assertSafeOwnership(real, st);
  // A world-writable folder (without the sticky bit) would let anyone swap the binary.
  const dir = await stat(path.dirname(real));
  if ((dir.mode & 0o002) !== 0 && (dir.mode & 0o1000) === 0) throw new PathValidationError(`Refusing to run ${p}: its folder is writable by everyone.`);
  return real;
}

/**
 * Only run programs that nobody else could have modified: owned by the current user or root, and not writable by
 * group or others. Skipped on Windows, where these POSIX permission bits do not apply.
 */
export function assertSafeOwnership(p: string, st: { uid: number; mode: number }, uid = process.getuid?.()): void {
  if (process.platform === 'win32' || uid === undefined) return;
  if (st.uid !== uid && st.uid !== 0) throw new PathValidationError(`Refusing to run ${p}: it is owned by another user.`);
  if ((st.mode & 0o022) !== 0) throw new PathValidationError(`Refusing to run ${p}: it is writable by other users.`);
}
