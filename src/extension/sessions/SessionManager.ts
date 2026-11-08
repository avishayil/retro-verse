import * as vscode from 'vscode';
import type { Capabilities, SessionStatus } from '../../protocol/types';
import { NO_CAPABILITIES } from '../../protocol/types';
import { log } from '../diagnostics/Log';
import type { CommandResult, HostSession, SessionCommand } from './Session';

/**
 * Owns all live sessions, tracks which one is "active" (last focused player) for palette commands,
 * and mirrors its status/capabilities into context keys used by `when` clauses.
 */
export class SessionManager implements vscode.Disposable {
  private readonly sessions = new Map<string, { session: HostSession; sub: vscode.Disposable }>();
  private activeId: string | undefined;

  register(session: HostSession): vscode.Disposable {
    const sub = session.onEvent((e) => {
      if (e.type === 'log') log[e.level](`[${session.id}] ${e.message}`);
      if (session.id === this.activeId) this.syncContext();
    });
    this.sessions.set(session.id, { session, sub });
    this.setActive(session.id);
    log.info(`[${session.id}] registered ${session.platform} session`);
    return new vscode.Disposable(() => this.unregister(session.id));
  }

  private unregister(id: string): void {
    const entry = this.sessions.get(id);
    if (!entry) return;
    entry.sub.dispose();
    this.sessions.delete(id);
    if (this.activeId === id) this.activeId = [...this.sessions.keys()].at(-1);
    this.syncContext();
  }

  setActive(id: string): void {
    if (!this.sessions.has(id)) return;
    this.activeId = id;
    this.syncContext();
  }

  get active(): HostSession | undefined {
    return this.activeId ? this.sessions.get(this.activeId)?.session : undefined;
  }

  get all(): HostSession[] {
    return [...this.sessions.values()].map((e) => e.session);
  }

  async run(command: SessionCommand): Promise<CommandResult> {
    const s = this.active;
    if (!s) {
      void vscode.window.showInformationMessage('RetroVerse: no game is running.');
      return { ok: false, message: 'no active session' };
    }
    try {
      const r = await s.command(command);
      if (!r.ok && r.message) void vscode.window.showWarningMessage(`RetroVerse: ${r.message}`);
      return r;
    } catch (e) {
      log.error(`[${s.id}] command ${command} failed`, e);
      void vscode.window.showErrorMessage(`RetroVerse: ${command} failed.`);
      return { ok: false };
    }
  }

  private syncContext(): void {
    const s = this.active;
    const status: SessionStatus | 'none' = s ? s.status : 'none';
    const caps: Capabilities = s ? s.capabilities : NO_CAPABILITIES;
    void vscode.commands.executeCommand('setContext', 'retroverse.sessionActive', !!s && status !== 'stopped' && status !== 'error');
    void vscode.commands.executeCommand('setContext', 'retroverse.sessionStatus', status);
    for (const [k, v] of Object.entries(caps)) void vscode.commands.executeCommand('setContext', `retroverse.cap.${k}`, v);
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled(this.all.map((s) => s.stop()));
  }

  dispose(): void {
    for (const { sub } of this.sessions.values()) sub.dispose();
    this.sessions.clear();
  }
}
