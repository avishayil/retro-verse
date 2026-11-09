// Validation and quoting for paths and package names that end up in an `adb shell` command line. adb joins
// shell arguments into one string that the phone's /system/bin/sh parses, so anything placed there must be
// impossible to interpret as shell syntax: a strict character allowlist, then single quotes.

const REMOTE_ROOTS = ['/storage/', '/sdcard/'];
// Letters and digits in any script (game names like "Pokémon"), plus a few punctuation marks seen in ROM names.
// Excludes quotes, $, `, \, ;, |, <, >, *, ?, newlines and every other control character.
const REMOTE_PATH = /^[\p{L}\p{N} ._()+&,[\]/-]+$/u;
const PACKAGE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/;

export class RemotePathError extends Error {}

/** Throws unless `p` is a plain absolute path in shared storage on the phone. Returns it normalised. */
export function validateRemotePath(p: string): string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 512) throw new RemotePathError('The phone path is empty or too long.');
  if (!REMOTE_ROOTS.some((r) => p.startsWith(r))) throw new RemotePathError('The phone path must start with /storage/ or /sdcard/.');
  if (!REMOTE_PATH.test(p)) throw new RemotePathError('The phone path contains characters RetroVerse does not allow (quotes, $, ; and similar).');
  const parts = p.split('/');
  if (parts.some((s) => s === '..' || s === '.')) throw new RemotePathError('The phone path must not contain . or .. segments.');
  if (p.endsWith('/')) throw new RemotePathError('The phone path must point at a file.');
  return p.replace(/\/{2,}/g, '/');
}

export function isRemotePath(p: string): boolean {
  try {
    validateRemotePath(p);
    return true;
  } catch {
    return false;
  }
}

export function validatePackage(pkg: string): string {
  if (typeof pkg !== 'string' || pkg.length > 120 || !PACKAGE.test(pkg)) throw new RemotePathError(`Not a valid Android package name: ${String(pkg).slice(0, 40)}`);
  return pkg;
}

/** Quote a validated remote path for the phone shell. */
export function q(p: string): string {
  return `'${validateRemotePath(p)}'`;
}
