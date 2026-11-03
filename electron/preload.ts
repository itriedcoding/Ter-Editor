import { contextBridge, ipcRenderer } from 'electron';
import type { AiEvent, ChatRequest, ExtEvent, Settings, TerApi } from '../shared/ipc';

const api: TerApi = {
  platform: process.platform,
  version: process.env.npm_package_version ?? '1.0.0',
  dialog: {
    pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
    pickFile: () => ipcRenderer.invoke('dialog:pickFile'),
  },
  project: {
    open: (root) => ipcRenderer.invoke('project:open', root),
    create: (input) => ipcRenderer.invoke('project:create', input),
    close: () => ipcRenderer.invoke('project:close'),
    recent: () => ipcRenderer.invoke('project:recent'),
    forget: (path) => ipcRenderer.invoke('project:forget', path),
    root: () => ipcRenderer.invoke('project:root'),
  },
  fs: {
    read: (path) => ipcRenderer.invoke('fs:read', path),
    write: (path, content) => ipcRenderer.invoke('fs:write', path, content),
    list: (path) => ipcRenderer.invoke('fs:list', path),
    tree: (path) => ipcRenderer.invoke('fs:tree', path),
    create: (path, kind, content) => ipcRenderer.invoke('fs:create', path, kind, content),
    remove: (path) => ipcRenderer.invoke('fs:remove', path),
    rename: (from, to) => ipcRenderer.invoke('fs:rename', from, to),
    find: (query) => ipcRenderer.invoke('fs:find', query),
    search: (query) => ipcRenderer.invoke('fs:search', query),
    reveal: (path) => ipcRenderer.invoke('fs:reveal', path),
    onChanged: (callback) => {
      const listener = (_event: unknown, paths: string[]): void => callback(paths);
      ipcRenderer.on('fs:changed', listener);
      return () => ipcRenderer.removeListener('fs:changed', listener);
    },
  },
  docs: {
    open: (uri, languageId, text, version) => ipcRenderer.send('docs:open', { uri, languageId, text, version }),
    change: (uri, text, version) => ipcRenderer.send('docs:change', { uri, text, version }),
    save: (uri) => ipcRenderer.send('docs:save', uri),
    close: (uri) => ipcRenderer.send('docs:close', uri),
    active: (uri, selection) => ipcRenderer.send('docs:active', uri, selection),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch) => ipcRenderer.invoke('settings:update', patch),
    onChanged: (callback) => {
      const listener = (_event: unknown, settings: Settings): void => callback(settings);
      ipcRenderer.on('settings:changed', listener);
      return () => ipcRenderer.removeListener('settings:changed', listener);
    },
  },
  ai: {
    hasKey: () => ipcRenderer.invoke('ai:has-key'),
    setKey: (key) => ipcRenderer.invoke('ai:set-key', key),
    clearKey: () => ipcRenderer.invoke('ai:clear-key'),
    models: () => ipcRenderer.invoke('ai:models'),
    start: (requestId, request: ChatRequest) => ipcRenderer.invoke('ai:start', requestId, request),
    cancel: (requestId) => ipcRenderer.send('ai:cancel', requestId),
    onEvent: (callback) => {
      const listener = (_event: unknown, payload: { requestId: string; event: AiEvent }): void =>
        callback(payload.requestId, payload.event);
      ipcRenderer.on('ai:event', listener);
      return () => ipcRenderer.removeListener('ai:event', listener);
    },
  },
  extensions: {
    list: () => ipcRenderer.invoke('ext:list'),
    search: (query) => ipcRenderer.invoke('ext:search', query),
    install: (id) => ipcRenderer.invoke('ext:install', id),
    uninstall: (id) => ipcRenderer.invoke('ext:uninstall', id),
    setEnabled: (id, enabled) => ipcRenderer.invoke('ext:set-enabled', id, enabled),
    commands: () => ipcRenderer.invoke('ext:commands'),
    executeCommand: (id) => ipcRenderer.invoke('ext:execute', id),
    readAsset: (id, relativePath) => ipcRenderer.invoke('ext:read-asset', id, relativePath),
    themes: () => ipcRenderer.invoke('ext:themes'),
    reply: (requestId, value) => ipcRenderer.send('ext:reply', requestId, value),
    onEvent: (callback) => {
      const listener = (_event: unknown, payload: ExtEvent): void => callback(payload);
      ipcRenderer.on('ext:event', listener);
      return () => ipcRenderer.removeListener('ext:event', listener);
    },
    onChanged: (callback) => {
      const listener = (): void => callback();
      ipcRenderer.on('ext:changed', listener);
      return () => ipcRenderer.removeListener('ext:changed', listener);
    },
  },
  app: {
    openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
    showItemInFolder: (path) => ipcRenderer.invoke('app:show-item', path),
    windowControl: (action) => ipcRenderer.send('window:control', action),
  },
};

contextBridge.exposeInMainWorld('ter', api);

// Extra helpers that are not part of the public editor API surface.
contextBridge.exposeInMainWorld('terInternals', {
  oniguruma: (): Promise<Uint8Array> => ipcRenderer.invoke('app:oniguruma'),
  onInitialProject: (callback: (root: string) => void) => {
    const listener = (_event: unknown, root: string): void => callback(root);
    ipcRenderer.on('open-initial-project', listener);
    return () => ipcRenderer.removeListener('open-initial-project', listener);
  },
});
