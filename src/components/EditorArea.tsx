import { useEffect, useRef } from 'react';
import { AlertCircle, AlertTriangle, ChevronDown, Info, X } from 'lucide-react';
import type { DiagnosticItem, Settings } from '../../shared/ipc';
import type { OpenFileState } from '../App';
import { monaco } from '../lib/monaco';

interface EditorAreaProps {
  openFiles: OpenFileState[];
  activePath: string | null;
  activeModel: monaco.editor.ITextModel | null;
  settings: Settings;
  problems: DiagnosticItem[];
  allProblems: Record<string, DiagnosticItem[]>;
  bottom: 'problems' | 'output' | null;
  setBottom: (value: 'problems' | 'output' | null) => void;
  output: Record<string, string>;
  outputChannel: string;
  setOutputChannel: (channel: string) => void;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
  onSave: () => void;
  onCursorChange: (line: number, column: number) => void;
  onOpenFileAt: (path: string, line: number, column: number) => void;
  hasTextMate: boolean;
  onOpenPalette: () => void;
}

export function EditorArea(props: EditorAreaProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const onSaveRef = useRef(props.onSave);
  const onPaletteRef = useRef(props.onOpenPalette);

  onSaveRef.current = props.onSave;
  onPaletteRef.current = props.onOpenPalette;

  useEffect(() => {
    if (!containerRef.current) return;
    const editor = monaco.editor.create(containerRef.current, {
      model: null,
      theme: 'ter-dark',
      automaticLayout: true,
      fontFamily: "'JetBrains Mono', 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace",
      fontSize: 14,
      lineHeight: 22,
      fontLigatures: true,
      minimap: { enabled: true, renderCharacters: false, maxColumn: 90 },
      scrollbar: { verticalScrollbarSize: 11, horizontalScrollbarSize: 11, useShadows: false },
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      renderLineHighlight: 'all',
      padding: { top: 12, bottom: 24 },
      tabSize: 2,
      wordWrap: 'off',
      lineNumbersMinChars: 4,
      glyphMargin: false,
      folding: true,
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true, indentation: true },
      suggest: { preview: true },
      scrollBeyondLastLine: true,
    });
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSaveRef.current());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, () => onPaletteRef.current());
    const cursorSubscription = editor.onDidChangeCursorPosition((event) => {
      props.onCursorChange(event.position.lineNumber, event.position.column);
    });
    return () => {
      cursorSubscription.dispose();
      editor.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.setModel(props.activeModel);
    if (props.activeModel) {
      const position = editor.getPosition();
      if (!position) editor.setPosition({ lineNumber: 1, column: 1 });
    }
  }, [props.activeModel]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.updateOptions({
      fontSize: props.settings.fontSize,
      lineHeight: Math.round(props.settings.fontSize * 1.6),
      fontFamily: props.settings.fontFamily,
      tabSize: props.settings.tabSize,
      wordWrap: props.settings.wordWrap ? 'on' : 'off',
      minimap: { enabled: props.settings.minimap, renderCharacters: false, maxColumn: 90 },
      lineNumbers: props.settings.lineNumbers ? 'on' : 'off',
    });
  }, [props.settings]);

  useEffect(() => {
    const model = props.activeModel;
    if (!model) return;
    monaco.editor.setModelMarkers(
      model,
      'extensions',
      props.problems.map((problem) => ({
        startLineNumber: problem.startLine,
        startColumn: problem.startColumn,
        endLineNumber: problem.endLine,
        endColumn: Math.max(problem.endColumn, problem.startColumn + 1),
        message: problem.source ? `${problem.message} (${problem.source})` : problem.message,
        severity:
          problem.severity === 'error'
            ? monaco.MarkerSeverity.Error
            : problem.severity === 'warning'
              ? monaco.MarkerSeverity.Warning
              : problem.severity === 'info'
                ? monaco.MarkerSeverity.Info
                : monaco.MarkerSeverity.Hint,
      })),
    );
  }, [props.problems, props.activeModel]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ path: string; line: number; column: number }>).detail;
      const editor = editorRef.current;
      if (!editor || detail.path !== props.activePath) return;
      const position = { lineNumber: Math.max(1, detail.line), column: Math.max(1, detail.column) };
      editor.setPosition(position);
      editor.revealPositionInCenter(position);
      editor.focus();
    };
    const explainHandler = () => {
      const editor = editorRef.current;
      if (!editor) return;
      const model = editor.getModel();
      const selection = editor.getSelection();
      const text = model && selection ? model.getValueInRange(selection) : '';
      window.dispatchEvent(new CustomEvent('ter:explain-text', { detail: { text } }));
    };
    window.addEventListener('ter:reveal', handler);
    window.addEventListener('ter:explain-selection', explainHandler);
    return () => {
      window.removeEventListener('ter:reveal', handler);
      window.removeEventListener('ter:explain-selection', explainHandler);
    };
  }, [props.activePath]);

  const problemEntries = Object.entries(props.allProblems).flatMap(([uri, items]) =>
    items.map((item) => ({ uri, item })),
  );
  const channels = Object.keys(props.output);
  const activeChannel = channels.includes(props.outputChannel) ? props.outputChannel : (channels[0] ?? 'Extension Host');

  return (
    <main className="editor-area">
      <div className="tabs">
        {props.openFiles.length === 0 && <div className="tab-empty">No file open</div>}
        {props.openFiles.map((file) => (
          <div
            key={file.path}
            className={`tab ${props.activePath === file.path ? 'active' : ''}`}
            role="tab"
            aria-selected={props.activePath === file.path}
          >
            <button type="button" className="tab-label" onClick={() => props.onActivate(file.path)} title={file.path}>
              {file.path.split(/[\\/]/).pop()}
              {file.dirty && <span className="dirty-dot" />}
            </button>
            <button
              type="button"
              className="tab-close"
              onClick={(event) => {
                event.stopPropagation();
                props.onClose(file.path);
              }}
              title="Close"
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>

      <div className="editor-surface">
        <div ref={containerRef} className="monaco-host" />
        {!props.activeModel && (
          <div className="editor-empty">
            <div className="editor-empty-title">Ter Editor</div>
            <p>Open a folder to browse files, or ask the AI assistant to build something.</p>
            <div className="shortcut-grid">
              <span>Command palette</span><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>P</kbd>
              <span>Quick open</span><kbd>Ctrl</kbd><kbd>P</kbd>
              <span>Save</span><kbd>Ctrl</kbd><kbd>S</kbd>
              <span>AI chat</span><kbd>Ctrl</kbd><kbd>J</kbd>
            </div>
          </div>
        )}
      </div>

      <div className={`bottom-drawer ${props.bottom ? 'open' : ''}`}>
        <div className="drawer-tabs">
          <button type="button" className={`drawer-tab ${props.bottom === 'problems' ? 'active' : ''}`} onClick={() => props.setBottom(props.bottom === 'problems' ? null : 'problems')}>
            Problems <span className="count">{problemEntries.length}</span>
          </button>
          <button type="button" className={`drawer-tab ${props.bottom === 'output' ? 'active' : ''}`} onClick={() => props.setBottom(props.bottom === 'output' ? null : 'output')}>
            Output
          </button>
          {channels.length > 0 && props.bottom === 'output' && (
            <div className="channel-picker">
              <select value={activeChannel} onChange={(event) => props.setOutputChannel(event.target.value)}>
                {channels.map((channel) => (
                  <option key={channel} value={channel}>
                    {channel}
                  </option>
                ))}
              </select>
              <ChevronDown size={12} />
            </div>
          )}
          <button type="button" className="icon-button drawer-close" title="Close panel" onClick={() => props.setBottom(null)}>
            <X size={13} />
          </button>
        </div>
        {props.bottom === 'problems' && (
          <div className="drawer-body">
            {problemEntries.length === 0 && <p className="muted pad">No problems detected. Extension diagnostics appear here.</p>}
            {problemEntries.map(({ uri, item }, index) => {
              const fsPath = decodeURIComponent(uri.replace('file:///', ''));
              const path = /^[A-Za-z]:/.test(fsPath) ? fsPath.replace(/\//g, '\\') : `/${fsPath}`;
              return (
                <button key={`${uri}-${index}`} type="button" className="problem-row" onClick={() => props.onOpenFileAt(path, item.startLine, item.startColumn)}>
                  {item.severity === 'error' ? <AlertCircle size={13} className="sev-error" /> : item.severity === 'warning' ? <AlertTriangle size={13} className="sev-warning" /> : <Info size={13} className="sev-info" />}
                  <span className="problem-message">{item.message}</span>
                  <span className="problem-location">
                    {path.split(/[\\/]/).pop()}:{item.startLine}:{item.startColumn}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {props.bottom === 'output' && (
          <div className="drawer-body">
            <pre className="output-pre">{props.output[activeChannel] || 'No output yet.'}</pre>
          </div>
        )}
      </div>
      {props.hasTextMate && <div className="language-note">TextMate grammar active</div>}
    </main>
  );
}
