import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AiModel,
  CreateProjectInput,
  DiagnosticItem,
  ExtCommand,
  ExtEvent,
  ExtensionInfo,
  ExtensionTheme,
  FileEntry,
  RecentProject,
  Settings,
  StatusItem,
} from '../shared/ipc';
import { fileUri, uriToPath } from '../shared/uri';
import { applyTextEdits } from '../shared/text';
import { languageForPath } from '../shared/languages';
import { formatError, ter } from './lib/bridge';
import { applyExtensionGrammars, registerExtraLanguages } from './lib/textmate';
import { BUILTIN_THEMES, defineExtensionTheme, monaco } from './lib/monaco';
import { TitleBar } from './components/TitleBar';
import { Sidebar, type SidebarPanel } from './components/Sidebar';
import { EditorArea } from './components/EditorArea';
import { ChatPanel } from './components/ChatPanel';
import { StatusBar } from './components/StatusBar';
import {
  CommandPalette,
  MessagePrompt,
  NewProjectDialog,
  PromptDialog,
  QuickPickDialog,
  SettingsDialog,
} from './components/Dialogs';
import { hasTextMateSupport } from './lib/textmate';

export interface OpenFileState {
  path: string;
  uri: string;
  language: string;
  dirty: boolean;
}

interface MessagePromptState {
  requestId: string;
  level: 'info' | 'warning' | 'error';
  message: string;
  items: string[];
}

interface QuickPickState {
  requestId: string;
  items: Array<{ label: string; description?: string; detail?: string; picked?: boolean }>;
  placeholder?: string;
  canPickMany: boolean;
}

