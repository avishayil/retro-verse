import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProcessSupervisor } from '../../src/extension/adapters/eden/ProcessSupervisor';
import { readLines, run } from '../../src/extension/util/proc';

// Reproduce the extension-host breakage seen in the wild: another extension left Node's string_decoder
// unusable, so every Readable#setEncoding (used by execFile's default 'utf8' and by readline-style code)
// threw "TypeError: StringDecoder is not a constructor". With setEncoding rigged to throw, any RetroVerse code
// path that still depends on stream text decoding fails these tests.
const original = Readable.prototype.setEncoding;

describe('process I/O survives a broken string_decoder', () => {
  beforeAll(() => {
    Readable.prototype.setEncoding = function () {
      throw new TypeError('StringDecoder is not a constructor');
    };
  });
  afterAll(() => {
    Readable.prototype.setEncoding = original;
  });

  it('the simulated breakage is active (execFile would fail)', async () => {
    expect(() => new Readable({ read() {} }).setEncoding('utf8')).toThrow(/StringDecoder/);
  });

  it('run() collects and decodes output (including multi-byte UTF-8)', async () => {
    const r = await run('/bin/sh', ['-c', 'printf "héllo\\n"; printf "err" >&2; exit 3']);
    expect(r).toEqual({ code: 3, stdout: 'héllo\n', stderr: 'err', timedOut: false });
  });

  it('run() times out and never rejects for missing binaries', async () => {
    expect((await run('/bin/sleep', ['5'], { timeoutMs: 100 })).timedOut).toBe(true);
    expect((await run('/nonexistent/binary', [])).code).toBeNull();
  });

  it('ProcessSupervisor spawns, captures stderr lines and stops', async () => {
    const p = new ProcessSupervisor('/bin/sh', ['-c', 'echo one >&2; echo two >&2; sleep 5']);
    const lines: string[] = [];
    p.on('stderr', (l: string) => lines.push(l));
    await p.start();
    await new Promise((r) => setTimeout(r, 200));
    expect(lines).toEqual(['one', 'two']);
    expect((await p.stop(500))?.expected).toBe(true);
  });

  it('readLines splits across chunk boundaries and multi-byte characters', async () => {
    const { PassThrough } = await import('node:stream');
    const s = new PassThrough();
    const got: string[] = [];
    readLines(s, (l) => got.push(l));
    const bytes = Buffer.from('{"type":"ready"}\r\nü-line\npartial');
    s.write(bytes.subarray(0, 5));
    s.write(bytes.subarray(5, 19)); // splits the 2-byte "ü"
    s.end(bytes.subarray(19));
    await new Promise((r) => setImmediate(r));
    expect(got).toEqual(['{"type":"ready"}', 'ü-line', 'partial']);
  });
});
