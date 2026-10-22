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
import { sendToTabWithRetry } from './tab-message';
import { DEFAULT_USER_WAIT_TIMEOUT_MS, createDeadlineSignal, isTimeoutError } from '../ai/deadline';
let requestCounter = 0;

/** 模型可主动调用本工具：限制单条消息长度与频率，避免被页面内容诱导刷屏或塞入超长话术。 */
const MAX_CONFIRMATION_MESSAGE_CHARS = 600;
const MAX_CONFIRMATIONS_PER_MINUTE = 10;
const confirmationTimestamps = new Map<string, number[]>();
/** 审批请求重复投递间隔：用于等待目标页 content script 就绪。 */
const APPROVAL_RESEND_INTERVAL_MS = 1_500;

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

    // 只发往发起会话的标签页；没有标签页（如 tab.open 尚未创建标签页）时，
    // broadcast 只能覆盖已登记的 content script——扩展刚重载、页面还没加载时 tabSet 是空的，
    // 广播等于发进空气，用户永远看不到卡片。这时改为定向投递到当前活动标签页。
    let deliveryTabId = targetTabId;
    let injectedOnce = false;
    const deliver = (type: string, data: unknown) => {
      const dispatch = (tabId: number) => {
        // 首次投递要能落进还没跑 document_idle 的页面，走带注入重试的通道；
        // 之后的重发只需普通发送，避免每次重发都挂 5s 等待。
        if (injectedOnce) {
          Channel.sendToTab(tabId, type, data);
          return;
        }
        injectedOnce = true;
        void sendToTabWithRetry(tabId, type, data, { deadlineMs: 5_000 }).catch(() => {});
      };
      if (deliveryTabId !== undefined) {
        dispatch(deliveryTabId);
        return;
      }
      if (!chrome.tabs?.query) {
        Channel.broadcast(type, data);
        return;
      }
      // chrome://、扩展页等不可注入页收不到消息（tab-message 的注入分支也会拒绝），
      // 优先活动页，其次同窗口第一个 http(s) 页，都没有才广播。
      chrome.tabs.query({ lastFocusedWindow: true }, (tabs) => {
        const candidates = tabs || [];
        // url 未知的标签页不排除：拿不到 url 不代表不可注入，排除它等于退回空广播。
        const usable = candidates.filter((tab) => {
          const url = tab.url || tab.pendingUrl || '';
          return !url || /^https?:\/\//i.test(url);
        });
        const pick = usable.find((tab) => tab.active) || usable[0];
        if (typeof pick?.id !== 'number') {
          Channel.broadcast(type, data);
          return;
        }
        deliveryTabId = pick.id;
        dispatch(pick.id);
      });
    };

    deliver('__approval_request', { requestId, message });

    // 阻塞等待用户响应
    return new Promise<FunctionResult>((resolve) => {
      let settled = false;
      // tabs.sendMessage 没有应答回执，目标页 content script 可能尚未就绪；同一 requestId 重复投递是幂等的。
      let resend: number | undefined;
      // 有明确标签页时用户就在当前页面，1 分钟足够；无标签页场景保留默认等待
      const waitMs = targetTabId !== undefined ? 60_000 : DEFAULT_USER_WAIT_TIMEOUT_MS;
      const deadline = createDeadlineSignal(signal, waitMs, 'request_confirmation waiting for a response');

      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearInterval(resend);
        Channel.off('__approval_response', handler);
        deadline.signal.removeEventListener('abort', onAbort);
        deadline.cleanup();
      };

      resend = setInterval(() => {
        if (!settled) deliver('__approval_request', { requestId, message });
      }, APPROVAL_RESEND_INTERVAL_MS);

      // 监听用户响应（匹配 requestId，并拒绝其他标签页的伪造响应）
      const handler = (data: unknown, sender?: chrome.runtime.MessageSender) => {
        if (!data || typeof data !== 'object') return;
        if (deliveryTabId !== undefined && sender?.tab?.id !== deliveryTabId) return;
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
