import { AlertCircle, AlertTriangle, Blocks, Cpu, Palette } from 'lucide-react';
import type { StatusItem } from '../../shared/ipc';

interface StatusBarProps {
  projectName: string | null;
  language: string | null;
  cursor: { line: number; column: number };
  errors: number;
  warnings: number;
  model: string;
  extensionCount: number;
  statusItems: StatusItem[];
  themeLabel: string;
  onCommand: (id: string) => void;
  onOpenProblems: () => void;
  onOpenSettings: () => void;
}

export function StatusBar(props: StatusBarProps) {
  const leftItems = props.statusItems.filter((item) => item.alignment === 'left').sort((a, b) => a.priority - b.priority);
  const rightItems = props.statusItems.filter((item) => item.alignment === 'right').sort((a, b) => b.priority - a.priority);

  return (
    <footer className="statusbar">
      <div className="status-left">
        <button type="button" className="status-button" onClick={() => props.onCommand('file.open-folder')} title="Open folder">
          {props.projectName ?? 'No folder'}
        </button>
        <button type="button" className="status-button" onClick={props.onOpenProblems} title="Show problems">
          <AlertCircle size={12} className={props.errors > 0 ? 'sev-error' : ''} />
          {props.errors}
          <AlertTriangle size={12} className={props.warnings > 0 ? 'sev-warning' : ''} />
          {props.warnings}
        </button>
        {leftItems.map((item) => (
          <button
            key={item.id}
            type="button"
            className="status-button"
            title={item.tooltip}
            onClick={() => item.command && props.onCommand(item.command)}
          >
            {item.text}
          </button>
        ))}
      </div>
      <div className="status-right">
        {rightItems.map((item) => (
          <button
            key={item.id}
            type="button"
            className="status-button"
            title={item.tooltip}
            onClick={() => item.command && props.onCommand(item.command)}
          >
            {item.text}
          </button>
        ))}
        <button type="button" className="status-button" onClick={props.onOpenSettings} title="Choose model">
          <Cpu size={12} />
          {props.model || 'No model'}
        </button>
        <button type="button" className="status-button" onClick={props.onOpenSettings} title="Extensions">
          <Blocks size={12} />
          {props.extensionCount}
        </button>
        <button type="button" className="status-button" onClick={props.onOpenSettings} title="Theme">
          <Palette size={12} />
          {props.themeLabel}
        </button>
        {props.language && <span className="status-text">{props.language}</span>}
        <span className="status-text">
          Ln {props.cursor.line}, Col {props.cursor.column}
        </span>
      </div>
    </footer>
  );
}
