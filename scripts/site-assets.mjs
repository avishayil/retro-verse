// Generates the website's pixel-art assets:
//   site/assets/wordmark.svg       "RETROVERSE" set in a 5x7 bitmap font
//   site/assets/icons/*.svg        16x16 pixel icons (one grid, one palette, no emoji)
//   site/assets/*.webp             WebP versions of the screenshots (encoded by headless Chromium)
//   site/assets/og.png             1200x630 social card rendered from scripts/site-og.html
// Usage: node scripts/site-assets.mjs
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const assets = path.join(root, 'site', 'assets');

// Palette (matches the CSS tokens in site/style.css).
const C = { light: '#c9c0ff', brand: '#7b6bf0', deep: '#3a2d9c', accent: '#22c55e', ink: '#0b0f1e' };

/** Turn rows of characters into crisp <rect> runs. `colors` maps characters to fills; '.' is empty. */
function pixels(rows, colors, unit = 1, dx = 0, dy = 0) {
  const out = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      if (!colors[ch]) {
        x++;
        continue;
      }
      let w = 1;
      while (row[x + w] === ch) w++;
      out.push(`<rect x="${(x + dx) * unit}" y="${(y + dy) * unit}" width="${w * unit}" height="${unit}" fill="${colors[ch]}"/>`);
      x += w;
    }
  });
  return out.join('');
}

// --- wordmark -------------------------------------------------------------------------------------------
const FONT = {
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '.#.#.', '.#.#.', '..#..', '..#..'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
};

function wordmark(text) {
  const rows = Array.from({ length: 7 }, () => '');
  [...text].forEach((ch, i) => FONT[ch].forEach((r, y) => (rows[y] += (i ? '.' : '') + r)));
  const w = rows[0].length + 1;
  const h = 8; // one extra row/column for the drop shadow
  const shadow = pixels(rows, { '#': C.deep }, 1, 1, 1);
  const face = pixels(rows, { '#': C.light });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w * 4}" height="${h * 4}" shape-rendering="crispEdges" role="img" aria-label="RetroVerse"><title>RetroVerse</title>${shadow}${face}</svg>\n`;
}

