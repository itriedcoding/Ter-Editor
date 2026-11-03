import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  shell,
} from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ChatRequest, ExtEvent, Settings, TerminalOptions } from '../shared/ipc';
import type { HostRequestKind, HostDelegate } from './ext/host';
import { ExtensionHost } from './ext/host';
import { FsService } from './services/fs';
import { SettingsService } from './services/settings';
import { AiService } from './services/ai';
import { ExtensionsService } from './services/extensions';
import { TerminalService } from './services/terminal';
import { loadNativeFs } from './native/fs';

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const isMac = process.platform === 'darwin';
const rendererRoot = path.join(__dirname, '..', 'dist');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

const fsService = new FsService(() => loadNativeFs(app.getAppPath()));
const settings = new SettingsService();
const ai = new AiService(settings);
const extensions = new ExtensionsService();
let extensionHost: ExtensionHost | null = null;
let mainWindow: BrowserWindow | null = null;

const pendingExtensionRequests = new Map<string, { resolve: (value: unknown) => void; timer: NodeJS.Timeout }>();

function sendToRenderer(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

const terminalService = new TerminalService(sendToRenderer, () => fsService.getRoot());

// node-pty's macOS spawn helper can arrive without its executable bit; restore it
// for both the development tree and the asar-unpacked copy in a packaged build.
terminalService.ensureHelper([
  path.join(app.getAppPath(), 'node_modules', 'node-pty'),
  path.join(process.resourcesPath ?? '', 'app.asar.unpacked', 'node_modules', 'node-pty'),
]);

/** Prefers a generally capable model when the user has not picked one yet. */
function pickDefaultModel(models: Array<{ id: string }>): string | null {
  const preferences = [/claude/i, /gpt-5/i, /gpt/i, /gemini/i, /deepseek/i, /llama/i, /qwen/i];
  for (const preference of preferences) {
    const match = models.find((model) => preference.test(model.id));
    if (match) return match.id;
  }
  return models[0]?.id ?? null;
}

const hostDelegate: HostDelegate = {
  send(event: ExtEvent) {
    sendToRenderer('ext:event', event);
  },
  request<T>(kind: HostRequestKind, payload: Record<string, unknown>): Promise<T> {
    const requestId = randomUUID();
    return new Promise<T>((resolve) => {
      const timer = setTimeout(() => {
        pendingExtensionRequests.delete(requestId);
        resolve(undefined as T);
      }, 120_000);
      pendingExtensionRequests.set(requestId, { resolve: resolve as (value: unknown) => void, timer });
      let event: ExtEvent;
      switch (kind) {
        case 'message':
          event = {
            kind: 'message',
            requestId,
            level: (payload.level as 'info' | 'warning' | 'error') ?? 'info',
            message: String(payload.message ?? ''),
            items: (payload.items as string[]) ?? [],
          };
          break;
        case 'quickPick':
          event = {
            kind: 'quick-pick',
            requestId,
            items: (payload.items as ExtEvent extends never ? never : never[]) ?? [],
            placeholder: payload.placeholder as string | undefined,
            canPickMany: Boolean(payload.canPickMany),
          } as ExtEvent;
          break;
        case 'inputBox':
          event = {
            kind: 'input-box',
            requestId,
            prompt: payload.prompt as string | undefined,
            placeHolder: payload.placeHolder as string | undefined,
            value: payload.value as string | undefined,
            password: Boolean(payload.password),
            title: payload.title as string | undefined,
          };
          break;
        case 'applyEdit':
          event = {
            kind: 'apply-edit',
            requestId,
            edits: (payload.edits as Array<{ uri: string; edits: Array<{ startLine: number; startColumn: number; endLine: number; endColumn: number; newText: string }> }>) ?? [],
          };
          break;
        case 'openDoc':
        default:
          event = { kind: 'open-doc', requestId, uri: String(payload.uri ?? '') };
          break;
      }
      sendToRenderer('ext:event', event);
    });
  },
  async openDialog(options) {
    if (!mainWindow) return undefined;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title,
      properties: [
        ...(options.canSelectFolders ? (['openDirectory'] as const) : []),
        ...(options.canSelectFiles ? (['openFile'] as const) : []),
        ...(options.canSelectMany ? (['multiSelections'] as const) : []),
      ],
    });
    return result.canceled ? undefined : result.filePaths;
  },
  async saveDialog(options) {
    if (!mainWindow) return undefined;
    const result = await dialog.showSaveDialog(mainWindow, {
      title: options.title,
      defaultPath: options.defaultPath,
    });
    return result.canceled ? undefined : result.filePath;
  },
  clipboardRead: () => clipboard.readText(),
  clipboardWrite: (text) => {
    void clipboard.writeText(text);
  },
};

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0e14',
    title: 'Ter Editor',
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 14 } }
      : { frame: false }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (DEV_URL) {
    await mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await mainWindow.loadURL('app://bundle/index.html');
  }
}

