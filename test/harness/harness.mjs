// Browser harness: serves the real player bundle + cores + fixture ROMs over HTTP with a fake
// `acquireVsCodeApi`, plays the host role, and drives the page with Playwright.
// Usage: node test/harness/harness.mjs [gba|nds] [--headed]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const kind = process.argv[2] ?? 'gba';
const headed = process.argv.includes('--headed');
const TYPES = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.html': 'text/html' };

const page = `<!DOCTYPE html><html><head><link rel="stylesheet" href="/dist/player/player.css">
<script>
  window.__toHost = [];
  window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__toHost.push(m), getState: () => undefined, setState: () => {} });
</script></head><body><div id="app"></div><script type="module" src="/dist/player/player.js"></script></body></html>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' }).end(page);
    return;
  }
  const p = path.join(root, path.normalize(url.pathname));
  if (!p.startsWith(root)) return res.writeHead(403).end();
  try {
    const data = await readFile(p);
    res.writeHead(200, { 'content-type': TYPES[path.extname(p)] ?? 'application/octet-stream' }).end(data);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const caps = kind === 'stream' ? { saveStates: false, batterySave: false, pause: true, reset: true, screenshots: false, mods: true, audio: true, gamepad: true } : { saveStates: true, batterySave: true, pause: true, reset: true, screenshots: true, mods: false, audio: true, gamepad: true };
const settings = { scale: 'fit', showStats: true, volume: 0, pauseOnBlur: false, keyboard: {}, ndsScreenLayout: 'Top/Bottom' };
let bridge;
async function startBridge() {
  const exe = [path.join(root, 'native/eden-bridge/.build/release/eden-bridge'), path.join(root, 'native/eden-bridge/.build/debug/eden-bridge')].find(existsSync);
  if (!exe) throw new Error('build the bridge first (npm run build:native)');
  const token = 'harness-token-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  bridge = spawn(exe, ['--synthetic', '--fps', '30', '--height', '720', ...(process.env.HARNESS_BRIDGE_ARGS ? process.env.HARNESS_BRIDGE_ARGS.split(' ') : [])], { env: { ...process.env, RETROVERSE_BRIDGE_TOKEN: token, RETROVERSE_BRIDGE_TEST_ORIGIN: base }, stdio: ['pipe', 'pipe', 'inherit'] });
  const rl = createInterface({ input: bridge.stdout });
  const port = await new Promise((resolve, reject) => {
    rl.on('line', (l) => { const m = JSON.parse(l); if (m.type === 'ready') resolve(m.port); });
    bridge.once('exit', (c) => reject(new Error('bridge exited ' + c)));
  });
  return { kind: 'stream', wsUrl: `ws://127.0.0.1:${port}/`, token, workletUrl: `${base}/dist/player/pcm-worklet.js` };
}
const backend = kind === 'stream' ? await startBridge() :
  kind === 'gba'
    ? { kind: 'gba', coreJsUrl: `${base}/media/cores/mgba/mgba.js`, romUrl: `${base}/test/fixtures/roms/rv-test.gba`, romName: 'game.gba' }
    : { kind: 'nds', coreJsUrl: `${base}/media/cores/melonds/melonds_libretro.js`, coreWasmUrl: `${base}/media/cores/melonds/melonds_libretro.wasm`, romUrl: `${base}/test/fixtures/roms/rv-test.nds`, romName: 'game.nds' };

setTimeout(() => { console.error('HARNESS TIMEOUT'); console.log(JSON.stringify({ kind, ok: false, error: 'timeout', logs: logs.slice(-30) }, null, 2)); process.exit(2); }, 90000).unref();
import { readdirSync } from 'node:fs';
import os from 'node:os';
function findHeadlessShell() {
  const dir = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  try {
    const d = readdirSync(dir).filter((n) => n.startsWith('chromium_headless_shell-')).sort().reverse();
    for (const n of d) { const exe = path.join(dir, n, 'chrome-headless-shell-mac-arm64/chrome-headless-shell'); if (existsSync(exe)) return exe; }
  } catch {}
  return undefined;
}
// Some managed Macs terminate automation-launched Google Chrome after a few seconds; prefer Playwright's shell.
const executablePath = process.env.HARNESS_BROWSER ?? (headed ? undefined : findHeadlessShell());
const browser = await chromium.launch({ ...(executablePath ? { executablePath } : { channel: 'chrome' }), headless: !headed, args: ['--autoplay-policy=no-user-gesture-required'] });
const pg = await browser.newPage({ viewport: { width: 800, height: 600 } });
const logs = [];
pg.on('console', (m) => { logs.push(`[${m.type()}] ${m.text()}`); if (process.env.DEBUG) console.error(`[${m.type()}] ${m.text().slice(0, 300)}`); });
pg.on('crash', () => console.error('PAGE CRASHED'));
browser.on('disconnected', () => console.error('BROWSER DISCONNECTED'));
pg.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await pg.goto(base + '/');
await pg.waitForFunction(() => window.__toHost.some((m) => m.type === 'ready'), null, { timeout: 10000 });
await pg.evaluate((payload) => window.postMessage({ v: 1, type: 'init', payload }, '*'), { platform: kind === 'stream' ? 'switch' : kind, title: 'RV Test <b>x</b>', capabilities: caps, settings, backend });

