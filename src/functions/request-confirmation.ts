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
    const message = String(params.message || '').trim();
    if (!message) {
      return { success: false, error: 'Missing confirmation message' };
    }

    const requestId = `approval_${Date.now()}_${++requestCounter}`;
    const signal = context?.signal;

    // 广播确认请求到所有标签页（与 __ai_stream 一致的通信模式）
    Channel.broadcast('__approval_request', { requestId, message });

    // 阻塞等待用户响应
    return new Promise<FunctionResult>((resolve) => {
      let settled = false;
      const deadline = createDeadlineSignal(signal, DEFAULT_USER_WAIT_TIMEOUT_MS, 'request_confirmation waiting for a response');

      const cleanup = () => {
        if (settled) return;
        settled = true;
        Channel.off('__approval_response', handler);
        deadline.signal.removeEventListener('abort', onAbort);
        deadline.cleanup();
      };

      // 监听用户响应（匹配 requestId）
      const handler = (data: unknown) => {
        if (!data || typeof data !== 'object') return;
        const response = data as { requestId?: unknown; approved?: unknown; userMessage?: unknown; trustAll?: unknown };
        if (settled || response.requestId !== requestId) return;
        cleanup();
        Channel.broadcast('__approval_settled', {
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
        Channel.broadcast('__approval_cancel', { requestId });
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
