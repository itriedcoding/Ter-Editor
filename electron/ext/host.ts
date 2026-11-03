import Module, { createRequire } from 'node:module';
import { existsSync, promises as fsp, readFileSync, watch, FSWatcher } from 'node:fs';
import { safeStorage } from 'electron';
import path from 'node:path';
import type {
  DiagnosticItem,
  ExtCommand,
  ExtEvent,
  ExtensionInfo,
  StatusItem,
} from '../../shared/ipc';
import { fileUri, uriToPath } from '../../shared/uri';
import type { FsService } from '../services/fs';
import type { SettingsService } from '../services/settings';
import type { ExtensionsService } from '../services/extensions';
import { languageForPath } from '../../shared/languages';
import { createVscodeApi } from './vscode';

export interface DocState {
  uri: string;
  fsPath: string;
  languageId: string;
  version: number;
  text: string;
  dirty: boolean;
}

export interface SelectionState {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export type HostRequestKind = 'message' | 'quickPick' | 'inputBox' | 'applyEdit' | 'openDoc';

export interface HostDelegate {
  send(event: ExtEvent): void;
  request<T = unknown>(kind: HostRequestKind, payload: Record<string, unknown>): Promise<T>;
  openDialog(options: { title?: string; canSelectFolders: boolean; canSelectFiles: boolean; canSelectMany: boolean }): Promise<string[] | undefined>;
  saveDialog(options: { title?: string; defaultPath?: string }): Promise<string | undefined>;
  clipboardRead(): Promise<string>;
  clipboardWrite(text: string): void;
}

export interface Memento {
  get<T>(key: string, defaultValue?: T): T | undefined;
  update(key: string, value: unknown): Promise<void>;
  keys(): readonly string[];
  setKeysForSync(): void;
}

interface LoadedExtension {
  info: ExtensionInfo;
  api: unknown;
  moduleExports: { activate?: (context: unknown) => unknown; deactivate?: () => unknown } | null;
  context: { subscriptions: Array<{ dispose(): unknown }> } | null;
  activated: boolean;
  activationError: string | null;
  outputChannels: Map<string, { append(text: string): void; appendLine(text: string): void }>;
}

interface CommandEntry {
  extensionId: string;
  handler: (...args: unknown[]) => unknown;
}

export class ExtensionHost {
  private fs: FsService;
  private settings: SettingsService;
  private extensions: ExtensionsService;
  private delegate: HostDelegate;
  private loaded: LoadedExtension[] = [];
  private commands = new Map<string, CommandEntry>();
  private declaredCommands: ExtCommand[] = [];
  private diagnostics = new Map<string, Map<string, DiagnosticItem[]>>();
  private statusItems = new Map<string, StatusItem>();
  private docs = new Map<string, DocState>();
  private activeUri: string | null = null;
  private selection: SelectionState | null = null;
  private configDefaults: Record<string, unknown> = {};
  private configOverrides: Record<string, unknown> = {};
  private configPath: string;
  private stateDir: string;
  private watchers: FSWatcher[] = [];
  private disposables = new Set<{ dispose(): unknown }>();

  constructor(options: {
    fs: FsService;
    settings: SettingsService;
    extensions: ExtensionsService;
    delegate: HostDelegate;
    userDataPath: string;
  }) {
    this.fs = options.fs;
    this.settings = options.settings;
    this.extensions = options.extensions;
    this.delegate = options.delegate;
    this.configPath = path.join(options.userDataPath, 'extension-config.json');
    this.stateDir = path.join(options.userDataPath, 'extension-state');
  }

  async start(): Promise<void> {
    await this.loadConfig();
    await this.reload();
  }

  async reload(): Promise<void> {
    this.deactivateAll();
    this.loaded = [];
    this.commands.clear();
    this.declaredCommands = [];
    this.diagnostics.clear();
    this.statusItems.clear();
    this.announceStatus('left', 'ext-host', 'Extensions loaded');

    const installed = await this.extensions.list();
    const enabled = installed.filter((extension) => extension.enabled);
    for (const info of enabled) {
      this.configDefaults = { ...(await this.extensions.configurationDefaults(info.id)), ...this.configDefaults };
      const entry: LoadedExtension = {
        info,
        api: null,
        moduleExports: null,
        context: null,
        activated: false,
        activationError: null,
        outputChannels: new Map(),
      };
      entry.api = createVscodeApi(this, info);
      this.loaded.push(entry);
      for (const command of info.extends.commands) {
        const keybinding = info.extends.keybindings.find((binding) => binding.command === command.command);
        this.declaredCommands.push({
          id: command.command,
          title: command.category ? `${command.category}: ${command.title}` : command.title,
          extensionId: info.id,
          keybinding: keybinding?.key,
        });
      }
    }

    for (const extension of this.loaded) {
      const events = extension.info.extends.activationEvents;
      if (events.includes('*') || events.includes('onStartupFinished')) {
        await this.activate(extension, 'startup');
      }
    }

    this.delegate.send({ kind: 'reload-themes' });
    this.delegate.send({ kind: 'log', message: `Loaded ${this.loaded.length} extension(s)` });
  }

