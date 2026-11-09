import * as vscode from 'vscode';
import path from 'node:path';
import { log } from '../diagnostics/Log';
import { formatForPath } from '../registry/formats';
import { validateRomPath } from '../security/paths';
import type { SessionManager } from '../sessions/SessionManager';
import { userSetting } from '../settings';
import { romIdentity } from '../storage/RomIdentity';
import type { SaveStore } from '../storage/SaveStore';
import { Adb, locateAdb } from './Adb';
import { AndroidSync, SyncCancelled, type SyncGame, type SyncUi } from './AndroidSync';

const CORE_FOR: Record<string, string> = { gba: 'mgba', nds: 'melonds' };

const ui: SyncUi = {
  async pick(title, items) {
    const r = await vscode.window.showQuickPick(
      items.map((i) => ({ label: i.label, description: i.description, value: i.value })),
      { title, ignoreFocusOut: true },
    );
    return r?.value;
  },
  input: (prompt, value, validate) => Promise.resolve(vscode.window.showInputBox({ prompt, value, ignoreFocusOut: true, validateInput: validate })),
  ask: (message, detail, actions) => Promise.resolve(vscode.window.showWarningMessage(message, { modal: true, detail }, ...actions)),
  info: (m) => void vscode.window.showInformationMessage(m),
};

type Action = 'sync' | 'pull' | 'push' | 'location';

/** Commands that copy GBA and DS battery saves between RetroVerse and an Android phone over adb. Manual only. */
export function registerAndroidSync(context: vscode.ExtensionContext, saves: () => SaveStore, sessions: SessionManager): vscode.Disposable[] {
  const runAction = async (action: Action, uri?: vscode.Uri) => {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage('RetroVerse: syncing saves with a phone runs adb, so it needs a trusted workspace.');
      return;
    }
    try {
      const game = await resolveGame(uri, sessions);
      if (!game) return;
      if (action !== 'location' && !(await closeIfOpen(game.realPath, game.title, sessions))) return;
      const exe = await locateAdb(userSetting<string>('android.adbPath', ''));
      if (!exe) {
        const pick = await vscode.window.showErrorMessage('RetroVerse could not find adb. Install Android platform-tools (for example "brew install android-platform-tools") or set retroverse.android.adbPath.', 'Open Setting');
        if (pick) void vscode.commands.executeCommand('workbench.action.openSettings', 'retroverse.android.adbPath');
        return;
      }
      const sync = new AndroidSync(new Adb(exe), saves(), context.globalState, ui, userSetting<string>('android.device', '').trim());
      const title = { sync: 'Syncing', pull: 'Copying from the phone', push: 'Copying to the phone', location: 'Looking for saves on the phone' }[action];
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `RetroVerse: ${title}...` }, async () => {
        if (action === 'sync') await sync.sync(game);
        else if (action === 'pull') await sync.pull(game);
        else if (action === 'push') await sync.push(game);
        else {
          const loc = await sync.chooseLocation(game);
          void vscode.window.showInformationMessage(`RetroVerse: ${game.title} now syncs with ${loc.path} on the phone.`);
        }
      });
    } catch (e) {
      if (e instanceof SyncCancelled) return;
      log.error(`android: ${action} failed`, e);
      void vscode.window.showErrorMessage(`RetroVerse: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return (['sync', 'pull', 'push', 'location'] as const).map((a) =>
    vscode.commands.registerCommand(`retroverse.android.${a === 'location' ? 'setLocation' : a}`, (uri?: vscode.Uri) => runAction(a, uri)),
  );
}

async function resolveGame(uri: vscode.Uri | undefined, sessions: SessionManager): Promise<(SyncGame & { realPath: string }) | undefined> {
  let fsPath = uri?.scheme === 'file' ? uri.fsPath : sessions.active?.gamePath;
  if (!fsPath) {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Choose Game', filters: { Games: ['gba', 'nds'] } });
    fsPath = picked?.[0]?.fsPath;
    if (!fsPath) return undefined;
  }
  const format = formatForPath(fsPath);
  const coreId = format && CORE_FOR[format.platform];
  if (!format || !coreId) throw new Error('Phone sync works with GBA and DS games. Switch saves stay in Eden.');
  const rom = await validateRomPath(fsPath, format.platform);
  const romId = await romIdentity(rom.realPath, rom.size);
  const romStem = path.basename(rom.realPath, path.extname(rom.realPath));
  return { romId, coreId, title: path.basename(fsPath, path.extname(fsPath)), romStem, realPath: rom.realPath };
}

/** A running game would write its in-memory save over whatever sync copies in, so it is closed first. */
async function closeIfOpen(realPath: string, title: string, sessions: SessionManager): Promise<boolean> {
  const open = sessions.all.filter((s) => s.gamePath === realPath && s.status !== 'stopped' && s.status !== 'idle');
  if (open.length === 0) return true;
  const go = 'Close the Game and Sync';
  const pick = await vscode.window.showWarningMessage(`${title} is running. RetroVerse saves and closes it before syncing.`, { modal: true }, go);
  if (pick !== go) return false;
  for (const s of open) await s.stop();
  return true;
}
