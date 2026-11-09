import * as vscode from 'vscode';
import path from 'node:path';
import { parsePlayerMessage, type PlayerAction } from '../../protocol/messages';
import { log, redact } from '../diagnostics/Log';
import type { EmulatorRegistry } from '../registry/EmulatorRegistry';
import { checkMagic, HEADER_PROBE_BYTES } from '../registry/formats';
import type { HostSession, LaunchContext } from '../sessions/Session';
import type { SessionManager } from '../sessions/SessionManager';
import { playerSettings } from '../settings';
import { readHeader } from '../storage/RomIdentity';
import type { SaveStore } from '../storage/SaveStore';
import { playerHtml } from '../webview/html';
import { GameDocument } from './GameDocument';
import { PanelChannel } from './PanelChannel';

export const VIEW_TYPE = 'retroverse.player';

/** Where games play: the RetroVerse sidebar view (default) or an editor tab. */
export function playerLocation(): 'sidebar' | 'editor' {
  return vscode.workspace.getConfiguration('retroverse').get<'sidebar' | 'editor'>('player.location', 'sidebar');
}

/** Something that hosts the player webview: an editor tab (WebviewPanel) or the sidebar view (WebviewView). */
export interface PlayerSurface {
  readonly webview: vscode.Webview;
  readonly visible: boolean;
  /** Has keyboard focus / is the active editor. */
  readonly active: boolean;
  onDidChangeState(listener: () => void): vscode.Disposable;
  onDidDispose(listener: () => void): vscode.Disposable;
  setTitle?(title: string, description?: string): void;
}

export function panelSurface(panel: vscode.WebviewPanel): PlayerSurface {
  return {
    webview: panel.webview,
    get visible() {
      return panel.visible;
    },
    get active() {
      return panel.active;
    },
    onDidChangeState: (l) => panel.onDidChangeViewState(l),
    onDidDispose: (l) => panel.onDidDispose(l),
  };
}

export interface PlayerAttachment {
  readonly session: HostSession;
  /** Stop the session and unhook it from the surface (the surface itself stays). */
  detach(): Promise<void>;
}

export class GameEditorProvider implements vscode.CustomReadonlyEditorProvider<GameDocument> {
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly registry: EmulatorRegistry,
    private readonly sessions: SessionManager,
    private readonly saves: () => SaveStore,
    private readonly retainContextWhenHidden: boolean,
    /** In sidebar mode, games opened as files are handed to the sidebar view instead. */
    private readonly playInSidebar?: (uri: vscode.Uri) => Promise<void>,
  ) {}

  openCustomDocument(uri: vscode.Uri): GameDocument {
    if (uri.scheme !== 'file') throw new Error('RetroVerse can only open games from the local file system.');
    return GameDocument.create(uri);
  }

  async resolveCustomEditor(document: GameDocument, panel: vscode.WebviewPanel): Promise<void> {
    if (this.playInSidebar && playerLocation() === 'sidebar') {
      // Hand the game to the RetroVerse view and close this tab, so the editor area stays free for code.
      panel.webview.html = '<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);padding:2em">Opening in the RetroVerse view…</body></html>';
      await this.playInSidebar(document.uri);
      setTimeout(() => panel.dispose(), 0);
      return;
    }
    const attachment = await attachPlayer(panelSurface(panel), document, {
      extensionUri: this.extensionUri,
      registry: this.registry,
      sessions: this.sessions,
      saves: this.saves(),
      retainContextWhenHidden: this.retainContextWhenHidden,
    });
    panel.onDidDispose(() => void attachment.detach());
  }
}

export interface AttachDeps {
  extensionUri: vscode.Uri;
  registry: EmulatorRegistry;
  sessions: SessionManager;
  saves: SaveStore;
  retainContextWhenHidden: boolean;
  /** Override session creation (used by the developer stream command). */
  createSession?: (ctx: LaunchContext) => Promise<HostSession>;
}

