import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  external: ['electron', 'node-pty'],
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
};

const targets = [
  { entryPoints: [path.join(root, 'electron/main.ts')], outfile: path.join(root, 'dist-electron/main.js') },
  { entryPoints: [path.join(root, 'electron/preload.ts')], outfile: path.join(root, 'dist-electron/preload.js') },
];

if (watch) {
  for (const target of targets) {
    const ctx = await context({ ...shared, ...target });
    await ctx.watch();
  }
  console.log('[build-main] watching');
} else {
  await Promise.all(targets.map((target) => build({ ...shared, ...target })));
  console.log('[build-main] done');
}
