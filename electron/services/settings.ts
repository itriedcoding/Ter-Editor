import { app, safeStorage } from 'electron';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { RecentProject, Settings } from '../../shared/ipc';

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: 'https://integrations.vly.ai/v1',
  model: '',
  theme: 'ter-dark',
  extensionTheme: null,
  fontSize: 14,
  tabSize: 2,
  wordWrap: false,
  minimap: true,
  lineNumbers: true,
  fontFamily: "'JetBrains Mono', 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace",
  autoSave: false,
  aiTemperature: 0.2,
  recentProjects: [],
};

const MAX_RECENT = 12;

export class SettingsService {
  private filePath: string;
  private keyPath: string;
  private current: Settings = { ...DEFAULT_SETTINGS };
  private apiKey: string | null = null;
  private loaded = false;
  private listeners = new Set<(settings: Settings) => void>();

  constructor() {
    const dir = app.getPath('userData');
    this.filePath = path.join(dir, 'settings.json');
    this.keyPath = path.join(dir, 'gateway-key.bin');
  }

  async load(): Promise<Settings> {
    if (this.loaded) return this.current;
    try {
      const raw = await fsp.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<Settings>;
      this.current = { ...DEFAULT_SETTINGS, ...parsed, recentProjects: parsed.recentProjects ?? [] };
    } catch {
      this.current = { ...DEFAULT_SETTINGS };
    }
    this.loaded = true;
    return this.current;
  }

  get(): Settings {
    return this.current;
  }

  onChange(listener: (settings: Settings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    const { recentProjects: _ignored, ...rest } = patch;
    void _ignored;
    this.current = { ...this.current, ...rest };
    await this.persist();
    for (const listener of this.listeners) listener(this.current);
    return this.current;
  }

  async touchRecent(root: string): Promise<RecentProject[]> {
    const name = path.basename(root);
    const entry: RecentProject = { path: root, name, openedAt: Date.now() };
    const recent = [entry, ...this.current.recentProjects.filter((item) => item.path !== root)].slice(0, MAX_RECENT);
    this.current = { ...this.current, recentProjects: recent };
    await this.persist();
    for (const listener of this.listeners) listener(this.current);
    return recent;
  }

  async forgetRecent(root: string): Promise<RecentProject[]> {
    const recent = this.current.recentProjects.filter((item) => item.path !== root);
    this.current = { ...this.current, recentProjects: recent };
    await this.persist();
    return recent;
  }

  private async persist(): Promise<void> {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    await fsp.writeFile(this.filePath, JSON.stringify(this.current, null, 2), 'utf8');
  }

  hasKey(): boolean {
    return Boolean(this.apiKey);
  }

  getKey(): string | null {
    return this.apiKey;
  }

  async loadKey(): Promise<void> {
    try {
      const buffer = await fsp.readFile(this.keyPath);
      if (safeStorage.isEncryptionAvailable()) {
        this.apiKey = safeStorage.decryptString(buffer);
      } else {
        this.apiKey = buffer.toString('utf8');
      }
    } catch {
      this.apiKey = null;
    }
  }

  async setKey(key: string): Promise<{ encrypted: boolean }> {
    const trimmed = key.trim();
    if (!trimmed) throw new Error('API key cannot be empty');
    const encrypted = safeStorage.isEncryptionAvailable();
    const payload = encrypted ? safeStorage.encryptString(trimmed) : Buffer.from(trimmed, 'utf8');
    await fsp.mkdir(path.dirname(this.keyPath), { recursive: true });
    await fsp.writeFile(this.keyPath, payload, { mode: 0o600 });
    this.apiKey = trimmed;
    return { encrypted };
  }

  async clearKey(): Promise<void> {
    this.apiKey = null;
    try {
      await fsp.rm(this.keyPath, { force: true });
    } catch {
      /* nothing stored */
    }
  }
}
