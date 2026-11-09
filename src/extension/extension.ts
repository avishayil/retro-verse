import * as vscode from 'vscode';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { DevStreamSession } from './adapters/eden/DevStreamSession';
import { edenAdapter } from './adapters/eden/EdenAdapter';
import { listWindows } from './adapters/eden/BridgeClient';
import { resolveBridgePath } from './adapters/eden/StreamSession';
import { melonDsAdapter, mgbaAdapter } from './adapters/wasm/cores';
import { initLog, log } from './diagnostics/Log';
import { attachPlayer, GameEditorProvider, panelSurface, playerLocation, VIEW_TYPE } from './providers/GameEditorProvider';
import { PLAYER_VIEW_ID, PlayerViewProvider } from './providers/PlayerViewProvider';
import { GameDocument } from './providers/GameDocument';
import { EmulatorRegistry } from './registry/EmulatorRegistry';
import { SessionManager } from './sessions/SessionManager';
import type { SessionCommand } from './sessions/Session';
import { cfg, userSetting } from './settings';
import { checkSavesDirectory, SaveStore } from './storage/SaveStore';
import { registerAndroidSync } from './sync/commands';

let manager: SessionManager | undefined;

/** Returned for integration tests; not a stable public API. */
export interface RetroVerseApi {
  sessions: SessionManager;
}

export function activate(context: vscode.ExtensionContext): RetroVerseApi {
  context.subscriptions.push(initLog());
  const registry = new EmulatorRegistry();
  registry.register(mgbaAdapter(context.extensionUri));
  registry.register(melonDsAdapter(context.extensionUri));
  registry.register(edenAdapter(context.globalStorageUri));

  manager = new SessionManager();
  context.subscriptions.push(manager);

  const defaultSaves = path.join(context.globalStorageUri.fsPath, 'saves');
  let refusedSavesDir = '';
  const saves = () => {
    const custom = userSetting<string>('storage.savesDirectory', '').trim();
    if (!custom) return new SaveStore(defaultSaves);
    const workspaces = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
    const checked = checkSavesDirectory(custom, workspaces, realpathSync);
    if (checked.ok) return new SaveStore(checked.dir);
    if (refusedSavesDir !== custom) {
      refusedSavesDir = custom;
      log.warn(`security: ignoring retroverse.storage.savesDirectory (${checked.reason}); using the default location`);
      void vscode.window.showWarningMessage(`RetroVerse is not using your custom saves folder because ${checked.reason}. Saves go to the default location instead.`);
    }
    return new SaveStore(defaultSaves);
  };
  // Changing this requires a window reload; VS Code fixes webview options at registration.
  const retain = cfg().get('player.retainContextWhenHidden', true);

  const sessions = manager;
  const sidebar = new PlayerViewProvider(() => ({ extensionUri: context.extensionUri, registry, sessions, saves: saves(), retainContextWhenHidden: true }));
  context.subscriptions.push(
    sidebar,
    // The view keeps running while collapsed or behind another view (games must not reload when you switch views).
    vscode.window.registerWebviewViewProvider(PLAYER_VIEW_ID, sidebar, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new GameEditorProvider(context.extensionUri, registry, manager, saves, retain, (uri) => sidebar.load(uri)), {
      webviewOptions: { retainContextWhenHidden: retain, enableFindWidget: false },
      supportsMultipleEditorsPerDocument: false,
    }),
  );

  const m = manager;
  const sessionCommand = (id: string, c: SessionCommand) => vscode.commands.registerCommand(id, () => m.run(c));
  context.subscriptions.push(
    sessionCommand('retroverse.pause', 'pause'),
    sessionCommand('retroverse.resume', 'resume'),
    sessionCommand('retroverse.reset', 'reset'),
    sessionCommand('retroverse.stop', 'stop'),
    sessionCommand('retroverse.quickSave', 'quickSave'),
    sessionCommand('retroverse.quickLoad', 'quickLoad'),
    sessionCommand('retroverse.openMods', 'openMods'),
    sessionCommand('retroverse.openSaves', 'openSaves'),
    vscode.commands.registerCommand('retroverse.play', async (uri?: vscode.Uri) => {
      const target =
        uri ??
        (
          await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Play',
            filters: { Games: ['gba', 'nds', 'nsp', 'xci', 'nro'] },
          })
        )?.[0];
      if (!target) return;
      if (playerLocation() === 'sidebar') await sidebar.load(target);
      else await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    }),
    vscode.commands.registerCommand('retroverse.playInEditor', async (uri?: vscode.Uri) => {
      if (uri) await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
    }),
    vscode.commands.registerCommand('retroverse.closeGame', () => sidebar.close()),
    vscode.commands.registerCommand('retroverse.settings', () => vscode.commands.executeCommand('workbench.action.openSettings', 'retroverse')),
    vscode.commands.registerCommand('retroverse.showDiagnostics', async () => {
      log.info(`--- diagnostics: VS Code ${vscode.version}, ${process.platform}-${process.arch}, trusted=${vscode.workspace.isTrusted}, remote=${vscode.env.remoteName ?? 'none'}`);
      for (const p of ['gba', 'nds', 'switch'] as const) {
        for (const a of registry.list(p)) {
          const r = await a.probe();
          log.info(`adapter ${a.id} (${p}): ${r.available ? 'available' : 'unavailable'}${r.version ? ' ' + r.version : ''}${r.reason ? ' — ' + r.reason : ''}`);
        }
      }
      log.info(`bridge: ${resolveBridgePath(context.extensionUri) ? 'found' : 'not built'}`);
      log.info(`sessions: ${m.all.map((s) => `${s.id}:${s.platform}:${s.status}`).join(', ') || 'none'}`);
      log.show();
    }),
    vscode.commands.registerCommand('retroverse.dev.streamProcess', () => devStream(context, registry, m, saves(), retain)),
    ...registerAndroidSync(context, saves, m),
  );

  const syncDev = () => void vscode.commands.executeCommand('setContext', 'retroverse.devMode', userSetting('diagnostics.devMode', false));
  syncDev();
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('retroverse.diagnostics.devMode') && syncDev()));
  log.info('RetroVerse activated');
  return { sessions: m };
}

