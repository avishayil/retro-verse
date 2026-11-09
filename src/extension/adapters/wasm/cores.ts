import * as vscode from 'vscode';
import type { EmulatorAdapter, LaunchContext } from '../../sessions/Session';
import { WasmSession, type WasmCoreSpec } from './WasmSession';

const core = (webview: vscode.Webview, ext: vscode.Uri, ...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(ext, 'media', 'cores', ...p)).toString();

export const MGBA_SPEC: WasmCoreSpec = {
  coreId: 'mgba',
  platform: 'gba',
  backend: (webview, ext, romSize, romName) => ({ kind: 'gba', coreJsUrl: core(webview, ext, 'mgba', 'mgba.js'), romSize, romName }),
};

export const MELONDS_SPEC: WasmCoreSpec = {
  coreId: 'melonds',
  platform: 'nds',
  backend: (webview, ext, romSize, romName) => ({
    kind: 'nds',
    coreJsUrl: core(webview, ext, 'melonds', 'melonds_libretro.js'),
    coreWasmUrl: core(webview, ext, 'melonds', 'melonds_libretro.wasm'),
    romSize,
    romName,
  }),
};

function wasmAdapter(id: string, spec: WasmCoreSpec, extensionUri: vscode.Uri): EmulatorAdapter {
  const files = spec.coreId === 'mgba' ? ['mgba/mgba.js', 'mgba/mgba.wasm'] : ['melonds/melonds_libretro.js', 'melonds/melonds_libretro.wasm'];
  return {
    id,
    platform: spec.platform,
    async probe() {
      try {
        for (const f of files) await vscode.workspace.fs.stat(vscode.Uri.joinPath(extensionUri, 'media', 'cores', ...f.split('/')));
        return { available: true };
      } catch {
        return { available: false, reason: `Emulator core files for ${spec.coreId} are missing (run "npm run vendor").` };
      }
    },
    async start(ctx: LaunchContext) {
      return new WasmSession(ctx, spec);
    },
  };
}

export const mgbaAdapter = (ext: vscode.Uri) => wasmAdapter('mgba-wasm', MGBA_SPEC, ext);
export const melonDsAdapter = (ext: vscode.Uri) => wasmAdapter('melonds-wasm', MELONDS_SPEC, ext);