  getCommands(): ExtCommand[] {
    const registered = Array.from(this.commands.keys()).map((id) => {
      const entry = this.commands.get(id)!;
      const declared = this.declaredCommands.find((command) => command.id === id);
      return declared ?? { id, title: id, extensionId: entry.extensionId };
    });
    const merged = new Map<string, ExtCommand>();
    for (const command of [...this.declaredCommands, ...registered]) merged.set(command.id, command);
    return Array.from(merged.values()).sort((a, b) => a.title.localeCompare(b.title));
  }

  getLoadedExtensionIds(): string[] {
    return this.loaded.filter((extension) => extension.activated && !extension.activationError).map((extension) => extension.info.id);
  }

  private async activate(extension: LoadedExtension, reason: string): Promise<void> {
    if (extension.activated) return;
    extension.activated = true;
    const label = extension.info.displayName;
    try {
      const manifestPath = path.join(extension.info.path, 'package.json');
      const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8')) as { main?: string };
      const entryRelative = manifest.main ?? './extension.js';
      const entry = path.resolve(extension.info.path, entryRelative);
      const code = await fsp.readFile(entry, 'utf8');

      const context = this.createContext(extension);
      const loadedModule = new Module(entry, module);
      loadedModule.filename = entry;
      loadedModule.paths = (Module as unknown as { _nodeModulePaths(from: string): string[] })._nodeModulePaths(
        path.dirname(entry),
      );
      const baseRequire = createRequire(entry);
      const patchedRequire = ((id: string) => {
        if (id === 'vscode') return extension.api;
        return baseRequire(id);
      }) as NodeRequire;
      patchedRequire.resolve = baseRequire.resolve;
      patchedRequire.cache = baseRequire.cache;
      (loadedModule as unknown as { require: NodeRequire }).require = patchedRequire;
      (loadedModule as unknown as { _compile(code: string, filename: string): void })._compile(code, entry);
      extension.moduleExports = loadedModule.exports as LoadedExtension['moduleExports'];
      extension.context = context;
      if (typeof extension.moduleExports?.activate === 'function') {
        await extension.moduleExports.activate(context);
      }
      this.log(`Activated ${label} (${reason})`);
    } catch (error) {
      extension.activationError = (error as Error).message;
      this.log(`Failed to activate ${label}: ${(error as Error).message}`);
    }
  }