interface InputBoxState {
  requestId: string;
  prompt?: string;
  placeHolder?: string;
  value?: string;
  password: boolean;
  title?: string;
}

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [project, setProject] = useState<{ root: string; name: string } | null>(null);
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [entries, setEntries] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [openFiles, setOpenFiles] = useState<OpenFileState[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [sidebar, setSidebar] = useState<SidebarPanel>('explorer');
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [chatOpen, setChatOpen] = useState(true);
  const [palette, setPalette] = useState<'commands' | 'files' | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [problems, setProblems] = useState<Record<string, DiagnosticItem[]>>({});
  const [output, setOutput] = useState<Record<string, string>>({});
  const [bottom, setBottom] = useState<'problems' | 'output' | 'terminal' | null>(null);
  const [nativeVersion, setNativeVersion] = useState('');
  const [outputChannel, setOutputChannel] = useState('Extension Host');
  const [statusItems, setStatusItems] = useState<StatusItem[]>([]);
  const [extCommands, setExtCommands] = useState<ExtCommand[]>([]);
  const [extensions, setExtensions] = useState<ExtensionInfo[]>([]);
  const [extThemes, setExtThemes] = useState<ExtensionTheme[]>([]);
  const [messagePrompt, setMessagePrompt] = useState<MessagePromptState | null>(null);
  const [quickPick, setQuickPick] = useState<QuickPickState | null>(null);
  const [inputBox, setInputBox] = useState<InputBoxState | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [models, setModels] = useState<AiModel[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [internalPrompt, setInternalPrompt] = useState<{
    title: string;
    label: string;
    value: string;
    resolve: (value: string | null) => void;
  } | null>(null);

  const modelsRef = useRef(new Map<string, monaco.editor.ITextModel>());
  const changeTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsRef = useRef<Settings | null>(null);

  settingsRef.current = settings;

  const showToast = useCallback((text: string) => {
    setToast(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4500);
  }, []);

  const loadDirectory = useCallback(async (dir: string) => {
    try {
      const listing = await ter.fs.list(dir);
      setEntries((previous) => ({ ...previous, [dir]: listing }));
    } catch (error) {
      showToast(formatError(error));
    }
  }, [showToast]);

  const refreshProject = useCallback(async () => {
    if (!project) return;
    await loadDirectory(project.root);
    setEntries((previous) => {
      const next: Record<string, FileEntry[]> = {};
      for (const key of Object.keys(previous)) {
        if (key === project.root || expanded.has(key)) next[key] = previous[key];
      }
      return next;
    });
    for (const dir of Array.from(expanded)) void loadDirectory(dir);
  }, [project, expanded, loadDirectory]);

  const loadExtensions = useCallback(async () => {
    try {
      const list = await ter.extensions.list();
      setExtensions(list);
      await applyExtensionGrammars(list);
      const themes = await ter.extensions.themes();
      setExtThemes(themes);
      for (const theme of themes) defineExtensionTheme(theme);
      setExtCommands(await ter.extensions.commands());
      if (project) {
        for (const open of openFiles) {
          const model = modelsRef.current.get(open.path);
          if (model) {
            const current = model.getLanguageId();
            if (!current || current === 'plaintext') monaco.editor.setModelLanguage(model, languageForPath(open.path));
          }
        }
      }
    } catch (error) {
      showToast(`Extensions: ${formatError(error)}`);
    }
  }, [openFiles, project, showToast]);

  const applyProject = useCallback(
    async (snapshot: { root: string; name: string }, recentList?: RecentProject[]) => {
      setProject({ root: snapshot.root, name: snapshot.name });
      setRecent(recentList ?? (await ter.project.recent()));
      setEntries({});
      setExpanded(new Set());
      await loadDirectory(snapshot.root);
      setExpanded(new Set([snapshot.root]));
    },
    [loadDirectory],
  );

  // ---- bootstrap -------------------------------------------------------

  useEffect(() => {
    let disposed = false;
    void (async () => {
      registerExtraLanguages();
      const loaded = await ter.settings.get();
      if (disposed) return;
      setSettings(loaded);
      monaco.editor.setTheme(loaded.extensionTheme ?? loaded.theme);
      setRecent(loaded.recentProjects);
      setHasKey(await ter.ai.hasKey());
      try {
        setNativeVersion(await ter.app.nativeVersion());
      } catch {
        setNativeVersion('native filesystem unavailable');
      }
      const modelList = await ter.ai.models();
      if (disposed) return;
      setModels(modelList.models);
      setModelsError(modelList.error ?? null);
      const root = await ter.project.root();
      if (root && !disposed) {
        const snapshot = await ter.project.open(root);
        montage(snapshot);
      }
      await loadExtensions();
    })();

    const unsubscribeInitial = window.terInternals.onInitialProject((root) => {
      void ter.project.open(root).then((snapshot) => applyProject(snapshot, snapshot.recent));
    });
    const unsubscribeSettings = ter.settings.onChanged((next) => {
      setSettings(next);
      monaco.editor.setTheme(next.extensionTheme ?? next.theme);
    });
    const unsubscribeExtensions = ter.extensions.onChanged(() => {
      void loadExtensions();
    });
    const unsubscribeFs = ter.fs.onChanged(() => {
      void refreshProject();
    });

    return () => {
      disposed = true;
      unsubscribeInitial();
      unsubscribeSettings();
      unsubscribeExtensions();
      unsubscribeFs();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const montage = (snapshot: { root: string; name: string; recent: RecentProject[] }) => {
    setProject({ root: snapshot.root, name: snapshot.name });
    setRecent(snapshot.recent);
    setExpanded(new Set([snapshot.root]));
    setEntries({});
    void loadDirectory(snapshot.root);
  };

  // ---- extension host events -------------------------------------------

  const openFile = useCallback(
    async (targetPath: string) => {
      const existing = openFiles.find((file) => file.path === targetPath);
      if (existing || modelsRef.current.has(targetPath)) {
        setActivePath(targetPath);
        return;
      }
      try {
        const text = await ter.fs.read(targetPath);
        const language = languageForPath(targetPath);
        const uri = fileUri(targetPath);
        const model = monaco.editor.createModel(text, language, monaco.Uri.parse(uri));
        modelsRef.current.set(targetPath, model);
        ter.docs.open(uri, language, text, model.getVersionId());
        model.onDidChangeContent(() => {
          setOpenFiles((previous) =>
            previous.map((file) => (file.path === targetPath ? { ...file, dirty: true } : file)),
          );
          const timer = changeTimers.current.get(targetPath);
          if (timer) clearTimeout(timer);
          changeTimers.current.set(
            targetPath,
            setTimeout(() => {
              ter.docs.change(uri, model.getValue(), model.getVersionId());
              if (settingsRef.current?.autoSave) {
                void ter.fs
                  .write(targetPath, model.getValue())
                  .then(() => {
                    ter.docs.save(uri);
                    setOpenFiles((previous) =>
                      previous.map((file) => (file.path === targetPath ? { ...file, dirty: false } : file)),
                    );
                  })
                  .catch(() => undefined);
              }
            }, 250),
          );
        });
        setOpenFiles((previous) => [...previous, { path: targetPath, uri, language, dirty: false }]);
        setActivePath(targetPath);
      } catch (error) {
        showToast(formatError(error));
      }
    },
    [openFiles, showToast],
  );

  const openUri = useCallback(
    async (uri: string) => {
      try {
        await openFile(uriToPath(uri));
      } catch (error) {
        showToast(formatError(error));
      }
    },
    [openFile, showToast],
  );

  const applyExtensionEdit = useCallback(
    async (edits: Array<{ uri: string; edits: Array<{ startLine: number; startColumn: number; endLine: number; endColumn: number; newText: string }> }>) => {
      for (const group of edits) {
        const targetPath = uriToPath(group.uri);
        const model = modelsRef.current.get(targetPath);
        if (model) {
          const operations = group.edits.map((edit) => {
            const start = model.getOffsetAt({ lineNumber: edit.startLine, column: edit.startColumn });
            const end = model.getOffsetAt({ lineNumber: edit.endLine, column: edit.endColumn });
            return { range: monaco.Range.fromPositions(model.getPositionAt(start), model.getPositionAt(end)), text: edit.newText };
          });
          model.pushEditOperations([], operations, () => null);
          ter.docs.change(group.uri, model.getValue(), model.getVersionId());
          setOpenFiles((previous) => previous.map((file) => (file.path === targetPath ? { ...file, dirty: true } : file)));
        } else {
          try {
            const text = await ter.fs.read(targetPath);
            await ter.fs.write(targetPath, applyTextEdits(text, group.edits));
          } catch (error) {
            showToast(`Extension edit failed: ${formatError(error)}`);
          }
        }
      }
      await refreshProject();
    },
    [refreshProject, showToast],
  );

  useEffect(() => {
    const unsubscribe = ter.extensions.onEvent((event: ExtEvent) => {
      switch (event.kind) {
        case 'status-set':
          setStatusItems((previous) => {
            const next = previous.filter((item) => item.id !== event.item.id);
            next.push(event.item);
            return next;
          });
          break;
        case 'status-dispose':
          setStatusItems((previous) => previous.filter((item) => item.id !== event.id));
          break;
        case 'message':
          setMessagePrompt({ requestId: event.requestId, level: event.level, message: event.message, items: event.items });
          break;
        case 'quick-pick':
          setQuickPick({
            requestId: event.requestId,
            items: event.items,
            placeholder: event.placeholder,
            canPickMany: event.canPickMany,
          });
          break;
        case 'input-box':
          setInputBox({
            requestId: event.requestId,
            prompt: event.prompt,
            placeHolder: event.placeHolder,
            value: event.value,
            password: event.password,
            title: event.title,
          });
          break;
        case 'diagnostics':
          setProblems((previous) => ({ ...previous, [event.uri]: event.items }));
          break;
        case 'output':
          setOutput((previous) => ({ ...previous, [event.channel]: (previous[event.channel] ?? '') + event.text }));
          break;
        case 'output-clear':
          setOutput((previous) => ({ ...previous, [event.channel]: '' }));
          break;
        case 'apply-edit':
          void applyExtensionEdit(event.edits).then(() => ter.extensions.reply(event.requestId, true));
          break;
        case 'open-doc':
          void openUri(event.uri).then(() => ter.extensions.reply(event.requestId, true));
          break;
        case 'reveal':
          void openUri(event.uri);
          break;
        case 'progress':
          setProgress(event.active ? event.title || 'Working…' : null);
          break;
        case 'reload-themes':
          void loadExtensions();
          break;
        case 'log':
          setOutput((previous) => ({
            ...previous,
            'Extension Host': (previous['Extension Host'] ?? '') + `${event.message}\n`,
          }));
          break;
        default:
          break;
      }
    });
    return unsubscribe;
  }, [applyExtensionEdit, loadExtensions, openUri]);

  // ---- file operations -------------------------------------------------

  const closeFile = useCallback(
    (targetPath: string) => {
      const uri = fileUri(targetPath);
      ter.docs.close(uri);
      const model = modelsRef.current.get(targetPath);
      if (model) {
        model.dispose();
        modelsRef.current.delete(targetPath);
      }
      const timer = changeTimers.current.get(targetPath);
      if (timer) clearTimeout(timer);
      changeTimers.current.delete(targetPath);
      const index = openFiles.findIndex((file) => file.path === targetPath);
      const next = openFiles.filter((file) => file.path !== targetPath);
      setOpenFiles(next);
      if (activePath === targetPath) setActivePath(next[Math.min(index, next.length - 1)]?.path ?? null);
    },
    [openFiles, activePath],
  );

  const saveFile = useCallback(
    async (targetPath?: string) => {
      const pathToSave = targetPath ?? activePath;
      if (!pathToSave) return;
      const model = modelsRef.current.get(pathToSave);
      if (!model) return;
      try {
        await ter.fs.write(pathToSave, model.getValue());
        ter.docs.save(fileUri(pathToSave));
        setOpenFiles((previous) => previous.map((file) => (file.path === pathToSave ? { ...file, dirty: false } : file)));
      } catch (error) {
        showToast(formatError(error));
      }
    },
    [activePath, showToast],
  );

  const promptForValue = useCallback(
    (title: string, label: string, value = ''): Promise<string | null> =>
      new Promise((resolve) => {
        setInternalPrompt({
          title,
          label,
          value,
          resolve: (result) => {
            setInternalPrompt(null);
            resolve(result);
          },
        });
      }),
    [],
  );

  const createEntry = useCallback(
    async (dir: string, kind: 'file' | 'folder') => {
      const name = await promptForValue(kind === 'file' ? 'New File' : 'New Folder', 'Name', kind === 'file' ? 'untitled.ts' : 'new-folder');
      if (!name) return;
      const target = `${dir}${dir.endsWith('/') || dir.endsWith('\\') ? '' : '/'}${name}`;
      try {
        await ter.fs.create(target, kind, '');
        await loadDirectory(dir);
        if (kind === 'file') await openFile(target);
      } catch (error) {
        showToast(formatError(error));
      }
    },
    [loadDirectory, openFile, promptForValue, showToast],
  );

  const renameEntry = useCallback(
    async (targetPath: string) => {
      const current = targetPath.split(/[\\/]/).pop() ?? '';
      const name = await promptForValue('Rename', 'New name', current);
      if (!name || name === current) return;
      const parent = targetPath.slice(0, targetPath.length - current.length);
      try {
        await ter.fs.rename(targetPath, `${parent}${name}`);
        if (modelsRef.current.has(targetPath)) closeFile(targetPath);
        await refreshProject();
      } catch (error) {
        showToast(formatError(error));
      }
    },
    [closeFile, promptForValue, refreshProject, showToast],
  );

  const deleteEntry = useCallback(
    async (targetPath: string) => {
      const confirmed = window.confirm(`Delete ${targetPath}? This cannot be undone.`);
      if (!confirmed) return;
      try {
        await ter.fs.remove(targetPath);
        closeFile(targetPath);
        await refreshProject();
      } catch (error) {
        showToast(formatError(error));
      }
    },
    [closeFile, refreshProject, showToast],
  );

  const toggleDirectory = useCallback(
    (dir: string) => {
      setExpanded((previous) => {
        const next = new Set(previous);
        if (next.has(dir)) next.delete(dir);
        else {
          next.add(dir);
          void loadDirectory(dir);
        }
        return next;
      });
    },
    [loadDirectory],
  );

  const openFolder = useCallback(async () => {
    const root = await ter.dialog.pickDirectory();
    if (!root) return;
    try {
      const snapshot = await ter.project.open(root);
      montage(snapshot);
      await loadExtensions();
    } catch (error) {
      showToast(formatError(error));
    }
  }, [loadExtensions]);

  const createProject = useCallback(
    async (input: CreateProjectInput) => {
      try {
        const snapshot = await ter.project.create(input);
        setNewProjectOpen(false);
        montage(snapshot);
        await loadExtensions();
        showToast(`Created ${snapshot.name}`);
      } catch (error) {
        showToast(formatError(error));
      }
    },
    [loadExtensions, showToast],
  );

  const updateSettings = useCallback(
    async (patch: Partial<Settings>) => {
      const next = await ter.settings.update(patch);
      setSettings(next);
      if (patch.theme || patch.extensionTheme !== undefined) monaco.editor.setTheme(next.extensionTheme ?? next.theme);
      return next;
    },
    [],
  );

  const refreshModels = useCallback(async () => {
    const result = await ter.ai.models();
    setModels(result.models);
    setModelsError(result.error ?? null);
  }, []);

  // ---- commands --------------------------------------------------------

  const runCommand = useCallback(
    (id: string) => {
      switch (id) {
        case 'file.open-folder':
          void openFolder();
          break;
        case 'file.new-project':
          setNewProjectOpen(true);
          break;
        case 'file.new-file':
          if (project) void createEntry(project.root, 'file');
          break;
        case 'file.save':
          void saveFile();
          break;
        case 'file.close-editor':
          if (activePath) closeFile(activePath);
          break;
        case 'view.toggle-sidebar':
          setSidebarVisible((value) => !value);
          break;
        case 'view.toggle-chat':
          setChatOpen((value) => !value);
          break;
        case 'view.problems':
          setBottom((value) => (value === 'problems' ? null : 'problems'));
          break;
        case 'view.output':
          setBottom((value) => (value === 'output' ? null : 'output'));
          break;
        case 'view.terminal':
          setBottom((value) => (value === 'terminal' ? null : 'terminal'));
          break;
        case 'preferences.settings':
          setSettingsOpen(true);
          break;
        case 'ai.new-chat':
          setChatOpen(true);
          window.dispatchEvent(new CustomEvent('ter:new-chat'));
          break;
        case 'ai.explain-selection':
          setChatOpen(true);
          window.dispatchEvent(new CustomEvent('ter:explain-selection'));
          break;
        default:
          void ter.extensions.executeCommand(id).catch((error: unknown) => showToast(formatError(error)));
      }
    },
    [activePath, closeFile, createEntry, openFolder, project, saveFile, showToast],
  );

  // ---- keyboard --------------------------------------------------------

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === 's') {
        event.preventDefault();
        void saveFile();
      } else if (key === 'p' && event.shiftKey) {
        event.preventDefault();
        setPalette('commands');
      } else if (key === 'p') {
        event.preventDefault();
        setPalette('files');
      } else if (key === 'w') {
        event.preventDefault();
        if (activePath) closeFile(activePath);
      } else if (key === 'b') {
        event.preventDefault();
        setSidebarVisible((value) => !value);
      } else if (key === 'j') {
        event.preventDefault();
        setChatOpen((value) => !value);
      } else if (key === '`') {
        event.preventDefault();
        setBottom((value) => (value === 'terminal' ? null : 'terminal'));
      } else if (key === ',') {
        event.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activePath, closeFile, saveFile]);

  useEffect(() => {
    const bindings = extCommands.filter((command) => command.keybinding);
    const handler = (event: KeyboardEvent) => {
      const pressed = [
        event.ctrlKey || event.metaKey ? 'ctrl' : '',
        event.altKey ? 'alt' : '',
        event.shiftKey ? 'shift' : '',
        event.key.toLowerCase(),
      ]
        .filter(Boolean)
        .join('+');
      const match = bindings.find((command) => command.keybinding?.toLowerCase().replace(/\s/g, '') === pressed);
      if (match) {
        event.preventDefault();
        void ter.extensions.executeCommand(match.id).catch((error: unknown) => showToast(formatError(error)));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [extCommands, showToast]);

  // ---- derived ---------------------------------------------------------

  const activeFile = openFiles.find((file) => file.path === activePath) ?? null;
  const activeModel = activePath ? (modelsRef.current.get(activePath) ?? null) : null;
  const activeUri = activePath ? fileUri(activePath) : null;
  const activeProblems = activeUri ? (problems[activeUri] ?? []) : [];
  const problemCount = useMemo(
    () =>
      Object.values(problems).reduce(
        (accumulator, items) => {
          for (const item of items) {
            if (item.severity === 'error') accumulator.errors += 1;
            else if (item.severity === 'warning') accumulator.warnings += 1;
          }
          return accumulator;
        },
        { errors: 0, warnings: 0 },
      ),
    [problems],
  );
  const themes = useMemo(
    () => [...BUILTIN_THEMES, ...extThemes.map((theme) => ({ id: theme.id, label: theme.label, type: theme.type }))],
    [extThemes],
  );
  const paletteCommands = useMemo(() => {
    const builtins = [
      { id: 'file.open-folder', title: 'File: Open Folder…' },
      { id: 'file.new-project', title: 'File: New Project…' },
      { id: 'file.new-file', title: 'File: New File' },
      { id: 'file.save', title: 'File: Save' },
      { id: 'file.close-editor', title: 'View: Close Editor' },
      { id: 'view.toggle-sidebar', title: 'View: Toggle Sidebar' },
      { id: 'view.toggle-chat', title: 'View: Toggle AI Chat' },
      { id: 'view.problems', title: 'View: Toggle Problems' },
      { id: 'view.output', title: 'View: Toggle Output' },
      { id: 'view.terminal', title: 'View: Toggle Terminal' },
      { id: 'preferences.settings', title: 'Preferences: Open Settings' },
      { id: 'ai.new-chat', title: 'AI: New Chat' },
      { id: 'ai.explain-selection', title: 'AI: Explain Selection' },
    ];
    return [...builtins, ...extCommands.map((command) => ({ id: command.id, title: command.title }))];
  }, [extCommands]);

  useEffect(() => {
    if (activePath) setCursor({ line: 1, column: 1 });
    ter.docs.active(activeUri);
  }, [activePath, activeUri]);

  if (!settings) {
    return (
      <div className="boot">
        <div className="boot-logo">Ter</div>
        <div className="boot-text">Starting editor…</div>
      </div>
    );
  }

  const extensionStatus = extensions.filter((extension) => extension.enabled).length;

  return (
    <div className={`app theme-${(settings.extensionTheme ? extThemes.find((theme) => theme.id === settings.extensionTheme)?.type : 'dark') ?? 'dark'}`}>
      <TitleBar
        projectName={project?.name ?? null}
        chatOpen={chatOpen}
        onOpenFolder={openFolder}
        onNewProject={() => setNewProjectOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onToggleChat={() => setChatOpen((value) => !value)}
        platform={ter.platform}
      />

      <div className="workspace">
        <Sidebar
          panel={sidebar}
          visible={sidebarVisible}
          onSelectPanel={(next) => {
            setSidebar(next);
            setSidebarVisible(true);
          }}
          project={project}
          entries={entries}
          expanded={expanded}
          activePath={activePath}
          extensions={extensions}
          onToggleDirectory={toggleDirectory}
          onOpenFile={openFile}
          onRefresh={refreshProject}
          onCreateEntry={createEntry}
          onRenameEntry={renameEntry}
          onDeleteEntry={deleteEntry}
          onOpenRecent={async (path) => {
            const snapshot = await ter.project.open(path);
            montage(snapshot);
            await loadExtensions();
          }}
          recent={recent}
          onForgetRecent={async (path) => setRecent(await ter.project.forget(path))}
          onInstallExtension={async (id) => {
            showToast(`Installing ${id}…`);
            try {
              await ter.extensions.install(id);
              showToast(`Installed ${id}`);
            } catch (error) {
              showToast(formatError(error));
            }
          }}
          onToggleExtension={async (id, enabled) => {
            await ter.extensions.setEnabled(id, enabled);
          }}
          onUninstallExtension={async (id) => {
            await ter.extensions.uninstall(id);
          }}
          onOpenSearchHit={(path, line, column) => {
            void openFile(path).then(() => {
              const model = modelsRef.current.get(path);
              if (model) window.dispatchEvent(new CustomEvent('ter:reveal', { detail: { path, line, column } }));
            });
          }}
        />

        <EditorArea
          openFiles={openFiles}
          activePath={activePath}
          activeModel={activeModel}
          settings={settings}
          problems={activeProblems}
          allProblems={problems}
          bottom={bottom}
          setBottom={setBottom}
          output={output}
          outputChannel={outputChannel}
          setOutputChannel={setOutputChannel}
          onActivate={setActivePath}
          onClose={closeFile}
          onSave={() => void saveFile()}
          onCursorChange={(line, column) => {
            setCursor({ line, column });
            if (activeUri) ter.docs.active(activeUri, { startLine: line, startColumn: column, endLine: line, endColumn: column });
          }}
          onOpenFileAt={(path, line, column) => {
            void openFile(path).then(() => {
              window.dispatchEvent(new CustomEvent('ter:reveal', { detail: { path, line, column } }));
            });
          }}
          hasTextMate={activeFile ? hasTextMateSupport(activeFile.language) : false}
          onOpenPalette={() => setPalette('files')}
          projectRoot={project?.root ?? null}
        />

        {chatOpen && (
          <ChatPanel
            projectRoot={project?.root ?? null}
            activeFile={activePath}
            models={models}
            modelsError={modelsError}
            settings={settings}
            hasKey={hasKey}
            onConfigure={() => setSettingsOpen(true)}
            onRefreshModels={refreshModels}
            onModelChange={(model) => void updateSettings({ model })}
            onFilesChanged={refreshProject}
            notify={showToast}
          />
        )}
      </div>

      <StatusBar
        projectName={project?.name ?? null}
        language={activeFile?.language ?? null}
        cursor={cursor}
        errors={problemCount.errors}
        warnings={problemCount.warnings}
        model={settings.model}
        extensionCount={extensionStatus}
        statusItems={statusItems}
        themeLabel={themes.find((theme) => theme.id === (settings.extensionTheme ?? settings.theme))?.label ?? settings.theme}
        nativeVersion={nativeVersion}
        onCommand={runCommand}
        onOpenProblems={() => setBottom((value) => (value === 'problems' ? null : 'problems'))}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {palette && (
        <CommandPalette
          mode={palette}
          commands={paletteCommands}
          onFindFiles={async (query) => {
            try {
              const files = await ter.fs.find(query);
              return files.map((file) => ({ path: file.path, name: file.name }));
            } catch {
              return [];
            }
          }}
          onRunCommand={(id) => {
            setPalette(null);
            runCommand(id);
          }}
          onOpenFile={(path) => {
            setPalette(null);
            void openFile(path);
          }}
          onClose={() => setPalette(null)}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          settings={settings}
          models={models}
          modelsError={modelsError}
          hasKey={hasKey}
          themes={themes}
          onSave={updateSettings}
          onSetKey={async (key) => {
            const result = await ter.ai.setKey(key);
            setHasKey(true);
            await refreshModels();
            showToast(result.encrypted ? 'Token saved (encrypted with the OS keychain)' : 'Token saved');
          }}
          onClearKey={async () => {
            await ter.ai.clearKey();
            setHasKey(false);
            setModels([]);
            showToast('Token removed');
          }}
          onRefreshModels={refreshModels}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {newProjectOpen && (
        <NewProjectDialog
          recent={recent}
          onOpenRecent={async (path) => {
            const snapshot = await ter.project.open(path);
            setNewProjectOpen(false);
            montage(snapshot);
            await loadExtensions();
          }}
          onCreate={createProject}
          onClose={() => setNewProjectOpen(false)}
        />
      )}

      {internalPrompt && (
        <PromptDialog
          title={internalPrompt.title}
          label={internalPrompt.label}
          initialValue={internalPrompt.value}
          onSubmit={(value) => internalPrompt.resolve(value)}
          onCancel={() => internalPrompt.resolve(null)}
        />
      )}

      {messagePrompt && (
        <MessagePrompt
          prompt={messagePrompt}
          onRespond={(index) => {
            ter.extensions.reply(messagePrompt.requestId, index);
            setMessagePrompt(null);
          }}
        />
      )}

      {quickPick && (
        <QuickPickDialog
          state={quickPick}
          onRespond={(value) => {
            ter.extensions.reply(quickPick.requestId, value);
            setQuickPick(null);
          }}
        />
      )}

      {inputBox && (
        <PromptDialog
          title={inputBox.title ?? 'Extension'}
          label={inputBox.prompt ?? inputBox.placeHolder ?? 'Value'}
          initialValue={inputBox.value ?? ''}
          password={inputBox.password}
          onSubmit={(value) => {
            ter.extensions.reply(inputBox.requestId, value ?? undefined);
            setInputBox(null);
          }}
          onCancel={() => {
            ter.extensions.reply(inputBox.requestId, undefined);
            setInputBox(null);
          }}
        />
      )}

      {progress && <div className="progress-chip"><span className="spinner" />{progress}</div>}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
