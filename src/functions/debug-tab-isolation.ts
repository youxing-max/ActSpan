import { waitForTabComplete } from './tab-utils';

const cloneablePageUrl = (url: string | undefined): string => (
  url && /^(?:https?|file):/i.test(url) ? url : 'about:blank'
);

const waitForIsolatedTabComplete = async (tabId: number): Promise<void> => {
  const controller = new AbortController();
  const completion = waitForTabComplete(tabId, 20_000, '隔离调试标签页加载超时', controller.signal);
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status !== 'complete') await completion;
  } finally {
    controller.abort();
    await completion.catch(() => undefined);
  }
};

export const prepareIsolatedDebugToolCall = (
  toolName: string,
  args: Record<string, unknown>,
  tabId: number,
): Record<string, unknown> => {
  const isolatedArgs = { ...args };

  if (Object.prototype.hasOwnProperty.call(isolatedArgs, 'tab_id')) {
    isolatedArgs.tab_id = tabId;
  }

  if (toolName === 'screenshot') {
    throw new Error('隔离调试模式禁止临时激活标签页，请使用 DOM/CDP 调试工具');
  }

  if (toolName !== 'tab_navigate') return isolatedArgs;

  const action = String(isolatedArgs.action || '').toLowerCase();
  if (action === 'switch' || action === 'duplicate') {
    throw new Error('隔离调试模式禁止切换或复制标签页');
  }
  if (action === 'open') isolatedArgs.action = 'navigate';
  isolatedArgs.active = false;
  isolatedArgs.tab_id = tabId;
  return isolatedArgs;
};

export const withIsolatedDebugTab = async <T>(
  sourceTabId: number | undefined,
  runner: (tabId: number, debugTabIds: Set<number>) => Promise<T>,
): Promise<T> => {
  let sourceUrl: string | undefined;
  let debugWindowId: number | undefined;
  let originalActiveTabId = sourceTabId;
  let originalActiveWindowId: number | undefined;
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    originalActiveTabId = activeTab?.id ?? originalActiveTabId;
    debugWindowId = activeTab?.windowId;
    originalActiveWindowId = activeTab?.windowId;
  } catch {
    // Fall back to the source tab supplied by the debugger.
  }
  if (typeof sourceTabId === 'number') {
    try {
      const sourceTab = await chrome.tabs.get(sourceTabId);
      sourceUrl = sourceTab.url;
      debugWindowId = sourceTab.windowId;
    } catch {
      sourceUrl = undefined;
    }
  }

  const debugTabIds = new Set<number>();
  let focusRestoration: Promise<void> = Promise.resolve();
  let activeTabTracking: Promise<void> = Promise.resolve();
  let lastCleanupActivityAt = Date.now();
  const isDebugTabOrDescendant = async (tabId: number): Promise<boolean> => {
    const visited = new Set<number>();
    let currentTabId: number | undefined = tabId;
    while (typeof currentTabId === 'number' && !visited.has(currentTabId)) {
      if (debugTabIds.has(currentTabId)) return true;
      visited.add(currentTabId);
      try {
        currentTabId = (await chrome.tabs.get(currentTabId)).openerTabId;
      } catch {
        return false;
      }
    }
    return false;
  };
  const discoverOwnedDescendants = async (): Promise<void> => {
    let tabs: chrome.tabs.Tab[];
    try {
      tabs = await chrome.tabs.query({});
    } catch {
      return;
    }

    let foundDescendant: boolean;
    do {
      foundDescendant = false;
      for (const tab of tabs) {
        if (typeof tab.id !== 'number' || typeof tab.openerTabId !== 'number') continue;
        if (!debugTabIds.has(tab.openerTabId) || debugTabIds.has(tab.id)) continue;
        debugTabIds.add(tab.id);
        lastCleanupActivityAt = Date.now();
        foundDescendant = true;
      }
    } while (foundDescendant);
  };
  const onActivated = ({ tabId, windowId }: chrome.tabs.TabActiveInfo) => {
    activeTabTracking = activeTabTracking.then(async () => {
      if (await isDebugTabOrDescendant(tabId)) return;
      originalActiveTabId = tabId;
      originalActiveWindowId = windowId;
    });
  };
  const onWindowFocusChanged = (windowId: number) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    activeTabTracking = activeTabTracking.then(async () => {
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, windowId });
        if (typeof activeTab?.id !== 'number') return;
        if (await isDebugTabOrDescendant(activeTab.id)) return;
        originalActiveTabId = activeTab.id;
        originalActiveWindowId = windowId;
      } catch {
        // The focused window may have closed before its active tab was read.
      }
    });
  };
  const onCreated = (tab: chrome.tabs.Tab) => {
    if (typeof tab.id !== 'number' || typeof tab.openerTabId !== 'number') return;
    if (!debugTabIds.has(tab.openerTabId)) return;
    debugTabIds.add(tab.id);
    lastCleanupActivityAt = Date.now();
    if (tab.active) {
      focusRestoration = focusRestoration.then(async () => {
        await activeTabTracking;
        const restoreTabId = originalActiveTabId;
        const restoreWindowId = originalActiveWindowId;
        if (typeof restoreTabId !== 'number' || debugTabIds.has(restoreTabId)) return;
        try {
          await chrome.tabs.update(restoreTabId, { active: true });
          if (
            typeof restoreWindowId === 'number'
            && typeof tab.windowId === 'number'
            && tab.windowId !== restoreWindowId
          ) {
            await chrome.windows.update(restoreWindowId, { focused: true });
          }
        } catch {
          // The user's previously active tab or window may have been closed meanwhile.
        }
      });
    }
  };

  chrome.tabs.onCreated.addListener(onCreated);
  chrome.tabs.onActivated.addListener(onActivated);
  chrome.windows.onFocusChanged.addListener(onWindowFocusChanged);
  try {
    const tab = await chrome.tabs.create({
      url: cloneablePageUrl(sourceUrl),
      active: false,
      ...(typeof debugWindowId === 'number' ? { windowId: debugWindowId } : {}),
    });
    if (typeof tab.id !== 'number') throw new Error('无法创建隔离调试标签页');
    debugTabIds.add(tab.id);
    await waitForIsolatedTabComplete(tab.id);
    return await runner(tab.id, debugTabIds);
  } finally {
    const closedTabIds = new Set<number>();
    const quietWindowMs = 50;
    for (;;) {
      await discoverOwnedDescendants();
      const pendingTabIds = Array.from(debugTabIds)
        .filter(tabId => !closedTabIds.has(tabId))
        .reverse();
      for (const tabId of pendingTabIds) {
        closedTabIds.add(tabId);
        try {
          await chrome.tabs.remove(tabId);
        } catch {
          // The page or workflow may already have closed its own debug tab.
        }
        lastCleanupActivityAt = Date.now();
      }

      await new Promise<void>(resolve => setTimeout(resolve, 10));
      await discoverOwnedDescendants();
      const hasPendingTabs = Array.from(debugTabIds).some(tabId => !closedTabIds.has(tabId));
      if (!hasPendingTabs && Date.now() - lastCleanupActivityAt >= quietWindowMs) break;
    }
    await activeTabTracking;
    await focusRestoration;
    chrome.tabs.onActivated.removeListener(onActivated);
    chrome.windows.onFocusChanged.removeListener(onWindowFocusChanged);
    chrome.tabs.onCreated.removeListener(onCreated);
  }
};
