import { isBlockedFetchUrl } from '../lib/ssrf-guard';

/** 获取当前活动标签页 ID，如果无法获取返回 null */
export const getActiveTabId = (): Promise<number | null> => {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs?.[0]?.id ?? null);
    });
  });
};

const buildAbortError = (): Error => {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
};

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) {
    throw buildAbortError();
  }
};

const isOwnExtensionResource = (value: string, resourceType?: string): boolean => {
  if (!resourceType || resourceType === 'Document' || !chrome.runtime?.id) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'chrome-extension:' && url.host === chrome.runtime.id;
  } catch {
    return false;
  }
};

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> => {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(buildAbortError());
      return;
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      reject(buildAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
};

export const waitForTabComplete = (
  tabId: number,
  timeoutMs: number,
  timeoutMessage: string,
  signal?: AbortSignal,
): Promise<void> => {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(buildAbortError());
      return;
    }

    let settled = false;
    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };

    const timeout = setTimeout(() => finish(new Error(timeoutMessage)), timeoutMs);

    const onAbort = () => finish(buildAbortError());

    const listener = (id: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && changeInfo.status === 'complete') finish();
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    // 先注册监听再查当前状态，避免两者之间完成事件丢失
    chrome.tabs.onUpdated.addListener(listener);
    try {
      chrome.tabs.get(tabId, (tab) => {
        const lastError = chrome.runtime?.lastError?.message;
        if (lastError) {
          // 标签页已不存在：立即失败，而不是等到超时
          finish(new Error(`标签页 ${tabId} 不存在或已关闭`));
          return;
        }
        if (tab?.status === 'complete') finish();
      });
    } catch {
      // 某些测试/受限环境没有实现 tabs.get，仅依赖事件监听
    }
  });
};

export const waitForAnySelector = async (
  tabId: number,
  selectors: string[],
  timeoutMs: number,
  intervalMs: number = 280,
  signal?: AbortSignal,
): Promise<boolean> => {
  if (!selectors.length) return true;

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    throwIfAborted(signal);
    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (selectorList: string[]) => {
          if (!document || !document.body) return false;
          return selectorList.some((selector) => Boolean(document.querySelector(selector)));
        },
        args: [selectors],
      });

      if (result?.[0]?.result === true) return true;
    } catch {
      // ignore transient script errors during page switching
    }

    await sleep(intervalMs, signal);
  }

  return false;
};

export const withHiddenTab = async <T>(
  url: string,
  runner: (tabId: number, signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  throwIfAborted(signal);
  if (isBlockedFetchUrl(url)) throw new Error('不允许访问本地/内网地址');
  // 先装请求守卫再导航，避免最终 URL 校验之前已访问重定向目标。
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  if (!tab.id) {
    throw new Error('无法创建后台标签页');
  }

  const tabId = tab.id;
  const target = { tabId };
  const controller = new AbortController();
  let attached = false;
  let closing = false;
  let tabClosed = false;
  let detachStarted = false;
  let failure: Error | undefined;
  let failResult!: (error: Error) => void;
  const failed = new Promise<Error>((resolve) => { failResult = resolve; });
  const fail = (error: Error) => {
    if (failure) return;
    failure = error;
    controller.abort(error);
    failResult(error);
  };
  const check = () => { if (failure) throw failure; throwIfAborted(signal); };
  const guarded = <V>(operation: Promise<V>): Promise<V> => Promise.race([
    operation,
    failed.then((error) => { throw error; }),
  ]);
  const detachIfClosed = async () => {
    if (!attached || !tabClosed || detachStarted) return;
    detachStarted = true;
    await chrome.debugger.detach(target).catch(() => undefined);
  };
  const installGuard = async (debuggee: chrome.debugger.Debuggee) => {
    await guarded(chrome.debugger.sendCommand(debuggee, 'Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
    }));
    check();
    await guarded(chrome.debugger.sendCommand(debuggee, 'Target.setAutoAttach', {
      autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
      filter: [{ type: 'iframe', exclude: false }, { exclude: true }],
    }));
    check();
  };
  const onAbort = () => fail(buildAbortError());
  const onDetach = (source: chrome.debugger.Debuggee) => {
    if (source.tabId === tabId && !closing) fail(new Error('后台页面请求守卫已断开'));
  };
  const onEvent = (source: chrome.debugger.Debuggee, method: string, params?: object) => {
    if (source.tabId !== tabId) return;
    if (method === 'Target.attachedToTarget') {
      const child = params as { sessionId: string };
      const debuggee = { tabId, sessionId: child.sessionId };
      void installGuard(debuggee).then(() => {
        check();
        return chrome.debugger.sendCommand(debuggee, 'Runtime.runIfWaitingForDebugger');
      }).catch((error: Error) => fail(error));
      return;
    }
    if (method !== 'Fetch.requestPaused') return;
    const event = params as { requestId: string; request: { url: string }; resourceType?: string };
    const blocked = closing || Boolean(failure)
      || (!isOwnExtensionResource(event.request.url, event.resourceType) && isBlockedFetchUrl(event.request.url));
    // 任何资源请求都检查；跨站 iframe 的初次导航同样经过请求阶段。
    void chrome.debugger.sendCommand(source, blocked ? 'Fetch.failRequest' : 'Fetch.continueRequest', {
      requestId: event.requestId,
      ...(blocked ? { errorReason: 'BlockedByClient' } : {}),
    }).catch((error: Error) => fail(error));
    if (blocked && !closing) fail(new Error('后台页面请求指向本地/内网地址，已拒绝'));
  };
  const dispose = () => {
    chrome.debugger.onEvent.removeListener(onEvent);
    chrome.debugger.onDetach.removeListener(onDetach);
    signal?.removeEventListener('abort', onAbort);
  };
  chrome.debugger.onEvent.addListener(onEvent);
  chrome.debugger.onDetach.addListener(onDetach);
  signal?.addEventListener('abort', onAbort, { once: true });
  let outcome: { value: T } | { error: unknown };
  try {
    check();
    await guarded(chrome.debugger.attach(target, '1.3').then(() => {
      attached = true;
      // 取消可能早于 attach 返回；只能在关页完成后释放晚到的调试器。
      if (closing) void detachIfClosed();
    }));
    check();
    await installGuard(target);
    check();
    await guarded(chrome.tabs.update(tabId, { url }));
    check();
    const result = await Promise.race([
      runner(tabId, controller.signal),
      failed.then((error) => { throw error; }),
    ]);
    check();
    outcome = { value: result };
  } catch (error) {
    // runner 可能先响应 abort，保留触发取消的守卫错误。
    outcome = { error };
    try { check(); } catch (preferred) { outcome = { error: preferred }; }
  }
  closing = true;
  controller.abort();
  try {
    // 不能先 disable/detach：那会放行仍暂停的请求。
    await chrome.tabs.remove(tabId);
    tabClosed = true;
  } catch (error) {
    let exists = true;
    try { await chrome.tabs.get(tabId); } catch { exists = false; }
    if (exists) {
      // 关闭失败时保留只拒绝请求的守卫，直到该页实际被关闭。
      const onRemoved = (removedId: number) => {
        if (removedId !== tabId) return;
        tabClosed = true;
        dispose();
        chrome.tabs.onRemoved.removeListener(onRemoved);
        void detachIfClosed();
      };
      chrome.tabs.onRemoved.addListener(onRemoved);
      signal?.removeEventListener('abort', onAbort);
      if (!('error' in outcome)) outcome = { error };
    } else {
      tabClosed = true;
    }
  }
  if (tabClosed) {
    await detachIfClosed();
    dispose();
  }
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
};
