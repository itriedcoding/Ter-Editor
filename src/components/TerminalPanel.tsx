import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { RotateCw, Trash2 } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import { ter } from '../lib/bridge';

interface TerminalPanelProps {
  cwd: string | null;
}

export function TerminalPanel({ cwd }: TerminalPanelProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<string | null>(null);
  const [shell, setShell] = useState('');
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 12.5,
      fontFamily: "'JetBrains Mono', 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace",
      lineHeight: 1.25,
      scrollback: 8000,
      allowProposedApi: true,
      theme: {
        background: '#0b0e14',
        foreground: '#d6deeb',
        cursor: '#6ea8fe',
        selectionBackground: '#264468',
        black: '#0b0e14',
        red: '#ff6b6b',
        green: '#6fcf97',
        yellow: '#f2c94c',
        blue: '#6ea8fe',
        magenta: '#c792ea',
        cyan: '#89ddff',
        white: '#d6deeb',
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;
    fitRef.current = fit;

    try {
      fit.fit();
    } catch {
      /* the host may not be laid out yet */
    }

    let disposed = false;
    let unlistenData: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;

    void (async () => {
      try {
        const session = await ter.terminal.create({
          cwd: cwd ?? undefined,
          cols: terminal.cols,
          rows: terminal.rows,
        });
        if (disposed) {
          ter.terminal.kill(session.id);
          return;
        }
        sessionRef.current = session.id;
        setShell(session.shell);
        unlistenData = ter.terminal.onData((id, data) => {
          if (id === session.id) terminal.write(data);
        });
        unlistenExit = ter.terminal.onExit((id, code) => {
          if (id !== session.id) return;
          terminal.write(`\r\n\x1b[90m[process exited with code ${code}]\x1b[0m\r\n`);
          sessionRef.current = null;
        });
        terminal.onData((data) => ter.terminal.write(session.id, data));
        terminal.onResize(({ cols, rows }) => ter.terminal.resize(session.id, cols, rows));
        terminal.focus();
      } catch (error) {
        terminal.write(`\r\n\x1b[31mCould not start a terminal: ${(error as Error).message}\x1b[0m\r\n`);
      }
    })();

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* ignore during teardown */
      }
    });
    observer.observe(host);

    return () => {
      disposed = true;
      observer.disconnect();
      unlistenData?.();
      unlistenExit?.();
      if (sessionRef.current) ter.terminal.kill(sessionRef.current);
      sessionRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [cwd, generation]);

  return (
    <div className="terminal-panel">
      <div className="terminal-toolbar">
        <span className="terminal-shell">{shell || 'terminal'}</span>
        <div className="terminal-actions">
          <button type="button" className="icon-button" title="Restart session" onClick={() => setGeneration((value) => value + 1)}>
            <RotateCw size={12} />
          </button>
          <button type="button" className="icon-button" title="Clear" onClick={() => terminalRef.current?.clear()}>
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      <div className="terminal-host" ref={hostRef} />
    </div>
  );
}
