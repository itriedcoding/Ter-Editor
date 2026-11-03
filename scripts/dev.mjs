import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const electronBinary = require('electron');

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))));
  });
}

async function waitForServer(url, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* server not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const devUrl = 'http://localhost:5173';

console.log('[dev] building electron main process');
await run('node', ['scripts/build-main.mjs']);

console.log('[dev] starting vite');
const vite = spawn('npx', ['vite', '--port', '5173', '--strictPort'], { cwd: root, stdio: 'inherit' });

let electron;

try {
  await waitForServer(devUrl);
  console.log('[dev] launching electron');
  electron = spawn(electronBinary, ['.'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: devUrl, NODE_ENV: 'development' },
  });
  electron.on('exit', (code) => {
    vite.kill('SIGTERM');
    process.exit(code ?? 0);
  });
} catch (error) {
  console.error('[dev]', error.message);
  vite.kill('SIGTERM');
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    electron?.kill('SIGTERM');
    vite.kill('SIGTERM');
    process.exit(0);
  });
}
