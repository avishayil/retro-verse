import { spawn, type SpawnOptions } from 'node:child_process';

// Node's text decoding for streams (Readable#setEncoding, readline, execFile's default 'utf8' encoding) goes
// through the `string_decoder` module, which other extensions in the same extension host have been seen to
// break ("TypeError: StringDecoder is not a constructor"). Everything here decodes with the global
// TextDecoder instead, so RetroVerse's process handling cannot be broken that way.

/** Invoke `onLine` for every line of a byte stream (\n or \r\n). Bounded buffer; flushes the tail on end. */
export function readLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void, maxBuffered = 1 << 20): void {
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  stream.on('data', (chunk: Buffer | string) => {
    buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, i).replace(/\r$/, ''));
      buf = buf.slice(i + 1);
    }
    if (buf.length > maxBuffered) buf = buf.slice(-maxBuffered / 2);
  });
  stream.on('end', () => {
    buf += decoder.decode();
    if (buf) onLine(buf);
    buf = '';
  });
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** execFile replacement: no shell, raw byte collection, TextDecoder, timeout. Never rejects. */
export function run(command: string, args: readonly string[], opts: { timeoutMs?: number; maxBytes?: number } & Omit<SpawnOptions, 'shell' | 'stdio'> = {}): Promise<RunResult> {
  const { timeoutMs = 5000, maxBytes = 4 << 20, ...spawnOpts } = opts;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, [...args], { ...spawnOpts, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      return resolve({ code: null, stdout: '', stderr: String(e), timedOut: false });
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    const collect = (into: Buffer[]) => (c: Buffer) => {
      size += c.length;
      if (size <= maxBytes) into.push(c);
    };
    child.stdout?.on('data', collect(out));
    child.stderr?.on('data', collect(err));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const finish = (code: number | null) => {
      clearTimeout(timer);
      const d = new TextDecoder('utf-8');
      resolve({ code, stdout: d.decode(Buffer.concat(out)), stderr: d.decode(Buffer.concat(err)), timedOut });
    };
    child.once('error', (e) => {
      err.push(Buffer.from(String(e)));
      finish(null);
    });
    child.once('close', (code) => finish(code));
  });
}
