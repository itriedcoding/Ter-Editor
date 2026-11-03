import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface NativeEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

export interface NativeHit {
  path: string;
  line: number;
  column: number;
  preview: string;
}

export interface NativeFs {
  nativeVersion(): string;
  readText(root: string, target: string): string;
  writeText(root: string, target: string, contents: string): void;
  createEntry(root: string, target: string, kind: 'file' | 'folder'): void;
  removeEntry(root: string, target: string): void;
  renameEntry(root: string, from: string, to: string): void;
  listDir(root: string, target: string): NativeEntry[];
  statPath(root: string, target: string): NativeEntry;
  indexFiles(root: string, maxFiles?: number): string[];
  findFiles(root: string, query: string, limit?: number): string[];
  searchText(root: string, query: string, maxHits?: number): NativeHit[];
}

/**
 * Loads the Rust N-API addon. `baseDir` is the application root: the repository
 * in development, or the packaged app directory in production.
 */
export function loadNativeFs(baseDir: string): NativeFs {
  const loader = path.join(baseDir, 'native', 'index.js');
  if (!existsSync(loader)) {
    throw new Error(
      `Native filesystem module not found at ${loader}. Run "npm run build:native" (requires a Rust toolchain).`,
    );
  }
  const localRequire = createRequire(loader);
  return localRequire(loader) as NativeFs;
}
