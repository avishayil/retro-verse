import * as vscode from 'vscode';
import { nonce as makeNonce } from '../security/tokens';
import { buildPlayerCsp, folderSource, webOrigins } from './csp';

export interface HtmlOptions {
  /** Exact loopback port of the capture agent (Switch streaming), once known. */
  bridgePort?: number;
}

/**
 * The HTML shell never contains game names or paths: everything dynamic arrives via the `init` message
 * and is rendered with textContent.
 */
export function playerHtml(webview: vscode.Webview, extensionUri: vscode.Uri, opts: HtmlOptions = {}): string {
  const n = makeNonce();
  const uri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...p));
  const asset = (...p: string[]) => uri(...p).toString();
  // Narrow every web origin VS Code serves webview resources from (cspSource may also contain 'self') to the two
  // extension folders the player needs.
  const origins = webOrigins(webview.cspSource);
  if (origins.length === 0) throw new Error(`Unexpected webview resource origin: ${webview.cspSource}`);
  const dirs = (...p: string[]) => origins.map((o) => folderSource(o, uri(...p).path)).join(' ');
  const playerDir = dirs('dist', 'player');
  const coresDir = dirs('media', 'cores');
  const csp = buildPlayerCsp({ cspSource: webview.cspSource, nonce: n, playerDir, coresDir, bridgePort: opts.bridgePort });
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('dist', 'player', 'player.css')}">
<title>RetroVerse</title>
</head>
<body>
<div id="app" tabindex="-1"></div>
<script nonce="${n}" type="module" src="${asset('dist', 'player', 'player.js')}"></script>
</body>
</html>`;
}