async function devStream(context: vscode.ExtensionContext, registry: EmulatorRegistry, m: SessionManager, saves: SaveStore, retain: boolean): Promise<void> {
  if (process.platform !== 'darwin') return void vscode.window.showWarningMessage('The stream test is macOS-only.');
  const exe = resolveBridgePath(context.extensionUri);
  if (!exe) return void vscode.window.showWarningMessage('eden-bridge is not built. Run "npm run build:native".');
  let windows;
  try {
    windows = await listWindows(exe);
  } catch (e) {
    return void vscode.window.showErrorMessage(`Could not list windows (Screen Recording permission?): ${e instanceof Error ? e.message : String(e)}`);
  }
  const pick = await vscode.window.showQuickPick(
    windows.map((w) => ({ label: w.app, description: `${w.title} — ${w.width}×${w.height}`, detail: `pid ${w.pid}`, w })),
    { placeHolder: 'Choose an app window to stream into a player tab' },
  );
  if (!pick) return;
  // Window capture shows everything in that window (and its audio); make the choice explicit every time.
  const ok = await vscode.window.showWarningMessage(
    `Stream the window "${pick.w.title || pick.w.app}" of ${pick.w.app} into VS Code?`,
    { modal: true, detail: 'RetroVerse will capture everything that window shows and plays until you close the stream tab. Nothing leaves this computer.' },
    'Stream',
  );
  if (ok !== 'Stream') return;
  const panel = vscode.window.createWebviewPanel('retroverse.devStream', `Stream: ${pick.w.app}`, vscode.ViewColumn.Active, { retainContextWhenHidden: true });
  const doc = new GameDocument(vscode.Uri.parse('retroverse-dev:/stream-test.nro'), { platform: 'switch', extension: '.nro', label: 'Stream test' });
  await attachPlayer(panelSurface(panel), doc, {
    extensionUri: context.extensionUri,
    registry,
    sessions: m,
    saves,
    retainContextWhenHidden: retain,
    createSession: async (ctx) => new DevStreamSession(ctx, pick.w.pid),
  });
}

export async function deactivate(): Promise<void> {
  // Never leave Eden or the bridge running after VS Code closes or reloads.
  await manager?.stopAll();
}
