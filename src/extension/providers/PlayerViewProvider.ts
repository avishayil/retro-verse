import * as vscode from 'vscode';
import { log } from '../diagnostics/Log';
import { nonce as makeNonce } from '../security/tokens';
import { GameDocument } from './GameDocument';
import { attachPlayer, type AttachDeps, type PlayerAttachment, type PlayerSurface } from './GameEditorProvider';

export const PLAYER_VIEW_ID = 'retroverse.playerView';

const GAME_FILTERS = { Games: ['gba', 'nds', 'nsp', 'xci', 'nro'] };

/**
 * The RetroVerse view: a section of the Explorer (below the file tree; movable to the secondary side bar or
 * panel by dragging) that plays one game at a time,
 * so the editor area stays free for code. Games opened from the Explorer are routed here in sidebar mode.
 */
export class PlayerViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private viewReady: Promise<vscode.WebviewView>;
  private resolveView!: (v: vscode.WebviewView) => void;
  private current: PlayerAttachment | undefined;
  private idleListener: vscode.Disposable | undefined;
  private loading: Promise<void> = Promise.resolve();

  constructor(private readonly deps: () => AttachDeps) {
    this.viewReady = new Promise((r) => (this.resolveView = r));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.onDidDispose(() => {
      void this.current?.detach();
      this.current = undefined;
      this.view = undefined;
      this.viewReady = new Promise((r) => (this.resolveView = r));
    });
    if (!this.current) this.showIdle();
    this.resolveView(view);
  }

  /** Play a game in the view (revealing it), replacing whatever is playing. Serialised. */
  load(uri: vscode.Uri): Promise<void> {
    this.loading = this.loading.then(() => this.doLoad(uri)).catch((e) => {
      log.error('sidebar load failed', e);
      void vscode.window.showErrorMessage(`RetroVerse: ${e instanceof Error ? e.message : String(e)}`);
    });
    return this.loading;
  }

  private async doLoad(uri: vscode.Uri): Promise<void> {
    if (uri.scheme !== 'file') throw new Error('RetroVerse can only open games from the local file system.');
    const document = GameDocument.create(uri);
    await vscode.commands.executeCommand(`${PLAYER_VIEW_ID}.focus`);
    const view = this.view ?? (await this.viewReady);
    await this.current?.detach();
    this.current = undefined;
    this.idleListener?.dispose();
    this.idleListener = undefined;
    const surface: PlayerSurface = {
      webview: view.webview,
      get visible() {
        return view.visible;
      },
      // Views have no "active" flag; visibility is the closest signal.
      get active() {
        return view.visible;
      },
      onDidChangeState: (l) => view.onDidChangeVisibility(l),
      onDidDispose: (l) => view.onDidDispose(l),
      setTitle: (title, description) => {
        view.title = title;
        view.description = description;
      },
    };
    this.current = await attachPlayer(surface, document, this.deps());
    void vscode.commands.executeCommand('setContext', 'retroverse.viewHasGame', true);
  }

  /** Stop the game in the view and return to the idle screen. */
  async close(): Promise<void> {
    await this.loading;
    await this.current?.detach();
    this.current = undefined;
    this.showIdle();
  }

  async openGamePicker(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Play', filters: GAME_FILTERS });
    if (picked?.[0]) await this.load(picked[0]);
  }

  private showIdle(): void {
    const view = this.view;
    if (!view) return;
    view.title = 'RetroVerse';
    view.description = undefined;
    void vscode.commands.executeCommand('setContext', 'retroverse.viewHasGame', false);
    const n = makeNonce();
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:12px;line-height:1.5}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;border-radius:3px;padding:6px 12px;cursor:pointer;font:inherit;width:100%}
button:hover{background:var(--vscode-button-hoverBackground)}
p{opacity:.85} kbd{font-family:var(--vscode-editor-font-family);border:1px solid var(--vscode-panel-border,#555);border-radius:3px;padding:0 4px}
</style></head><body>
<p>Play GBA, Nintendo DS and Switch games right here while you code.</p>
<button id="open">Open a game…</button>
<p>Or click a <kbd>.gba</kbd> <kbd>.nds</kbd> <kbd>.nsp</kbd> <kbd>.xci</kbd> <kbd>.nro</kbd> file in the Explorer.</p>
<p>Drag the divider above this section to give the game more room. Click the game to give it the keyboard; click your code to type again.</p>
<script nonce="${n}">
const vscode = acquireVsCodeApi();
document.getElementById('open').addEventListener('click', () => vscode.postMessage({ type: 'openGame' }));
</script></body></html>`;
    this.idleListener?.dispose();
    this.idleListener = view.webview.onDidReceiveMessage((m: { type?: unknown }) => {
      if (m?.type === 'openGame') void this.openGamePicker();
    });
  }

  dispose(): void {
    this.idleListener?.dispose();
    void this.current?.detach();
  }
}
