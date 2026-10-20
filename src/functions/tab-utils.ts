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

    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    const onAbort = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      reject(buildAbortError());
    };

    const listener = (id: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    chrome.tabs.onUpdated.addListener(listener);
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