function registerAppProtocol(): void {
  protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url);
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === '/' || pathname === '') pathname = '/index.html';
      const resolved = path.normalize(path.join(rendererRoot, pathname));
      const relative = path.relative(rendererRoot, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return new Response('Forbidden', { status: 403 });
      return await net.fetch(pathToFileURL(resolved).toString());
    } catch {
      return await net.fetch(pathToFileURL(path.join(rendererRoot, 'index.html')).toString());
    }
  });
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { role: 'close' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function openProject(root: string) {
  const resolved = path.resolve(root);
  const stat = await fsp.stat(resolved);
  if (!stat.isDirectory()) throw new Error(`${resolved} is not a folder`);
  fsService.setRoot(resolved);
  const tree = await fsService.tree(resolved, 2);
  const recent = await settings.touchRecent(resolved);
  return { root: resolved, name: path.basename(resolved), tree, recent };
}

function registerIpc(): void {
  ipcMain.handle('project:open', async (_event, root: string) => openProject(root));
  ipcMain.handle('project:create', async (_event, input) => {
    const snapshot = await fsService.createProject(input);
    const recent = await settings.touchRecent(snapshot.root);
    return { ...snapshot, recent };
  });
  ipcMain.handle('project:close', async () => {
    fsService.setRoot(null);
    await extensionHost?.reload();
  });
  ipcMain.handle('project:recent', async () => settings.get().recentProjects);
  ipcMain.handle('project:forget', async (_event, root: string) => settings.forgetRecent(root));
  ipcMain.handle('project:root', async () => fsService.getRoot());

  ipcMain.handle('dialog:pickDirectory', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle('dialog:pickFile', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle('fs:read', async (_event, target: string) => fsService.readText(target));
  ipcMain.handle('fs:write', async (_event, target: string, content: string) => fsService.writeText(target, content));
  ipcMain.handle('fs:list', async (_event, target: string) => fsService.list(target));
  ipcMain.handle('fs:tree', async (_event, target: string) => fsService.tree(target, 2));
  ipcMain.handle('fs:create', async (_event, target: string, kind: 'file' | 'folder', content?: string) =>
    fsService.create(target, kind, content ?? ''),
  );
  ipcMain.handle('fs:remove', async (_event, target: string) => fsService.remove(target));
  ipcMain.handle('fs:rename', async (_event, from: string, to: string) => fsService.rename(from, to));
  ipcMain.handle('fs:find', async (_event, query: string) => fsService.find(query));
  ipcMain.handle('fs:search', async (_event, query: string) => fsService.search(query));
  ipcMain.handle('fs:reveal', async (_event, target: string) => shell.showItemInFolder(target));

  ipcMain.handle('term:create', async (_event, options: TerminalOptions) => terminalService.create(options));
  ipcMain.on('term:write', (_event, id: string, data: string) => terminalService.write(id, data));
  ipcMain.on('term:resize', (_event, id: string, cols: number, rows: number) =>
    terminalService.resize(id, cols, rows),
  );
  ipcMain.on('term:kill', (_event, id: string) => terminalService.kill(id));
  ipcMain.handle('app:native-version', async () => fsService.nativeVersion());

  ipcMain.on('docs:open', (_event, payload: { uri: string; languageId: string; text: string; version: number }) => {
    extensionHost?.notifyDocumentOpen(payload.uri, payload.languageId, payload.text, payload.version);
  });
  ipcMain.on('docs:change', (_event, payload: { uri: string; text: string; version: number }) => {
    extensionHost?.notifyDocumentChange(payload.uri, payload.text, payload.version);
  });
  ipcMain.on('docs:save', (_event, uri: string) => extensionHost?.notifyDocumentSave(uri));
  ipcMain.on('docs:close', (_event, uri: string) => extensionHost?.notifyDocumentClose(uri));
  ipcMain.on(
    'docs:active',
    (
      _event,
      uri: string | null,
      selection?: { startLine: number; startColumn: number; endLine: number; endColumn: number },
    ) => {
      extensionHost?.setActiveDocument(uri, selection);
    },
  );

  ipcMain.handle('settings:get', async () => settings.get());
  ipcMain.handle(
    'settings:update',
    async (_event, patch: Partial<Settings>) => settings.update(patch),
  );

  ipcMain.handle('ai:has-key', async () => settings.hasKey());
  ipcMain.handle('ai:set-key', async (_event, key: string) => settings.setKey(key));
  ipcMain.handle('ai:clear-key', async () => settings.clearKey());
  ipcMain.handle('ai:models', async (_event, force?: boolean) => {
    const result = await ai.listModels(Boolean(force));
    if (result.models.length > 0 && !settings.get().model) {
      const picked = pickDefaultModel(result.models);
      if (picked) await settings.update({ model: picked });
    }
    return result;
  });
  ipcMain.handle('ai:start', async (_event, requestId: string, request: ChatRequest) => {
    void ai.streamChat(requestId, request, (event) => sendToRenderer('ai:event', { requestId, event }));
    return true;
  });
  ipcMain.on('ai:cancel', (_event, requestId: string) => ai.cancel(requestId));

  ipcMain.handle('ext:list', async () => extensions.list());
  ipcMain.handle('ext:search', async (_event, query: string) => extensions.search(query));
  ipcMain.handle('ext:install', async (_event, id: string) => {
    const installed = await extensions.install(id);
    await extensionHost?.reload();
    sendToRenderer('ext:changed', null);
    return installed;
  });
  ipcMain.handle('ext:uninstall', async (_event, id: string) => {
    extensionHost?.deactivateAll();
    await extensions.uninstall(id);
    await extensionHost?.reload();
    sendToRenderer('ext:changed', null);
  });
  ipcMain.handle('ext:set-enabled', async (_event, id: string, enabled: boolean) => {
    await extensions.setEnabled(id, enabled);
    await extensionHost?.reload();
    sendToRenderer('ext:changed', null);
  });
  ipcMain.handle('ext:commands', async () => extensionHost?.getCommands() ?? []);
  ipcMain.handle('ext:execute', async (_event, id: string) => extensionHost?.executeCommand(id));
  ipcMain.handle('ext:read-asset', async (_event, id: string, relativePath: string) => extensions.readAsset(id, relativePath));
  ipcMain.handle('ext:themes', async () => extensions.themes());
  ipcMain.on('ext:reply', (_event, requestId: string, value: unknown) => {
    const pending = pendingExtensionRequests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingExtensionRequests.delete(requestId);
    pending.resolve(value);
  });

  ipcMain.handle('app:open-external', async (_event, url: string) => {
    if (/^https?:\/\//.test(url)) await shell.openExternal(url);
  });
  ipcMain.handle('app:show-item', async (_event, target: string) => shell.showItemInFolder(target));
  ipcMain.handle('app:oniguruma', async () => {
    const candidates = [
      path.join(process.resourcesPath ?? '', 'onig.wasm'),
      path.join(app.getAppPath(), 'node_modules', 'vscode-oniguruma', 'release', 'onig.wasm'),
      path.join(__dirname, '..', 'node_modules', 'vscode-oniguruma', 'release', 'onig.wasm'),
    ];
    for (const candidate of candidates) {
      try {
        return await fsp.readFile(candidate);
      } catch {
        continue;
      }
    }
    throw new Error('onig.wasm not found; TextMate grammars from extensions are unavailable');
  });
  ipcMain.on('window:control', (_event, action: 'minimize' | 'maximize' | 'close') => {
    if (!mainWindow) return;
    if (action === 'minimize') mainWindow.minimize();
    else if (action === 'maximize') {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    } else mainWindow.close();
  });
}

app.whenReady().then(async () => {
  registerAppProtocol();
  buildMenu();
  await settings.load();
  await settings.loadKey();
  fsService.setChangeListener((paths) => sendToRenderer('fs:changed', paths));
  settings.onChange((value) => sendToRenderer('settings:changed', value));
  extensionHost = new ExtensionHost({
    fs: fsService,
    settings,
    extensions,
    delegate: hostDelegate,
    userDataPath: app.getPath('userData'),
  });
  registerIpc();
  await extensionHost.start().catch((error: Error) => {
    console.error('Extension host failed to start', error);
  });

  // Resolve the folder passed on the command line before the renderer mounts so
  // its first project:root query already sees it.
  const initialPath = process.argv.find((arg) => arg && !arg.startsWith('-') && arg !== '.' && arg !== app.getAppPath());
  if (initialPath) {
    try {
      await openProject(initialPath);
    } catch {
      /* ignore an invalid initial path */
    }
  }

  await createWindow();
  if (initialPath) {
    mainWindow?.webContents.once('did-finish-load', () => {
      sendToRenderer('open-initial-project', initialPath);
    });
  }

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});

app.on('before-quit', () => {
  ai.cancelAll();
  terminalService.disposeAll();
  extensionHost?.dispose();
  fsService.dispose();
});

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (mainWindow) sendToRenderer('open-path', filePath);
});
