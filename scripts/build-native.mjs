// Builds native/eden-bridge (macOS only) and copies it to bin/<platform>-<arch>/eden-bridge.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
if (process.platform !== 'darwin') {
  console.log('eden-bridge: skipped (macOS only for now)');
  process.exit(0);
}
const pkg = path.join(root, 'native', 'eden-bridge');
execFileSync('swift', ['build', '-c', 'release', '--package-path', pkg], { stdio: 'inherit' });
const outDir = path.join(root, 'bin', `${process.platform}-${process.arch}`);
mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'eden-bridge');
copyFileSync(path.join(pkg, '.build', 'release', 'eden-bridge'), out);
// Ad-hoc signature with the hardened runtime: macOS then ignores DYLD_* injection, enforces library validation
// and blocks debugger attachment, and TCC permissions stay attributed consistently.
execFileSync('/usr/bin/codesign', ['--force', '--options', 'runtime', '--timestamp=none', '--sign', '-', out], { stdio: 'inherit' });

console.log(`eden-bridge -> ${path.relative(root, out)}`);
