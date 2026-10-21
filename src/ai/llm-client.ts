/**
 * LLM API 客户端
 * 基于 fetch 实现 OpenAI Responses API，支持流式响应和工具调用
 * 不引入 SDK，保持轻量
 */

import { AI_CONFIG } from '../config';
import { readMigratedStorage } from '../lib/legacy-storage';
import type {
  InputItem,
  OutputItem,
  ToolSchema,
  StreamChunk,
  AISettings,
  ToolChoice,
  ContentPart,
  InputTextContent,
} from './types';
import { DEFAULT_LLM_IDLE_TIMEOUT_MS, DEFAULT_LLM_TOTAL_TIMEOUT_MS, createDeadlineSignal } from './deadline';

export const STORAGE_KEY_AI_SETTINGS = 'actspan_ai_settings';
export const LEGACY_STORAGE_KEY_AI_SETTINGS = 'mole_ai_settings';

/** 默认配置，与 OMP anyrouter 的 openai-responses provider 对齐 */
const DEFAULT_SETTINGS: AISettings = {
  apiKey: '',
  endpoint: AI_CONFIG.DEFAULT_ENDPOINT,
  model: AI_CONFIG.DEFAULT_MODEL,
  strictResultMode: true,
  apiMode: 'responses' as const,
};


/**
 * 模型并行工具能力表（对齐 Codex models.json）
 * 未命中时按 Codex fallback 语义默认 false。
 */
const MODEL_PARALLEL_TOOL_CALL_SUPPORT: Record<string, boolean> = {
  'gpt-5.4': true,
  'gpt-5.3-codex': true,
  'gpt-5.2-codex': true,
  'gpt-5.1-codex-max': false,
  'gpt-5.1-codex': false,
  'gpt-5.2': true,
  'gpt-5.1': true,
  'gpt-5-codex': false,
  'gpt-5': false,
  'gpt-oss-120b': false,
  'gpt-oss-20b': false,
  'gpt-5.1-codex-mini': false,
  'gpt-5-codex-mini': false,
};

const resolveParallelToolCalls = (settings: AISettings): boolean => {
  if (typeof settings.supportsParallelToolCalls === 'boolean') {
    return settings.supportsParallelToolCalls;
  }
  const modelSlug = String(settings.model || '').trim().toLowerCase();
  if (!modelSlug) return false;
  return MODEL_PARALLEL_TOOL_CALL_SUPPORT[modelSlug] === true;
};

/** chat/completions 多模态内容片段 */
type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/** Chat Completions 消息形状（仅本文件内部使用） */
type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | ChatContentPart[] | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
};

/**
 * Responses 形状内容 → chat/completions content
 * 纯文本（含无图片的片段数组）保持 string，减少无谓差异；含 input_image 时转多模态数组。
 */
const toChatContent = (content: string | ContentPart[]): string | ChatContentPart[] => {
  if (typeof content === 'string') return content;
  if (!content.some((part) => part.type === 'input_image')) {
    return content
      .filter((part): part is InputTextContent => part.type === 'input_text')
      .map((part) => part.text)
      .join('\n');
  }
  return content.map((part) => (
    part.type === 'input_image'
      ? { type: 'image_url' as const, image_url: { url: part.image_url } }
      : { type: 'text' as const, text: part.text }
  ));
};

/** 把 Responses 形状的输入项转换为 chat/completions 的 messages */
const toChatMessages = (input: InputItem[]): ChatMessage[] => {
  const messages: ChatMessage[] = [];
  for (const item of input) {
    if (!('type' in item)) {
      messages.push({
        role: item.role === 'developer' ? 'system' : item.role,
        content: toChatContent(item.content),
      });
    } else if (item.type === 'function_call') {
      let last = messages[messages.length - 1];
      if (!last || last.role !== 'assistant' || (last.content != null && last.content !== '')) {
        last = { role: 'assistant', content: null, tool_calls: [] };
        messages.push(last);
      }
      last.tool_calls = last.tool_calls || [];
      last.tool_calls.push({
        id: item.call_id || item.id,
        type: 'function',
        function: { name: item.name, arguments: item.arguments },
      });
    } else if (item.type === 'function_call_output') {
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: item.output });
    }
  }
  return messages;
};