const result = { kind, ok: false };
if (kind === 'stream') await pg.waitForTimeout(3000); // first keyframe + decoder config // first keyframe + decoder config
try {
  await pg.waitForFunction(() => window.__toHost.some((m) => m.type === 'status' && (m.payload.status === 'running' || m.payload.status === 'error')), null, { timeout: 30000 });
  const status = await pg.evaluate(() => window.__toHost.filter((m) => m.type === 'status').map((m) => m.payload));
  result.status = status;
  await pg.waitForTimeout(1500);
  // Sample the centre pixel of the screen canvas via a screenshot (WebGL canvases are not readable directly).
  const sample = async (label) => {
    const buf = await pg.locator('canvas.screen').screenshot();
    const { decodePng } = await import('./png.mjs');
    const img = decodePng(buf);
    const px = (x, y) => { const i = (y * img.width + x) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };
    result[label] = { top: px(img.width >> 1, img.height >> 2), centre: px(img.width >> 1, img.height >> 1) };
  };
  await sample('idle');
  await pg.locator('.stage').focus();
  await pg.keyboard.down('x'); // A
  await pg.waitForTimeout(500);
  await sample('holdA');
  await pg.keyboard.up('x');
  await pg.waitForTimeout(500);
  await sample('released');
  await pg.waitForTimeout(1500); // battery flush is debounced
  result.battery = await pg.evaluate(() => { const b = window.__toHost.filter((m) => m.type === 'save.battery').at(-1); return b ? { bytes: b.payload.data.byteLength, first: b.payload.data[0] } : null; });
  if (kind === 'stream') {
    // Bad-token client must be rejected.
    result.badToken = await pg.evaluate((url) => new Promise((res) => { const ws = new WebSocket(url); ws.binaryType = 'arraybuffer'; ws.onopen = () => { const f = new Uint8Array(9 + 5); f[0] = 1; f.set(new TextEncoder().encode('wrong'), 9); ws.send(f); }; ws.onclose = () => res('closed'); setTimeout(() => res('still-open'), 4000); }), backend.wsUrl);
    await pg.waitForTimeout(500);
    await sample('afterBadClient');
    // Unlock audio (autoplay gesture) and check that the worklet receives PCM.
    const overlay = pg.locator('.gesture-overlay');
    if (await overlay.count()) await overlay.click();
    await pg.waitForTimeout(1500);
    result.audio = await pg.evaluate(() => window.__rvAudioStats ?? null);
    result.title = await pg.locator('.toolbar .title').textContent();
    result.stats = await pg.locator('.stats').textContent();
    await pg.screenshot({ path: path.join(root, `test/harness/out-${kind}.png`) });
    result.ok = true;
    throw 'done';
  }
  // Turbo: Shift+Tab toggles, Tab held = fast-forward while held. Stats report emulated frames per second.
  const fps = async () => Number(((await pg.locator('.stats').textContent()) ?? '').match(/(\d+) fps/)?.[1] ?? 0);
  await pg.waitForTimeout(1200);
  result.turbo = { normal: await fps() };
  await pg.keyboard.press('Shift+Tab');
  await pg.waitForTimeout(2200);
  result.turbo.toggled = await fps();
  result.turbo.button = await pg.locator('.toolbar .btn.active .label').textContent().catch(() => null);
  await pg.keyboard.press('Shift+Tab');
  await pg.waitForTimeout(2200);
  result.turbo.off = await fps();
  await pg.keyboard.down('Tab');
  await pg.waitForTimeout(2200);
  result.turbo.held = await fps();
  await pg.keyboard.up('Tab');
  result.turbo.focusKept = await pg.evaluate(() => document.activeElement?.classList.contains('stage'));
  // Save state round-trip through the command channel.
  await pg.evaluate(() => window.postMessage({ v: 1, type: 'command', id: 't1', payload: { command: 'saveState', slot: 0 } }, '*'));
  await pg.waitForFunction(() => window.__toHost.some((m) => m.type === 'reply' && m.id === 't1'), null, { timeout: 5000 });
  result.saveState = await pg.evaluate(() => {
    const s = window.__toHost.find((m) => m.type === 'save.state');
    const r = window.__toHost.find((m) => m.type === 'reply' && m.id === 't1');
    return { reply: r.payload, bytes: s?.payload.data.byteLength };
  });
  const st = await pg.evaluate(() => window.__toHost.find((m) => m.type === 'save.state')?.payload.data);
  await pg.evaluate((data) => window.postMessage({ v: 1, type: 'command', id: 't2', payload: { command: 'loadState', slot: 0, data: new Uint8Array(Object.values(data)) } }, '*'), st);
  await pg.waitForFunction(() => window.__toHost.some((m) => m.type === 'reply' && m.id === 't2'), null, { timeout: 5000 });
  result.loadState = await pg.evaluate(() => window.__toHost.find((m) => m.type === 'reply' && m.id === 't2').payload);
  // Pause/resume
  await pg.evaluate(() => window.postMessage({ v: 1, type: 'command', id: 't3', payload: { command: 'pause' } }, '*'));
  await pg.waitForTimeout(300);
  await pg.evaluate(() => window.postMessage({ v: 1, type: 'command', id: 't4', payload: { command: 'resume' } }, '*'));
  await pg.waitForTimeout(300);
  result.title = await pg.locator('.toolbar .title').textContent();
  result.stats = await pg.locator('.stats').textContent();
  await pg.screenshot({ path: path.join(root, `test/harness/out-${kind}.png`) });
  result.ok = result.status.at(-1)?.status !== 'error';
} catch (e) {
  if (e !== 'done') result.error = String(e);
  await pg.screenshot({ path: path.join(root, `test/harness/out-${kind}.png`) }).catch(() => {});
}
result.logs = logs.filter((l) => !l.includes('[debug]')).slice(-25);
result.toHostTypes = await pg.evaluate(() => window.__toHost.map((m) => m.type + (m.payload?.level ? ':' + m.payload.level + ':' + m.payload.message : ''))).catch(() => []);
console.log(JSON.stringify(result, null, 2));
await browser.close();
server.close();
bridge?.kill('SIGTERM');
process.exit(result.ok ? 0 : 1);
