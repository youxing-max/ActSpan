/**
 * LLM API 客户端
 * 基于 fetch 实现 OpenAI Responses API，支持流式响应和工具调用
 * 不引入 SDK，保持轻量
 */

import { AI_CONFIG } from '../config';
import { readMigratedStorage } from '../lib/legacy-storage';
import type { InputItem, OutputItem, ToolSchema, StreamChunk, AISettings, ToolChoice } from './types';
import { DEFAULT_LLM_IDLE_TIMEOUT_MS, DEFAULT_LLM_TOTAL_TIMEOUT_MS, createDeadlineSignal } from './deadline';

export const STORAGE_KEY_AI_SETTINGS = 'actspan_ai_settings';
export const LEGACY_STORAGE_KEY_AI_SETTINGS = 'mole_ai_settings';

/** 默认配置，与 OMP anyrouter 的 openai-responses provider 对齐 */
const DEFAULT_SETTINGS: AISettings = {
  apiKey: '',
  endpoint: AI_CONFIG.DEFAULT_ENDPOINT,
  model: AI_CONFIG.DEFAULT_MODEL,
  strictResultMode: true,
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

  const body: Record<string, any> = {
    model: settings.model,
    input: effectiveInput,
    max_output_tokens: 16384,
  };
  if (instructions) {
    body.instructions = instructions;
  }
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.parallel_tool_calls = resolveParallelToolCalls(settings);
    // tool_choice 仅在有 tools 时生效
    if (toolChoice) {
      body.tool_choice = toolChoice;
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

  const body: Record<string, any> = {
    model: settings.model,
    input: effectiveInput,
    max_output_tokens: 16384,
    stream: true,
  };
  if (instructions) {
    body.instructions = instructions;
  }
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.parallel_tool_calls = resolveParallelToolCalls(settings);
    if (toolChoice) {
      body.tool_choice = toolChoice;
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
    if (unrecognizedEventCount > 0) yield terminalChunk();
  } catch (error) {
    if (deadline.didTimeout()) throw deadline.timeoutError;
    throw error;
  } finally {
    reader?.releaseLock();
    deadline.cleanup();
  }
}
