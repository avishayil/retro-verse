// Content Security Policy for the player webview. Pure (no vscode import) so tests can apply the exact same policy.

export interface PlayerCspOptions {
  /** The webview's resource origin, e.g. `https://*.vscode-cdn.net` (webview.cspSource). */
  cspSource: string;
  nonce: string;
  /** Space-separated URL prefixes (ending in `/`) of the extension folders the player may load code and data from. */
  playerDir: string;
  coresDir: string;
  /** Loopback port of the capture agent (Switch streaming). Omitted until it is known. */
  bridgePort?: number;
}

/** Each CSP source must be a plain URL source: nothing that could end or split a directive, and no keywords. */
function safeSources(s: string): string {
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 0) throw new Error('empty CSP source');
  for (const p of parts) if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[A-Za-z0-9.*:%_~@!$&()=+/-]+$/.test(p)) throw new Error(`unsafe CSP source: ${p}`);
  return parts.join(' ');
}

/** The web origins in a webview's cspSource (e.g. "'self' https://*.vscode-cdn.net" -> ["https://*.vscode-cdn.net"]). */
export function webOrigins(cspSource: string): string[] {
  return cspSource.split(/\s+/).filter((t) => /^https?:\/\/[^\s;,']+$/.test(t));
}

/**
 * default-src 'none', then only what the player needs:
 * - scripts: the nonce'd entry module plus the player bundle folder and the emulator cores folder
 *   ('wasm-unsafe-eval' compiles the WebAssembly cores; there is no 'unsafe-eval' or 'unsafe-inline');
 * - styles: the player's stylesheet folder only (styles set from script go through CSSOM, which CSP allows);
 * - connections: the cores folder (WebAssembly fetches) and, for Switch, exactly ws://127.0.0.1:<port>;
 * - no images, media, fonts, frames, workers other than the audio worklet (covered by script-src), or forms.
 */
export function buildPlayerCsp(o: PlayerCspOptions): string {
  const player = safeSources(o.playerDir);
  const cores = safeSources(o.coresDir);
  if (!/^[A-Za-z0-9+/=]+$/.test(o.nonce)) throw new Error('invalid nonce');
  const connect = [cores];
  if (o.bridgePort !== undefined) {
    if (!Number.isInteger(o.bridgePort) || o.bridgePort < 1024 || o.bridgePort > 65535) throw new Error('invalid bridge port');
    connect.push(`ws://127.0.0.1:${o.bridgePort}`);
  }
  return [
    `default-src 'none'`,
    `script-src 'nonce-${o.nonce}' 'wasm-unsafe-eval' ${player} ${cores}`,
    `style-src ${player}`,
    `connect-src ${connect.join(' ')}`,
    `img-src 'none'`,
    `media-src 'none'`,
    `font-src 'none'`,
    `frame-src 'none'`,
    `worker-src 'none'`,
    `object-src 'none'`,
    `base-uri 'none'`,
    `form-action 'none'`,
  ].join('; ');
}

/** Turn a webview resource URI into a CSP path source under the webview's resource origin. */
export function folderSource(cspSource: string, uriPath: string): string {
  // cspSource is the wildcard resource origin (e.g. https://*.vscode-cdn.net); asWebviewUri keeps the file path
  // in the URI path, so origin + path + "/" matches exactly that folder and everything below it.
  const encodedPath = uriPath.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  return `${cspSource}${encodedPath.endsWith('/') ? encodedPath : encodedPath + '/'}`;
}
