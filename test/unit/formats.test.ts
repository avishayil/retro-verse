import { describe, expect, it } from 'vitest';
import { checkMagic, crc16, formatForPath } from '../../src/extension/registry/formats';
// @ts-expect-error JS fixture module
import { makeGba, makeNds, makeSwitchStubs } from '../fixtures/gen-roms.mjs';

describe('format detection', () => {
  it('maps extensions case-insensitively', () => {
    expect(formatForPath('/a/b/Game.GBA')?.platform).toBe('gba');
    expect(formatForPath('/a/x.nds')?.platform).toBe('nds');
    expect(formatForPath('/a/x.nsp')?.platform).toBe('switch');
    expect(formatForPath('/a/x.xci')?.platform).toBe('switch');
    expect(formatForPath('/a/x.nro')?.platform).toBe('switch');
    expect(formatForPath('/a/x.zip')).toBeUndefined();
    expect(formatForPath('/a/noext')).toBeUndefined();
    expect(formatForPath('/a.gba/noext')).toBeUndefined();
  });

  it('accepts the generated GBA ROM and reads its title', () => {
    const r = checkMagic('gba', '.gba', new Uint8Array(makeGba()));
    expect(r.ok).toBe(true);
    expect(r.headerTitle).toBe('RVTEST');
  });

  it('rejects a GBA ROM with a corrupted header checksum', () => {
    const rom = makeGba();
    rom[0xbd] ^= 0xff;
    expect(checkMagic('gba', '.gba', new Uint8Array(rom)).ok).toBe(false);
  });

  it('validates the NDS header CRC', () => {
    const rom = makeNds();
    expect(checkMagic('nds', '.nds', new Uint8Array(rom)).ok).toBe(true);
    rom[0x05] ^= 1;
    expect(checkMagic('nds', '.nds', new Uint8Array(rom)).reason).toMatch(/CRC/);
  });

  it('computes CRC-16/MODBUS', () => {
    expect(crc16(new TextEncoder().encode('123456789'), 0, 9)).toBe(0x4b37);
  });

  it('checks Switch container magics', () => {
    const s = makeSwitchStubs();
    expect(checkMagic('switch', '.nsp', new Uint8Array(s.nsp)).ok).toBe(true);
    expect(checkMagic('switch', '.xci', new Uint8Array(s.xci)).ok).toBe(true);
    expect(checkMagic('switch', '.nro', new Uint8Array(s.nro)).ok).toBe(true);
    expect(checkMagic('switch', '.xci', new Uint8Array(s.nsp)).ok).toBe(false);
  });

  it('sanitises header titles to printable ASCII', () => {
    const rom = makeGba();
    rom.write('<b>\u0001', 0xa0, 'latin1');
    expect(checkMagic('gba', '.gba', new Uint8Array(rom)).headerTitle).not.toMatch(/\u0001/);
  });
});
