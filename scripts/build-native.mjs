import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = path.join(root, 'native', 'Cargo.toml');

// rustup installs into ~/.cargo/bin, which is not always on PATH in GUI shells.
const cargoBin = path.join(os.homedir(), '.cargo', 'bin');
if (existsSync(cargoBin) && !(process.env.PATH ?? '').split(path.delimiter).includes(cargoBin)) {
  process.env.PATH = `${cargoBin}${path.delimiter}${process.env.PATH ?? ''}`;
}

const cargo = process.env.CARGO ?? 'cargo';

console.log('[build-native] compiling Rust filesystem core');
execFileSync(cargo, ['build', '--release', '--manifest-path', manifest], { stdio: 'inherit' });

const artifactNames = {
  win32: 'ter_fs.dll',
  darwin: 'libter_fs.dylib',
  linux: 'libter_fs.so',
};

const artifact = artifactNames[process.platform];
if (!artifact) throw new Error(`Unsupported platform for the native module: ${process.platform}`);

const source = path.join(root, 'native', 'target', 'release', artifact);
if (!existsSync(source)) throw new Error(`Rust build produced no ${artifact} at ${source}`);

const destination = path.join(root, 'native', `ter-fs.${process.platform}-${process.arch}.node`);
copyFileSync(source, destination);
console.log(`[build-native] wrote ${path.relative(root, destination)}`);
