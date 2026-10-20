/**
 * ask_user 工具
 * AI 主动提问节点 — 向用户提出问题并等待回答
 *
 * 职责：
 * 1. AI 判断需要获取用户信息或让用户做选择时调用此工具
 * 2. 通过 Channel 广播提问请求到悬浮球
 * 3. 阻塞等待用户选择选项或输入文本
 * 4. 返回用户的回答（含答案来源）
 */

import type { FunctionDefinition, FunctionResult, ToolExecutionContext } from './types';
import Channel from '../lib/channel';
import { DEFAULT_USER_WAIT_TIMEOUT_MS, createDeadlineSignal, isTimeoutError } from '../ai/deadline';
let requestCounter = 0;

export const askUserFunction: FunctionDefinition = {
  name: 'ask_user',
  description: 'Ask the user a question, or wait until a page condition becomes true. Supports preset options, free-text input, and unattended mode (returns immediately).',
  supportsParallel: false,
  permissionLevel: 'read',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The question to present to the user. Be concise and clearly state what information is needed.',
      },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional preset option list (1-6 items) for the user to select from.',
      },
      allow_free_text: {
        type: 'boolean',
        description: 'Whether to allow free-text input. Default: true.',
      },
      until: {
        type: 'object',
        description: 'Automatically finish when all specified page conditions hold on the controlled tab.',
        properties: {
          selectorExists: { type: 'string' },
          textContains: { type: 'string' },
          urlContains: { type: 'string' },
        },
      },
      unattended: { type: 'boolean', description: 'Return immediately instead of waiting for a user or page condition.' },
    },
    required: ['question'],
  },

  execute: async (
    params: { question?: string; options?: string[]; allow_free_text?: boolean; until?: { selectorExists?: string; textContains?: string; urlContains?: string }; unattended?: boolean },
    context?: ToolExecutionContext,
  ): Promise<FunctionResult> => {
    const question = String(params.question || '').trim();
    if (!question) {
      return { success: false, error: 'Missing question content' };
    }
    if (params.unattended) {
      return { success: false, error: 'User is unavailable in unattended mode', data: { code: 'unattended' } };
    }

    const until = params.until;
    const hasUntil = !!until && !!(until.selectorExists || until.textContains || until.urlContains);
    if (until && !hasUntil) {
      return { success: false, error: 'until requires selectorExists, textContains, or urlContains' };
    }
    if (hasUntil && (typeof context?.tabId !== 'number' || context.tabId <= 0)) {
      return { success: false, error: 'until requires a controlled tabId' };
    }

    // 规范化参数
    const options = Array.isArray(params.options)
      ? params.options.map(o => String(o || '').trim()).filter(Boolean).slice(0, 6)
      : [];
    const allowFreeText = params.allow_free_text !== false; // 默认 true

    // 校验：如果没有选项也不允许文本输入，则无法交互
    if (options.length === 0 && !allowFreeText && !hasUntil) {
      return { success: false, error: 'Invalid params: options is empty and allow_free_text is false, user cannot respond' };
    }

    const requestId = `ask_${Date.now()}_${++requestCounter}`;
    const signal = context?.signal;

    // 广播提问请求到所有标签页
    Channel.broadcast('__ask_user_request', {
      requestId,
      question,
      options: options.length > 0 ? options : undefined,
      allowFreeText,
    });

    // 阻塞等待用户回答，默认 deadline 防止外部请求永久挂起
    return new Promise<FunctionResult>((resolve) => {
      let settled = false;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      const deadline = createDeadlineSignal(signal, DEFAULT_USER_WAIT_TIMEOUT_MS, 'ask_user waiting for a response');

      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(pollTimer);
        Channel.off('__ask_user_response', handler);
        deadline.signal.removeEventListener('abort', onAbort);
        deadline.cleanup();
      };

      // 监听用户回答（匹配 requestId）
      const handler = (data: unknown) => {
        if (!data || typeof data !== 'object') return;
        const response = data as { requestId?: unknown; answer?: unknown; source?: unknown; denied?: unknown };
        if (settled || response.requestId !== requestId) return;
        if (response.denied === true) {
          cleanup();
          Channel.broadcast('__ask_user_cancel', { requestId, code: 'denied' });
          resolve({ success: false, error: 'User denied the request', data: { code: 'denied' } });
          return;
        }
        cleanup();
        Channel.broadcast('__ask_user_settled', {
          requestId,
          answer: String(response.answer || ''),
          source: response.source === 'option' ? 'option' : 'text',
        });
        resolve({
          success: true,
          data: {
            answer: String(response.answer || ''),
            source: response.source === 'option' ? 'option' : 'text',
          },
        });
      };

      // 主动取消或 deadline 到期时清理并通知悬浮球；
      // 调用方用 DeadlineTimeoutError 中止时同样是超时，不能退化成“已取消”。
      const onAbort = () => {
        if (settled) return;
        const reason = deadline.signal.reason;
        const timedOut = deadline.didTimeout() || isTimeoutError(reason);
        cleanup();
        Channel.broadcast('__ask_user_cancel', { requestId, code: timedOut ? 'timed_out' : 'cancelled' });
        resolve({ success: false, error: timedOut
          ? (isTimeoutError(reason) ? reason.message : deadline.timeoutError.message)
          : 'Task cancelled', data: { code: timedOut ? 'timed_out' : 'cancelled' } });
      };

      const checkUntil = async () => {
        if (settled || deadline.signal.aborted || !until) return;
        try {
          const [frame] = await chrome.scripting.executeScript({
            target: { tabId: context!.tabId! },
            func: (condition: { selectorExists?: string; textContains?: string; urlContains?: string }) =>
              (!condition.selectorExists || !!document.querySelector(condition.selectorExists))
              && (!condition.textContains || !!document.body?.innerText.includes(condition.textContains))
              && (!condition.urlContains || location.href.includes(condition.urlContains)),
            args: [until],
          });
          if (settled) return;
          if (frame?.result === true) {
            cleanup();
            Channel.broadcast('__ask_user_cancel', { requestId, code: 'until' });
            resolve({ success: true, data: { code: 'until' } });
            return;
          }
        } catch (error) {
          if (settled) return;
          cleanup();
          Channel.broadcast('__ask_user_cancel', { requestId });
          resolve({ success: false, error: `Could not check until condition: ${error instanceof Error ? error.message : String(error)}` });
          return;
        }
        pollTimer = setTimeout(() => void checkUntil(), 250);
      };

      Channel.on('__ask_user_response', handler);

      if (deadline.signal.aborted) {
        onAbort();
      } else {
        deadline.signal.addEventListener('abort', onAbort, { once: true });
        if (hasUntil) void checkUntil();
      }
    });
  },
};
