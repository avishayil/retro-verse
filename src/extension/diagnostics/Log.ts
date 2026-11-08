import * as vscode from 'vscode';
import path from 'node:path';
import { createHash } from 'node:crypto';

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
