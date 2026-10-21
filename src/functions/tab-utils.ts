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
  runner: (tabId: number) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  throwIfAborted(signal);
  const tab = await chrome.tabs.create({ url, active: false });
  if (!tab.id) {
    throw new Error('无法创建后台标签页');
  }

  const tabId = tab.id;
  try {
    throwIfAborted(signal);
    return await runner(tabId);
  } finally {
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      // tab may already be closed
    }
  }
};