  private createContext(extension: LoadedExtension): { subscriptions: Array<{ dispose(): unknown }> } {
    const workspaceKey = this.fs.getRoot() ? Buffer.from(this.fs.getRoot()!).toString('base64url').slice(0, 24) : 'no-workspace';
    const stateFile = (scope: 'global' | 'workspace') =>
      path.join(this.stateDir, scope === 'global' ? 'global.json' : `${workspaceKey}.json`);

    const buildMemento = (filePath: string, namespace: string): Memento => {
      // Hydrated synchronously so memento.get() behaves like the real API.
      let data: Record<string, Record<string, unknown>> = {};
      try {
        data = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, Record<string, unknown>>;
      } catch {
        data = {};
      }
      data[namespace] ??= {};
      let writeTimer: NodeJS.Timeout | null = null;
      const persist = () => {
        if (writeTimer) clearTimeout(writeTimer);
        writeTimer = setTimeout(() => {
          const snapshot = JSON.stringify(data, null, 2);
          fsp.mkdir(path.dirname(filePath), { recursive: true })
            .then(() => fsp.writeFile(filePath, snapshot, 'utf8'))
            .catch(() => undefined);
        }, 120);
      };
      return {
        get<T>(key: string, defaultValue?: T): T | undefined {
          return (data[namespace][key] as T) ?? defaultValue;
        },
        update(key: string, value: unknown): Promise<void> {
          data[namespace][key] = value;
          persist();
          return Promise.resolve();
        },
        keys(): readonly string[] {
          return Object.keys(data[namespace]);
        },
        setKeysForSync(): void {
          /* settings sync is not available in this editor */
        },
      };
    };

    const secretsPath = path.join(this.stateDir, 'secrets', `${extension.info.id}.json`);
    const readSecrets = (): Record<string, string> => {
      try {
        const raw = readFileSync(secretsPath);
        const decoded = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8');
        return JSON.parse(decoded) as Record<string, string>;
      } catch {
        return {};
      }
    };
    const writeSecrets = async (values: Record<string, string>): Promise<void> => {
      const plain = JSON.stringify(values);
      const payload = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(plain) : Buffer.from(plain, 'utf8');
      await fsp.mkdir(path.dirname(secretsPath), { recursive: true });
      await fsp.writeFile(secretsPath, payload, { mode: 0o600 });
    };

    const context = {
      subscriptions: [] as Array<{ dispose(): unknown }>,
      extensionPath: extension.info.path,
      extensionUri: asUri(fileUri(extension.info.path)),
      globalState: buildMemento(stateFile('global'), extension.info.id),
      workspaceState: buildMemento(stateFile('workspace'), extension.info.id),
      storageUri: asUri(fileUri(path.join(this.stateDir, 'storage', extension.info.id))),
      globalStorageUri: asUri(fileUri(path.join(this.stateDir, 'global-storage', extension.info.id))),
      logUri: asUri(fileUri(path.join(this.stateDir, 'logs'))),
      extensionMode: 1,
      environmentVariableCollection: { replace: () => undefined, append: () => undefined, prepend: () => undefined, clear: () => undefined, persistent: false, get: () => undefined, delete: () => undefined, forEach: () => undefined, [Symbol.iterator]: () => [][Symbol.iterator]() },
      secrets: {
        get: async (key: string) => readSecrets()[key],
        store: async (key: string, value: string) => {
          const values = readSecrets();
          values[key] = value;
          await writeSecrets(values);
        },
        delete: async (key: string) => {
          const values = readSecrets();
          delete values[key];
          await writeSecrets(values);
        },
        onDidChange: () => ({ dispose: () => undefined }),
      },
      asAbsolutePath: (relativePath: string) => path.join(extension.info.path, relativePath),
    };
    void fsp.mkdir(path.join(this.stateDir, 'storage', extension.info.id), { recursive: true }).catch(() => undefined);
    return context;
  }

  async executeCommand(id: string, args: unknown[] = []): Promise<unknown> {
    let entry = this.commands.get(id);
    if (!entry) {
      const declared = this.declaredCommands.find((command) => command.id === id);
      const extension = this.loaded.find((candidate) => candidate.info.id === declared?.extensionId);
      if (extension) {
        await this.activate(extension, `command ${id}`);
        entry = this.commands.get(id);
      }
    }
    if (!entry) throw new Error(`Command "${id}" is not registered. Is its extension enabled?`);
    return entry.handler(...args);
  }

  registerCommand(extensionId: string, id: string, handler: (...args: unknown[]) => unknown): { dispose(): void } {
    this.commands.set(id, { extensionId, handler });
    this.declaredCommands = this.declaredCommands.filter((command) => command.id !== id || command.extensionId !== extensionId);
    this.declaredCommands.push({
      id,
      title: this.declaredCommands.find((command) => command.id === id)?.title ?? id,
      extensionId,
    });
    return { dispose: () => this.commands.delete(id) };
  }

  // ---- documents -------------------------------------------------------

  getDocument(uri: string): DocState | undefined {
    return this.docs.get(uri);
  }

  getDocuments(): DocState[] {
    return Array.from(this.docs.values());
  }

  getActiveUri(): string | null {
    return this.activeUri;
  }

  getSelection(): SelectionState | null {
    return this.selection;
  }

  workspaceRoot(): string | null {
    return this.fs.getRoot();
  }

  notifyDocumentOpen(uri: string, languageId: string, text: string, version: number): void {
    const fsPath = safeUriToPath(uri);
    this.docs.set(uri, { uri, fsPath, languageId, version, text, dirty: false });
    this.emit('onDidOpenTextDocument', uri);
  }

  notifyDocumentChange(uri: string, text: string, version: number): void {
    const doc = this.docs.get(uri);
    if (!doc) return;
    doc.text = text;
    doc.version = version;
    doc.dirty = true;
    this.emit('onDidChangeTextDocument', uri);
  }

  notifyDocumentSave(uri: string): void {
    const doc = this.docs.get(uri);
    if (doc) doc.dirty = false;
    this.emit('onDidSaveTextDocument', uri);
  }

