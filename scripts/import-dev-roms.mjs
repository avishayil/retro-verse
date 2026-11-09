// Sets up a local, gitignored dev library from your own games, and imports compatible battery saves into
// RetroVerse's save store (the same location the extension uses: globalStorage/<ext-id>/saves/<sha256>/<core>/).
//
//   ROMS_DIR=~/Games [SWITCH_DIR=~/Games/Switch] node scripts/import-dev-roms.mjs [--dry-run] [--force]
//
// ROMS_DIR holds .gba/.nds files. Battery saves are looked up next to each ROM (<name>.sav / <name>.srm) and
// in any `saves/` or `SkyEmu/` folder below ROMS_DIR. SWITCH_DIR (optional) holds .nsp/.xci/.nro files.
//
// Source folders are only ever read. GBA/NDS ROMs are copied into dev-roms/; multi-GB Switch images are
// symlinked (RetroVerse resolves symlinks before launching Eden). Existing RetroVerse saves are backed up
// (battery.sav.bak-<timestamp>) before being replaced. Save states from other emulators are not imported
// (incompatible formats).
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, symlink, writeFile, lstat, readlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dry = process.argv.includes('--dry-run');
const expand = (p) => p.replace(/^~(?=$|\/)/, os.homedir());
if (!process.env.ROMS_DIR) {
  console.error('usage: ROMS_DIR=<folder with .gba/.nds files> [SWITCH_DIR=<folder with .nsp/.xci/.nro>] node scripts/import-dev-roms.mjs [--dry-run]');
  process.exit(2);
}
const ROMS_DIR = expand(process.env.ROMS_DIR);
const SWITCH_DIR = process.env.SWITCH_DIR ? expand(process.env.SWITCH_DIR) : undefined;
const EXT_ID = 'retroverse.retroverse';
const SAVES_ROOT = expand(process.env.RETROVERSE_SAVES ?? `~/Library/Application Support/Code/User/globalStorage/${EXT_ID}/saves`);
const DEV = path.join(root, 'dev-roms');

const CORE = { '.gba': ['gba', 'mgba'], '.nds': ['nds', 'melonds'] };
const NDS_SAVE_SIZES = [512, 8 * 1024, 64 * 1024, 256 * 1024, 512 * 1024, 1024 * 1024, 2 * 1024 * 1024, 8 * 1024 * 1024];

const log = (...a) => console.log(dry ? '[dry-run]' : '', ...a);

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

/** Battery save candidates for a ROM, newest first: <name>.sav next to it, SkyEmu .srm, RetroArch .srm. */
/** `saves/` and `SkyEmu/` folders anywhere below ROMS_DIR (up to 3 levels deep). */
function findSaveDirs(dir, depth = 0) {
  if (depth > 3) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (/^(saves|skyemu)$/i.test(e.name)) out.push(p);
    out.push(...findSaveDirs(p, depth + 1));
  }
  return out;
}

