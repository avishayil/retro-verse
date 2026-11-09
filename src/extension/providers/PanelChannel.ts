import type * as vscode from 'vscode';
import type { HostToPlayer, PlayerCommand } from '../../protocol/messages';
import type { PlayerChannel } from '../sessions/Session';

let seq = 0;

export class PanelChannel implements PlayerChannel {
  private readonly pending = new Map<string, { resolve: (r: { ok: boolean; error?: string }) => void; timer: NodeJS.Timeout }>();
  private disposed = false;

  constructor(readonly webview: vscode.Webview) {}

  async post(msg: HostToPlayer): Promise<boolean> {
    if (this.disposed) return false;
    try {
      return await this.webview.postMessage(msg);
    } catch {
      return false;
    }
  }

  request(command: PlayerCommand, extra?: { slot?: number; data?: Uint8Array }, timeoutMs = 5000): Promise<{ ok: boolean; error?: string }> {
    const id = `h-${++seq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: `Player did not respond to ${command}.` });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      void this.post({ v: 1, type: 'command', id, payload: { command, ...extra } }).then((sent) => {
        if (!sent) this.settle(id, { ok: false, error: 'Player is not available.' });
      });
    });
  }

  settle(id: string | undefined, r: { ok: boolean; error?: string }): void {
    if (!id) return;
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(r);
  }

  dispose(): void {
    this.disposed = true;
    for (const [id] of this.pending) this.settle(id, { ok: false, error: 'Player closed.' });
  }
}
