import { net } from 'electron';
import type { AiEvent, AiModel, ChatRequest, ToolCall } from '../../shared/ipc';
import type { SettingsService } from './settings';

const MODEL_CACHE_TTL = 10 * 60 * 1000;

/** The integrations.vly.ai gateway exposes the completion route at <base>/llm. */
const CHAT_PATH = '/llm';
const MODEL_PATHS = ['/llm/models', '/models'];

interface RawModel {
  id?: string;
  name?: string;
  owned_by?: string;
  provider?: string;
  context_window?: number;
  context_length?: number;
  max_tokens?: number;
  pricing?: { input?: number; output?: number } | string;
  type?: string;
  tags?: string[];
}

interface RawChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    message?: { content?: string | null; tool_calls?: RawChunk['choices'] extends Array<infer C> ? (C extends { delta?: unknown } ? ToolCall[] : never) : never };
    text?: string;
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string } | string;
}

export class AiService {
  private settings: SettingsService;
  private controllers = new Map<string, AbortController>();
  private modelCache: { at: number; models: AiModel[] } | null = null;

  constructor(settings: SettingsService) {
    this.settings = settings;
  }

  private baseUrl(): string {
    return this.settings.get().baseUrl.replace(/\/+$/, '');
  }

  async listModels(force = false): Promise<{ models: AiModel[]; error?: string }> {
    if (!force && this.modelCache && Date.now() - this.modelCache.at < MODEL_CACHE_TTL) {
      return { models: this.modelCache.models };
    }
    const key = this.settings.getKey();
    let lastError = '';
    for (const modelPath of MODEL_PATHS) {
      try {
        const response = await net.fetch(`${this.baseUrl()}${modelPath}`, {
          headers: {
            Accept: 'application/json',
            ...(key ? { Authorization: `Bearer ${key}` } : {}),
          },
        });
        const bodyText = await response.text();
        if (!response.ok) {
          lastError = describeHttpError(response.status, bodyText);
          continue;
        }
        const models = parseModels(bodyText);
        if (models.length === 0) {
          lastError = 'The gateway returned no models.';
          continue;
        }
        this.modelCache = { at: Date.now(), models };
        return { models };
      } catch (error) {
        lastError = (error as Error).message;
      }
    }
    return { models: this.modelCache?.models ?? [], error: lastError || 'Could not reach the gateway.' };
  }

  cancel(requestId: string): void {
    this.controllers.get(requestId)?.abort();
    this.controllers.delete(requestId);
  }

  cancelAll(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }

