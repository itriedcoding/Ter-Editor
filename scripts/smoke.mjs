import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rm } from 'node:fs/promises';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, '.smoke');
const outfile = path.join(outDir, 'smoke.cjs');

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

const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit', env: process.env });

// Windows cannot delete a file that the shell still has open, so cleanup is
// best-effort and never masks the test result.
await rm(outDir, { recursive: true, force: true }).catch(() => undefined);

process.exit(result.status ?? 1);
