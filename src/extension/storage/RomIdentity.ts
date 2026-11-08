import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';

const SAMPLE = 4 * 1024 * 1024;
/** Above this size (multi-GB Switch images) we hash a deterministic sample instead of the whole file. */
export const FULL_HASH_LIMIT = 1024 * 1024 * 1024;

/**
 * Stable identity for a game image. GBA/NDS: SHA-256 of the full file.
 * Large images: SHA-256 over (size || first 4 MiB || middle 4 MiB || last 4 MiB), prefixed "s:" to avoid collisions with full hashes.
 */
export async function romIdentity(realPath: string, size: number): Promise<string> {
  if (size <= FULL_HASH_LIMIT) {
    const h = createHash('sha256');
    await new Promise<void>((resolve, reject) => {
      createReadStream(realPath).on('data', (c) => h.update(c)).on('end', resolve).on('error', reject);
    });
    return h.digest('hex');
  }
  const h = createHash('sha256');
  h.update(`size:${size};`);
  const fh = await open(realPath, 'r');
  try {
    for (const off of [0, Math.floor(size / 2) - SAMPLE / 2, size - SAMPLE]) {
      const buf = Buffer.alloc(SAMPLE);
      const { bytesRead } = await fh.read(buf, 0, SAMPLE, Math.max(0, off));
      h.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await fh.close();
  }
  return 's:' + h.digest('hex');
}

export async function readHeader(realPath: string, bytes: number): Promise<Uint8Array> {
  const fh = await open(realPath, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
  } finally {
    await fh.close();
  }
}
