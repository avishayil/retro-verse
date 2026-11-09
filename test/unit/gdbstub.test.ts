import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { parseEdenShortcut, parseGdbStub, qtSequenceToBridgeHotkey } from '../../src/extension/adapters/eden/EdenConfig';
import { GdbStubPump, rspPacket, rspParse } from '../../src/extension/adapters/eden/GdbStubPump';

describe('Eden GDB stub config', () => {
  it('reads the non-default keys from qt-config.ini', () => {
    const ini = ['[Debugging]', 'use_gdbstub\\default=false', 'use_gdbstub=true', 'gdbstub_port\\default=true', 'gdbstub_port=6543'].join('\n');
    expect(parseGdbStub(ini)).toEqual({ enabled: true, port: 6543 });
    expect(parseGdbStub('use_gdbstub=false\ngdbstub_port=7000')).toEqual({ enabled: false, port: 7000 });
    expect(parseGdbStub('')).toEqual({ enabled: false, port: 6543 });
    expect(parseGdbStub('use_gdbstub=true\ngdbstub_port=99999')).toEqual({ enabled: true, port: 6543 });
  });
});

describe('RSP framing', () => {
  it('builds checksummed packets', () => {
    expect(rspPacket('c')).toBe('$c#63');
    expect(rspPacket('?')).toBe('$?#3f');
    expect(rspPacket('D')).toBe('$D#44');
  });
  it('parses packets across acks, notifications and partial reads', () => {
    expect(rspParse('+$OK#9a+$T05#b9')).toEqual({ packets: ['OK', 'T05'], rest: '' });
    expect(rspParse('%Stop:T05#00$OK#9a')).toEqual({ packets: ['OK'], rest: '' });
    expect(rspParse('$T05#b')).toEqual({ packets: [], rest: '$T05#b' });
    expect(rspParse('junk$OK#9a')).toEqual({ packets: ['OK'], rest: '' });
  });
});

/**
 * Minimal fake of Eden's stub. Like the real one, it accepts connections before the guest exists: the first
 * few qfThreadInfo replies are empty, and a continue sent before the guest is suspended is ignored. After the
 * first effective continue it reports a breakpoint; interrupts report a stop.
 */
function fakeStub(port: number, received: string[]): net.Server {
  return net.createServer((sock) => {
    sock.on('error', () => undefined); // the pump may drop the connection mid-write
    let buf = '';
    let continues = 0;
    let threadPolls = 0;
    sock.on('data', (d) => {
      const { packets, rest } = rspParse(buf + d.toString('latin1'));
      buf = rest;
      if (d.includes(0x03)) sock.write(rspPacket('T02thread:50;'));
      for (const p of packets) {
        received.push(p);
        sock.write('+');
        if (p.startsWith('qSupported')) sock.write(rspPacket('PacketSize=4000;vContSupported+'));
        else if (p === 'qfThreadInfo') sock.write(rspPacket(++threadPolls < 4 ? 'l' : continues > 0 ? 'm50,53,54' : 'm50'));
        else if (p === '?') sock.write(rspPacket('T0520:00f0288000000000;thread:50;'));
        else if (p === 'c' && ++continues === 1) setTimeout(() => sock.write(rspPacket('T05thread:51;')), 20);
        else if (p === 'D') sock.end(rspPacket('OK'));
      }
    });
  }).listen(port, '127.0.0.1');
}