function saveCandidates(romPath) {
  const base = path.basename(romPath, path.extname(romPath));
  const dirs = [path.dirname(romPath), ...saveDirs];
  const out = [];
  for (const d of dirs) for (const ext of ['.sav', '.srm']) {
    const p = path.join(d, base + ext);
    if (existsSync(p)) out.push({ path: p, mtime: statSync(p).mtimeMs });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** Normalise a save to what the core expects. SkyEmu pads DS saves to 8 MiB with zeros. */
function normaliseSave(platform, data) {
  if (platform !== 'nds') return data;
  let end = data.length;
  while (end > 0 && data[end - 1] === 0) end--;
  const size = NDS_SAVE_SIZES.find((s) => s >= end && s <= data.length) ?? data.length;
  return size < data.length ? data.subarray(0, size) : data;
}

async function atomicWrite(p, data) {
  await mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, p);
}

async function importRom(romPath) {
  const ext = path.extname(romPath).toLowerCase();
  const [platform, coreId] = CORE[ext];
  const dest = path.join(DEV, platform, path.basename(romPath));
  const srcSize = statSync(romPath).size;
  if (existsSync(dest) && statSync(dest).size === srcSize) log(`= ${path.relative(root, dest)} (already present)`);
  else {
    log(`+ copy ${path.basename(romPath)} -> ${path.relative(root, dest)}`);
    if (!dry) {
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(romPath, dest);
    }
  }
  const id = await sha256(romPath);
  const cands = saveCandidates(romPath);
  if (!cands.length) return log(`  no battery save found for ${path.basename(romPath)}`);
  const src = cands[0];
  const raw = await readFile(src.path);
  const data = normaliseSave(platform, raw);
  const target = path.join(SAVES_ROOT, id, coreId, 'battery.sav');
  if (existsSync(target)) {
    const cur = await readFile(target);
    if (cur.equals(data)) return log(`  = save already imported (${data.length} bytes)`);
    // Never replace newer progress (e.g. played in RetroVerse, or synced from a phone) with an older file.
    if (statSync(target).mtimeMs > src.mtime && !process.argv.includes('--force')) {
      return log(`  ~ kept RetroVerse save: it is newer than ${path.basename(src.path)} (use --force to replace it)`);
    }
    const bak = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    log(`  ! existing RetroVerse save backed up -> ${path.basename(bak)}`);
    if (!dry) await copyFile(target, bak);
  }
  log(`  + save ${path.relative(ROMS_DIR, src.path)} (${raw.length}${data.length !== raw.length ? ` -> ${data.length}` : ''} bytes) -> saves/${id.slice(0, 12)}…/${coreId}/battery.sav`);
  if (cands.length > 1) log(`    (newest of ${cands.length} candidates; others: ${cands.slice(1).map((c) => path.basename(path.dirname(c.path)) + '/' + path.basename(c.path)).join(', ')})`);
  if (!dry) await atomicWrite(target, data);
}

async function linkSwitch() {
  if (!SWITCH_DIR) return log('(SWITCH_DIR not set; skipping Switch games)');
  if (!existsSync(SWITCH_DIR)) return log(`(no Switch folder at ${SWITCH_DIR})`);
  const files = readdirSync(SWITCH_DIR).filter((f) => /\.(nsp|xci|nro)$/i.test(f));
  for (const f of files) {
    const src = path.join(SWITCH_DIR, f);
    // Small versioned NSPs next to a base game are updates: Eden applies them from its game folder; they are not launchable.
    if (/\.nsp$/i.test(f) && statSync(src).size < 512 * 1024 * 1024 && /v\d+/i.test(f) && !/v0*100\b/i.test(f)) {
      log(`- skip ${f} (update — Eden applies it automatically from its game folder; don't launch it directly)`);
      continue;
    }
    const dest = path.join(DEV, 'switch', f);
    const existing = await lstat(dest).catch(() => undefined);
    if (existing?.isSymbolicLink() && (await readlink(dest)) === src) { log(`= ${path.relative(root, dest)} -> ${src}`); continue; }
    if (existing) { log(`! ${path.relative(root, dest)} exists and is not our symlink; leaving it alone`); continue; }
    log(`+ link ${path.relative(root, dest)} -> ${src}`);
    if (!dry) {
      await mkdir(path.dirname(dest), { recursive: true });
      await symlink(src, dest);
    }
  }
}

if (!existsSync(ROMS_DIR)) {
  console.error(`ROMS_DIR not found: ${ROMS_DIR}`);
  process.exit(1);
}
const saveDirs = findSaveDirs(ROMS_DIR);
log(`ROMs:  ${ROMS_DIR}\nSaves: ${SAVES_ROOT}\nDev library: ${DEV}\n`);
const roms = readdirSync(ROMS_DIR).filter((f) => CORE[path.extname(f).toLowerCase()]).map((f) => path.join(ROMS_DIR, f));
for (const r of roms) await importRom(r);
await linkSwitch();
log('\nSkipped on purpose: save states from melonDS desktop (.ml1-3) and SkyEmu (.state) — not compatible with RetroVerse\'s cores; .rtc/.mch files — not used.');
