// End-to-end key check for Switch streaming, up to (not including) the final CGEvent post:
// browser key -> InputManager -> StreamBackend wire frame -> eden-bridge -> keymap -> emulator key.
// The keymap is built exactly like the extension does: Eden defaults + the user's Eden config bindings.
// Usage: node test/harness/switch-keys.mjs
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import * as esbuild from 'esbuild';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

// Build the keymap with the real extension code (EdenConfig has no vscode dependency).
const bundled = path.join(os.tmpdir(), `rv-edencfg-${process.pid}.mjs`);
await esbuild.build({ entryPoints: [path.join(root, 'src/extension/adapters/eden/EdenConfig.ts')], bundle: true, platform: 'node', format: 'esm', outfile: bundled, logLevel: 'warning' });
const { readEdenKeymap } = await import(bundled);
const DEFAULTS = { A: 'C', B: 'X', X: 'V', Y: 'Z', L: 'Q', R: 'E', ZL: 'R', ZR: 'T', Start: 'M', Select: 'N', Up: 'UpArrow', Down: 'DownArrow', Left: 'LeftArrow', Right: 'RightArrow', LS: 'F', RS: 'G', LUp: 'W', LDown: 'S', LLeft: 'A', LRight: 'D', RUp: 'I', RDown: 'K', RLeft: 'J', RRight: 'L' };
const fromEden = await readEdenKeymap();
const keymap = { ...DEFAULTS, ...fromEden };

const page = `<!DOCTYPE html><html><head><link rel="stylesheet" href="/dist/player/player.css"><script>
window.__toHost = []; window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__toHost.push(m), getState() {}, setState() {} });
</script></head><body><div id="app"></div><script type="module" src="/dist/player/player.js"></script></body></html>`;
const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(page);
  try {
    const p = path.join(root, path.normalize(u.pathname));
    res.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : 'application/octet-stream' }).end(await readFile(p));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const exe = [path.join(root, 'bin/darwin-arm64/eden-bridge'), path.join(root, 'native/eden-bridge/.build/debug/eden-bridge')].find(existsSync);
const token = 'switchkeys-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const bridge = spawn(exe, ['--synthetic', '--no-audio', '--height', '360', '--keymap', JSON.stringify(keymap)], { env: { ...process.env, RETROVERSE_BRIDGE_TEST_ORIGIN: base }, stdio: ['pipe', 'pipe', 'ignore'] });
bridge.stdin.write(JSON.stringify({ type: 'token', token }) + '\n'); // same handshake as the extension
const injected = [];
let port;
await new Promise((resolve) => {
  createInterface({ input: bridge.stdout }).on('line', (l) => {
    const m = JSON.parse(l);
    if (m.type === 'ready') { port = m.port; resolve(); }
    if (m.type === 'injected') injected.push(m);
  });
});

const shell = readdirSync(path.join(os.homedir(), 'Library/Caches/ms-playwright')).filter((n) => n.startsWith('chromium_headless_shell-')).sort().reverse()
  .map((n) => path.join(os.homedir(), 'Library/Caches/ms-playwright', n, 'chrome-headless-shell-mac-arm64/chrome-headless-shell')).find(existsSync);
const browser = await chromium.launch({ ...(shell ? { executablePath: shell } : { channel: 'chrome' }), headless: true });
const pg = await browser.newPage();
await pg.goto(base + '/');
await pg.waitForFunction(() => window.__toHost.some((m) => m.type === 'ready'));
const settings = { scale: 'fit', showStats: false, volume: 0, pauseOnBlur: false, keyboard: {}, ndsScreenLayout: 'Top/Bottom', turboSpeed: 3 };
const caps = { saveStates: false, batterySave: false, pause: true, reset: true, screenshots: false, mods: true, audio: true, gamepad: true };
await pg.evaluate((p) => window.postMessage({ v: 1, type: 'init', payload: p }, '*'), {
  platform: 'switch', title: 'keys', capabilities: caps, settings,
  backend: { kind: 'stream', wsUrl: `ws://127.0.0.1:${port}/`, token, workletUrl: `${base}/dist/player/pcm-worklet.js` },
});
await pg.waitForTimeout(1500);
await pg.locator('.stage').click({ position: { x: 5, y: 5 } });

