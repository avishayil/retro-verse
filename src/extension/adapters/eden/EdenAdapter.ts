import type * as vscode from 'vscode';
import path from 'node:path';
import type { EmulatorAdapter, LaunchContext } from '../../sessions/Session';
import { cfg } from '../../settings';
import { locateEden } from './EdenLocator';
import { EdenSession } from './EdenSession';

export function edenAdapter(globalStorage: vscode.Uri): EmulatorAdapter {
  return {
    id: 'eden-native',
    platform: 'switch',
    async probe() {
      try {
        const install = await locateEden(cfg().get<string>('switch.edenPath', ''));
        return install ? { available: true, version: `${install.flavor} ${install.version ?? ''}`.trim() } : { available: false, reason: 'Eden not found' };
      } catch (e) {
        return { available: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },
    async start(ctx: LaunchContext) {
      return new EdenSession(ctx, path.join(globalStorage.fsPath, 'eden'));
    },
  };
}
