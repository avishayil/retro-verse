import * as vscode from 'vscode';
import type { PlayerSettings } from '../protocol/messages';

export function cfg() {
  return vscode.workspace.getConfiguration('retroverse');
}

/**
 * Settings that choose executables, arguments, environment variables, file-system locations or capture
 * behaviour. They are declared machine/application scoped in package.json; this reader additionally ignores
 * workspace and folder values, so a cloned repository's .vscode/settings.json can never set them.
 */
export const USER_ONLY_SETTINGS = [
  'switch.edenPath',
  'switch.bridgePath',
  'switch.extraArgs',
  'switch.environment',
  'switch.keyboardMap',
  'switch.streamMode',
  'switch.gdbStub',
  'switch.parkWindow',
  'switch.isolatedConfig',
  'storage.savesDirectory',
  'diagnostics.devMode',
  'android.adbPath',
  'android.device',
] as const;
export type UserOnlySetting = (typeof USER_ONLY_SETTINGS)[number];

export function userSetting<T>(key: UserOnlySetting, fallback: T): T {
  const i = cfg().inspect<T>(key);
  return (i?.globalValue ?? i?.defaultValue ?? fallback) as T;
}

export function playerSettings(): PlayerSettings {
  const c = cfg();
  return {
    scale: c.get<PlayerSettings['scale']>('player.scale', 'fit'),
    showStats: c.get('player.showStats', false),
    volume: Math.max(0, Math.min(100, c.get('player.volume', 80))),
    pauseOnBlur: c.get('player.pauseOnBlur', false),
    keyboard: sanitizeMap(c.get<Record<string, unknown>>('input.keyboard', {})),
    ndsScreenLayout: c.get('nds.screenLayout', 'Top/Bottom'),
    turboSpeed: Math.max(2, Math.min(8, c.get('player.turboSpeed', 3))),
  };
}

export function sanitizeMap(m: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m ?? {})) {
    if (typeof v === 'string' && /^[A-Za-z0-9]{1,24}$/.test(k) && /^[A-Za-z0-9]{1,32}$/.test(v)) out[k] = v;
  }
  return out;
}
