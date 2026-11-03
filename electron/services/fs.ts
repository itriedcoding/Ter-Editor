import { watch, FSWatcher } from 'node:fs';
import path from 'node:path';
import type { CreateProjectInput, FileEntry, FileNode, ProjectSnapshot, SearchHit } from '../../shared/ipc';
import type { NativeFs } from '../native/fs';

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'dist-electron', 'release', 'out', 'build',
  '.next', '.nuxt', '.cache', '.parcel-cache', 'target', 'vendor', '.venv', 'venv', '__pycache__',
  '.idea', '.gradle', '.mypy_cache', '.pytest_cache', '.tox', 'coverage', '.turbo', 'native',
]);

/**
 * Workspace filesystem. Every operation on an open project is executed by the
 * Rust core (see native/src/lib.rs), which validates paths against the workspace
 * root before touching disk. Node is only used to bootstrap projects (before a
 * root exists) and to watch for external changes.
 */
export class FsService {
  private root: string | null = null;
  private nativeModule: NativeFs | null = null;
  private watchers: FSWatcher[] = [];
  private onChanged: (paths: string[]) => void = () => {};

  constructor(private readonly resolveNative: () => NativeFs) {}

  private native(): NativeFs {
    if (!this.nativeModule) {
      try {
        this.nativeModule = this.resolveNative();
      } catch (error) {
        throw new Error(`The native filesystem core is unavailable: ${(error as Error).message}`);
      }
    }
    return this.nativeModule;
  }

  nativeVersion(): string {
    return this.native().nativeVersion();
  }

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
        const relative = filename.toString();
        if (relative.split(/[\\/]/).some((part) => IGNORED_DIRS.has(part))) return;
        pending.add(relative);
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
      // Recursive watching is not available on every platform/filesystem; the
      // explorer still refreshes after editor-initiated file operations.
    }
  }

  resolveRoot(): string {
    if (!this.root) throw new Error('No folder is open');
    return this.root;
  }

  resolveInRoot(target: string): string {
    const root = this.resolveRoot();
    const absolute = path.resolve(target);
    const relative = path.relative(root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Path is outside the open folder: ${target}`);
    }
    return absolute;
  }

  list(dir: string): FileEntry[] {
    return this.native().listDir(this.resolveRoot(), dir) as FileEntry[];
  }

  tree(dir: string, depth = 2, skipIgnored = true): FileNode {
    const absolute = this.resolveInRoot(dir);
    const node: FileNode = {
      name: path.basename(absolute) || absolute,
      path: absolute,
      isDir: true,
      children: [],
    };
    if (depth <= 0) {
      delete node.children;
      return node;
    }
    for (const entry of this.list(absolute)) {
      if (skipIgnored && entry.isDir && IGNORED_DIRS.has(entry.name)) continue;
      node.children!.push(
        entry.isDir
          ? this.tree(entry.path, depth - 1, skipIgnored)
          : { name: entry.name, path: entry.path, isDir: false },
      );
    }
    return node;
  }

  readText(target: string): string {
    return this.native().readText(this.resolveRoot(), target);
  }

  writeText(target: string, content: string): void {
    this.native().writeText(this.resolveRoot(), target, content);
  }

  create(target: string, kind: 'file' | 'folder', content = ''): void {
    this.native().createEntry(this.resolveRoot(), target, kind);
    if (kind === 'file' && content.length > 0) {
      this.native().writeText(this.resolveRoot(), target, content);
    }
  }

  remove(target: string): void {
    this.native().removeEntry(this.resolveRoot(), target);
  }

  rename(from: string, to: string): void {
    this.native().renameEntry(this.resolveRoot(), from, to);
  }

  find(query: string): FileEntry[] {
    return this.native()
      .findFiles(this.resolveRoot(), query, 60)
      .map((filePath) => ({
        name: path.basename(filePath),
        path: filePath,
        isDir: false,
        size: 0,
        mtime: 0,
      }));
  }

  search(query: string): SearchHit[] {
    return this.native().searchText(this.resolveRoot(), query, 200) as SearchHit[];
  }

  createProject(input: CreateProjectInput): ProjectSnapshot {
    const name = input.name.trim();
    if (!name) throw new Error('Project name is required');
    if (/[\\/:*?"<>|]/.test(name)) {
      throw new Error('Project name contains characters that are not allowed in a folder name');
    }
    const parent = path.resolve(input.parent);
    const root = path.join(parent, name);
    const native = this.native();

    try {
      const existing = native.listDir(parent, root);
      if (existing.length > 0) throw new Error(`Folder ${root} already exists and is not empty`);
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes('already exists and is not empty')) throw error;
      // The folder does not exist yet, which is the expected path.
    }

    native.createEntry(parent, root, 'folder');
    for (const [relative, content] of Object.entries(templateFiles(input.template, name))) {
      native.writeText(parent, path.join(root, relative), content);
    }

    this.setRoot(root);
    return {
      root,
      name: path.basename(root),
      tree: this.tree(root, 2),
      recent: [],
    };
  }

  dispose(): void {
    this.closeWatchers();
  }
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
