/**
 * 标签页消息工具
 * 统一处理发送到 content script 的消息、超时、Abort、自动注入重试
 */

import Channel from '../lib/channel';

interface SendToTabOptions {
  signal?: AbortSignal;
  deadlineMs?: number;
  injectContentScript?: boolean;
  timeoutMessage?: string;
  /** 指定时只投递到该 frame；省略时按 Chrome 默认行为投递 */
  frameId?: number;
}

const isRetryableConnectionError = (message: string): boolean => {
  const normalized = String(message || '').toLowerCase();
  return normalized.includes('receiving end does not exist')
    || normalized.includes('could not establish connection')
    || normalized.includes('message port closed');
};

const injectContentScriptIfPossible = async (tabId: number): Promise<boolean> => {
  try {
    const tab = await chrome.tabs.get(tabId);
    const targetUrl = tab.url || tab.pendingUrl || '';
    if (!/^https?:\/\//i.test(targetUrl)) {
      return false;
    }
    // G5：跨源 iframe 也要有 content script，否则子框架 ref 无法解析
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content.js'],
    });
    return true;
  } catch {
    return false;
  }
};

export const sendToTabWithRetry = async <T = any>(
  tabId: number,
  type: string,
  data: any,
  options?: SendToTabOptions,
): Promise<T> => {
  const deadlineMs = Math.max(1000, Math.floor(Number(options?.deadlineMs) || 12000));
  const timeoutMessage = options?.timeoutMessage || '目标页面连接超时：content script 未就绪';
  const injectContentScript = options?.injectContentScript !== false;
  const signal = options?.signal;
  const frameId = options?.frameId;

  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      const abortError = new Error('aborted');
      abortError.name = 'AbortError';
      reject(abortError);
      return;
    }

    const startedAt = Date.now();
    let attempt = 0;
    let injectedOnce = false;
    let settled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (error?: Error, response?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (retryTimer) clearTimeout(retryTimer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(response as T);
    };

    const onAbort = () => {
      const abortError = new Error('aborted');
      abortError.name = 'AbortError';
      finish(abortError);
    };
    const timeout = setTimeout(() => finish(new Error(timeoutMessage)), deadlineMs);

    const sendOnce = (): Promise<T> => {
      return new Promise((resolveSend, rejectSend) => {
        Channel.sendToTab(tabId, type, data, (response: unknown) => {
          if (chrome.runtime.lastError) {
            rejectSend(new Error(chrome.runtime.lastError.message || '发送消息失败'));
            return;
          }
          if (response === undefined) {
            rejectSend(new Error('message port closed before a response was received'));
            return;
          }
          resolveSend(response as T);
        }, frameId, rejectSend);
      });
    };

    const trySend = async () => {
      if (settled) return;
      attempt += 1;
      const remain = deadlineMs - (Date.now() - startedAt);
      if (remain <= 0) {
        finish(new Error(timeoutMessage));
        return;
      }

      try {
        const response = await sendOnce();
        finish(undefined, response);
      } catch (err: any) {
        if (settled) return;
        const message = err?.message || '发送消息失败';
        const retryable = isRetryableConnectionError(message) && Date.now() - startedAt < deadlineMs;
        if (!retryable) {
          finish(new Error(message));
          return;
        }

        if (injectContentScript && !injectedOnce) {
          injectedOnce = true;
          await injectContentScriptIfPossible(tabId);
        }
        if (settled) return;
        const delayMs = Math.min(1400, 160 + attempt * 140);
        retryTimer = setTimeout(() => {
          void trySend();
        }, delayMs);
      }
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    void trySend();
  });
};
