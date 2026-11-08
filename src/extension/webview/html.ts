import * as vscode from 'vscode';
import { nonce as makeNonce } from '../security/tokens';

export interface HtmlOptions {
  /** Allow WebSocket connections to the loopback bridge (Switch streaming only). */
  allowLoopbackSocket: boolean;
}

/**
 * The HTML shell never contains game names or paths: everything dynamic arrives via the `init` message
 * and is rendered with textContent.
 */
export function playerHtml(webview: vscode.Webview, extensionUri: vscode.Uri, opts: HtmlOptions): string {
  const n = makeNonce();
  const asset = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...p)).toString();
  const connect = [webview.cspSource, opts.allowLoopbackSocket ? 'ws://127.0.0.1:*' : ''].filter(Boolean).join(' ');
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} blob: data:`,
    `media-src ${webview.cspSource} blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    // 'wasm-unsafe-eval' is required to compile the emulator cores; the cores themselves load from cspSource only.
    `script-src 'nonce-${n}' 'wasm-unsafe-eval' ${webview.cspSource}`,
    `worker-src ${webview.cspSource} blob:`,
    `connect-src ${connect}`,
  ].join('; ');
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
