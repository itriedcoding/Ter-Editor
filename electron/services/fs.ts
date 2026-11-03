import { promises as fsp, watch, FSWatcher } from 'node:fs';
import path from 'node:path';
import type { CreateProjectInput, FileEntry, FileNode, ProjectSnapshot, SearchHit } from '../../shared/ipc';

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'dist-electron', 'release', 'out', 'build',
  '.next', '.nuxt', '.cache', '.parcel-cache', 'target', 'vendor', '.venv', 'venv', '__pycache__',
  '.idea', '.gradle', '.mypy_cache', '.pytest_cache', '.tox', '.DS_Store', 'coverage', '.turbo',
]);

const MAX_INDEX_FILES = 40_000;
const MAX_SEARCH_BYTES = 2_000_000;

function isProbablyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  return sample.includes(0);
}

export class FsService {
  private root: string | null = null;
  private watchers: FSWatcher[] = [];
  private onChanged: (paths: string[]) => void = () => {};

  setChangeListener(listener: (paths: string[]) => void): void {
    this.onChanged = listener;
  }

  getRoot(): string | null {
    return this.root;
  }

  setRoot(root: string | null): void {
    this.closeWatchers();
    this.root = root ? path.resolve(root) : null;
    if (this.root) this.watchRoot(this.root);
  }

