// Copies emulator cores from pinned npm packages into media/cores/ so the VSIX
// never fetches code from a CDN at runtime. Licence texts are copied alongside.
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = path.join(root, 'media', 'cores');

async function vendorMgba() {
  const pkgDir = path.dirname(require.resolve('@thenick775/mgba-wasm/package.json'));
  const pkg = JSON.parse(await readFile(path.join(pkgDir, 'package.json'), 'utf8'));
  const dest = path.join(out, 'mgba');
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  for (const f of ['mgba.js', 'mgba.wasm']) {
    await cp(path.join(pkgDir, 'dist', f), path.join(dest, f));
  }
  await writeFile(path.join(dest, 'VERSION.json'), JSON.stringify({ package: pkg.name, version: pkg.version, license: pkg.license, source: 'https://github.com/thenick775/mgba/tree/feature/wasm' }, null, 2));
  // MPL-2.0 requires the licence text to travel with the covered files.
  const mpl = path.join(root, 'licenses', 'MPL-2.0.txt');
  if (existsSync(mpl)) await cp(mpl, path.join(dest, 'LICENSE'));
  else if (process.env.CI) throw new Error('licenses/MPL-2.0.txt is missing (required for mGBA, MPL-2.0)');
  else console.warn('warning: licenses/MPL-2.0.txt is missing; add it before publishing a release');
  console.log(`vendored ${pkg.name}@${pkg.version}`);
}

async function vendorMelonDs() {
  const pkgDir = path.dirname(require.resolve('@emulatorjs/core-melonds/package.json'));
  const pkg = JSON.parse(await readFile(path.join(pkgDir, 'package.json'), 'utf8'));
  const dest = path.join(out, 'melonds');
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  // Non-threaded build: VS Code webviews are not cross-origin isolated, so no SharedArrayBuffer.
  const archive = path.join(pkgDir, 'melonds-wasm.data');
  const sevenZip = require('7zip-min');
  const unpack = promisify(sevenZip.unpack);
  await unpack(archive, dest);
  for (const f of ['melonds_libretro.js', 'melonds_libretro.wasm', 'license.txt']) {
    if (!existsSync(path.join(dest, f))) throw new Error(`melonDS archive missing ${f}`);
  }
  const jsSize = (await stat(path.join(dest, 'melonds_libretro.js'))).size;
  await writeFile(path.join(dest, 'VERSION.json'), JSON.stringify({ package: pkg.name, version: pkg.version, license: 'GPL-3.0', source: pkg.repository?.url, jsSize }, null, 2));
  console.log(`vendored ${pkg.name}@${pkg.version}`);
}

await mkdir(out, { recursive: true });
await vendorMgba();
await vendorMelonDs();
