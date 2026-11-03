import { app } from 'electron';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  ExtensionContribution,
  ExtensionInfo,
  ExtensionSearchResult,
  ExtensionTheme,
  ThemeRule,
} from '../../shared/ipc';
import { installFromOpenVsx } from './vsix';

const OPEN_VSX = 'https://open-vsx.org/api';

interface RawPackageJson {
  name?: string;
  displayName?: string;
  publisher?: string;
  version?: string;
  description?: string;
  main?: string;
  activationEvents?: string[];
  contributes?: {
    languages?: Array<{ id?: string; extensions?: string[]; aliases?: string[]; filenames?: string[] }>;
    grammars?: Array<{ language?: string; scopeName?: string; path?: string; embeddedLanguages?: Record<string, string> }>;
    themes?: Array<{ id?: string; label?: string; uiTheme?: string; path?: string }>;
    snippets?: Array<{ language?: string; path?: string }>;
    keybindings?: Array<{ command?: string; key?: string; when?: string; mac?: string; linux?: string; win?: string }>;
    commands?: Array<{ command?: string; title?: string; category?: string }>;
    configuration?: unknown;
  };
}

interface SchemaProperty {
  type?: string | string[];
  default?: unknown;
  description?: string;
  enum?: unknown[];
  items?: unknown;
}

interface OpenVsxSearchResponse {
  extensions?: Array<{
    name: string;
    namespace: string;
    displayName?: string;
    version?: string;
    description?: string;
    downloadCount?: number;
    verified?: boolean;
  }>;
}

export class ExtensionsService {
  private root: string;
  private disabledFile: string;
  private disabled: Set<string> = new Set();
  private loaded = false;

  constructor() {
    const userData = app.getPath('userData');
    this.root = path.join(userData, 'extensions');
    this.disabledFile = path.join(userData, 'extensions-disabled.json');
  }

  getExtensionsRoot(): string {
    return this.root;
  }

