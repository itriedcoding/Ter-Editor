import { useState } from 'react';
import {
  Blocks,
  ChevronDown,
  ChevronRight,
  Download,
  FilePlus,
  Files,
  FolderPlus,
  Package,
  Pencil,
  Power,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import type { ExtensionInfo, ExtensionSearchResult, FileEntry, RecentProject, SearchHit } from '../../shared/ipc';
import { formatError, ter } from '../lib/bridge';

export type SidebarPanel = 'explorer' | 'search' | 'extensions';

interface SidebarProps {
  panel: SidebarPanel;
  visible: boolean;
  onSelectPanel: (panel: SidebarPanel) => void;
  project: { root: string; name: string } | null;
  entries: Record<string, FileEntry[]>;
  expanded: Set<string>;
  activePath: string | null;
  extensions: ExtensionInfo[];
  recent: RecentProject[];
  onToggleDirectory: (dir: string) => void;
  onOpenFile: (path: string) => void;
  onRefresh: () => void;
  onCreateEntry: (dir: string, kind: 'file' | 'folder') => void;
  onRenameEntry: (path: string) => void;
  onDeleteEntry: (path: string) => void;
  onOpenRecent: (path: string) => void;
  onForgetRecent: (path: string) => void;
  onInstallExtension: (id: string) => Promise<void>;
  onToggleExtension: (id: string, enabled: boolean) => Promise<void>;
  onUninstallExtension: (id: string) => Promise<void>;
  onOpenSearchHit: (path: string, line: number, column: number) => void;
}

export function Sidebar(props: SidebarProps) {
  if (!props.visible) return null;
  return (
    <aside className="sidebar">
      <nav className="activity-bar">
        <button
          type="button"
          className={`activity ${props.panel === 'explorer' ? 'active' : ''}`}
          onClick={() => props.onSelectPanel('explorer')}
          title="Explorer"
        >
          <Files size={19} />
        </button>
        <button
          type="button"
          className={`activity ${props.panel === 'search' ? 'active' : ''}`}
          onClick={() => props.onSelectPanel('search')}
          title="Search"
        >
          <Search size={19} />
        </button>
        <button
          type="button"
          className={`activity ${props.panel === 'extensions' ? 'active' : ''}`}
          onClick={() => props.onSelectPanel('extensions')}
          title="Extensions"
        >
          <Blocks size={19} />
        </button>
      </nav>
      <div className="sidebar-panel">
        {props.panel === 'explorer' && <Explorer {...props} />}
        {props.panel === 'search' && <SearchPanel onOpenSearchHit={props.onOpenSearchHit} />}
        {props.panel === 'extensions' && (
          <ExtensionsPanel
            extensions={props.extensions}
            onInstall={props.onInstallExtension}
            onToggle={props.onToggleExtension}
            onUninstall={props.onUninstallExtension}
          />
        )}
      </div>
    </aside>
  );
}

function Explorer(props: SidebarProps) {
  const { project, entries, expanded, activePath } = props;
  return (
    <div className="panel-content">
      <div className="panel-header">
        <span className="panel-title">Explorer</span>
        {project && (
          <div className="panel-actions">
            <button type="button" className="icon-button" title="New file" onClick={() => props.onCreateEntry(project.root, 'file')}>
              <FilePlus size={14} />
            </button>
            <button type="button" className="icon-button" title="New folder" onClick={() => props.onCreateEntry(project.root, 'folder')}>
              <FolderPlus size={14} />
            </button>
            <button type="button" className="icon-button" title="Refresh" onClick={props.onRefresh}>
              <RefreshCw size={13} />
            </button>
          </div>
        )}
      </div>

      {!project ? (
        <div className="empty-panel">
          <p>No folder is open.</p>
          <div className="recent-list">
            {props.recent.length === 0 && <p className="muted">Create a project to get started.</p>}
            {props.recent.map((item) => (
              <div key={item.path} className="recent-item">
                <button type="button" onClick={() => props.onOpenRecent(item.path)}>
                  <span className="recent-name">{item.name}</span>
                  <span className="recent-path">{item.path}</span>
                </button>
                <button type="button" className="icon-button" title="Remove from recent" onClick={() => props.onForgetRecent(item.path)}>
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="tree" role="tree">
          <div className="tree-root">
            <button type="button" className="tree-row tree-root-row" onClick={() => props.onToggleDirectory(project.root)}>
              {expanded.has(project.root) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span className="tree-label root-label">{project.name.toUpperCase()}</span>
            </button>
          </div>
          {expanded.has(project.root) && (
            <TreeLevel
              dir={project.root}
              depth={1}
              entries={entries}
              expanded={expanded}
              activePath={activePath}
              onToggleDirectory={props.onToggleDirectory}
              onOpenFile={props.onOpenFile}
              onRenameEntry={props.onRenameEntry}
              onDeleteEntry={props.onDeleteEntry}
              onCreateEntry={props.onCreateEntry}
            />
          )}
        </div>
      )}
    </div>
  );
}

interface TreeLevelProps {
  dir: string;
  depth: number;
  entries: Record<string, FileEntry[]>;
  expanded: Set<string>;
  activePath: string | null;
  onToggleDirectory: (dir: string) => void;
  onOpenFile: (path: string) => void;
  onRenameEntry: (path: string) => void;
  onDeleteEntry: (path: string) => void;
  onCreateEntry: (dir: string, kind: 'file' | 'folder') => void;
}

function TreeLevel(props: TreeLevelProps) {
  const listing = props.entries[props.dir];
  if (!listing) return <div className="tree-loading" style={{ paddingLeft: props.depth * 12 }}>Loading…</div>;
  if (listing.length === 0) return <div className="tree-empty" style={{ paddingLeft: props.depth * 12 + 12 }}>empty</div>;
  return (
    <>
      {listing.map((entry) => {
        const isOpen = props.expanded.has(entry.path);
        return (
          <div key={entry.path}>
            <div
              className={`tree-row ${props.activePath === entry.path ? 'selected' : ''}`}
              style={{ paddingLeft: props.depth * 12 }}
              role="treeitem"
              aria-expanded={entry.isDir ? isOpen : undefined}
            >
              <button
                type="button"
                className="tree-main"
                onClick={() => (entry.isDir ? props.onToggleDirectory(entry.path) : props.onOpenFile(entry.path))}
                title={entry.path}
              >
                <span className="tree-chevron">
                  {entry.isDir ? isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}
                </span>
                <span className={`tree-label ${entry.isDir ? 'dir' : ''}`}>{entry.name}</span>
              </button>
              <span className="tree-actions">
                {entry.isDir && (
                  <>
                    <button type="button" className="icon-button" title="New file here" onClick={() => props.onCreateEntry(entry.path, 'file')}>
                      <FilePlus size={12} />
                    </button>
                    <button type="button" className="icon-button" title="New folder here" onClick={() => props.onCreateEntry(entry.path, 'folder')}>
                      <FolderPlus size={12} />
                    </button>
                  </>
                )}
                <button type="button" className="icon-button" title="Rename" onClick={() => props.onRenameEntry(entry.path)}>
                  <Pencil size={12} />
                </button>
                <button type="button" className="icon-button" title="Delete" onClick={() => props.onDeleteEntry(entry.path)}>
                  <Trash2 size={12} />
                </button>
              </span>
            </div>
            {entry.isDir && isOpen && (
              <TreeLevel
                dir={entry.path}
                depth={props.depth + 1}
                entries={props.entries}
                expanded={props.expanded}
                activePath={props.activePath}
                onToggleDirectory={props.onToggleDirectory}
                onOpenFile={props.onOpenFile}
                onRenameEntry={props.onRenameEntry}
                onDeleteEntry={props.onDeleteEntry}
                onCreateEntry={props.onCreateEntry}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

function SearchPanel({ onOpenSearchHit }: { onOpenSearchHit: (path: string, line: number, column: number) => void }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (): Promise<void> => {
    if (query.trim().length < 2) return;
    setBusy(true);
    setError(null);
    try {
      setHits(await ter.fs.search(query));
    } catch (caught) {
      setError(formatError(caught));
      setHits([]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel-content">
      <div className="panel-header">
        <span className="panel-title">Search</span>
      </div>
      <div className="search-box">
        <input
          value={query}
          autoFocus
          placeholder="Search in folder"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void run();
          }}
        />
        <button type="button" className="ghost-button" onClick={() => void run()} disabled={busy}>
          {busy ? 'Searching…' : 'Search'}
        </button>
      </div>
      {error && <div className="inline-error">{error}</div>}
      <div className="search-results">
        {hits.map((hit) => (
          <button key={`${hit.path}:${hit.line}:${hit.column}`} type="button" className="search-hit" onClick={() => onOpenSearchHit(hit.path, hit.line, hit.column)}>
            <span className="hit-path">{hit.path.split(/[\\/]/).slice(-2).join('/')}:{hit.line}</span>
            <span className="hit-preview">{hit.preview}</span>
          </button>
        ))}
        {!busy && hits.length === 0 && query.length >= 2 && !error && <p className="muted pad">No matches.</p>}
      </div>
    </div>
  );
}

function ExtensionsPanel({
  extensions,
  onInstall,
  onToggle,
  onUninstall,
}: {
  extensions: ExtensionInfo[];
  onInstall: (id: string) => Promise<void>;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
  onUninstall: (id: string) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ExtensionSearchResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async (): Promise<void> => {
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setResults(await ter.extensions.search(query));
    } catch (caught) {
      setError(formatError(caught));
      setResults([]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel-content">
      <div className="panel-header">
        <span className="panel-title">Extensions</span>
        <span className="badge">{extensions.filter((extension) => extension.enabled).length} active</span>
      </div>
      <div className="search-box">
        <input
          value={query}
          placeholder="Search Open VSX"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void search();
          }}
        />
        <button type="button" className="ghost-button" onClick={() => void search()} disabled={busy}>
          {busy ? '…' : 'Search'}
        </button>
      </div>
      {error && <div className="inline-error">{error}</div>}

      {results.length > 0 && (
        <div className="ext-results">
          <div className="subsection-title">Open VSX results</div>
          {results.map((result) => (
            <div key={result.id} className="ext-card">
              <div className="ext-card-head">
                <Package size={14} />
                <div className="ext-card-title">
                  <strong>{result.displayName}</strong>
                  <span className="muted">
                    {result.publisher} · v{result.version} · {result.downloads.toLocaleString()} installs
                  </span>
                </div>
                <button
                  type="button"
                  className="ghost-button compact"
                  onClick={async () => {
                    await onInstall(result.id);
                  }}
                >
                  <Download size={13} /> Install
                </button>
              </div>
              <p className="ext-desc">{result.description}</p>
            </div>
          ))}
        </div>
      )}

      <div className="subsection-title">Installed</div>
      {extensions.length === 0 && <p className="muted pad">No extensions installed yet. Language packs, themes and command extensions install from Open VSX.</p>}
      {extensions.map((extension) => (
        <div key={extension.id} className={`ext-card ${extension.enabled ? '' : 'disabled'}`}>
          <div className="ext-card-head">
            <Package size={14} />
            <div className="ext-card-title">
              <strong>{extension.displayName}</strong>
              <span className="muted">
                {extension.publisher} · v{extension.version}
              </span>
            </div>
            <div className="ext-card-actions">
              <button
                type="button"
                className={`icon-button ${extension.enabled ? 'active' : ''}`}
                title={extension.enabled ? 'Disable' : 'Enable'}
                onClick={() => void onToggle(extension.id, !extension.enabled)}
              >
                <Power size={13} />
              </button>
              <button type="button" className="icon-button" title="Uninstall" onClick={() => void onUninstall(extension.id)}>
                <Trash2 size={13} />
              </button>
            </div>
          </div>
          <p className="ext-desc">{extension.description}</p>
          {extension.extends.languages.length > 0 && (
            <p className="ext-meta">Languages: {extension.extends.languages.map((language) => language.id).join(', ')}</p>
          )}
          {extension.extends.themes.length > 0 && <p className="ext-meta">Themes: {extension.extends.themes.length}</p>}
        </div>
      ))}
    </div>
  );
}
