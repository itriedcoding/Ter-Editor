/**
 * Shared types for the Electron main process, preload bridge and renderer.
 * Everything crossing the IPC boundary is described here exactly once.
 */

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

export interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: FileNode[];
}

export interface RecentProject {
  path: string;
  name: string;
  openedAt: number;
}

export interface ProjectSnapshot {
  root: string;
  name: string;
  tree: FileNode;
  recent: RecentProject[];
}

export type ProjectTemplate = 'empty' | 'node' | 'web' | 'python' | 'rust' | 'go' | 'cpp';

export interface CreateProjectInput {
  parent: string;
  name: string;
  template: ProjectTemplate;
}

export interface SearchHit {
  path: string;
  line: number;
  column: number;
  preview: string;
}

export interface Settings {
  baseUrl: string;
  model: string;
  theme: string;
  extensionTheme: string | null;
  fontSize: number;
  tabSize: number;
  wordWrap: boolean;
  minimap: boolean;
  lineNumbers: boolean;
  fontFamily: string;
  autoSave: boolean;
  aiTemperature: number;
  recentProjects: RecentProject[];
}

export interface AiModel {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  inputPrice?: number;
  outputPrice?: number;
  tags: string[];
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools: AiToolDefinition[];
  temperature?: number;
}

export interface AiToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type AiEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | {
      type: 'done';
      content: string;
      reasoning: string;
      toolCalls: ToolCall[];
      finishReason: string;
      usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    }
  | { type: 'error'; message: string };

export interface ExtensionContribution {
  languages: Array<{ id: string; extensions: string[]; aliases: string[]; filenames: string[] }>;
  grammars: Array<{ language?: string; scopeName: string; path: string }>;
  themes: Array<{ id: string; label: string; uiTheme: string; path: string }>;
  snippets: Array<{ language: string; path: string }>;
  keybindings: Array<{ command: string; key: string; when?: string; mac?: string; linux?: string; win?: string }>;
  commands: Array<{ command: string; title: string; category?: string }>;
  activationEvents: string[];
}

export interface ExtensionInfo {
  id: string;
  name: string;
  displayName: string;
  publisher: string;
  version: string;
  description: string;
  enabled: boolean;
  path: string;
  extends: ExtensionContribution;
}

export interface ExtensionSearchResult {
  id: string;
  name: string;
  displayName: string;
  publisher: string;
  version: string;
  description: string;
  downloads: number;
  verified: boolean;
}

export interface ExtCommand {
  id: string;
  title: string;
  extensionId: string;
  keybinding?: string;
}

export interface StatusItem {
  id: string;
  alignment: 'left' | 'right';
  priority: number;
  text: string;
  tooltip?: string;
  command?: string;
  color?: string;
}

export interface DiagnosticItem {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  message: string;
  severity: 'error' | 'warning' | 'info' | 'hint';
  source?: string;
  code?: string;
}

export interface ThemeRule {
  token: string;
  foreground?: string;
  background?: string;
  fontStyle?: string;
}

export interface ExtensionTheme {
  id: string;
  label: string;
  type: 'dark' | 'light' | 'hc';
  colors: Record<string, string>;
  rules: ThemeRule[];
}

export type ExtEvent =
  | { kind: 'status-set'; item: StatusItem }
  | { kind: 'status-dispose'; id: string }
  | { kind: 'message'; requestId: string; level: 'info' | 'warning' | 'error'; message: string; items: string[] }
  | {
      kind: 'quick-pick';
      requestId: string;
      items: Array<{ label: string; description?: string; detail?: string; picked?: boolean }>;
      placeholder?: string;
      canPickMany: boolean;
    }
  | {
      kind: 'input-box';
      requestId: string;
      prompt?: string;
      placeHolder?: string;
      value?: string;
      password: boolean;
      title?: string;
    }
  | { kind: 'diagnostics'; uri: string; items: DiagnosticItem[] }
  | { kind: 'output'; channel: string; text: string }
  | { kind: 'output-clear'; channel: string }
  | { kind: 'apply-edit'; requestId: string; edits: Array<{ uri: string; edits: Array<{ startLine: number; startColumn: number; endLine: number; endColumn: number; newText: string }> }> }
  | { kind: 'open-doc'; requestId: string; uri: string }
  | { kind: 'reveal'; uri: string; startLine: number; startColumn: number }
  | { kind: 'progress'; active: boolean; title: string }
  | { kind: 'reload-themes' }
  | { kind: 'log'; message: string };