  notifyDocumentClose(uri: string): void {
    this.docs.delete(uri);
    if (this.activeUri === uri) this.activeUri = null;
    this.emit('onDidCloseTextDocument', uri);
  }

  setActiveDocument(uri: string | null, selection?: SelectionState): void {
    this.activeUri = uri;
    if (selection) this.selection = selection;
    this.emit('onDidChangeActiveTextEditor', uri ?? '');
    this.emit('onDidChangeTextEditorSelection', uri ?? '');
  }

  async openDocument(uri: string, preview = false): Promise<DocState> {
    const existing = this.docs.get(uri);
    if (existing) return existing;
    const fsPath = safeUriToPath(uri);
    const text = await this.fs.readText(fsPath);
    const languageId = languageForPath(fsPath);
    const doc: DocState = { uri, fsPath, languageId, version: 1, text, dirty: false };
    this.docs.set(uri, doc);
    this.emit('onDidOpenTextDocument', uri);
    await this.delegate.request('openDoc', { uri, preview });
    return doc;
  }

  async applyWorkspaceEdit(payload: Array<{ uri: string; edits: Array<{ startLine: number; startColumn: number; endLine: number; endColumn: number; newText: string }> }>): Promise<boolean> {
    return this.delegate.request<boolean>('applyEdit', { edits: payload });
  }

  // ---- diagnostics -----------------------------------------------------

  updateDiagnostics(collectionId: string, uri: string, items: DiagnosticItem[]): void {
    let collection = this.diagnostics.get(collectionId);
    if (!collection) {
      collection = new Map();
      this.diagnostics.set(collectionId, collection);
    }
    if (items.length === 0) collection.delete(uri);
    else collection.set(uri, items);
    this.publishDiagnostics(uri);
  }

  clearDiagnostics(collectionId: string): void {
    const collection = this.diagnostics.get(collectionId);
    if (!collection) return;
    const uris = Array.from(collection.keys());
    this.diagnostics.delete(collectionId);
    for (const uri of uris) this.publishDiagnostics(uri);
  }

  private publishDiagnostics(uri: string): void {
    const merged: DiagnosticItem[] = [];
    for (const collection of this.diagnostics.values()) merged.push(...(collection.get(uri) ?? []));
    this.delegate.send({ kind: 'diagnostics', uri, items: merged });
  }

  // ---- status bar ------------------------------------------------------

  setStatusItem(item: StatusItem): void {
    this.statusItems.set(item.id, item);
    this.delegate.send({ kind: 'status-set', item });
  }

  disposeStatusItem(id: string): void {
    this.statusItems.delete(id);
    this.delegate.send({ kind: 'status-dispose', id });
  }

  private announceStatus(alignment: 'left' | 'right', id: string, text: string): void {
    this.setStatusItem({ id, alignment, priority: -1000, text });
  }

  // ---- output ----------------------------------------------------------

  output(channel: string, text: string): void {
    this.delegate.send({ kind: 'output', channel, text });
  }

  clearOutput(channel: string): void {
    this.delegate.send({ kind: 'output-clear', channel });
  }

  showOutput(channel: string): void {
    this.delegate.send({ kind: 'output', channel, text: '' });
    this.delegate.send({ kind: 'progress', active: false, title: '' });
  }

  log(message: string): void {
    this.output('Extension Host', `${message}\n`);
  }

  // ---- configuration ---------------------------------------------------

  private async loadConfig(): Promise<void> {
    try {
      this.configOverrides = JSON.parse(await fsp.readFile(this.configPath, 'utf8')) as Record<string, unknown>;
    } catch {
      this.configOverrides = {};
    }
  }

  getConfigurationValue<T>(key: string, fallback?: T): T | undefined {
    if (key in this.configOverrides) return this.configOverrides[key] as T;
    if (key in this.configDefaults) return this.configDefaults[key] as T;
    return fallback;
  }

  getConfigurationDefaults(): Record<string, unknown> {
    return this.configDefaults;
  }

  async updateConfiguration(key: string, value: unknown): Promise<void> {
    this.configOverrides[key] = value;
    await fsp.mkdir(path.dirname(this.configPath), { recursive: true });
    await fsp.writeFile(this.configPath, JSON.stringify(this.configOverrides, null, 2), 'utf8');
    this.emit('onDidChangeConfiguration', key);
  }

  // ---- files -----------------------------------------------------------

