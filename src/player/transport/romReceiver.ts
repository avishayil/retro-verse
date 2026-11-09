/**
 * Reassembles a ROM streamed by the host in `rom.chunk` messages. The size is fixed up front (from the init
 * payload) and every chunk is checked against it, so a confused or hostile sender cannot grow the buffer, write out
 * of order, or deliver a short file.
 */
export class RomReceiver {
  private readonly buf: Uint8Array;
  private received = 0;
  private settled = false;
  readonly done: Promise<Uint8Array>;
  private resolve!: (b: Uint8Array) => void;
  private reject!: (e: Error) => void;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly expectedSize: number,
    timeoutMs = 60_000,
  ) {
    if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) throw new Error('Invalid game size.');
    this.buf = new Uint8Array(expectedSize);
    this.done = new Promise((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
    this.timer = setTimeout(() => this.fail('Timed out while loading the game.'), timeoutMs);
  }

  /** Feed one chunk. Returns false once the transfer is finished (successfully or not). */
  push(c: { offset: number; total: number; data: Uint8Array; done: boolean; error?: string }): boolean {
    if (this.settled) return false;
    if (c.error) return this.fail(c.error);
    if (c.total !== this.expectedSize) return this.fail('The game size does not match.');
    if (!(c.data instanceof Uint8Array)) return this.fail('Invalid game data.');
    if (c.offset !== this.received) return this.fail('Game data arrived out of order.');
    if (c.offset + c.data.byteLength > this.expectedSize) return this.fail('Game data is larger than expected.');
    this.buf.set(c.data, c.offset);
    this.received += c.data.byteLength;
    if (c.done) {
      if (this.received !== this.expectedSize) return this.fail('The game file is incomplete.');
      this.finish();
      return false;
    }
    return true;
  }

  private finish(): void {
    this.settled = true;
    clearTimeout(this.timer);
    this.resolve(this.buf);
  }

  private fail(message: string): false {
    if (!this.settled) {
      this.settled = true;
      clearTimeout(this.timer);
      this.reject(new Error(message));
    }
    return false;
  }

  cancel(): void {
    this.fail('Loading was cancelled.');
  }
}
