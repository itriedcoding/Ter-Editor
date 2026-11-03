import { spawn, type IPty } from 'node-pty';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export interface TerminalSession {
  id: string;
  shell: string;
  cwd: string;
}

interface SpawnOptions {
  cwd?: string;
  cols?: number;
  rows?: number;
  shell?: string;
}

/**
 * Real pseudo-terminal sessions. node-pty allocates an OS pty so interactive
 * programs (vim, top, prompts, TUI tools) behave exactly as in a native terminal.
 */
export class TerminalService {
  private sessions = new Map<string, IPty>();

  constructor(
    private readonly send: (channel: string, payload: unknown) => void,
    private readonly fallbackCwd: () => string | null,
  ) {}

  private defaultShell(): string {
    if (process.platform === 'win32') {
      return process.env.COMSPEC || 'powershell.exe';
    }
    return process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  }

  private shellArgs(shell: string): string[] {
    if (process.platform === 'win32' && /pwsh|powershell/i.test(shell)) return ['-NoLogo'];
    return [];
  }

  create(options: SpawnOptions = {}): TerminalSession {
    const shell = options.shell || this.defaultShell();
    const cwd = options.cwd || this.fallbackCwd() || os.homedir();
    const id = randomUUID();

    const session = spawn(shell, this.shellArgs(shell), {
      name: 'xterm-256color',
      cols: Math.max(options.cols ?? 80, 2),
      rows: Math.max(options.rows ?? 24, 1),
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        TERM_PROGRAM: 'TerEditor',
      } as Record<string, string>,
    });

    session.onData((data) => this.send('term:data', { id, data }));
    session.onExit(({ exitCode }) => {
      this.sessions.delete(id);
      this.send('term:exit', { id, code: exitCode });
    });
    this.sessions.set(id, session);

    return { id, shell, cwd: path.resolve(cwd) };
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.sessions.get(id)?.resize(Math.max(2, Math.floor(cols)), Math.max(1, Math.floor(rows)));
    } catch {
      // The process may have exited between the renderer event and this call.
    }
  }

  kill(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    try {
      session.kill();
    } catch {
      /* already gone */
    }
    this.sessions.delete(id);
  }

  disposeAll(): void {
    for (const id of Array.from(this.sessions.keys())) this.kill(id);
  }
}