export interface DocumentSyncState {
  uri: string;
  languageId: string;
  text: string;
  version: number;
}

export interface TerminalOptions {
  cwd?: string;
  cols?: number;
  rows?: number;
  shell?: string;
}

export interface TerminalSession {
  id: string;
  shell: string;
  cwd: string;
}

export interface TerApi {
  platform: string;
  version: string;
  dialog: {
    pickDirectory(): Promise<string | null>;
    pickFile(): Promise<string | null>;
  };
  project: {
    open(root: string): Promise<ProjectSnapshot>;
    create(input: CreateProjectInput): Promise<ProjectSnapshot>;
    close(): Promise<void>;
    recent(): Promise<RecentProject[]>;
    forget(path: string): Promise<RecentProject[]>;
    root(): Promise<string | null>;
  };
  fs: {
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
    list(path: string): Promise<FileEntry[]>;
    tree(path: string): Promise<FileNode>;
    create(path: string, kind: 'file' | 'folder', content?: string): Promise<void>;
    remove(path: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    find(query: string): Promise<FileEntry[]>;
    search(query: string): Promise<SearchHit[]>;
    reveal(path: string): Promise<void>;
    onChanged(cb: (paths: string[]) => void): () => void;
  };
  docs: {
    open(uri: string, languageId: string, text: string, version: number): void;
    change(uri: string, text: string, version: number): void;
    save(uri: string): void;
    close(uri: string): void;
    active(uri: string | null, selection?: { startLine: number; startColumn: number; endLine: number; endColumn: number }): void;
  };
  settings: {
    get(): Promise<Settings>;
    update(patch: Partial<Settings>): Promise<Settings>;
    onChanged(cb: (settings: Settings) => void): () => void;
  };
  ai: {
    hasKey(): Promise<boolean>;
    setKey(key: string): Promise<{ encrypted: boolean }>;
    clearKey(): Promise<void>;
    models(): Promise<{ models: AiModel[]; error?: string }>;
    start(requestId: string, request: ChatRequest): Promise<void>;
    cancel(requestId: string): void;
    onEvent(cb: (requestId: string, event: AiEvent) => void): () => void;
  };
  extensions: {
    list(): Promise<ExtensionInfo[]>;
    search(query: string): Promise<ExtensionSearchResult[]>;
    install(id: string): Promise<ExtensionInfo>;
    uninstall(id: string): Promise<void>;
    setEnabled(id: string, enabled: boolean): Promise<void>;
    commands(): Promise<ExtCommand[]>;
    executeCommand(id: string): Promise<void>;
    readAsset(id: string, relativePath: string): Promise<string>;
    themes(): Promise<ExtensionTheme[]>;
    reply(requestId: string, value: unknown): void;
    onEvent(cb: (event: ExtEvent) => void): () => void;
    onChanged(cb: () => void): () => void;
  };
  terminal: {
    create(options: TerminalOptions): Promise<TerminalSession>;
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    kill(id: string): void;
    onData(callback: (id: string, data: string) => void): () => void;
    onExit(callback: (id: string, code: number) => void): () => void;
  };
  app: {
    openExternal(url: string): void;
    showItemInFolder(path: string): void;
    windowControl(action: 'minimize' | 'maximize' | 'close'): void;
    nativeVersion(): Promise<string>;
  };
}
