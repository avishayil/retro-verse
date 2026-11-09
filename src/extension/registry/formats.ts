import type { Platform } from '../../protocol/types';

export interface FormatInfo {
  platform: Platform;
  extension: string;
  label: string;
}

const FORMATS: Record<string, FormatInfo> = {
  '.gba': { platform: 'gba', extension: '.gba', label: 'Game Boy Advance' },
  '.nds': { platform: 'nds', extension: '.nds', label: 'Nintendo DS' },
  '.nsp': { platform: 'switch', extension: '.nsp', label: 'Switch (NSP)' },
  '.xci': { platform: 'switch', extension: '.xci', label: 'Switch (XCI)' },
  '.nro': { platform: 'switch', extension: '.nro', label: 'Switch homebrew (NRO)' },
};

export function formatForPath(p: string): FormatInfo | undefined {
  const m = /\.[^./\\]+$/.exec(p);
  return m ? FORMATS[m[0].toLowerCase()] : undefined;
}

/** Bytes of the header we need for magic checks. */
export const HEADER_PROBE_BYTES = 0x200;

const NINTENDO_LOGO_PREFIX = [0x24, 0xff, 0xae, 0x51, 0x69, 0x9a, 0xa2, 0x21];

function matches(buf: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (buf.byteLength < offset + expected.length) return false;
  return expected.every((b, i) => buf[offset + i] === b);
}

function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

/** CRC-16/MODBUS as used by the NDS header (init 0xFFFF, poly 0xA001 reflected). */
export function crc16(buf: Uint8Array, start: number, end: number): number {
  let crc = 0xffff;
  for (let i = start; i < end; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc & 0xffff;
}

export function gbaHeaderChecksum(buf: Uint8Array): number {
  let chk = 0;
  for (let i = 0xa0; i <= 0xbc; i++) chk = (chk - buf[i]) & 0xff;
  return (chk - 0x19) & 0xff;
}

export interface MagicResult {
  ok: boolean;
  /** Human readable reason when !ok. */
  reason?: string;
  /** Game title from the header, sanitised to printable ASCII. */
  headerTitle?: string;
}

function headerString(buf: Uint8Array, off: number, len: number): string | undefined {
  if (buf.byteLength < off + len) return undefined;
  const s = String.fromCharCode(...buf.subarray(off, off + len)).replace(/\0+$/, '');
  const clean = s.replace(/[^\x20-\x7e]/g, '').trim();
  return clean || undefined;
}

export function checkMagic(platform: Platform, ext: string, buf: Uint8Array): MagicResult {
  switch (platform) {
    case 'gba': {
      if (buf.byteLength < 0xc0) return { ok: false, reason: 'File is too small to be a GBA ROM.' };
      const title = headerString(buf, 0xa0, 12);
      if (buf[0xb2] !== 0x96) return { ok: false, reason: 'GBA header fixed byte (0xB2) mismatch.', headerTitle: title };
      if (gbaHeaderChecksum(buf) !== buf[0xbd]) return { ok: false, reason: 'GBA header checksum mismatch.', headerTitle: title };
      return { ok: true, headerTitle: title };
    }
    case 'nds': {
      if (buf.byteLength < 0x160) return { ok: false, reason: 'File is too small to be an NDS ROM.' };
      const title = headerString(buf, 0x00, 12);
      const stored = buf[0x15e] | (buf[0x15f] << 8);
      if (crc16(buf, 0, 0x15e) !== stored) return { ok: false, reason: 'NDS header CRC mismatch.', headerTitle: title };
      if (!matches(buf, 0xc0, NINTENDO_LOGO_PREFIX)) return { ok: true, headerTitle: title, reason: 'Homebrew header without logo.' };
      return { ok: true, headerTitle: title };
    }
    case 'switch':
      if (ext === '.nsp') return matches(buf, 0, ascii('PFS0')) ? { ok: true } : { ok: false, reason: 'Missing PFS0 magic.' };
      if (ext === '.xci') return matches(buf, 0x100, ascii('HEAD')) ? { ok: true } : { ok: false, reason: 'Missing XCI HEAD magic.' };
      if (ext === '.nro') return matches(buf, 0x10, ascii('NRO0')) ? { ok: true } : { ok: false, reason: 'Missing NRO0 magic.' };
      return { ok: false, reason: 'Unknown Switch container.' };
  }
}
