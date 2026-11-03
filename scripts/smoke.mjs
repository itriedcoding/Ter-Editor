import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rm } from 'node:fs/promises';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outfile = path.join(root, '.smoke', 'smoke.cjs');

await build({
  entryPoints: [path.join(root, 'scripts', 'smoke-entry.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['node-pty'],
  logLevel: 'warning',
});

try {
  await import(pathToFileURL(outfile).href);
} finally {
  await rm(path.join(root, '.smoke'), { recursive: true, force: true });
}
