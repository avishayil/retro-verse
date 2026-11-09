// Attack-style checks against the capture agent's loopback WebSocket (eden-bridge --synthetic). Uses raw TCP so it
// can control the Origin header and send malformed frames. No macOS permissions are needed.
// Usage: node test/harness/bridge-security.mjs
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const exe = [path.join(root, 'bin/darwin-arm64/eden-bridge'), path.join(root, 'native/eden-bridge/.build/debug/eden-bridge')].find(existsSync);
if (!exe) throw new Error('build the bridge first (npm run build:native)');
const TEST_ORIGIN = 'http://127.0.0.1:1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`);
};

function startBridge({ sendToken = true } = {}) {
  const token = 'sec-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const child = spawn(exe, ['--synthetic', '--no-audio', '--height', '144', '--fps', '5'], { env: { PATH: '/usr/bin:/bin', RETROVERSE_BRIDGE_TEST_ORIGIN: TEST_ORIGIN }, stdio: ['pipe', 'pipe', 'ignore'] });
  const events = [];
  const exited = new Promise((r) => child.once('exit', (code) => r(code)));
  const ready = new Promise((resolve) => {
    createInterface({ input: child.stdout }).on('line', (l) => {
      try {
        const m = JSON.parse(l);
        events.push(m);
        if (m.type === 'ready') resolve(m.port);
      } catch {}
    });
  });
  if (sendToken) child.stdin.write(JSON.stringify({ type: 'token', token }) + '\n');
  return { child, token, events, ready, exited };
}

/** Open a raw WebSocket. Resolves { sock, status } after the HTTP handshake. */
function wsConnect(port, origin) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    let head = '';
    sock.on('error', () => resolve({ sock, status: 0 }));
    sock.on('connect', () => {
      const key = Buffer.from(Math.random().toString()).toString('base64');
      sock.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${origin ? `Origin: ${origin}\r\n` : ''}\r\n`);
    });
    const onData = (d) => {
      head += d.toString('latin1');
      if (head.includes('\r\n\r\n')) {
        sock.off('data', onData);
        resolve({ sock, status: Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1] ?? 0) });
      }
    };
    sock.on('data', onData);
    sock.on('close', () => resolve({ sock, status: Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1] ?? 0) }));
  });
}

/** A masked binary client frame carrying RetroVerse's [type][u64 ts][payload] message. */
function frame(type, payload = Buffer.alloc(0)) {
  const msg = Buffer.concat([Buffer.from([type]), Buffer.alloc(8), payload]);
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(msg.map((b, i) => b ^ mask[i % 4]));
  return Buffer.concat([Buffer.from([0x82, 0x80 | msg.length]), mask, masked]);
}

const closedWithin = (sock, ms) => new Promise((r) => {
  if (sock.destroyed) return r(true);
  const t = setTimeout(() => r(false), ms);
  sock.once('close', () => { clearTimeout(t); r(true); });
});

// 1. No token on stdin: the agent must refuse to start.
{
  const b = startBridge({ sendToken: false });
  const code = await Promise.race([b.exited, sleep(5000).then(() => 'still running')]);
  check('agent exits when no session token arrives on stdin', code === 2, `exit ${code}`);
  b.child.kill();
}

const b = startBridge();
const port = await b.ready;

// 2. Foreign and missing Origin are refused at the handshake.
check('handshake with a foreign Origin is refused', (await wsConnect(port, 'https://evil.example')).status !== 101);
check('handshake without an Origin is refused', (await wsConnect(port, undefined)).status !== 101);
await sleep(200);
check('origin rejections are reported as security events', b.events.filter((e) => e.type === 'security' && e.event === 'origin-rejected').length >= 2);

// 3. Allowed origin but no Hello: closed after the 2 s grace period.
{
  const c = await wsConnect(port, TEST_ORIGIN);
  check('allowed-origin handshake succeeds', c.status === 101);
  check('silent unauthenticated connection is closed within 3 s', await closedWithin(c.sock, 3000));
}

// 4. Wrong token: closed immediately and reported.
{
  const c = await wsConnect(port, TEST_ORIGIN);
  c.sock.write(frame(0x01, Buffer.from('not-the-token-at-all-000000')));
  check('wrong token closes the connection', await closedWithin(c.sock, 1000));
  await sleep(100);
  check('auth failure is reported as a security event', b.events.some((e) => e.type === 'security' && e.event === 'auth-failed'));
}

// 5. Connection flood: at most 4 unauthenticated connections at once.
{
  const socks = await Promise.all(Array.from({ length: 10 }, () => wsConnect(port, TEST_ORIGIN)));
  await sleep(300);
  const open = socks.filter((c) => c.status === 101 && !c.sock.destroyed).length;
  check('no more than 4 unauthenticated connections are kept', open <= 4, `${open} open`);
  check('connection flood is reported', b.events.some((e) => e.type === 'security' && e.event === 'connection-limit'));
  for (const c of socks) c.sock.destroy();
  await sleep(300);
}

// 6. Authenticated client sending garbage: closed after 3 bad frames.
{
  const c = await wsConnect(port, TEST_ORIGIN);
  c.sock.write(frame(0x01, Buffer.from(b.token)));
  await sleep(200);
  check('valid token authenticates', !c.sock.destroyed && b.events.some((e) => e.type === 'client' && e.connected));
  for (let i = 0; i < 3; i++) c.sock.write(frame(0x20, Buffer.from([1, 2, 3]))); // malformed input frames
  check('three malformed frames close the connection', await closedWithin(c.sock, 1000));
  await sleep(100);
  check('bad frames are reported', b.events.some((e) => e.type === 'security' && e.event === 'bad-frames'));
}

// 7. The token never appears in anything the agent writes out.
check('session token is never echoed in agent output', !JSON.stringify(b.events).includes(b.token));

b.child.stdin.end();
b.child.kill();
console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
