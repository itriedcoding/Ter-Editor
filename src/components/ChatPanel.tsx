import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Send, Settings2, Sparkles, Square, Trash2 } from 'lucide-react';
import type { AiModel, ChatMessage, Settings } from '../../shared/ipc';
import { buildSystemPrompt, executeTool, requestCompletion } from '../lib/agent';
import { formatError } from '../lib/bridge';

interface ChatPanelProps {
  projectRoot: string | null;
  activeFile: string | null;
  models: AiModel[];
  modelsError: string | null;
  settings: Settings;
  hasKey: boolean;
  onConfigure: () => void;
  onRefreshModels: () => Promise<void>;
  onModelChange: (model: string) => void;
  onFilesChanged: () => Promise<void> | void;
  notify: (message: string) => void;
}

interface ChatItem {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  toolName?: string;
  pending?: boolean;
}

const MAX_HISTORY = 24;

export function ChatPanel(props: ChatPanelProps) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const historyRef = useRef<ChatMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [items, status]);

  useEffect(() => {
    const newChat = () => {
      historyRef.current = [];
      setItems([]);
      setStatus(null);
      inputRef.current?.focus();
    };
    const explain = (event: Event) => {
      const detail = (event as CustomEvent<{ text: string }>).detail;
      const selection = detail?.text?.trim();
      setInput(
        selection
          ? `Explain this code from ${props.activeFile ?? 'the editor'}:\n\n\`\`\`\n${selection}\n\`\`\``
          : `Explain what ${props.activeFile ?? 'this project'} does.`,
      );
      inputRef.current?.focus();
    };
    window.addEventListener('ter:new-chat', newChat);
    window.addEventListener('ter:explain-text', explain);
    return () => {
      window.removeEventListener('ter:new-chat', newChat);
      window.removeEventListener('ter:explain-text', explain);
    };
  }, [props.activeFile]);

  const updateItem = (id: string, updater: (previous: ChatItem) => ChatItem): void => {
    setItems((previous) => previous.map((item) => (item.id === id ? updater(item) : item)));
  };

  const send = async (): Promise<void> => {
    const text = input.trim();
    if (!text || busy) return;
    if (!props.hasKey) {
      props.onConfigure();
      return;
    }
    if (!props.settings.model) {
      props.notify('Choose a model from the gateway first.');
      return;
    }

    setInput('');
    setBusy(true);
    setStatus(null);
    const controller = new AbortController();
    abortRef.current = controller;

    const userItem: ChatItem = { id: crypto.randomUUID(), role: 'user', text };
    setItems((previous) => [...previous, userItem]);

    const history: ChatMessage[] = [...historyRef.current, { role: 'user', content: text }];
    historyRef.current = history;

    const system: ChatMessage = {
      role: 'system',
      content: `${buildSystemPrompt(props.projectRoot, props.activeFile)}\n\nToday is ${new Date().toISOString().slice(0, 10)}.`,
    };

    let step = 0;
    try {
      while (step < 20) {
        step += 1;
        const assistantId = crypto.randomUUID();
        setItems((previous) => [...previous, { id: assistantId, role: 'assistant', text: '', pending: true }]);
        setStatus(step === 1 ? 'Thinking…' : 'Working…');

        const result = await requestCompletion({
          model: props.settings.model,
          messages: [system, ...history.slice(-MAX_HISTORY)],
          temperature: props.settings.aiTemperature,
          signal: controller.signal,
          onText: (chunk) => updateItem(assistantId, (previous) => ({ ...previous, text: previous.text + chunk })),
        });

        if (result.error) {
          updateItem(assistantId, (previous) => ({
            ...previous,
            text: previous.text || `Request failed: ${result.error}`,
            pending: false,
          }));
          setStatus(null);
          break;
        }

        updateItem(assistantId, (previous) => ({ ...previous, pending: false }));
        history.push({
          role: 'assistant',
          content: result.content || null,
          ...(result.toolCalls.length > 0 ? { tool_calls: result.toolCalls } : {}),
        });
        historyRef.current = history;

        if (result.toolCalls.length === 0) {
          setStatus(null);
          break;
        }

        for (const call of result.toolCalls) {
          const toolId = crypto.randomUUID();
          setItems((previous) => [
            ...previous,
            { id: toolId, role: 'tool', text: `Running ${call.function.name}…`, toolName: call.function.name, pending: true },
          ]);
          const output = await executeTool(call);
          updateItem(toolId, (previous) => ({ ...previous, text: output, pending: false }));
          history.push({ role: 'tool', tool_call_id: call.id, content: output });
          historyRef.current = history;
          void props.onFilesChanged();
        }
      }
    } catch (error) {
      props.notify(formatError(error));
    } finally {
      setBusy(false);
      setStatus(null);
      abortRef.current = null;
    }
  };

  const stop = (): void => {
    abortRef.current?.abort();
    setBusy(false);
    setStatus(null);
  };

  return (
    <aside className="chat-panel">
      <div className="chat-header">
        <div className="chat-title">
          <Sparkles size={15} />
          <span>AI Assistant</span>
        </div>
        <div className="chat-actions">
          <button type="button" className="icon-button" title="Refresh models" onClick={() => void props.onRefreshModels()}>
            <RefreshCw size={13} />
          </button>
          <button type="button" className="icon-button" title="New chat" onClick={() => window.dispatchEvent(new CustomEvent('ter:new-chat'))}>
            <Trash2 size={13} />
          </button>
          <button type="button" className="icon-button" title="Settings" onClick={props.onConfigure}>
            <Settings2 size={13} />
          </button>
        </div>
      </div>

      <div className="chat-model">
        <label htmlFor="model-select">Model</label>
        <select
          id="model-select"
          value={props.settings.model}
          onChange={(event) => props.onModelChange(event.target.value)}
        >
          <option value="">Select a model…</option>
          {props.models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name} · {model.provider}
            </option>
          ))}
          {props.settings.model && !props.models.some((model) => model.id === props.settings.model) && (
            <option value={props.settings.model}>{props.settings.model}</option>
          )}
        </select>
      </div>
      {props.modelsError && (
        <div className="chat-warning">
          {props.modelsError}
          <button type="button" className="link-button" onClick={props.onConfigure}>
            Open settings
          </button>
        </div>
      )}

      <div className="chat-messages" ref={scrollRef}>
        {items.length === 0 && (
          <div className="chat-empty">
            <p className="chat-empty-title">Build with the agent</p>
            <p className="muted">
              Ask for a feature and the assistant writes the files in your open project. It can read, create, move and search files.
            </p>
            <div className="chat-suggestions">
              {[
                'Scaffold a React + Vite app with a landing page',
                'Add a Rust CLI that parses a CSV file',
                'Explain the file I have open',
                'Write tests for the current module',
              ].map((suggestion) => (
                <button key={suggestion} type="button" className="suggestion" onClick={() => setInput(suggestion)}>
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}
        {items.map((item) => (
          <div key={item.id} className={`chat-item ${item.role}`}>
            {item.role === 'tool' ? (
              <details className={`tool-card ${item.pending ? 'pending' : ''}`}>
                <summary>
                  <span className="tool-dot" />
                  <span className="tool-name">{item.toolName}</span>
                  <span className="tool-state">{item.pending ? 'running' : 'done'}</span>
                </summary>
                <pre className="tool-output">{item.text}</pre>
              </details>
            ) : (
              <div className={`bubble ${item.role} ${item.pending ? 'pending' : ''}`}>{item.text || (item.pending ? '…' : '')}</div>
            )}
          </div>
        ))}
        {status && (
          <div className="chat-status">
            <span className="spinner" />
            {status}
          </div>
        )}
      </div>

      {!props.hasKey && (
        <div className="chat-key-hint">
          <p>Connect the AI Gateway to start.</p>
          <button type="button" className="primary-button" onClick={props.onConfigure}>
            Add gateway token
          </button>
        </div>
      )}

      <div className="chat-composer">
        <textarea
          ref={inputRef}
          value={input}
          placeholder={props.hasKey ? 'Describe what to build or change…' : 'Add a gateway token in settings to chat'}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          rows={3}
        />
        <div className="composer-actions">
          <span className="composer-hint">Enter to send · Shift+Enter for a new line</span>
          {busy ? (
            <button type="button" className="stop-button" onClick={stop}>
              <Square size={12} /> Stop
            </button>
          ) : (
            <button type="button" className="primary-button" onClick={() => void send()} disabled={!input.trim()}>
              <Send size={13} /> Send
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