  async findFiles(include: string, exclude: string | undefined, maxResults: number): Promise<string[]> {
    const root = this.fs.getRoot();
    if (!root) return [];
    const includeMatcher = globToRegExp(include);
    const excludeMatcher = exclude ? globToRegExp(exclude) : null;
    const results: string[] = [];
    const queue: string[] = [root];
    while (queue.length > 0 && results.length < maxResults) {
      const current = queue.shift()!;
      let entries;
      try {
        entries = await this.fs.list(current);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const relative = path.relative(root, entry.path).replace(/\\/g, '/');
        if (entry.isDir) {
          if (excludeMatcher?.test(relative) || entry.name === 'node_modules' || entry.name === '.git') continue;
          queue.push(entry.path);
        } else if (includeMatcher.test(relative) && !excludeMatcher?.test(relative)) {
          results.push(entry.path);
          if (results.length >= maxResults) break;
        }
      }
    }
    return results;
  }

  createWatcher(pattern: string, handlers: { create(uri: string): void; change(uri: string): void; delete(uri: string): void }): { dispose(): void } {
    const root = this.fs.getRoot();
    if (!root) return { dispose: () => undefined };
    const base = pattern.includes('*') ? path.join(root, pattern.split('*')[0]) : root;
    const matcher = globToRegExp(pattern);
    let watcher: FSWatcher | null = null;
    try {
      watcher = watch(root, { recursive: true }, (event, filename) => {
        if (!filename) return;
        const absolute = path.join(root, filename.toString());
        const relative = path.relative(base, absolute).replace(/\\/g, '/');
        if (!matcher.test(relative) && !matcher.test(filename.toString().replace(/\\/g, '/'))) return;
        const uri = fileUri(absolute);
        if (event === 'rename') {
          if (existsSync(absolute)) handlers.create(uri);
          else handlers.delete(uri);
        } else {
          handlers.change(uri);
        }
      });
      this.watchers.push(watcher);
    } catch {
      /* recursive watching unavailable */
    }
    return {
      dispose: () => {
        try {
          watcher?.close();
        } catch {
          /* already closed */
        }
        this.watchers = this.watchers.filter((candidate) => candidate !== watcher);
      },
    };
  }

  getExtensionExports(id: string): unknown {
    const extension = this.loaded.find((candidate) => candidate.info.id === id);
    return extension?.moduleExports ?? undefined;
  }

  getExtensionInfo(id: string): ExtensionInfo | undefined {
    return this.loaded.find((candidate) => candidate.info.id === id)?.info;
  }

  listExtensionInfos(): ExtensionInfo[] {
    return this.loaded.map((extension) => extension.info);
  }

  trackDisposable(disposable: { dispose(): unknown }): void {
    this.disposables.add(disposable);
  }

  private emit(event: string, uri: string): void {
    for (const extension of this.loaded) {
      const api = extension.api as { __emit?: (name: string, uri: string) => void } | null;
      api?.__emit?.(event, uri);
    }
  }

  deactivateAll(): void {
    for (const extension of this.loaded) {
      try {
        extension.moduleExports?.deactivate?.();
      } catch (error) {
        this.log(`Error deactivating ${extension.info.displayName}: ${(error as Error).message}`);
      }
      for (const subscription of extension.context?.subscriptions ?? []) {
        try {
          subscription.dispose();
        } catch {
          /* ignore */
        }
      }
      extension.activated = false;
      extension.moduleExports = null;
      extension.context = null;
    }
    for (const disposable of this.disposables) {
      try {
        disposable.dispose();
      } catch {
        /* ignore */
      }
    }
    this.disposables.clear();
    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        /* ignore */
      }
    }
    this.watchers = [];
    this.commands.clear();
    for (const item of this.statusItems.values()) this.delegate.send({ kind: 'status-dispose', id: item.id });
    this.statusItems.clear();
  }

  dispose(): void {
    this.deactivateAll();
  }

  getDelegate(): HostDelegate {
    return this.delegate;
  }

  getSettings(): SettingsService {
    return this.settings;
  }
}

function safeUriToPath(uri: string): string {
  try {
    return uriToPath(uri);
  } catch {
    return uri;
  }
}

function asUri(value: string): { scheme: string; path: string; fsPath: string; toString(): string } {
  const fsPath = safeUriToPath(value);
  return {
    scheme: 'file',
    path: fsPath.replace(/\\/g, '/'),
    fsPath,
    toString: () => value,
  };
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/\\/g, '/').replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\{([^}]+)\}/g, (_match, group: string) => `(?:${group.split(',').join('|')})`);
  return new RegExp(`^${pattern}$`);
}
