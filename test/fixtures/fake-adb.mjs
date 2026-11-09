#!/usr/bin/env node
// Fake adb for unit tests. The phone's file system is the folder in FAKE_PHONE; every call is appended to
// FAKE_ADB_LOG. Supports exactly the commands RetroVerse uses.
import { appendFileSync, copyFileSync, existsSync, readdirSync, renameSync, statSync, utimesSync } from 'node:fs';
import path from 'node:path';

const root = process.env.FAKE_PHONE;
let args = process.argv.slice(2);
appendFileSync(process.env.FAKE_ADB_LOG, JSON.stringify(args) + '\n');
if (args[0] === '-s') args = args.slice(2);
const local = (remote) => path.join(root, remote);
const out = (s) => process.stdout.write(s);
/** Split a shell line into words, honouring single quotes only (that is all RetroVerse emits). */
function words(line) {
  const w = [];
  let cur = '';
  let quoted = false;
  let had = false;
  for (const ch of line) {
    if (ch === "'") { quoted = !quoted; had = true; continue; }
    if (!quoted && ch === ' ') { if (cur || had) w.push(cur); cur = ''; had = false; continue; }
    cur += ch;
  }
  if (cur || had) w.push(cur);
  return w;
}

switch (args[0]) {
  case 'devices':
    out(`List of devices attached\n${process.env.FAKE_DEVICES ?? 'R5CT1 device usb:1 product:x model:Galaxy_S23 device:y'}\n`);
    break;
  case 'pull':
    if (!existsSync(local(args[1]))) { process.stderr.write('adb: error: remote object does not exist\n'); process.exit(1); }
    copyFileSync(local(args[1]), args[2]);
    break;
  case 'push':
    if (process.env.FAKE_CORRUPT_PUSH === '1') { copyFileSync(args[1], local(args[2])); appendFileSync(local(args[2]), 'x'); break; }
    copyFileSync(args[1], local(args[2]));
    break;
  case 'shell': {
    const line = args[1];
    const w = words(line);
    if (w[0] === 'stat') {
      const p = local(w[3]);
      if (!existsSync(p)) out('missing\n');
      else { const s = statSync(p); out(`${s.size} ${Math.floor(s.mtimeMs / 1000)}\n`); }
    } else if (w[0] === 'mv') {
      renameSync(local(w[2]), local(w[3]));
      const now = new Date();
      utimesSync(local(w[3]), now, now);
    } else if (w[0] === 'am') {
      // force-stop: nothing to do
    } else if (w[0] === 'pm') {
      out((process.env.FAKE_PACKAGES ?? 'com.retroarch,me.magnum.melonds,com.android.chrome').split(',').map((p) => `package:${p}`).join('\n') + '\n');
    } else if (w[0] === 'find') {
      const roots = [];
      for (let i = 1; i < w.length && w[i].startsWith('/'); i++) roots.push(w[i]);
      const exts = [...line.matchAll(/-iname '\*(\.[a-z0-9]+)'/g)].map((m) => m[1]);
      const walk = (d) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : []);
      for (const r of roots) for (const f of walk(local(r))) if (exts.some((e) => f.toLowerCase().endsWith(e))) { const s = statSync(f); out(`${Math.floor(s.mtimeMs / 1000)} ${s.size} /${path.relative(root, f)}\n`); }
    } else {
      process.stderr.write(`fake adb: unsupported shell command ${line}\n`);
      process.exit(2);
    }
    break;
  }
  default:
    process.stderr.write(`fake adb: unsupported ${args.join(' ')}\n`);
    process.exit(2);
}