describe('GdbStubPump', () => {
  it('waits for the stub, continues the suspended guest, re-continues after stops, and detaches on stop()', async () => {
    const port = 40000 + Math.floor(Math.random() * 20000);
    const received: string[] = [];
    const pump = new GdbStubPump({ port, retryMs: 50, connectTimeoutMs: 5000 });
    const stops: string[] = [];
    pump.on('stop', (p: string) => stops.push(p));
    pump.start();
    // Eden opens the port only after it has started booting.
    await new Promise((r) => setTimeout(r, 300));
    const server = fakeStub(port, received);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout; got ${received.join(',')}`)), 4000);
      pump.on('continued', (n: number) => n === 2 && (clearTimeout(t), resolve()));
    });
    await new Promise((r) => setTimeout(r, 50)); // let the fake stub read the second continue
    const flow = received.filter((p) => p !== 'qfThreadInfo');
    expect(flow.slice(0, 4)).toEqual([expect.stringMatching(/^qSupported/), '?', 'c', 'c']);
    // continue must only be sent after the guest thread list became non-empty
    expect(received.indexOf('?')).toBeGreaterThan(received.lastIndexOf('qfThreadInfo', received.indexOf('?')));
    expect(received.filter((p) => p === 'qfThreadInfo').length).toBeGreaterThanOrEqual(4);
    expect(stops).toEqual(['T05thread:51;']);
    expect(await pump.probeThreads()).toBe(3);
    await new Promise((r) => setTimeout(r, 50));
    expect(received.at(-1)).toBe('c'); // probe resumes the guest
    pump.stop();
    await new Promise((r) => setTimeout(r, 100));
    expect(received.at(-1)).toBe('D');
    server.close();
  });

  it('reports an error when no stub ever appears', async () => {
    const pump = new GdbStubPump({ port: 1, retryMs: 20, connectTimeoutMs: 150 });
    const err = await new Promise<Error>((resolve) => {
      pump.on('error', resolve);
      pump.start();
    });
    expect(err.message).toMatch(/did not accept/);
  });
});

describe('Eden turbo hotkey', () => {
  it('reads the Toggle Turbo Speed shortcut and maps Qt modifiers per OS', () => {
    const ini = ['Shortcuts\\Main%20Window\\Toggle%20Turbo%20Speed\\KeySeq=Ctrl+Z', 'Shortcuts\\Main%20Window\\Toggle%20Framerate%20Limit\\KeySeq=Ctrl+U'].join('\n');
    expect(parseEdenShortcut(ini, 'Toggle Turbo Speed')).toBe('Ctrl+Z');
    expect(parseEdenShortcut(ini, 'Toggle Framerate Limit')).toBe('Ctrl+U');
    expect(parseEdenShortcut('', 'Toggle Turbo Speed')).toBeUndefined();
    expect(qtSequenceToBridgeHotkey('Ctrl+Z', 'darwin')).toBe('cmd+Z');
    expect(qtSequenceToBridgeHotkey('Meta+Shift+F5', 'darwin')).toBe('ctrl+shift+F5');
    expect(qtSequenceToBridgeHotkey('Ctrl+Z', 'linux')).toBe('ctrl+Z');
    expect(qtSequenceToBridgeHotkey('Ctrl+K, Ctrl+Z', 'darwin')).toBeUndefined();
    expect(qtSequenceToBridgeHotkey('Ctrl+Ü', 'darwin')).toBeUndefined();
  });
});

describe('GdbStubPump ownership', () => {
  it('never attaches to another Eden holding the port, then attaches to ours and reattaches after a drop', async () => {
    const port = 40000 + Math.floor(Math.random() * 20000);
    const received: string[] = [];
    const ours = process.pid; // alive for the duration of the test
    let owner = 999_999; // a different Eden (e.g. one still shutting down after a window reload)
    const pump = new GdbStubPump({ port, pid: ours, retryMs: 40, connectTimeoutMs: 5000, ownerOf: async () => [owner] });
    const conflicts: number[][] = [];
    let connects = 0;
    pump.on('conflict', (p: number[]) => conflicts.push(p));
    pump.on('connected', () => connects++);
    const server = fakeStub(port, received);
    pump.start();
    await new Promise((r) => setTimeout(r, 300));
    expect(connects).toBe(0); // the port is up, but not owned by our Eden
    expect(conflicts).toEqual([[999_999]]);
    owner = ours;
    await new Promise<void>((resolve) => pump.once('continued', () => resolve()));
    expect(connects).toBe(1);
    // the stub drops us while our Eden lives: the pump must come back and continue again
    const again = new Promise<void>((resolve) => pump.on('connected', () => connects === 2 && resolve()));
    (pump as unknown as { sock?: net.Socket }).sock?.destroy();
    await again;
    await new Promise<void>((resolve) => pump.once('continued', () => resolve()));
    pump.stop();
    server.close();
  });
});

describe('GdbStubPump error handling', () => {
  it('does not throw when connecting fails and nobody listens for errors', async () => {
    const pump = new GdbStubPump({ port: 1, retryMs: 10, connectTimeoutMs: 60 });
    pump.start();
    await new Promise((r) => setTimeout(r, 200)); // an unhandled 'error' would fail the test run here
    pump.stop();
  });
});
