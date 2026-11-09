import * as vscode from 'vscode';
import path from 'node:path';
import { createHash } from 'node:crypto';
import os from 'node:os';

let channel: vscode.LogOutputChannel | undefined;

export function initLog(): vscode.LogOutputChannel {
  channel ??= vscode.window.createOutputChannel('RetroVerse', { log: true });
  return channel;
}

/** Replace file names with a short stable hash so diagnostics never leak game titles. */
export function redact(p: string): string {
  const base = path.basename(p);
  return `<file:${createHash('sha256').update(base).digest('hex').slice(0, 8)}${path.extname(base)}>`;
}

export const log = {
  debug: (m: string) => initLog().debug(m),
  info: (m: string) => initLog().info(m),
  warn: (m: string) => initLog().warn(m),
  error: (m: string, e?: unknown) => initLog().error(e ? `${m}: ${e instanceof Error ? e.message : String(e)}` : m),
  show: () => initLog().show(true),
};

/**
 * Make a line of native-process output safe to log or show: replaces the given sensitive paths (e.g. the game
 * file) with their redacted names, the home directory with ~, strips control characters (terminal escapes, NUL,
 * CR that could forge log lines) and caps the length.
 */
export function sanitizeLogLine(line: string, sensitivePaths: readonly string[] = [], home = os.homedir(), max = 500): string {
  let s = String(line);
  for (const p of [...sensitivePaths].filter(Boolean).sort((a, b) => b.length - a.length)) s = s.split(p).join(redact(p));
  if (home && home.length > 1) s = s.split(home).join('~');
  // eslint-disable-next-line no-control-regex
  s = s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  return s.length > max ? s.slice(0, max) + '…' : s;
}