  private async loadState(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fsp.readFile(this.disabledFile, 'utf8');
      const parsed = JSON.parse(raw) as string[];
      this.disabled = new Set(Array.isArray(parsed) ? parsed : []);
    } catch {
      this.disabled = new Set();
    }
    this.loaded = true;
  }

  private async persistState(): Promise<void> {
    await fsp.mkdir(path.dirname(this.disabledFile), { recursive: true });
    await fsp.writeFile(this.disabledFile, JSON.stringify(Array.from(this.disabled), null, 2), 'utf8');
  }

  async list(): Promise<ExtensionInfo[]> {
    await this.loadState();
    await fsp.mkdir(this.root, { recursive: true });
    const directories = await fsp.readdir(this.root, { withFileTypes: true });
    const infos: ExtensionInfo[] = [];
    for (const directory of directories) {
      if (!directory.isDirectory()) continue;
      const extPath = path.join(this.root, directory.name);
      try {
        const manifest = JSON.parse(await fsp.readFile(path.join(extPath, 'package.json'), 'utf8')) as RawPackageJson;
        if (!manifest.name || !manifest.publisher) continue;
        const id = `${manifest.publisher}.${manifest.name}`.toLowerCase();
        infos.push({
          id,
          name: manifest.name,
          displayName: manifest.displayName ?? manifest.name,
          publisher: manifest.publisher,
          version: manifest.version ?? '0.0.0',
          description: manifest.description ?? '',
          enabled: !this.disabled.has(id),
          path: extPath,
          extends: normalizeContribution(manifest),
        });
      } catch {
        // A half-extracted directory; ignore it rather than breaking the list.
      }
    }
    return infos.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async get(id: string): Promise<ExtensionInfo | undefined> {
    const list = await this.list();
    return list.find((extension) => extension.id === id.toLowerCase());
  }

  async search(query: string): Promise<ExtensionSearchResult[]> {
    const url = `${OPEN_VSX}/-/search?query=${encodeURIComponent(query)}&size=40&sortBy=downloadCount&sortOrder=desc`;
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Open VSX search failed with ${response.status}`);
    const payload = (await response.json()) as OpenVsxSearchResponse;
    return (payload.extensions ?? []).map((extension) => ({
      id: `${extension.namespace}.${extension.name}`,
      name: extension.name,
      displayName: extension.displayName ?? extension.name,
      publisher: extension.namespace,
      version: extension.version ?? '',
      description: extension.description ?? '',
      downloads: extension.downloadCount ?? 0,
      verified: Boolean(extension.verified),
    }));
  }

  async install(id: string): Promise<ExtensionInfo> {
    await installFromOpenVsx(id, this.root);
    const installed = await this.get(id);
    if (!installed) throw new Error(`Extension ${id} did not install correctly`);
    return installed;
  }

  async uninstall(id: string): Promise<void> {
    await this.loadState();
    const normalized = id.toLowerCase();
    const target = path.join(this.root, normalized);
    await fsp.rm(target, { recursive: true, force: true });
    this.disabled.delete(normalized);
    await this.persistState();
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.loadState();
    const normalized = id.toLowerCase();
    if (enabled) this.disabled.delete(normalized);
    else this.disabled.add(normalized);
    await this.persistState();
  }

  async readAsset(id: string, relativePath: string): Promise<string> {
    const extension = await this.get(id);
    if (!extension) throw new Error(`Extension ${id} is not installed`);
    const resolved = path.resolve(extension.path, relativePath);
    const relative = path.relative(extension.path, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Extension asset path escapes the extension folder');
    }
    return fsp.readFile(resolved, 'utf8');
  }

  async configurationDefaults(id: string): Promise<Record<string, unknown>> {
    const extension = await this.get(id);
    if (!extension) return {};
    const manifest = JSON.parse(await fsp.readFile(path.join(extension.path, 'package.json'), 'utf8')) as RawPackageJson;
    return flattenConfiguration(manifest.contributes?.configuration);
  }

  async themes(): Promise<ExtensionTheme[]> {
    const extensions = await this.list();
    const themes: ExtensionTheme[] = [];
    for (const extension of extensions) {
      if (!extension.enabled) continue;
      for (const theme of extension.extends.themes) {
        try {
          const raw = await this.readAsset(extension.id, theme.path);
          const parsed = await this.resolveThemeJson(extension.id, JSON.parse(stripJsonComments(raw)), 0);
          themes.push({
            id: `${extension.id}.${theme.id}`,
            label: `${theme.label} (${extension.displayName})`,
            type: theme.uiTheme === 'vs' ? 'light' : theme.uiTheme === 'hc-black' ? 'hc' : 'dark',
            colors: (parsed.colors as Record<string, string>) ?? {},
            rules: normalizeTokenColors(parsed.tokenColors),
          });
        } catch {
          // Malformed theme files are skipped; the built-in themes stay available.
        }
      }
    }
    return themes;
  }

  private async resolveThemeJson(extensionId: string, theme: Record<string, unknown>, depth: number): Promise<Record<string, unknown>> {
    const include = typeof theme.include === 'string' ? theme.include : null;
    if (!include || depth > 3) return theme;
    try {
      const parentRaw = await this.readAsset(extensionId, include);
      const parent = await this.resolveThemeJson(extensionId, JSON.parse(stripJsonComments(parentRaw)), depth + 1);
      return {
        ...parent,
        ...theme,
        colors: { ...(parent.colors as Record<string, string>), ...((theme.colors as Record<string, string>) ?? {}) },
        tokenColors: [
          ...((parent.tokenColors as unknown[]) ?? []),
          ...((theme.tokenColors as unknown[]) ?? []),
        ],
      };
    } catch {
      return theme;
    }
  }
}

function normalizeContribution(manifest: RawPackageJson): ExtensionContribution {
  const contributes = manifest.contributes ?? {};
  return {
    languages: (contributes.languages ?? [])
      .filter((language) => Boolean(language.id))
      .map((language) => ({
        id: language.id!,
        extensions: language.extensions ?? [],
        aliases: language.aliases ?? [],
        filenames: language.filenames ?? [],
      })),
    grammars: (contributes.grammars ?? [])
      .filter((grammar) => Boolean(grammar.scopeName && grammar.path))
      .map((grammar) => ({ language: grammar.language, scopeName: grammar.scopeName!, path: grammar.path! })),
    themes: (contributes.themes ?? [])
      .filter((theme) => Boolean(theme.path))
      .map((theme) => ({
        id: theme.id ?? theme.label ?? 'theme',
        label: theme.label ?? theme.id ?? 'Theme',
        uiTheme: theme.uiTheme ?? 'vs-dark',
        path: theme.path!,
      })),
    snippets: (contributes.snippets ?? [])
      .filter((snippet) => Boolean(snippet.path))
      .map((snippet) => ({ language: snippet.language ?? 'plaintext', path: snippet.path! })),
    keybindings: (contributes.keybindings ?? [])
      .filter((binding) => Boolean(binding.command && binding.key))
      .map((binding) => ({
        command: binding.command!,
        key: binding.key!,
        when: binding.when,
        mac: binding.mac,
        linux: binding.linux,
        win: binding.win,
      })),
    commands: (contributes.commands ?? [])
      .filter((command) => Boolean(command.command && command.title))
      .map((command) => ({ command: command.command!, title: command.title!, category: command.category })),
    activationEvents: manifest.activationEvents ?? [],
  };
}

function flattenConfiguration(configuration: unknown): Record<string, unknown> {
  if (!configuration) return {};
  const defaults: Record<string, unknown> = {};
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    if (!entry || typeof entry !== 'object') return;
    const record = entry as { properties?: Record<string, SchemaProperty> };
    for (const [key, schema] of Object.entries(record.properties ?? {})) {
      if (schema && Object.prototype.hasOwnProperty.call(schema, 'default')) defaults[key] = schema.default;
      else if (schema && Array.isArray(schema.enum) && schema.enum.length > 0) defaults[key] = schema.enum[0];
      else if (schema?.type === 'boolean') defaults[key] = false;
      else if (schema?.type === 'number' || schema?.type === 'integer') defaults[key] = 0;
      else if (schema?.type === 'array') defaults[key] = [];
      else if (schema?.type === 'string') defaults[key] = '';
    }
  };
  visit(configuration);
  return defaults;
}

function stripJsonComments(input: string): string {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'\\])\/\/.*$/gm, '$1')
    .replace(/,(\s*[}\]])/g, '$1');
}

function normalizeTokenColors(tokenColors: unknown): ThemeRule[] {
  if (!Array.isArray(tokenColors)) return [];
  const rules: ThemeRule[] = [];
  for (const entry of tokenColors) {
    if (!entry || typeof entry !== 'object') continue;
    const { scope, settings } = entry as { scope?: string | string[]; settings?: { foreground?: string; background?: string; fontStyle?: string } };
    if (!settings) continue;
    const scopes = Array.isArray(scope) ? scope : typeof scope === 'string' ? scope.split(',') : [];
    const tokens = scopes.map((item) => item.trim().split(/\s+/).join(' ')).filter(Boolean);
    const targets = tokens.length > 0 ? tokens : [''];
    for (const token of targets) {
      rules.push({
        token,
        foreground: settings.foreground?.replace(/^#/, ''),
        background: settings.background?.replace(/^#/, ''),
        fontStyle: settings.fontStyle,
      });
    }
  }
  return rules;
}
