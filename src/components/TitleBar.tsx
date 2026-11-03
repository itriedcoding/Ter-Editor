import { FolderOpen, MessageSquare, Minus, Search, Settings, Square, X } from 'lucide-react';
import { ter } from '../lib/bridge';

interface TitleBarProps {
  projectName: string | null;
  chatOpen: boolean;
  platform: string;
  onOpenFolder: () => void;
  onNewProject: () => void;
  onOpenSettings: () => void;
  onToggleChat: () => void;
  onOpenPalette: () => void;
}

export function TitleBar({ projectName, chatOpen, platform, onOpenFolder, onNewProject, onOpenSettings, onToggleChat, onOpenPalette }: TitleBarProps) {
  const showControls = platform !== 'darwin';
  return (
    <header className={`titlebar ${platform === 'darwin' ? 'titlebar-mac' : ''}`}>
      <div className="titlebar-left">
        <span className="brand">Ter</span>
        <span className="titlebar-divider" />
        <button type="button" className="ghost-button" onClick={onOpenFolder} title="Open folder (Ctrl+K Ctrl+O)">
          <FolderOpen size={14} /> Open Folder
        </button>
        <button type="button" className="ghost-button" onClick={onNewProject} title="Create a new project">
          New Project
        </button>
      </div>
      <div className="titlebar-center">
        <button type="button" className="titlebar-search" onClick={onOpenPalette} title="Search files and commands (Ctrl+P)">
          <Search size={13} />
          <span className="titlebar-search-label">{projectName ?? 'No folder open'}</span>
          <kbd>{platform === 'darwin' ? '⌘P' : 'Ctrl P'}</kbd>
        </button>
      </div>
      <div className="titlebar-right">
        <button
          type="button"
          className={`icon-button ${chatOpen ? 'active' : ''}`}
          onClick={onToggleChat}
          title="Toggle AI chat (Ctrl+J)"
        >
          <MessageSquare size={15} />
        </button>
        <button type="button" className="icon-button" onClick={onOpenSettings} title="Settings (Ctrl+,)">
          <Settings size={15} />
        </button>
        {showControls && (
          <div className="window-controls">
            <button type="button" className="window-button" onClick={() => ter.app.windowControl('minimize')} title="Minimize">
              <Minus size={14} />
            </button>
            <button type="button" className="window-button" onClick={() => ter.app.windowControl('maximize')} title="Maximize">
              <Square size={12} />
            </button>
            <button type="button" className="window-button window-close" onClick={() => ter.app.windowControl('close')} title="Close">
              <X size={14} />
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
