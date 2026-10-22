/**
 * request_confirmation 工具
 * AI 驱动的人机确认节点
 *
 * 职责：
 * 1. AI 判断需要用户确认时调用此工具
 * 2. 通过 Channel 广播确认请求到悬浮球
 * 3. 阻塞等待用户批准/拒绝
 * 4. 返回用户决策（含可选的拒绝附言）
 */

import type { FunctionDefinition, FunctionResult, ToolExecutionContext } from './types';
import Channel from '../lib/channel';
import { DEFAULT_USER_WAIT_TIMEOUT_MS, createDeadlineSignal, isTimeoutError } from '../ai/deadline';
let requestCounter = 0;

/** 模型可主动调用本工具：限制单条消息长度与频率，避免被页面内容诱导刷屏或塞入超长话术。 */
const MAX_CONFIRMATION_MESSAGE_CHARS = 600;
const MAX_CONFIRMATIONS_PER_MINUTE = 10;
const confirmationTimestamps = new Map<string, number[]>();

export const requestConfirmationFunction: FunctionDefinition = {
  name: 'request_confirmation',
  description: 'Request user confirmation before performing sensitive or critical operations. The user will see a confirmation message and choose to approve or reject, optionally providing a reason when rejecting.',
  supportsParallel: false,
  permissionLevel: 'read',
  parameters: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'The confirmation message to present to the user, briefly describing the operation to be performed and its impact.',
      },
    },
    required: ['message'],
  },

  execute: async (
    params: { message?: string },
    context?: ToolExecutionContext,
  ): Promise<FunctionResult> => {
    let message = String(params.message || '').trim();
    if (!message) {
      return { success: false, error: 'Missing confirmation message' };
    }
    if (message.length > MAX_CONFIRMATION_MESSAGE_CHARS) {
      message = `${message.slice(0, MAX_CONFIRMATION_MESSAGE_CHARS)}…`;
    }
    const rateKey = context?.sessionId || context?.taskId || (typeof context?.tabId === 'number' ? `tab:${context.tabId}` : 'global');
    const now = Date.now();
    // 键本身也可能随会话/标签页增长：顺手回收所有已过窗口的空桶。
    for (const [key, times] of confirmationTimestamps) {
      if (!times.some((time) => now - time < 60_000)) confirmationTimestamps.delete(key);
    }
    const recent = (confirmationTimestamps.get(rateKey) || []).filter((time) => now - time < 60_000);
    if (recent.length >= MAX_CONFIRMATIONS_PER_MINUTE) {
      return { success: false, error: '确认请求过于频繁，请稍后再试' };
    }
    recent.push(now);
    confirmationTimestamps.set(rateKey, recent);

    const requestId = `approval_${Date.now()}_${++requestCounter}`;
    const signal = context?.signal;
    const targetTabId = typeof context?.tabId === 'number' && context.tabId > 0 ? context.tabId : undefined;

    // 只发往发起会话的标签页；没有标签页（如纯 background 任务）才退回广播，
    // 避免多个窗口弹出同一个审批、用户在错误页面批准。
    const deliver = (type: string, data: unknown) => {
      if (targetTabId !== undefined) Channel.sendToTab(targetTabId, type, data);
      else Channel.broadcast(type, data);
    };

    deliver('__approval_request', { requestId, message });

    // 阻塞等待用户响应
    return new Promise<FunctionResult>((resolve) => {
      let settled = false;
      // 有明确标签页时用户就在当前页面，1 分钟足够；无标签页场景保留默认等待
      const waitMs = targetTabId !== undefined ? 60_000 : DEFAULT_USER_WAIT_TIMEOUT_MS;
      const deadline = createDeadlineSignal(signal, waitMs, 'request_confirmation waiting for a response');

      const cleanup = () => {
        if (settled) return;
        settled = true;
        Channel.off('__approval_response', handler);
        deadline.signal.removeEventListener('abort', onAbort);
        deadline.cleanup();
      };

      // 监听用户响应（匹配 requestId，并拒绝其他标签页的伪造响应）
      const handler = (data: unknown, sender?: chrome.runtime.MessageSender) => {
        if (!data || typeof data !== 'object') return;
        if (targetTabId !== undefined && sender?.tab?.id !== targetTabId) return;
        const response = data as { requestId?: unknown; approved?: unknown; userMessage?: unknown; trustAll?: unknown };
        if (settled || response.requestId !== requestId) return;
        cleanup();
        deliver('__approval_settled', {
          requestId,
          approved: !!response.approved,
          userMessage: response.userMessage || '',
          trustAll: !!response.trustAll,
        });
        resolve({
          success: true,
          data: {
            approved: !!response.approved,
            userMessage: response.userMessage || undefined,
            trustAll: !!response.trustAll,
          },
        });
      };

      // 主动取消或 deadline 到期时清理并通知悬浮球。
      // 调用方用 DeadlineTimeoutError 中止（例如 bridge 的审批等待上限）同样是超时，不能退化成“已取消”。
      const onAbort = () => {
        if (settled) return;
        const reason = deadline.signal.reason;
        const timedOut = deadline.didTimeout() || isTimeoutError(reason);
        cleanup();
        deliver('__approval_cancel', { requestId });
        resolve({ success: false, error: timedOut
          ? (isTimeoutError(reason) ? reason.message : deadline.timeoutError.message)
          : 'Task cancelled' });
      };

      Channel.on('__approval_response', handler);

      if (deadline.signal.aborted) {
        onAbort();
      } else {
        deadline.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  },
};