/** Responses 工具 schema → chat/completions 工具 schema */
const toChatTools = (tools: ToolSchema[]) =>
  tools.map((tool) => ({
    type: 'function' as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));

/** Responses tool_choice → chat/completions tool_choice */
const toChatToolChoice = (toolChoice: ToolChoice) =>
  typeof toolChoice === 'string' ? toolChoice : { type: 'function' as const, function: { name: toolChoice.name } };

/** 读取 AI 配置（apiKey 从存储中读取，用户自行配置） */
export const getAISettings = async (): Promise<AISettings> => {
  let saved: Record<string, unknown> | undefined;
  try {
    saved = await readMigratedStorage<Record<string, unknown>>(
      chrome.storage.local,
      STORAGE_KEY_AI_SETTINGS,
      LEGACY_STORAGE_KEY_AI_SETTINGS,
    );
  } catch {
    saved = undefined;
  }

  return { ...DEFAULT_SETTINGS, ...saved };
};

/** 保存 AI 配置 */
export const saveAISettings = async (settings: Partial<AISettings>): Promise<void> => {
  const current = await getAISettings();
  const updated = { ...current, ...settings };
  await chrome.storage.local.set({ [STORAGE_KEY_AI_SETTINGS]: updated });
};

/**
 * 非流式调用 OpenAI Responses API（用于工具调用循环中拿完整响应）
 * @param input 输入项列表
 * @param tools 可用工具列表
 * @param instructions 系统提示词
 * @param signal 可选的 AbortSignal，用于取消请求
 * @param toolChoice 工具选择策略（'required' 可强制模型必须调用工具）
 */
export const chatComplete = async (
  input: InputItem[],
  tools?: ToolSchema[],
  instructions?: string,
  signal?: AbortSignal,
  toolChoice?: ToolChoice,
): Promise<{ output: OutputItem[]; status: string }> => {
  const settings = await getAISettings();

  if (!settings.apiKey) {
    throw new Error('未配置 API Key，请在设置中填写后重试。');
  }

  // 将 instructions 同时作为 developer 消息注入 input 开头
  // 部分模型/API 代理可能忽略 instructions 字段，developer 消息是更可靠的补充
  const effectiveInput = instructions
    ? [{ role: 'developer' as const, content: instructions }, ...input]
    : input;

  const isChatCompletions = settings.apiMode === 'chat_completions';
  const body: Record<string, any> = isChatCompletions
    ? {
        model: settings.model,
        messages: toChatMessages(effectiveInput),
        max_tokens: 16384,
      }
    : {
        model: settings.model,
        input: effectiveInput,
        max_output_tokens: 16384,
      };
  if (!isChatCompletions && instructions) {
    body.instructions = instructions;
  }
  if (tools && tools.length > 0) {
    if (isChatCompletions) {
      body.tools = toChatTools(tools);
      // tool_choice 仅在有 tools 时生效
      if (toolChoice) {
        body.tool_choice = toChatToolChoice(toolChoice);
      }
    } else {
      body.tools = tools;
      body.parallel_tool_calls = resolveParallelToolCalls(settings);
      // tool_choice 仅在有 tools 时生效
      if (toolChoice) {
        body.tool_choice = toolChoice;
      }
    }
  }

  const deadline = createDeadlineSignal(signal, DEFAULT_LLM_TOTAL_TIMEOUT_MS, 'LLM request exceeded its total deadline');
  try {
    const res = await fetch(settings.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.apiKey}`,
        'User-Agent': 'claude-code/1.0.0',
      },
      body: JSON.stringify(body),
      signal: deadline.signal,
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new Error('API Key 无效或已过期，请检查配置。');
      }
      const text = await res.text();
      throw new Error(`LLM API 错误 (${res.status}): ${text}`);
    }

    const json = await res.json();
    if (isChatCompletions) {
      if (!Array.isArray(json.choices)) throw new Error('LLM 返回格式异常：无 choices');
      const chatMessage = json.choices[0]?.message;
      const output: OutputItem[] = [];
      if (typeof chatMessage?.content === 'string' && chatMessage.content) {
        output.push({
          type: 'message',
          id: json.id || 'msg',
          role: 'assistant',
          content: [{ type: 'output_text', text: chatMessage.content }],
        });
      }
      const toolCalls = Array.isArray(chatMessage?.tool_calls) ? chatMessage.tool_calls : [];
      for (const toolCall of toolCalls) {
        const callId = toolCall?.id || `call_${output.length}`;
        output.push({
          type: 'function_call',
          id: callId,
          call_id: callId,
          name: toolCall?.function?.name || '',
          arguments: toolCall?.function?.arguments || '{}',
        });
      }
      return { output, status: 'completed' };
    }
    if (!json.output) throw new Error('LLM 返回格式异常：无 output');

    return {
      output: json.output as OutputItem[],
      status: json.status || 'completed',
    };
  } catch (error) {
    if (deadline.didTimeout()) throw deadline.timeoutError;
    throw error;
  } finally {
    deadline.cleanup();
  }
};

/**
 * 流式调用 OpenAI Responses API（用于最终文本回复的流式输出）
 * @param input 输入项列表
 * @param tools 可用工具列表
 * @param instructions 系统提示词
 * @param signal 可选的 AbortSignal，用于取消请求
 * @param toolChoice 工具选择策略（'required' 可强制模型必须调用工具）
 */
export async function* chatStream(
  input: InputItem[],
  tools?: ToolSchema[],
  instructions?: string,
  signal?: AbortSignal,
  toolChoice?: ToolChoice,
): AsyncGenerator<StreamChunk> {
  const settings = await getAISettings();

  if (!settings.apiKey) {
    throw new Error('未配置 API Key，请在设置中填写后重试。');
  }

  // 将 instructions 同时作为 developer 消息注入 input 开头（与 chatComplete 对齐）
  const effectiveInput = instructions
    ? [{ role: 'developer' as const, content: instructions }, ...input]
    : input;

  const isChatCompletions = settings.apiMode === 'chat_completions';
  const body: Record<string, any> = isChatCompletions
    ? {
        model: settings.model,
        messages: toChatMessages(effectiveInput),
        max_tokens: 16384,
        stream: true,
      }
    : {
        model: settings.model,
        input: effectiveInput,
        max_output_tokens: 16384,
        stream: true,
      };
  if (!isChatCompletions && instructions) {
    body.instructions = instructions;
  }
  if (tools && tools.length > 0) {
    if (isChatCompletions) {
      body.tools = toChatTools(tools);
      if (toolChoice) {
        body.tool_choice = toChatToolChoice(toolChoice);
      }
    } else {
      body.tools = tools;
      body.parallel_tool_calls = resolveParallelToolCalls(settings);
      if (toolChoice) {
        body.tool_choice = toolChoice;
      }
    }
  }

  const deadline = createDeadlineSignal(signal, DEFAULT_LLM_TOTAL_TIMEOUT_MS, 'LLM stream exceeded its total deadline');
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const res = await fetch(settings.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.apiKey}`,
        'User-Agent': 'claude-code/1.0.0',
      },
      body: JSON.stringify(body),
      signal: deadline.signal,
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new Error('API Key 无效或已过期，请检查配置。');
      }
      const text = await res.text();
      throw new Error(`LLM API 错误 (${res.status}): ${text}`);
    }

    reader = res.body?.getReader();
    if (!reader) throw new Error('无法读取流式响应');

    const decoder = new TextDecoder();
    let buffer = '';
    let unrecognizedEventCount = 0;
    const terminalChunk = (done = true) => ({
      done,
      unrecognizedEventCount,
    } as StreamChunk & { unrecognizedEventCount: number });
    /** chat/completions 流式工具调用按 index 聚合的累加器 */
    const toolCallAcc = new Map<number, { id: string; name: string; arguments: string }>();
    const flushToolCalls = function* (): Generator<StreamChunk> {
      for (const [, entry] of [...toolCallAcc.entries()].sort((a, b) => a[0] - b[0])) {
        yield {
          outputItem: {
            type: 'function_call',
            id: entry.id,
            call_id: entry.id,
            name: entry.name,
            arguments: entry.arguments || '{}',
          },
        };
      }
      toolCallAcc.clear();
    };
    while (true) {
      const idle = createDeadlineSignal(deadline.signal, DEFAULT_LLM_IDLE_TIMEOUT_MS, 'LLM stream received no data before its idle deadline');
      let onAbort: (() => void) | undefined;
      try {
        const readPromise = reader.read();
        const abortPromise = new Promise<never>((_, reject) => {
          onAbort = () => {
            const reason = idle.didTimeout() ? idle.timeoutError : idle.signal.reason;
            reject(reason);
            void reader?.cancel(reason);
          };
          if (idle.signal.aborted) onAbort();
          else idle.signal.addEventListener('abort', onAbort, { once: true });
        });
        const { done, value } = await Promise.race([readPromise, abortPromise]);
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('event:')) continue;
          if (!trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          if (data === '[DONE]') {
            if (isChatCompletions) yield* flushToolCalls();
            yield terminalChunk();
            return;
          }

          try {
            const json = JSON.parse(data);
            let recognized = false;
            if (json.type === 'response.output_text.delta' && typeof json.delta === 'string') {
              recognized = true;
              yield { delta: json.delta };
            }
            if (json.type === 'response.output_item.done' && json.item) {
              recognized = true;
              yield { outputItem: json.item as OutputItem };
            }
            if (json.type === 'response.completed' || json.type === 'response.done') {
              recognized = true;
              yield { ...terminalChunk(), done: true };
              return;
            }
            const content = json.choices?.[0]?.delta?.content;
            if (typeof content === 'string') {
              recognized = true;
              yield { delta: content };
            }
            if (isChatCompletions) {
              const choice = json.choices?.[0];
              const deltaToolCalls = choice?.delta?.tool_calls;
              if (Array.isArray(deltaToolCalls) && deltaToolCalls.length > 0) {
                recognized = true;
                for (const fragment of deltaToolCalls) {
                  const index = typeof fragment?.index === 'number' ? fragment.index : 0;
                  const entry = toolCallAcc.get(index) || { id: '', name: '', arguments: '' };
                  if (typeof fragment?.id === 'string' && fragment.id) entry.id = fragment.id;
                  if (typeof fragment?.function?.name === 'string' && fragment.function.name) {
                    entry.name += fragment.function.name;
                  }
                  if (typeof fragment?.function?.arguments === 'string' && fragment.function.arguments) {
                    entry.arguments += fragment.function.arguments;
                  }
                  toolCallAcc.set(index, entry);
                }
              }
              const finishReason = choice?.finish_reason;
              if (finishReason === 'tool_calls') {
                recognized = true;
                yield* flushToolCalls();
                yield terminalChunk();
                return;
              }
              if (finishReason === 'stop') {
                recognized = true;
                yield terminalChunk();
                return;
              }
            }
            if (!recognized) unrecognizedEventCount++;
          } catch {
            unrecognizedEventCount++;
          }
        }
      } finally {
        if (onAbort) idle.signal.removeEventListener('abort', onAbort);
        idle.cleanup();
      }
    }
    if (isChatCompletions) yield* flushToolCalls();
    if (unrecognizedEventCount > 0) yield terminalChunk();
  } catch (error) {
    if (deadline.didTimeout()) throw deadline.timeoutError;
    throw error;
  } finally {
    reader?.releaseLock();
    deadline.cleanup();
  }
}
