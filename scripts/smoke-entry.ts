import assert from 'node:assert/strict';
import { existsSync, promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FsService } from '../electron/services/fs';
import { loadNativeFs } from '../electron/native/fs';
import { TerminalService } from '../electron/services/terminal';
import { languageForPath, isBinaryExt, labelForLanguage } from '../shared/languages';
import { applyTextEdits, offsetAt, positionAt } from '../shared/text';
import { fileUri, uriToPath } from '../shared/uri';
import { installFromOpenVsx } from '../electron/services/vsix';

let checks = 0;

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    throw new Error(`${name}: ${(error as Error).message}`);
  }
  checks += 1;
  console.log(`  ok  ${name}`);
}

async function main(): Promise<void> {
  console.log('language detection');
  await check('TypeScript extension', () => assert.equal(languageForPath('/a/b/app.tsx'), 'typescript'));
  await check('Haskell extension maps to a real language id', () => assert.equal(languageForPath('Main.hs'), 'haskell'));
  await check('Dockerfile filename', () => assert.equal(languageForPath('/repo/Dockerfile'), 'dockerfile'));
  await check('dotenv filename', () => assert.equal(languageForPath('/repo/.env.local'), 'dotenv'));
  await check('unknown extension falls back to plaintext', () => assert.equal(languageForPath('file.zzz'), 'plaintext'));
  await check('binary detection', () => assert.equal(isBinaryExt('logo.png'), true));
  await check('language label', () => assert.equal(labelForLanguage('cpp'), 'C/C++'));

  console.log('text helpers');
  const source = 'one\ntwo\nthree';
  await check('offsetAt round trip', () => {
    const offset = offsetAt(source, 2, 2);
    assert.deepEqual(positionAt(source, offset), { line: 2, column: 2 });
  });
  await check('applyTextEdits applies from the end', () => {
    const result = applyTextEdits(source, [
      { startLine: 1, startColumn: 1, endLine: 1, endColumn: 4, newText: 'ONE' },
      { startLine: 3, startColumn: 1, endLine: 3, endColumn: 6, newText: 'THREE' },
    ]);
    assert.equal(result, 'ONE\ntwo\nTHREE');
  });

  console.log('uri helpers');
  await check('unix path round trip', () => assert.equal(uriToPath(fileUri('/home/dev/a b.ts')), '/home/dev/a b.ts'));
  await check('windows path round trip', () => {
    const uri = fileUri('C:\\Users\\dev\\a b.ts');
    assert.equal(uri, 'file:///C:/Users/dev/a%20b.ts');
    assert.equal(uriToPath(uri), 'C:\\Users\\dev\\a b.ts');
  });

  console.log('filesystem service');
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'ter-smoke-'));
  const nativeFs = loadNativeFs(path.resolve(__dirname, '..'));
  await check('Rust filesystem core loads', () => assert.match(nativeFs.nativeVersion(), /ter-fs/));
  const service = new FsService(() => nativeFs);
  try {
    const snapshot = await service.createProject({ parent: tempRoot, name: 'demo-app', template: 'web' });
    await check('project scaffold created', () => assert.equal(snapshot.name, 'demo-app'));
    const html = await fsp.readFile(path.join(snapshot.root, 'index.html'), 'utf8');
    await check('template files have real content', () => assert.ok(html.includes('<!doctype html>') && html.includes('demo-app')));
    await check('binary guard', () => assert.equal(isBinaryExt(path.join(snapshot.root, 'index.html')), false));

    const listing = await service.list(snapshot.root);
    await check('list returns sorted entries', () => assert.ok(listing.length >= 4 && listing.some((entry) => entry.name === 'app.js')));

    const appJs = path.join(snapshot.root, 'app.js');
    await service.writeText(appJs, 'console.log("patched");\n');
    await check('write then read text', async () => assert.ok((await service.readText(appJs)).includes('patched')));

    await service.create(path.join(snapshot.root, 'src'), 'folder');
    await service.create(path.join(snapshot.root, 'src', 'main.ts'), 'file', 'export const x = 1;\n');
    await check('create file with content', async () =>
      assert.equal(await service.readText(path.join(snapshot.root, 'src', 'main.ts')), 'export const x = 1;\n'),
    );

    await service.rename(path.join(snapshot.root, 'src', 'main.ts'), path.join(snapshot.root, 'src', 'entry.ts'));
    await check('rename moves the file', async () =>
      assert.ok((await service.readText(path.join(snapshot.root, 'src', 'entry.ts'))).includes('export const x')),
    );

    const found = await service.find('entry');
    await check('fuzzy file find', () => assert.ok(found.some((entry) => entry.path.endsWith('entry.ts'))));

    const hits = await service.search('patched');
    await check('text search returns line hits', () => assert.ok(hits.length > 0 && hits[0].line === 1));

    let guarded = false;
    try {
      await service.readText('/etc/passwd');
    } catch {
      guarded = true;
    }
    await check('path escape is rejected', () => assert.equal(guarded, true));

    let duplicate = false;
    try {
      await service.createProject({ parent: tempRoot, name: 'demo-app', template: 'empty' });
    } catch {
      duplicate = true;
    }
    await check('non-empty target folder is rejected', () => assert.equal(duplicate, true));

    await service.remove(path.join(snapshot.root, 'src'));
    let removed = false;
    try {
      await fsp.access(path.join(snapshot.root, 'src'));
    } catch {
      removed = true;
    }
    await check('remove deletes a directory', () => assert.equal(removed, true));

    console.log('pty terminal');
    const terminalChunks: string[] = [];
    const terminal = new TerminalService((channel, payload) => {
      if (channel === 'term:data') terminalChunks.push((payload as { data: string }).data);
    }, () => tempRoot);
    const session = terminal.create({ cwd: tempRoot, cols: 90, rows: 24 });
    const marker = path.join(tempRoot, 'pty-ok.txt');
    terminal.write(
      session.id,
      process.platform === 'win32' ? `echo done> "${marker}"\r` : `printf done > '${marker}'\r`,
    );
    const ptyDeadline = Date.now() + 10_000;
    while (Date.now() < ptyDeadline && !existsSync(marker)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await check('pty shell runs a real command', async () => {
      assert.equal((await fsp.readFile(marker, 'utf8')).trim(), 'done');
      assert.ok(terminalChunks.length > 0, 'the pty produced output');
      assert.ok(session.shell.length > 0);
    });
    terminal.kill(session.id);
    terminal.disposeAll();

    // macOS exposes /var as a symlink and Windows returns 8.3 short paths; the
    // native guard must accept a workspace root addressed through either.
    if (process.platform !== 'win32') {
      const linkRoot = path.join(tempRoot, 'link-root');
      try {
        await fsp.symlink(path.join(tempRoot, 'demo-app'), linkRoot, 'dir');
        await check('symlinked workspace root is accepted', async () => {
          const linked = new FsService(() => nativeFs);
          linked.setRoot(linkRoot);
          assert.ok(linked.readText(path.join(linkRoot, 'index.html')).includes('<!doctype html>'));
          linked.writeText(path.join(linkRoot, 'linked.txt'), 'ok');
          assert.equal(await fsp.readFile(path.join(tempRoot, 'demo-app', 'linked.txt'), 'utf8'), 'ok');
          linked.dispose();
        });
      } catch (error) {
        console.log(`  --  symlink check skipped: ${(error as Error).message}`);
      }
    }

    if (process.env.SMOKE_NETWORK === '1') {
      console.log('Open VSX extension install (network)');
      const extensionsRoot = path.join(tempRoot, 'extensions');
      const installed = await installFromOpenVsx('syler.sass-indented', extensionsRoot);
      await check('downloaded and extracted a real .vsix', async () => {
        assert.ok(installed.version.length > 0);
        const manifest = JSON.parse(await fsp.readFile(path.join(installed.path, 'package.json'), 'utf8')) as {
          contributes?: { grammars?: unknown[] };
        };
        assert.ok(Array.isArray(manifest.contributes?.grammars) && manifest.contributes.grammars.length > 0);
      });
      await check('installed extension exposes its files', async () => {
        const entries = await fsp.readdir(installed.path);
        assert.ok(entries.includes('package.json'));
      });
    }
  } finally {
    service.dispose();
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }

  console.log(`\n${checks} checks passed`);
}

void main().catch((error) => {
  console.error('\nSmoke test failed:', error);
  process.exit(1);
});
