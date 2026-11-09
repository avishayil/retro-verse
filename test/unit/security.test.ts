import { describe, expect, it } from 'vitest';
// @ts-expect-error test-only export of the vscode stub
import { __config } from 'vscode';
import { userSetting } from '../../src/extension/settings';
import { buildPlayerCsp, folderSource, webOrigins } from '../../src/extension/webview/csp';
import { RomReceiver } from '../../src/player/transport/romReceiver';

describe('user-only settings', () => {
  it('ignore workspace and folder values, so a repository cannot pick executables or paths', () => {
    __config['switch.edenPath'] = { globalValue: '/Applications/Eden.app/Contents/MacOS/eden', workspaceValue: '/tmp/evil', workspaceFolderValue: '/tmp/evil2', defaultValue: '' };
    expect(userSetting('switch.edenPath', '')).toBe('/Applications/Eden.app/Contents/MacOS/eden');
    __config['switch.environment'] = { workspaceValue: { DYLD_INSERT_LIBRARIES: '/tmp/x.dylib' }, defaultValue: {} };
    expect(userSetting('switch.environment', {})).toEqual({});
    __config['storage.savesDirectory'] = { workspaceFolderValue: '/tmp/collect', defaultValue: '' };
    expect(userSetting('storage.savesDirectory', '')).toBe('');
  });
});

describe('ROM transfer', () => {
  const chunk = (offset: number, bytes: number[], total: number, done: boolean) => ({ offset, total, data: new Uint8Array(bytes), done });
  it('reassembles in-order chunks of exactly the announced size', async () => {
    const rx = new RomReceiver(5);
    expect(rx.push(chunk(0, [1, 2, 3], 5, false))).toBe(true);
    expect(rx.push(chunk(3, [4, 5], 5, true))).toBe(false);
    expect([...(await rx.done)]).toEqual([1, 2, 3, 4, 5]);
  });
  it.each([
    ['out of order', [chunk(2, [1], 4, false)], /out of order/],
    ['larger than announced', [chunk(0, [1, 2, 3, 4, 5], 4, true)], /larger/],
    ['shorter than announced', [chunk(0, [1, 2], 4, true)], /incomplete/],
    ['different total', [chunk(0, [1], 9, false)], /size/],
    ['host error', [{ offset: 0, total: 4, data: new Uint8Array(0), done: true, error: 'disk gone' }], /disk gone/],
  ])('rejects a transfer that is %s', async (_n, chunks, err) => {
    const rx = new RomReceiver(4);
    for (const c of chunks) rx.push(c);
    await expect(rx.done).rejects.toThrow(err as RegExp);
  });
  it('ignores chunks after it finished', async () => {
    const rx = new RomReceiver(1);
    rx.push(chunk(0, [7], 1, true));
    expect(rx.push(chunk(0, [8], 1, true))).toBe(false);
    expect([...(await rx.done)]).toEqual([7]);
  });
  it('times out', async () => {
    await expect(new RomReceiver(1, 20).done).rejects.toThrow(/Timed out/);
  });
});

describe('player content security policy', () => {
  const base = { cspSource: 'https://*.vscode-cdn.net', nonce: 'abc123==', playerDir: 'https://*.vscode-cdn.net/ext/dist/player/', coresDir: 'https://*.vscode-cdn.net/ext/media/cores/' };
  it('allows only the player and core folders, and no inline code', () => {
    const csp = buildPlayerCsp(base);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-abc123==' 'wasm-unsafe-eval' https://*.vscode-cdn.net/ext/dist/player/ https://*.vscode-cdn.net/ext/media/cores/");
    expect(csp).not.toMatch(/'unsafe-inline'|'unsafe-eval'|blob:|data:/);
    expect(csp).toContain("connect-src https://*.vscode-cdn.net/ext/media/cores/;");
    expect(csp).toContain("object-src 'none'");
  });
  it('names the exact bridge port and validates it', () => {
    expect(buildPlayerCsp({ ...base, bridgePort: 54321 })).toContain('connect-src https://*.vscode-cdn.net/ext/media/cores/ ws://127.0.0.1:54321;');
    expect(() => buildPlayerCsp({ ...base, bridgePort: 80 })).toThrow();
  });
  it('refuses sources that would break out of a directive', () => {
    expect(() => buildPlayerCsp({ ...base, playerDir: "https://x/; script-src 'unsafe-inline'" })).toThrow();
    expect(() => buildPlayerCsp({ ...base, nonce: "x' 'unsafe-inline" })).toThrow();
  });
  it("handles VS Code's multi-source origin (\"'self' https://*.vscode-cdn.net\")", () => {
    expect(webOrigins("'self' https://*.vscode-cdn.net")).toEqual(['https://*.vscode-cdn.net']);
    expect(webOrigins('https://*.vscode-cdn.net')).toEqual(['https://*.vscode-cdn.net']);
    const two = "https://*.vscode-cdn.net/a/dist/player/ https://other.example/a/dist/player/";
    expect(buildPlayerCsp({ ...base, playerDir: two })).toContain(`'wasm-unsafe-eval' ${two} `);
    expect(() => buildPlayerCsp({ ...base, playerDir: "'self' https://*.vscode-cdn.net/x/" })).toThrow(/unsafe/);
  });
  it('turns resource paths into encoded folder sources', () => {
    expect(folderSource('https://*.vscode-cdn.net', '/Users/a b/ext/dist/player')).toBe('https://*.vscode-cdn.net/Users/a%20b/ext/dist/player/');
  });
});