/** Wire a player surface (editor tab or sidebar view) to a new session. */
export async function attachPlayer(surface: PlayerSurface, document: GameDocument, deps: AttachDeps): Promise<PlayerAttachment> {
  const platform = document.platform;
  // The webview may only load the extension's own bundles and emulator cores. Game files are streamed to it by the
  // host (rom.request / rom.chunk), so no user folder is ever readable from the webview.
  const roots = [vscode.Uri.joinPath(deps.extensionUri, 'dist'), vscode.Uri.joinPath(deps.extensionUri, 'media')];
  const webview = surface.webview;
  surface.setTitle?.(document.title, document.format.label);
  webview.options = { enableScripts: true, localResourceRoots: roots };
  webview.html = playerHtml(webview, deps.extensionUri);

  const channel = new PanelChannel(webview);
  let bridgePort: number | undefined;
  const ctx: LaunchContext = {
    document,
    channel,
    saves: deps.saves,
    extensionUri: deps.extensionUri,
    retainContextWhenHidden: deps.retainContextWhenHidden,
    allowBridgePort: (port) => {
      if (port === bridgePort) return;
      bridgePort = port;
      webview.html = playerHtml(webview, deps.extensionUri, { bridgePort: port });
    },
  };

  let session: HostSession;
  if (deps.createSession) {
    session = await deps.createSession(ctx);
  } else {
    const adapter = deps.registry.resolve(platform);
    if (!adapter) throw new Error(`No emulator registered for ${platform}.`);
    session = await adapter.start(ctx);
  }
  const registration = deps.sessions.register(session);
  const disposables: vscode.Disposable[] = [registration];

  // Header sanity check (warn only; homebrew headers are often imperfect).
  if (document.uri.scheme === 'file') {
    readHeader(document.uri.fsPath, HEADER_PROBE_BYTES)
      .then((hdr) => {
        const r = checkMagic(platform, document.format.extension, hdr);
        if (!r.ok) {
          log.warn(`[${session.id}] header check: ${r.reason} (${redact(document.uri.fsPath)})`);
          void channel.post({ v: 1, type: 'toast', payload: { level: 'warn', message: `This file does not look like a valid ${document.format.label} image: ${r.reason}` } });
        }
      })
      .catch(() => undefined);
  }

  disposables.push(
    webview.onDidReceiveMessage(async (raw: unknown) => {
      const parsed = parsePlayerMessage(raw);
      if (!parsed.ok) {
        log.warn(`[${session.id}] rejected webview message: ${parsed.error}`);
        return;
      }
      const msg = parsed.message;
      try {
        switch (msg.type) {
          case 'ready':
            await channel.post({ v: 1, type: 'init', payload: await session.init() });
            session.afterInit?.();
            break;
          case 'reply':
            channel.settle(msg.id, msg.payload);
            break;
          case 'input':
            await session.sendInput(msg.payload);
            break;
          case 'log':
            log[msg.payload.level === 'debug' ? 'debug' : msg.payload.level](`[${session.id}] webview: ${msg.payload.message}`);
            break;
          case 'action':
            await runAction(session, msg.payload.action);
            break;
          default:
            await session.handleMessage(msg);
        }
      } catch (e) {
        log.error(`[${session.id}] handling ${msg.type}`, e);
      }
    }),
    surface.onDidChangeState(() => {
      session.setVisible(surface.visible);
      if (surface.active || surface.visible) deps.sessions.setActive(session.id);
      void vscode.commands.executeCommand('setContext', 'retroverse.playerFocused', surface.active);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('retroverse.player') || e.affectsConfiguration('retroverse.input') || e.affectsConfiguration('retroverse.nds')) {
        void channel.post({ v: 1, type: 'settings', payload: playerSettings() });
      }
    }),
  );

  let detached: Promise<void> | undefined;
  const detach = () =>
    (detached ??= (async () => {
      try {
        await session.stop();
      } catch (e) {
        log.error(`[${session.id}] stop on detach`, e);
      }
      channel.dispose();
      (session as { dispose?: () => void }).dispose?.();
      for (const d of disposables) d.dispose();
    })());
  disposables.push(surface.onDidDispose(() => void detach()));
  return { session, detach };
}

async function runAction(session: HostSession, action: PlayerAction): Promise<void> {
  switch (action) {
    case 'pause':
    case 'resume':
    case 'reset':
    case 'quickSave':
    case 'quickLoad':
    case 'stop':
    case 'restart':
    case 'openMods':
    case 'openSaves': {
      const r = await session.command(action);
      if (!r.ok && r.message) void vscode.window.showWarningMessage(`RetroVerse: ${r.message}`);
      break;
    }
    case 'retry':
      await session.command('restart');
      break;
    case 'openSettings':
      await vscode.commands.executeCommand('workbench.action.openSettings', 'retroverse');
      break;
    case 'locateEden': {
      const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Use this Eden executable', title: 'Locate Eden (eden-cli or Eden.app)' });
      if (!picked?.[0]) return;
      let p = picked[0].fsPath;
      if (p.endsWith('.app')) p = path.join(p, 'Contents', 'MacOS', path.basename(p, '.app').toLowerCase());
      await vscode.workspace.getConfiguration('retroverse').update('switch.edenPath', p, vscode.ConfigurationTarget.Global);
      await session.command('restart');
      break;
    }
    case 'openScreenPrivacy':
      await vscode.env.openExternal(vscode.Uri.parse('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'));
      break;
    case 'openAccessibilityPrivacy':
      await vscode.env.openExternal(vscode.Uri.parse('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'));
      break;
  }
}
