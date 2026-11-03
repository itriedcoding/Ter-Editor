import { useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen, Search } from 'lucide-react';
import type { AiModel, CreateProjectInput, ProjectTemplate, RecentProject, Settings } from '../../shared/ipc';
import { ter } from '../lib/bridge';

/* ------------------------------------------------------------------ palette */

interface CommandPaletteProps {
  mode: 'commands' | 'files';
  commands: Array<{ id: string; title: string }>;
  onFindFiles: (query: string) => Promise<Array<{ path: string; name: string }>>;
  onRunCommand: (id: string) => void;
  onOpenFile: (path: string) => void;
  onClose: () => void;
}

export function CommandPalette(props: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<Array<{ path: string; name: string }>>([]);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (props.mode !== 'files') return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void props.onFindFiles(query).then((results) => {
        if (!cancelled) setFiles(results);
      });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, props.mode, props.onFindFiles]);

  const commandResults = useMemo(() => {
    if (props.mode !== 'commands') return [];
    const needle = query.toLowerCase();
    return props.commands.filter((command) => command.title.toLowerCase().includes(needle)).slice(0, 60);
  }, [props.commands, props.mode, query]);

  const results = props.mode === 'commands' ? commandResults : files;
  const safeIndex = Math.min(index, Math.max(results.length - 1, 0));

  const choose = (position: number): void => {
    if (props.mode === 'commands') {
      const command = commandResults[position];
      if (command) props.onRunCommand(command.id);
    } else {
      const file = files[position];
      if (file) props.onOpenFile(file.path);
    }
  };

  return (
    <div className="palette-overlay" onMouseDown={(event) => event.target === event.currentTarget && props.onClose()}>
      <div className="palette">
        <div className="palette-input-row">
          <Search size={14} />
          <input
            ref={inputRef}
            value={query}
            placeholder={props.mode === 'commands' ? 'Type a command…' : 'Search files by name…'}
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') props.onClose();
              else if (event.key === 'ArrowDown') {
                event.preventDefault();
                setIndex((value) => Math.min(value + 1, results.length - 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setIndex((value) => Math.max(value - 1, 0));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                choose(safeIndex);
              }
            }}
          />
        </div>
        <div className="palette-list">
          {results.length === 0 && <div className="palette-empty">No results</div>}
          {results.map((result, position) => (
            <button
              key={props.mode === 'commands' ? (result as { id: string }).id : (result as { path: string }).path}
              type="button"
              className={`palette-item ${position === safeIndex ? 'active' : ''}`}
              onMouseEnter={() => setIndex(position)}
              onClick={() => choose(position)}
            >
              {props.mode === 'commands' ? (
                <span>{(result as { title: string }).title}</span>
              ) : (
                <>
                  <span>{(result as { name: string }).name}</span>
                  <span className="palette-path">{(result as { path: string }).path}</span>
                </>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- settings */

interface SettingsDialogProps {
  settings: Settings;
  models: AiModel[];
  modelsError: string | null;
  hasKey: boolean;
  themes: Array<{ id: string; label: string; type: string }>;
  onSave: (patch: Partial<Settings>) => Promise<Settings>;
  onSetKey: (key: string) => Promise<void>;
  onClearKey: () => Promise<void>;
  onRefreshModels: () => Promise<void>;
  onClose: () => void;
}

export function SettingsDialog(props: SettingsDialogProps) {
  const [draft, setDraft] = useState<Settings>(props.settings);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const save = async (patch: Partial<Settings>): Promise<void> => {
    setBusy(true);
    try {
      const next = await props.onSave(patch);
      setDraft(next);
      setMessage('Saved');
      setTimeout(() => setMessage(null), 1800);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && props.onClose()}>
      <div className="modal settings-modal">
        <div className="modal-header">
          <h2>Settings</h2>
          <button type="button" className="icon-button" onClick={props.onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <section className="settings-section">
            <h3>AI Gateway</h3>
            <p className="muted">
              Models come from <code>integrations.vly.ai</code>. The token stays in the main process and is encrypted with the OS
              keychain when available.
            </p>
            <div className="field">
              <label htmlFor="base-url">Gateway base URL</label>
              <input
                id="base-url"
                value={draft.baseUrl}
                onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
                onBlur={() => void save({ baseUrl: draft.baseUrl })}
                spellCheck={false}
              />
            </div>
            <div className="field">
              <label htmlFor="gateway-token">Gateway token {props.hasKey ? '(configured)' : '(not set)'}</label>
              <div className="inline-field">
                <input
                  id="gateway-token"
                  type="password"
                  value={token}
                  placeholder={props.hasKey ? '••••••••  replace token' : 'Paste token'}
                  onChange={(event) => setToken(event.target.value)}
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="primary-button"
                  disabled={!token.trim()}
                  onClick={async () => {
                    await props.onSetKey(token.trim());
                    setToken('');
                    setMessage('Token saved');
                  }}
                >
                  Save token
                </button>
                {props.hasKey && (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={async () => {
                      await props.onClearKey();
                      setMessage('Token removed');
                    }}
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
            <div className="field">
              <label htmlFor="model">Default model</label>
              <div className="inline-field">
                <select id="model" value={draft.model} onChange={(event) => void save({ model: event.target.value })}>
                  <option value="">Select a model…</option>
                  {props.models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name} · {model.provider}
                      {model.contextWindow ? ` · ${Math.round(model.contextWindow / 1000)}k ctx` : ''}
                    </option>
                  ))}
                </select>
                <button type="button" className="secondary-button" onClick={() => void props.onRefreshModels()}>
                  Refresh list
                </button>
              </div>
              {props.modelsError && <p className="inline-error">{props.modelsError}</p>}
              {props.models.length > 0 && <p className="muted small">{props.models.length} models available from the gateway.</p>}
            </div>
            <div className="field">
              <label htmlFor="temperature">Temperature ({draft.aiTemperature.toFixed(2)})</label>
              <input
                id="temperature"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={draft.aiTemperature}
                onChange={(event) => setDraft({ ...draft, aiTemperature: Number(event.target.value) })}
                onMouseUp={() => void save({ aiTemperature: draft.aiTemperature })}
              />
            </div>
          </section>

          <section className="settings-section">
            <h3>Editor</h3>
            <div className="field-row">
              <div className="field">
                <label htmlFor="font-size">Font size</label>
                <input
                  id="font-size"
                  type="number"
                  min={10}
                  max={28}
                  value={draft.fontSize}
                  onChange={(event) => setDraft({ ...draft, fontSize: Number(event.target.value) })}
                  onBlur={() => void save({ fontSize: draft.fontSize })}
                />
              </div>
              <div className="field">
                <label htmlFor="tab-size">Tab size</label>
                <input
                  id="tab-size"
                  type="number"
                  min={1}
                  max={8}
                  value={draft.tabSize}
                  onChange={(event) => setDraft({ ...draft, tabSize: Number(event.target.value) })}
                  onBlur={() => void save({ tabSize: draft.tabSize })}
                />
              </div>
              <div className="field">
                <label htmlFor="theme">Theme</label>
                <select
                  id="theme"
                  value={draft.extensionTheme ?? draft.theme}
                  onChange={(event) => {
                    const value = event.target.value;
                    const isExtension = props.themes.find((theme) => theme.id === value && !['ter-dark', 'ter-midnight', 'ter-light', 'vs', 'vs-dark', 'hc-black'].includes(theme.id));
                    void save(isExtension ? { extensionTheme: value } : { theme: value, extensionTheme: null });
                  }}
                >
                  {props.themes.map((theme) => (
                    <option key={theme.id} value={theme.id}>
                      {theme.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={draft.wordWrap}
                onChange={(event) => void save({ wordWrap: event.target.checked })}
              />
              Word wrap
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={draft.minimap}
                onChange={(event) => void save({ minimap: event.target.checked })}
              />
              Minimap
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={draft.lineNumbers}
                onChange={(event) => void save({ lineNumbers: event.target.checked })}
              />
              Line numbers
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={draft.autoSave}
                onChange={(event) => void save({ autoSave: event.target.checked })}
              />
              Auto save after 1 second of inactivity
            </label>
          </section>
        </div>
        <div className="modal-footer">
          <span className="muted small">{busy ? 'Saving…' : (message ?? '')}</span>
          <button type="button" className="secondary-button" onClick={props.onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- new project */

const TEMPLATES: Array<{ id: ProjectTemplate; label: string; description: string }> = [
  { id: 'empty', label: 'Empty folder', description: 'README and .gitignore only' },
  { id: 'web', label: 'Static website', description: 'HTML, CSS and JavaScript' },
  { id: 'node', label: 'Node.js', description: 'package.json and an ESM entry point' },
  { id: 'python', label: 'Python', description: 'main.py and requirements.txt' },
  { id: 'rust', label: 'Rust', description: 'Cargo project with src/main.rs' },
  { id: 'go', label: 'Go', description: 'go.mod and main.go' },
  { id: 'cpp', label: 'C++', description: 'main.cpp and a Makefile' },
];

export function NewProjectDialog(props: {
  recent: RecentProject[];
  onCreate: (input: CreateProjectInput) => Promise<void>;
  onOpenRecent: (path: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [parent, setParent] = useState('');
  const [template, setTemplate] = useState<ProjectTemplate>('web');
  const [busy, setBusy] = useState(false);

  const create = async (): Promise<void> => {
    if (!parent || !name.trim()) return;
    setBusy(true);
    try {
      await props.onCreate({ parent, name: name.trim(), template });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && props.onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h2>New project</h2>
          <button type="button" className="icon-button" onClick={props.onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label htmlFor="project-name">Project name</label>
            <input id="project-name" value={name} placeholder="my-app" onChange={(event) => setName(event.target.value)} autoFocus />
          </div>
          <div className="field">
            <label htmlFor="project-parent">Location</label>
            <div className="inline-field">
              <input id="project-parent" value={parent} placeholder="Choose a parent folder" onClick={async () => {
                const directory = await ter.dialog.pickDirectory();
                if (directory) setParent(directory);
              }} readOnly />
              <button
                type="button"
                className="secondary-button"
                onClick={async () => {
                  const directory = await ter.dialog.pickDirectory();
                  if (directory) setParent(directory);
                }}
              >
                <FolderOpen size={13} /> Browse
              </button>
            </div>
          </div>
          <div className="field">
            <label>Template</label>
            <div className="template-grid">
              {TEMPLATES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`template-card ${template === item.id ? 'active' : ''}`}
                  onClick={() => setTemplate(item.id)}
                >
                  <strong>{item.label}</strong>
                  <span>{item.description}</span>
                </button>
              ))}
            </div>
          </div>
          {props.recent.length > 0 && (
            <div className="field">
              <label>Recent projects</label>
              <div className="recent-list">
                {props.recent.slice(0, 5).map((item) => (
                  <button key={item.path} type="button" className="recent-item" onClick={() => void props.onOpenRecent(item.path)}>
                    <span className="recent-name">{item.name}</span>
                    <span className="recent-path">{item.path}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="secondary-button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="button" className="primary-button" disabled={busy || !name.trim() || !parent} onClick={() => void create()}>
            {busy ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ prompts */

export function PromptDialog(props: {
  title: string;
  label: string;
  initialValue: string;
  password?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(props.initialValue);
  return (
    <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && props.onCancel()}>
      <div className="modal small">
        <div className="modal-header">
          <h2>{props.title}</h2>
        </div>
        <div className="modal-body">
          <div className="field">
            <label htmlFor="prompt-value">{props.label}</label>
            <input
              id="prompt-value"
              autoFocus
              type={props.password ? 'password' : 'text'}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') props.onSubmit(value);
                if (event.key === 'Escape') props.onCancel();
              }}
            />
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="secondary-button" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="button" className="primary-button" onClick={() => props.onSubmit(value)}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

export function MessagePrompt(props: {
  prompt: { level: 'info' | 'warning' | 'error'; message: string; items: string[] };
  onRespond: (index: number | undefined) => void;
}) {
  return (
    <div className="modal-overlay">
      <div className={`modal small message-modal ${props.prompt.level}`}>
        <div className="modal-body">
          <p className="message-text">{props.prompt.message}</p>
        </div>
        <div className="modal-footer">
          {props.prompt.items.map((item, index) => (
            <button key={item} type="button" className="secondary-button" onClick={() => props.onRespond(index)}>
              {item}
            </button>
          ))}
          <button type="button" className="primary-button" onClick={() => props.onRespond(undefined)}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

export function QuickPickDialog(props: {
  state: {
    items: Array<{ label: string; description?: string; detail?: string; picked?: boolean }>;
    placeholder?: string;
    canPickMany: boolean;
  };
  onRespond: (value: number | number[] | undefined) => void;
}) {
  const [selected, setSelected] = useState<number[]>(
    props.state.items.map((item, index) => (item.picked ? index : -1)).filter((index) => index >= 0),
  );
  const [active, setActive] = useState(0);

  const choose = (index: number): void => {
    if (props.state.canPickMany) {
      setSelected((previous) => (previous.includes(index) ? previous.filter((value) => value !== index) : [...previous, index]));
    } else {
      props.onRespond(index);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal small">
        <div className="modal-header">
          <h2>{props.state.placeholder ?? 'Select an item'}</h2>
        </div>
        <div className="modal-body quick-list">
          {props.state.items.map((item, index) => (
            <button
              key={`${item.label}-${index}`}
              type="button"
              className={`palette-item ${index === active ? 'active' : ''} ${selected.includes(index) ? 'selected' : ''}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(index)}
            >
              <span>{item.label}</span>
              {item.description && <span className="palette-path">{item.description}</span>}
              {item.detail && <span className="palette-detail">{item.detail}</span>}
            </button>
          ))}
        </div>
        <div className="modal-footer">
          <button type="button" className="secondary-button" onClick={() => props.onRespond(undefined)}>
            Cancel
          </button>
          {props.state.canPickMany && (
            <button type="button" className="primary-button" onClick={() => props.onRespond(selected)}>
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
