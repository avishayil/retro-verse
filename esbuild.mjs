import * as esbuild from 'esbuild';
import { rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
if (production) rmSync('dist', { recursive: true, force: true }); // no stale dev sourcemaps in the VSIX

/** @type {esbuild.BuildOptions[]} */
const builds = [
  {
    entryPoints: ['src/extension/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
  },
  {
    entryPoints: ['src/player/main.ts'],
    outfile: 'dist/player/player.js',
    platform: 'browser',
    format: 'esm',
    target: 'chrome120',
    loader: { '.css': 'css' },
  },
  {
    entryPoints: ['src/player/media/pcm-worklet.ts'],
    outfile: 'dist/player/pcm-worklet.js',
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
  },
  {
    entryPoints: ['src/player/styles.css'],
    outfile: 'dist/player/player.css',
  },
];

const common = { bundle: true, sourcemap: !production, minify: production, logLevel: 'info' };

if (watch) {
  const ctxs = await Promise.all(builds.map((b) => esbuild.context({ ...common, ...b })));
  await Promise.all(ctxs.map((c) => c.watch()));
} else {
  await Promise.all(builds.map((b) => esbuild.build({ ...common, ...b })));
}