// --- icons (16x16; '#' light, 'b' brand, 'd' deep, 'g' accent) ------------------------------------------
const ICONS = {
  // Game Boy Advance style cartridge
  cartridge: [
    '................',
    '...##########...',
    '...#dddddddd##..',
    '...#d######d.#..',
    '...#d#bbbb#d.#..',
    '...#d#bbbb#d.#..',
    '...#d######d.#..',
    '...#dddddddd.#..',
    '...#.........#..',
    '...#.##.##.#.#..',
    '...#.##.##.#.#..',
    '...#.........#..',
    '...###########..',
    '....#.#.#.#.#...',
    '................',
    '................',
  ],
  // Two stacked screens (Nintendo DS)
  dualscreen: [
    '................',
    '..############..',
    '..#bbbbbbbbbb#..',
    '..#bbbbbbbbbb#..',
    '..#bbbbbbbbbb#..',
    '..#bbbbbbbbbb#..',
    '..############..',
    '.....#....#.....',
    '..############..',
    '..#dddddddddd#..',
    '..#dddddddd#d#..',
    '..#ddddddd#dd#..',
    '..#dddddd#ddd#..',
    '..############..',
    '................',
    '................',
  ],
  // Handheld controller with two sticks (Switch)
  controller: [
    '................',
    '................',
    '..###......###..',
    '.#####....#####.',
    '.#bb##########g#',
    '#b##b###..##g#g#',
    '#bb##########g##',
    '#####d####d#####',
    '####ddd##ddd####',
    '#####d####d#####',
    '.######..######.',
    '..####....####..',
    '................',
    '................',
    '................',
    '................',
  ],
  // D-pad
  dpad: [
    '................',
    '................',
    '......####......',
    '......#bb#......',
    '......#bb#......',
    '......#bb#......',
    '..#####bb#####..',
    '..#bbbb##bbbb#..',
    '..#bbbb##bbbb#..',
    '..#####bb#####..',
    '......#bb#......',
    '......#bb#......',
    '......#bb#......',
    '......####......',
    '................',
    '................',
  ],
  // Explorer: folder tree with a game below
  explorer: [
    '................',
    '.###............',
    '.#bb####........',
    '.#bbbbbb#.......',
    '.########.......',
    '...#............',
    '...#.######.....',
    '...#.#bbbb#.....',
    '...#.######.....',
    '...#............',
    '.##############.',
    '.#gggggggggggg#.',
    '.#g##gggggg##g#.',
    '.#gggggggggggg#.',
    '.##############.',
    '................',
  ],
  // Download arrow into a tray
  download: [
    '................',
    '.......##.......',
    '.......##.......',
    '.......##.......',
    '.......##.......',
    '....########....',
    '.....######.....',
    '......####......',
    '.......##.......',
    '................',
    '..##........##..',
    '..##........##..',
    '..############..',
    '..############..',
    '................',
    '................',
  ],
  // Keyboard key
  keyboard: [
    '................',
    '................',
    '.##############.',
    '.#bbbbbbbbbbbb#.',
    '.#b##b##b##b#b#.',
    '.#bbbbbbbbbbbb#.',
    '.#b#b##b##b#bb#.',
    '.#bbbbbbbbbbbb#.',
    '.#bb########bb#.',
    '.#bbbbbbbbbbbb#.',
    '.##############.',
    '.dddddddddddddd.',
    '................',
    '................',
    '................',
    '................',
  ],
  // Shield (security)
  shield: [
    '................',
    '.......##.......',
    '.....##bb##.....',
    '...##bbbbbb##...',
    '..#bbbbbbbbbb#..',
    '..#bbbbbbbbgb#..',
    '..#bbbbbbbggb#..',
    '..#bgbbbbggbb#..',
    '..#bggbbggbbb#..',
    '...#bgggggbb#...',
    '...#bbgggbbb#...',
    '....#bbgbbb#....',
    '.....##bb##.....',
    '.......##.......',
    '................',
    '................',
  ],
};

function icon(rows) {
  const body = pixels(rows, { '#': C.light, b: C.brand, d: C.deep, g: C.accent });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="32" height="32" shape-rendering="crispEdges" aria-hidden="true">${body}</svg>\n`;
}

// --- raster assets via headless Chromium ----------------------------------------------------------------
function chromiumExecutable() {
  const dir = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  if (!existsSync(dir)) return undefined;
  return readdirSync(dir)
    .filter((n) => n.startsWith('chromium_headless_shell-'))
    .sort()
    .reverse()
    .map((n) => path.join(dir, n, 'chrome-headless-shell-mac-arm64/chrome-headless-shell'))
    .find(existsSync);
}

async function rasterAssets() {
  const executablePath = chromiumExecutable();
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const page = await browser.newPage();
  for (const name of ['screenshot', 'explorer-player']) {
    const png = await readFile(path.join(assets, `${name}.png`));
    const webp = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/webp', 0.86).split(',')[1];
    }, png.toString('base64'));
    await writeFile(path.join(assets, `${name}.webp`), Buffer.from(webp, 'base64'));
    console.log(`${name}.webp: ${png.length} -> ${Buffer.from(webp, 'base64').length} bytes`);
  }
  const og = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await og.goto(pathToFileURL(path.join(root, 'scripts', 'site-og.html')).href);
  await og.waitForLoadState('networkidle');
  await og.screenshot({ path: path.join(assets, 'og.png') });
  console.log('og.png rendered');
  await browser.close();
}

await mkdir(path.join(assets, 'icons'), { recursive: true });
await writeFile(path.join(assets, 'wordmark.svg'), wordmark('RETROVERSE'));
for (const [name, rows] of Object.entries(ICONS)) {
  if (rows.some((r) => r.length !== 16) || rows.length !== 16) throw new Error(`icon ${name} is not 16x16`);
  await writeFile(path.join(assets, 'icons', `${name}.svg`), icon(rows));
}
console.log(`wordmark + ${Object.keys(ICONS).length} icons written`);
if (!process.argv.includes('--svg-only')) await rasterAssets();
