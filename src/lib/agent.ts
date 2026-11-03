import type { AiToolDefinition, ChatMessage, ToolCall } from '../../shared/ipc';
import { ter, formatError } from './bridge';

export const AGENT_TOOLS: AiToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description:
        'List files and folders inside a directory. Pass an absolute path inside the open project. Use the project root when unsure.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of the directory to list' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the full UTF-8 text of a file. Use this before editing an existing file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of the file to read' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create or overwrite a file with the given content. Parent folders are created automatically. Always write complete file contents, never diffs.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of the file to write' },
          content: { type: 'string', description: 'Full file content' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_directory',
      description: 'Create a directory (and any missing parents) inside the open project.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of the directory to create' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move_path',
      description: 'Rename or move a file or directory.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Existing absolute path' },
          to: { type: 'string', description: 'New absolute path' },
        },
        required: ['from', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_path',
      description: 'Delete a file or directory inside the open project. Only use when the user asked for removal.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to delete' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search for a literal string across the project files and return matching lines.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Literal text to find' },
        },
        required: ['query'],
      },
    },
  },
];

export function buildSystemPrompt(workspaceRoot: string | null, activeFile: string | null): string {
  return [
    'You are the coding agent inside Ter Editor, a desktop code editor.',
    'You can create, read, edit, move and delete real files through your tools, and the user sees the results immediately in the editor.',
    '',
    workspaceRoot
      ? `The open project root is: ${workspaceRoot}`
      : 'No folder is open. Ask the user to open or create a project before writing files.',
    activeFile ? `The file the user is currently looking at is: ${activeFile}` : '',
    '',
    'Rules:',
    '- Always use absolute paths that start with the project root.',
    '- Inspect before you change: read a file before rewriting it.',
    '- Write complete files with write_file; do not send patches.',
    '- When you build something, create every file it needs so it runs as-is.',
    '- After editing, summarise what changed in two or three short sentences.',
    '- Never claim a command was run: this editor has no integrated terminal, so you cannot execute programs.',
    '- If a request is ambiguous, make a reasonable choice and state it rather than stopping to ask.',
  ]
    .filter(Boolean)
    .join('\n');
}

interface CompletionResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  error?: string;
}

/** Streams one assistant completion and resolves when the stream finishes. */
export function requestCompletion(options: {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  onText?: (text: string) => void;
  onReasoning?: (text: string) => void;
  signal?: AbortSignal;
}): Promise<CompletionResult> {
  const requestId = crypto.randomUUID();
  return new Promise<CompletionResult>((resolve) => {
    let settled = false;
    const finish = (result: CompletionResult): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      options.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const unsubscribe = ter.ai.onEvent((incomingId, event) => {
      if (incomingId !== requestId) return;
      if (event.type === 'text') options.onText?.(event.text);
      else if (event.type === 'reasoning') options.onReasoning?.(event.text);
      else if (event.type === 'done') {
        finish({
          content: event.content,
          reasoning: event.reasoning,
          toolCalls: event.toolCalls,
        });
      } else if (event.type === 'error') {
        finish({ content: '', reasoning: '', toolCalls: [], error: event.message });
      }
    });
    const onAbort = (): void => {
      ter.ai.cancel(requestId);
      finish({ content: '', reasoning: '', toolCalls: [], error: 'Cancelled' });
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    ter.ai
      .start(requestId, {
        model: options.model,
        messages: options.messages,
        tools: AGENT_TOOLS,
        temperature: options.temperature,
      })
      .catch((error: unknown) => finish({ content: '', reasoning: '', toolCalls: [], error: formatError(error) }));
  });
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Executes one tool call against the real filesystem and returns a text result. */
export async function executeTool(call: ToolCall): Promise<string> {
  const args = parseArgs(call.function.arguments);
  const name = call.function.name;
  try {
    switch (name) {
      case 'list_directory': {
        const target = String(args.path ?? '');
        if (!target) return 'Error: path is required';
        const entries = await ter.fs.list(target);
        if (entries.length === 0) return `${target} is empty`;
        return entries
          .map((entry) => `${entry.isDir ? 'dir ' : 'file'}  ${entry.path}${entry.isDir ? '/' : ` (${entry.size} bytes)`}`)
          .join('\n');
      }
      case 'read_file': {
        const target = String(args.path ?? '');
        if (!target) return 'Error: path is required';
        const content = await ter.fs.read(target);
        return content.length > 200_000 ? `${content.slice(0, 200_000)}\n… truncated (${content.length} characters total)` : content;
      }
      case 'write_file': {
        const target = String(args.path ?? '');
        const content = String(args.content ?? '');
        if (!target) return 'Error: path is required';
        await ter.fs.write(target, content);
        return `Wrote ${content.length} characters to ${target}`;
      }
      case 'create_directory': {
        const target = String(args.path ?? '');
        if (!target) return 'Error: path is required';
        await ter.fs.create(target, 'folder');
        return `Created directory ${target}`;
      }
      case 'move_path': {
        const from = String(args.from ?? '');
        const to = String(args.to ?? '');
        if (!from || !to) return 'Error: from and to are required';
        await ter.fs.rename(from, to);
        return `Moved ${from} to ${to}`;
      }
      case 'delete_path': {
        const target = String(args.path ?? '');
        if (!target) return 'Error: path is required';
        await ter.fs.remove(target);
        return `Deleted ${target}`;
      }
      case 'search_files': {
        const query = String(args.query ?? '');
        if (query.length < 2) return 'Error: query needs at least two characters';
        const hits = await ter.fs.search(query);
        if (hits.length === 0) return `No matches for "${query}"`;
        return hits
          .slice(0, 60)
          .map((hit) => `${hit.path}:${hit.line}:${hit.column}  ${hit.preview}`)
          .join('\n');
      }
      default:
        return `Error: unknown tool ${name}`;
    }
  } catch (error) {
    return `Error: ${formatError(error)}`;
  }
}