  private closeWatchers(): void {
    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        /* already closed */
      }
    }
    this.watchers = [];
  }

  private watchRoot(root: string): void {
    const pending = new Set<string>();
    let timer: NodeJS.Timeout | null = null;
    try {
      const watcher = watch(root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const rel = filename.toString();
        if (rel.split(/[\\/]/).some((part) => IGNORED_DIRS.has(part))) return;
        pending.add(rel);
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          const paths = Array.from(pending);
          pending.clear();
          this.onChanged(paths);
        }, 150);
      });
      watcher.on('error', () => {
        try {
          watcher.close();
        } catch {
          /* ignore */
        }
      });
      this.watchers.push(watcher);
    } catch {
      // Recursive watching is unavailable on some platforms; the explorer refreshes
      // after editor-initiated file operations instead.
    }
  }

  resolveInRoot(target: string): string {
    if (!this.root) throw new Error('No folder is open');
    const absolute = path.resolve(target);
    const relative = path.relative(this.root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Path is outside the open folder: ${target}`);
    }
    return absolute;
  }

  resolveRoot(): string {
    if (!this.root) throw new Error('No folder is open');
    return this.root;
  }

  async list(dir: string): Promise<FileEntry[]> {
    const absolute = this.resolveInRoot(dir);
    const entries = await fsp.readdir(absolute, { withFileTypes: true });
    const results: FileEntry[] = [];
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const full = path.join(absolute, entry.name);
      let size = 0;
      let mtime = 0;
      try {
        const stat = await fsp.stat(full);
        size = stat.size;
        mtime = stat.mtimeMs;
      } catch {
        continue;
      }
      results.push({
        name: entry.name,
        path: full,
        isDir: entry.isDirectory(),
        size,
        mtime,
      });
    }
    results.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    return results;
  }

  async tree(dir: string, depth = 2, skipIgnored = true): Promise<FileNode> {
    const absolute = this.resolveInRoot(dir);
    const node: FileNode = { name: path.basename(absolute) || absolute, path: absolute, isDir: true, children: [] };
    if (depth <= 0) {
      delete node.children;
      return node;
    }
    const entries = await this.list(absolute);
    for (const entry of entries) {
      if (skipIgnored && entry.isDir && IGNORED_DIRS.has(entry.name)) continue;
      if (entry.isDir) {
        node.children!.push(await this.tree(entry.path, depth - 1, skipIgnored));
      } else {
        node.children!.push({ name: entry.name, path: entry.path, isDir: false });
      }
    }
    return node;
  }

  async readText(target: string): Promise<string> {
    const absolute = this.resolveInRoot(target);
    const buffer = await fsp.readFile(absolute);
    if (isProbablyBinary(buffer)) {
      throw new Error(`${path.basename(absolute)} is a binary file and cannot be opened as text`);
    }
    return buffer.toString('utf8');
  }

  async writeText(target: string, content: string): Promise<void> {
    const absolute = this.resolveInRoot(target);
    await fsp.mkdir(path.dirname(absolute), { recursive: true });
    await fsp.writeFile(absolute, content, 'utf8');
  }

  async create(target: string, kind: 'file' | 'folder', content = ''): Promise<void> {
    const absolute = this.resolveInRoot(target);
    if (kind === 'folder') {
      await fsp.mkdir(absolute, { recursive: true });
      return;
    }
    await fsp.mkdir(path.dirname(absolute), { recursive: true });
    const handle = await fsp.open(absolute, 'wx');
    await handle.writeFile(content, 'utf8');
    await handle.close();
  }

  async remove(target: string): Promise<void> {
    const absolute = this.resolveInRoot(target);
    if (absolute === this.root) throw new Error('Refusing to delete the open folder');
    await fsp.rm(absolute, { recursive: true, force: false });
  }

  async rename(from: string, to: string): Promise<void> {
    const source = this.resolveInRoot(from);
    const destination = this.resolveInRoot(to);
    await fsp.access(source);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.rename(source, destination);
  }

  private async indexFiles(): Promise<string[]> {
    const root = this.resolveRoot();
    const files: string[] = [];
    const queue: string[] = [root];
    while (queue.length > 0 && files.length < MAX_INDEX_FILES) {
      const current = queue.shift()!;
      let entries;
      try {
        entries = await fsp.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name)) continue;
          queue.push(full);
        } else if (entry.isFile()) {
          files.push(full);
          if (files.length >= MAX_INDEX_FILES) break;
        }
      }
    }
    return files;
  }

  async find(query: string): Promise<FileEntry[]> {
    const root = this.resolveRoot();
    const files = await this.indexFiles();
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return files.slice(0, 50).map((file) => ({
        name: path.basename(file),
        path: file,
        isDir: false,
        size: 0,
        mtime: 0,
      }));
    }
    const scored: Array<{ file: string; score: number }> = [];
    for (const file of files) {
      const relative = path.relative(root, file).toLowerCase();
      const base = path.basename(file).toLowerCase();
      let score = -1;
      if (base === needle) score = 1000;
      else if (base.startsWith(needle)) score = 800;
      else if (base.includes(needle)) score = 600;
      else if (fuzzyIncludes(relative, needle)) score = 400 - relative.length * 0.01;
      if (score >= 0) scored.push({ file, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 60).map(({ file }) => ({
      name: path.basename(file),
      path: file,
      isDir: false,
      size: 0,
      mtime: 0,
    }));
  }

  async search(query: string): Promise<SearchHit[]> {
    const needle = query.trim();
    if (needle.length < 2) throw new Error('Search needs at least two characters');
    const lowerNeedle = needle.toLowerCase();
    const files = await this.indexFiles();
    const hits: SearchHit[] = [];
    for (const file of files) {
      if (hits.length >= 200) break;
      let stat;
      try {
        stat = await fsp.stat(file);
      } catch {
        continue;
      }
      if (stat.size > MAX_SEARCH_BYTES) continue;
      let content: string;
      try {
        const buffer = await fsp.readFile(file);
        if (isProbablyBinary(buffer)) continue;
        content = buffer.toString('utf8');
      } catch {
        continue;
      }
      if (!content.toLowerCase().includes(lowerNeedle)) continue;
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const column = lines[i].toLowerCase().indexOf(lowerNeedle);
        if (column >= 0) {
          hits.push({
            path: file,
            line: i + 1,
            column: column + 1,
            preview: lines[i].trim().slice(0, 240),
          });
          if (hits.length >= 200) break;
        }
      }
    }
    return hits;
  }

  async createProject(input: CreateProjectInput): Promise<ProjectSnapshot> {
    const name = input.name.trim();
    if (!name) throw new Error('Project name is required');
    if (/[\\/:*?"<>|]/.test(name)) throw new Error('Project name contains characters that are not allowed in a folder name');
    const root = path.join(path.resolve(input.parent), name);
    await fsp.mkdir(root, { recursive: true });
    const existing = await fsp.readdir(root);
    if (existing.length > 0) throw new Error(`Folder ${root} already exists and is not empty`);
    for (const [relative, content] of Object.entries(templateFiles(input.template, name))) {
      const target = path.join(root, relative);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, content, 'utf8');
    }
    this.setRoot(root);
    const tree = await this.tree(root, 2);
    return { root, name: path.basename(root), tree, recent: [] };
  }

  dispose(): void {
    this.closeWatchers();
  }
}

function fuzzyIncludes(haystack: string, needle: string): boolean {
  let index = 0;
  for (const char of needle) {
    index = haystack.indexOf(char, index);
    if (index === -1) return false;
    index += 1;
  }
  return true;
}

function templateFiles(template: CreateProjectInput['template'], name: string): Record<string, string> {
  const gitignore = 'node_modules/\ndist/\n.env\n.DS_Store\n';
  switch (template) {
    case 'node':
      return {
        'package.json': `${JSON.stringify(
          {
            name: name.toLowerCase().replace(/[^a-z0-9-_]/g, '-'),
            version: '0.1.0',
            private: true,
            type: 'module',
            main: 'index.js',
            scripts: { start: 'node index.js' },
          },
          null,
          2,
        )}\n`,
        'index.js': `export function main() {\n  console.log('Hello from ${name}');\n}\n\nmain();\n`,
        'README.md': `# ${name}\n\nCreated with Ter Editor.\n\n\`\`\`bash\nnpm start\n\`\`\`\n`,
        '.gitignore': gitignore,
      };
    case 'web':
      return {
        'index.html': `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1" />\n    <title>${name}</title>\n    <link rel="stylesheet" href="styles.css" />\n  </head>\n  <body>\n    <main>\n      <h1>${name}</h1>\n      <p>Edit <code>index.html</code>, <code>styles.css</code> and <code>app.js</code> to get started.</p>\n      <button id="counter">Clicked 0 times</button>\n    </main>\n    <script src="app.js"></script>\n  </body>\n</html>\n`,
        'styles.css': `:root {\n  color-scheme: dark;\n  --bg: #0e1116;\n  --fg: #e6edf3;\n  --accent: #4c9aff;\n}\n\nbody {\n  margin: 0;\n  min-height: 100vh;\n  display: grid;\n  place-items: center;\n  background: var(--bg);\n  color: var(--fg);\n  font-family: ui-sans-serif, system-ui, sans-serif;\n}\n\nmain {\n  max-width: 34rem;\n  padding: 2rem;\n  text-align: center;\n}\n\nbutton {\n  margin-top: 1.5rem;\n  padding: 0.65rem 1.25rem;\n  border-radius: 0.6rem;\n  border: 1px solid var(--accent);\n  background: transparent;\n  color: var(--accent);\n  font: inherit;\n  cursor: pointer;\n}\n`,
        'app.js': `const button = document.getElementById('counter');\nlet clicks = 0;\n\nbutton?.addEventListener('click', () => {\n  clicks += 1;\n  button.textContent = \`Clicked \${clicks} times\`;\n});\n`,
        'README.md': `# ${name}\n\nA static site created with Ter Editor. Open \`index.html\` in a browser.\n`,
        '.gitignore': gitignore,
      };
    case 'python':
      return {
        'main.py': `def main() -> None:\n    print("Hello from ${name}")\n\n\nif __name__ == "__main__":\n    main()\n`,
        'requirements.txt': '# Add dependencies here\n',
        'README.md': `# ${name}\n\nCreated with Ter Editor.\n\n\`\`\`bash\npython main.py\n\`\`\`\n`,
        '.gitignore': `${gitignore}__pycache__/\n*.pyc\n.venv/\n`,
      };
    case 'rust':
      return {
        'Cargo.toml': `[package]\nname = "${name.toLowerCase().replace(/[^a-z0-9-_]/g, '_')}"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n`,
        'src/main.rs': `fn main() {\n    println!("Hello from ${name}");\n}\n`,
        'README.md': `# ${name}\n\nCreated with Ter Editor.\n\n\`\`\`bash\ncargo run\n\`\`\`\n`,
        '.gitignore': `${gitignore}target/\n`,
      };
    case 'go':
      return {
        'go.mod': `module ${name.toLowerCase().replace(/[^a-z0-9-_/]/g, '')}\n\ngo 1.22\n`,
        'main.go': `package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("Hello from ${name}")\n}\n`,
        'README.md': `# ${name}\n\nCreated with Ter Editor.\n\n\`\`\`bash\ngo run .\n\`\`\`\n`,
        '.gitignore': `${gitignore}bin/\n`,
      };
    case 'cpp':
      return {
        'main.cpp': `#include <iostream>\n\nint main() {\n    std::cout << "Hello from ${name}" << std::endl;\n    return 0;\n}\n`,
        'Makefile': `CXX ?= g++\nCXXFLAGS ?= -std=c++20 -Wall -Wextra\n\nmain: main.cpp\n\t$(CXX) $(CXXFLAGS) -o main main.cpp\n\n.PHONY: clean\nclean:\n\trm -f main\n`,
        'README.md': `# ${name}\n\nCreated with Ter Editor.\n\n\`\`\`bash\nmake && ./main\n\`\`\`\n`,
        '.gitignore': `${gitignore}main\n`,
      };
    default:
      return {
        'README.md': `# ${name}\n\nCreated with Ter Editor.\n`,
        '.gitignore': gitignore,
      };
  }
}
