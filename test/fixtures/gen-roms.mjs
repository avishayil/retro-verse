// Generates tiny, original, freely redistributable homebrew test ROMs (no Nintendo logo or code).
// Each fills the screen blue; holding A turns it red, holding Start turns it green — a visual check
// for rendering + input. Machine code was assembled from the commented sources below with
// `clang --target=armv5te-none-eabi` and is embedded so no ARM toolchain is needed.
//
// GBA:  mov r0,#0x04000000; DISPCNT=0x403; loop{ r2=KEYINPUT; colour=A?red:Start?green:blue; A held => SRAM[0]=0x5A; fill 240*160 }
//       followed by the "SRAM_V113" tag so cores detect a battery-backed SRAM save.
// NDS9: POWCNT1=0x8003; DISPCNT=VRAM-A display; VRAMCNT_A=0x80; loop{ same, fill 256*192 at 0x06800000 }
// NDS7: b .
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const GBA_CODE = '0103a0e3011ba0e3031081e2b010c0e10e74a0e3136e80e2b020d6e10634a0e3964ca0e3010012e31f50a0031f5ba0135a10a0030010c705080012e33e5ea003b250c3e0014054e2fcffff1af0ffffea5352414d5f56313133000000';
const NDS9_CODE = '0103a0e350109fe5032c80e2042082e2001082e50218a0e3001080e5092d80e28010a0e30010c2e5136e80e2b020d6e11a35a0e30349a0e3010012e31c509f053f5ba013080012e314509f05b250c3e0014054e2fcffff1af2ffffea038000001f800000e0830000';
const NDS7_CODE = 'feffffea';

export function crc16(buf, start, end) {
  let crc = 0xffff;
  for (let i = start; i < end; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc & 0xffff;
}

export function makeGba() {
  const rom = Buffer.alloc(0x1000);
  rom.writeUInt32LE(0xea00002e, 0); // b 0xC0
  rom.write('RVTEST', 0xa0, 'ascii');
  rom.write('RVTE', 0xac, 'ascii');
  rom.write('00', 0xb0, 'ascii');
  rom[0xb2] = 0x96;
  let chk = 0;
  for (let i = 0xa0; i <= 0xbc; i++) chk = (chk - rom[i]) & 0xff;
  rom[0xbd] = (chk - 0x19) & 0xff;
  Buffer.from(GBA_CODE, 'hex').copy(rom, 0xc0);
  return rom;
}

export function makeNds() {
  const arm9 = Buffer.from(NDS9_CODE, 'hex');
  const arm7 = Buffer.from(NDS7_CODE, 'hex');
  const rom = Buffer.alloc(0xa000);
  rom.write('RVTEST', 0x00, 'ascii');
  rom.write('RVTE', 0x0c, 'ascii');
  rom.write('00', 0x10, 'ascii');
  rom.writeUInt32LE(0x8000, 0x20); // past the 0x4000-0x7FFF secure area
  rom.writeUInt32LE(0x02000000, 0x24);
  rom.writeUInt32LE(0x02000000, 0x28);
  rom.writeUInt32LE(arm9.length, 0x2c);
  rom.writeUInt32LE(0x9000, 0x30);
  rom.writeUInt32LE(0x037f8000, 0x34);
  rom.writeUInt32LE(0x037f8000, 0x38);
  rom.writeUInt32LE(arm7.length, 0x3c);
  rom.writeUInt32LE(0x00586000, 0x60);
  rom.writeUInt32LE(0x001808f8, 0x64);
  rom.writeUInt32LE(rom.length, 0x80);
  rom.writeUInt32LE(0x4000, 0x84);
  arm9.copy(rom, 0x8000);
  arm7.copy(rom, 0x9000);
  rom.writeUInt16LE(crc16(rom, 0, 0x15e), 0x15e);
  return rom;
}

/** Minimal containers with the right magic for format detection tests (not runnable). */
export function makeSwitchStubs() {
  const nsp = Buffer.alloc(0x200);
  nsp.write('PFS0', 0, 'ascii');
  const xci = Buffer.alloc(0x200);
  xci.write('HEAD', 0x100, 'ascii');
  const nro = Buffer.alloc(0x200);
  nro.write('NRO0', 0x10, 'ascii');
  return { nsp, xci, nro };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'roms');
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'rv-test.gba'), makeGba());
  writeFileSync(path.join(out, 'rv-test.nds'), makeNds());
  const s = makeSwitchStubs();
  writeFileSync(path.join(out, 'stub.nsp'), s.nsp);
  writeFileSync(path.join(out, 'stub.xci'), s.xci);
  writeFileSync(path.join(out, 'stub.nro'), s.nro);
  console.log(`fixtures written to ${out}`);
}