const last = () => injected.filter((m) => m.keys).at(-1);
const cases = [
  // [description, keys to hold, expected logical inputs, expected Eden keys]
  ['Arrow Up = move (left stick up)', ['ArrowUp'], ['LUp'], [keymap.LUp]],
  ['Arrow Down = move down', ['ArrowDown'], ['LDown'], [keymap.LDown]],
  ['Arrow Left = move left', ['ArrowLeft'], ['LLeft'], [keymap.LLeft]],
  ['Arrow Right = move right', ['ArrowRight'], ['LRight'], [keymap.LRight]],
  ['Diagonal up+right', ['ArrowUp', 'ArrowRight'], ['LRight', 'LUp'], [keymap.LUp, keymap.LRight]],
  ['I = D-pad up', ['KeyI'], ['Up'], [keymap.Up]],
  ['K = D-pad down', ['KeyK'], ['Down'], [keymap.Down]],
  ['J = D-pad left', ['KeyJ'], ['Left'], [keymap.Left]],
  ['L = D-pad right', ['KeyL'], ['Right'], [keymap.Right]],
  ['X = A', ['KeyX'], ['A'], [keymap.A]],
  ['Z = B', ['KeyZ'], ['B'], [keymap.B]],
  ['C = Y', ['KeyC'], ['Y'], [keymap.Y]],
  ['V = X', ['KeyV'], ['X'], [keymap.X]],
  ['A = L', ['KeyA'], ['L'], [keymap.L]],
  ['S = R', ['KeyS'], ['R'], [keymap.R]],
  ['Q = ZL', ['KeyQ'], ['ZL'], [keymap.ZL]],
  ['W = ZR', ['KeyW'], ['ZR'], [keymap.ZR]],
  ['Enter = + (Start)', ['Enter'], ['Start'], [keymap.Start]],
  ['Backspace = − (Select)', ['Backspace'], ['Select'], [keymap.Select]],
  ['Right Shift = − (Select)', ['ShiftRight'], ['Select'], [keymap.Select]],
  ['Run: hold B while moving', ['KeyZ', 'ArrowLeft'], ['B', 'LLeft'], [keymap.B, keymap.LLeft]],
];

let failures = 0;
for (const [name, keys, inputs, eden] of cases) {
  for (const k of keys) await pg.keyboard.down(k);
  await pg.waitForTimeout(150);
  const got = last();
  for (const k of [...keys].reverse()) await pg.keyboard.up(k);
  await pg.waitForTimeout(150);
  const released = last();
  const ok = JSON.stringify(got?.inputs) === JSON.stringify([...inputs].sort()) && JSON.stringify(got?.keys) === JSON.stringify([...eden].sort()) && released?.inputs.length === 0;
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${name.padEnd(34)} -> Eden keys ${JSON.stringify(got?.keys)}${ok ? '' : `  (expected ${JSON.stringify([...eden].sort())}, inputs ${JSON.stringify(got?.inputs)}, released ${JSON.stringify(released?.inputs)})`}`);
}
// Turbo travels as its own frame.
await pg.keyboard.down('Tab');
await pg.waitForTimeout(150);
await pg.keyboard.up('Tab');
await pg.waitForTimeout(150);
const turbo = injected.filter((m) => 'turbo' in m).map((m) => m.turbo);
const turboOk = turbo.at(-2) === true && turbo.at(-1) === false;
if (!turboOk) failures++;
console.log(`${turboOk ? '✓' : '✗'} ${'Tab = turbo while held'.padEnd(34)} -> turbo frames ${JSON.stringify(turbo.slice(-2))}`);
// Focus loss must release everything.
await pg.keyboard.down('ArrowUp');
await pg.waitForTimeout(150);
await pg.evaluate(() => window.dispatchEvent(new Event('blur')));
await pg.waitForTimeout(150);
const blurOk = last()?.inputs.length === 0;
if (!blurOk) failures++;
console.log(`${blurOk ? '✓' : '✗'} ${'Focus lost releases held keys'.padEnd(34)} -> ${JSON.stringify(last()?.inputs)}`);
await pg.keyboard.up('ArrowUp');

console.log(`\nkeymap source: ${Object.keys(fromEden).length ? 'your Eden config' : 'Eden defaults'}; ${failures ? failures + ' FAILED' : 'all passed'}`);
await browser.close();
bridge.kill('SIGTERM');
server.close();
process.exit(failures ? 1 : 0);