  async streamChat(requestId: string, request: ChatRequest, emit: (event: AiEvent) => void): Promise<void> {
    const key = this.settings.getKey();
    if (!key) {
      emit({
        type: 'error',
        message: 'No gateway token configured. Open Settings (Ctrl+,) and paste a token from integrations.vly.ai.',
      });
      return;
    }

    const controller = new AbortController();
    this.controllers.set(requestId, controller);
    const payload: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (request.tools.length > 0) {
      payload.tools = request.tools;
      payload.tool_choice = 'auto';
    }
    if (typeof request.temperature === 'number') payload.temperature = request.temperature;

    try {
      const response = await net.fetch(`${this.baseUrl()}${CHAT_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream, application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        emit({ type: 'error', message: describeHttpError(response.status, await response.text()) });
        return;
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('application/json') && !contentType.includes('event-stream')) {
        emit(parseWholeCompletion(await response.json()));
        return;
      }
      if (!response.body) {
        emit({ type: 'error', message: 'The gateway returned an empty response body.' });
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let content = '';
      let reasoning = '';
      let finishReason = 'stop';
      let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;
      const toolCalls: ToolCall[] = [];
      let failure: string | null = null;

      const consume = (rawLine: string): void => {
        const line = rawLine.trim();
        if (!line || line.startsWith(':')) return;
        const data = line.startsWith('data:') ? line.slice(5).trim() : line;
        if (!data || data === '[DONE]') return;
        let chunk: RawChunk & { type?: string; delta?: string; text?: string };
        try {
          chunk = JSON.parse(data);
        } catch {
          return;
        }
        if (chunk.error) {
          failure = typeof chunk.error === 'string' ? chunk.error : (chunk.error.message ?? 'The gateway reported an error');
          return;
        }
        const choice = chunk.choices?.[0];
        const textDelta = choice?.delta?.content ?? choice?.text ?? chunk.delta ?? chunk.text ?? '';
        if (textDelta) {
          content += textDelta;
          emit({ type: 'text', text: textDelta });
        }
        const reasoningDelta = choice?.delta?.reasoning ?? choice?.delta?.reasoning_content;
        if (reasoningDelta) {
          reasoning += reasoningDelta;
          emit({ type: 'reasoning', text: reasoningDelta });
        }
        const streamedCalls = choice?.delta?.tool_calls ?? choice?.message?.tool_calls;
        for (const toolCall of streamedCalls ?? []) {
          const index = toolCall.index ?? 0;
          if (!toolCalls[index]) {
            toolCalls[index] = {
              id: toolCall.id ?? `call_${index}`,
              type: 'function',
              function: { name: toolCall.function?.name ?? '', arguments: '' },
            };
          }
          if (toolCall.id) toolCalls[index].id = toolCall.id;
          if (toolCall.function?.name) toolCalls[index].function.name = toolCall.function.name;
          if (toolCall.function?.arguments) toolCalls[index].function.arguments += toolCall.function.arguments;
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens ?? 0,
            completionTokens: chunk.usage.completion_tokens ?? 0,
            totalTokens: chunk.usage.total_tokens ?? 0,
          };
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) consume(line);
        if (failure) {
          reader.cancel().catch(() => undefined);
          break;
        }
      }
      if (buffer.trim()) consume(buffer);

      if (failure) {
        emit({ type: 'error', message: failure });
        return;
      }

      emit({
        type: 'done',
        content,
        reasoning,
        toolCalls: toolCalls.filter((call) => call && call.function.name),
        finishReason,
        usage,
      });
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        emit({ type: 'error', message: 'Request cancelled' });
        return;
      }
      emit({ type: 'error', message: (error as Error).message });
    } finally {
      this.controllers.delete(requestId);
    }
  }
}

function parseModels(bodyText: string): AiModel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { data?: unknown }).data)
      ? (parsed as { data: unknown[] }).data
      : Array.isArray((parsed as { models?: unknown }).models)
        ? (parsed as { models: unknown[] }).models
        : [];
  const models: AiModel[] = [];
  for (const entry of list) {
    const raw = entry as RawModel;
    if (typeof raw?.id !== 'string' || raw.id.length === 0) continue;
    const pricing = raw.pricing && typeof raw.pricing === 'object' ? raw.pricing : null;
    models.push({
      id: raw.id,
      name: raw.name ?? raw.id,
      provider: raw.provider ?? raw.owned_by ?? raw.id.split('/')[0] ?? 'gateway',
      contextWindow: raw.context_window ?? raw.context_length ?? raw.max_tokens,
      inputPrice: pricing?.input,
      outputPrice: pricing?.output,
      tags: raw.tags ?? (raw.type ? [raw.type] : []),
    });
  }
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

function parseWholeCompletion(payload: unknown): AiEvent {
  const body = payload as {
    choices?: Array<{
      message?: { content?: string | null; tool_calls?: ToolCall[]; reasoning?: string };
      text?: string;
      finish_reason?: string;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    error?: { message?: string } | string;
    content?: string;
    text?: string;
  };
  if (body?.error) {
    return { type: 'error', message: typeof body.error === 'string' ? body.error : (body.error.message ?? 'Gateway error') };
  }
  const choice = body?.choices?.[0];
  const content = choice?.message?.content ?? choice?.text ?? body?.content ?? body?.text ?? '';
  return {
    type: 'done',
    content,
    reasoning: choice?.message?.reasoning ?? '',
    toolCalls: (choice?.message?.tool_calls ?? []).filter((call) => call?.function?.name),
    finishReason: choice?.finish_reason ?? 'stop',
    usage: body?.usage
      ? {
          promptTokens: body.usage.prompt_tokens ?? 0,
          completionTokens: body.usage.completion_tokens ?? 0,
          totalTokens: body.usage.total_tokens ?? 0,
        }
      : undefined,
  };
}

function describeHttpError(status: number, body: string): string {
  let detail = body.trim();
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string };
    if (typeof parsed.error === 'string') detail = parsed.error;
    else if (parsed.error?.message) detail = parsed.error.message;
  } catch {
    /* keep raw body */
  }
  if (detail.length > 400) detail = `${detail.slice(0, 400)}…`;
  switch (status) {
    case 401:
      return `The gateway rejected the token (401). Verify the token from integrations.vly.ai in Settings. ${detail}`;
    case 403:
      return `The gateway refused access (403). ${detail}`;
    case 404:
      return `Gateway route not found (404). Check the base URL. ${detail}`;
    case 429:
      return `Rate limited by the gateway (429). ${detail}`;
    default:
      return `Gateway error ${status}: ${detail}`;
  }
}
