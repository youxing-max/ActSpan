import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const created = [];
const updated = [];
const removed = [];
const focusedWindows = [];
let nextTabId = 101;
let nextCreatedStatus = 'complete';
let onCreatedListener = null;
let onUpdatedListener = null;
let onActivatedListener = null;
let onWindowFocusChangedListener = null;
let completionListenerInstalledBeforeGet = false;
const tabStatuses = new Map();
const openTabs = new Map();

globalThis.chrome = {
  tabs: {
    async query(properties) {
      const sourceTab = { id: 7, windowId: 1, url: 'https://user.example/current', active: true, status: 'complete' };
      if (properties?.active && properties.windowId === 2) {
        return [{ id: 8, windowId: 2, url: 'https://user.example/other', active: true, status: 'complete' }];
      }
      return properties?.active ? [sourceTab] : [sourceTab, ...openTabs.values()];
    },
    async get(tabId) {
      if (tabId === 7) return { id: 7, windowId: 1, url: 'https://user.example/current', active: true, status: 'complete' };
      completionListenerInstalledBeforeGet ||= onUpdatedListener !== null;
      const openTab = openTabs.get(tabId);
      if (openTab) return { ...openTab, status: tabStatuses.get(tabId) || openTab.status };
      return { id: tabId, windowId: 1, url: 'about:blank', active: false, status: 'complete' };
    },
    async create(properties) {
      const tab = {
        id: nextTabId++,
        windowId: properties.windowId ?? 1,
        url: properties.url,
        pendingUrl: properties.url,
        active: properties.active,
        openerTabId: properties.openerTabId,
        status: nextCreatedStatus,
      };
      openTabs.set(tab.id, tab);
      tabStatuses.set(tab.id, tab.status);
      created.push({ ...properties, tabId: tab.id });
      queueMicrotask(() => onCreatedListener?.(tab));
      if (tab.status !== 'complete') {
        setTimeout(() => {
          tabStatuses.set(tab.id, 'complete');
          onUpdatedListener?.(tab.id, { status: 'complete' });
        }, 0);
      }
      return tab;
    },
    async update(tabId, properties) {
      updated.push({ tabId, properties: { ...properties } });
      return { id: tabId, url: properties.url, pendingUrl: properties.url, active: false };
    },
    async remove(tabId) {
      removed.push(tabId);
      openTabs.delete(tabId);
      tabStatuses.delete(tabId);
    },
    onCreated: {
      addListener(listener) { onCreatedListener = listener; },
      removeListener(listener) { if (onCreatedListener === listener) onCreatedListener = null; },
    },
    onUpdated: {
      addListener(listener) { onUpdatedListener = listener; },
      removeListener(listener) { if (onUpdatedListener === listener) onUpdatedListener = null; },
    },
    onActivated: {
      addListener(listener) { onActivatedListener = listener; },
      removeListener(listener) { if (onActivatedListener === listener) onActivatedListener = null; },
    },
  },
  windows: {
    WINDOW_ID_NONE: -1,
    onFocusChanged: {
      addListener(listener) { onWindowFocusChangedListener = listener; },
      removeListener(listener) {
        if (onWindowFocusChangedListener === listener) onWindowFocusChangedListener = null;
      },
    },
    async update(windowId, properties) {
      focusedWindows.push({ windowId, properties: { ...properties } });
      return { id: windowId, focused: properties.focused };
    },
  },
};
const bundle = await build({
  stdin: {
    contents: `
      export { executeDebugRemotePlan, registerBuiltinFunctionResolver } from './src/functions/remote-workflow.ts';
      export { tabNavigateFunction } from './src/functions/tab-navigate.ts';
      export { prepareIsolatedDebugToolCall, withIsolatedDebugTab } from './src/functions/debug-tab-isolation.ts';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const {
  executeDebugRemotePlan,
  registerBuiltinFunctionResolver,
  tabNavigateFunction,
  prepareIsolatedDebugToolCall,
  withIsolatedDebugTab,
} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

const throwingFunction = {
  name: 'throwing_tool',
  description: 'test helper',
  parameters: { type: 'object', properties: {} },
  supportsParallel: false,
  async execute() {
    throw new Error('debug failure');
  },
};
let receivedDebugTabIds;
const contextProbeFunction = {
  name: 'context_probe',
  description: 'test helper',
  parameters: { type: 'object', properties: {} },
  supportsParallel: false,
  async execute(_params, context) {
    receivedDebugTabIds = context?.debugTabIds;
    return { success: true };
  },
};
const builtins = new Map([
  ['tab_navigate', tabNavigateFunction],
  ['throwing_tool', throwingFunction],
  ['context_probe', contextProbeFunction],
]);
registerBuiltinFunctionResolver((name) => builtins.get(name), () => [...builtins.keys()]);

const resetCalls = () => {
  created.length = 0;
  updated.length = 0;
  removed.length = 0;
  nextTabId = 101;
  nextCreatedStatus = 'complete';
  onCreatedListener = null;
  onUpdatedListener = null;
  onActivatedListener = null;
  onWindowFocusChangedListener = null;
  completionListenerInstalledBeforeGet = false;
  receivedDebugTabIds = undefined;
  focusedWindows.length = 0;
  tabStatuses.clear();
  openTabs.clear();
};

const isolatedContext = { tabId: 100, isolatedDebug: true };
const quietParams = { float_ball_execution_state: false };

test('isolated debug plan navigates only its background tab', async () => {
  resetCalls();
  const result = await executeDebugRemotePlan('debug', {
    version: 1,
    closeOpenedTabs: 'never',
    steps: [{
      action: 'tab_navigate',
      params: { action: 'navigate', url: 'https://debug.example/', tab_id: 7, active: true },
    }],
  }, quietParams, isolatedContext);

  assert.equal(result.success, true);
  assert.deepEqual(created, []);
  assert.deepEqual(updated, [{ tabId: 100, properties: { url: 'https://debug.example/' } }]);
  assert.deepEqual(removed, []);
});

test('isolated debug plan forces background opens and closes them despite keep-alive policy', async () => {
  resetCalls();
  const result = await executeDebugRemotePlan('debug', {
    version: 1,
    closeOpenedTabs: 'never',
    steps: [{
      action: 'tab_navigate',
      keepAlive: true,
      params: { action: 'open', url: 'https://debug.example/', active: true },
    }],
  }, quietParams, isolatedContext);

  assert.equal(result.success, true);
  assert.deepEqual(created, [{ url: 'https://debug.example/', active: false, openerTabId: 100, windowId: 1, tabId: 101 }]);
  assert.deepEqual(removed, [101]);
});

test('isolated debug plan closes opened tabs when a later tool throws', async () => {
  resetCalls();
  await assert.rejects(() => executeDebugRemotePlan('debug', {
    version: 1,
    closeOpenedTabs: 'never',
    steps: [
      { action: 'tab_navigate', params: { action: 'open', url: 'https://debug.example/' } },
      { action: 'throwing_tool', params: {} },
    ],
  }, quietParams, isolatedContext), /debug failure/);

  assert.deepEqual(removed, [101]);
});

test('isolated debug forwards shared tab ownership to workflow actions', async () => {
  resetCalls();
  const debugTabIds = new Set([100]);

  const result = await executeDebugRemotePlan('debug', {
    version: 1,
    steps: [{ action: 'context_probe', params: {} }],
  }, quietParams, { ...isolatedContext, debugTabIds });

  assert.equal(result.success, true);
  assert.equal(receivedDebugTabIds, debugTabIds);
});

test('debug tool calls are pinned to the isolated tab and cannot change focus', () => {
  assert.deepEqual(
    prepareIsolatedDebugToolCall('page_snapshot', { tab_id: 7 }, 100),
    { tab_id: 100 },
  );
  assert.deepEqual(
    prepareIsolatedDebugToolCall('tab_navigate', { action: 'open', url: 'https://debug.example/', active: true }, 100),
    { action: 'navigate', url: 'https://debug.example/', active: false, tab_id: 100 },
  );
  assert.throws(
    () => prepareIsolatedDebugToolCall('tab_navigate', { action: 'switch', tab_id: 7 }, 100),
    /隔离调试模式禁止切换或复制标签页/,
  );
  assert.throws(
    () => prepareIsolatedDebugToolCall('screenshot', {}, 100),
    /隔离调试模式禁止临时激活标签页/,
  );
});

test('isolated debug tab clones the source in background and always closes', async () => {
  resetCalls();
  const result = await withIsolatedDebugTab(7, async (tabId) => {
    assert.equal(tabId, 101);
    return 'ok';
  });

  assert.equal(result, 'ok');
  assert.deepEqual(created, [{ url: 'https://user.example/current', active: false, windowId: 1, tabId: 101 }]);
  assert.deepEqual(removed, [101]);
});

test('isolated debug waits for the cloned page before running', async () => {
  resetCalls();
  nextCreatedStatus = 'loading';
  let statusWhenRun;

  await withIsolatedDebugTab(7, async (tabId) => {
    statusWhenRun = (await globalThis.chrome.tabs.get(tabId)).status;
  });

  assert.equal(statusWhenRun, 'complete');
  assert.deepEqual(removed, [101]);
  assert.equal(completionListenerInstalledBeforeGet, true);
});

test('isolated debug restores focus and closes popup descendants', async () => {
  resetCalls();

  await withIsolatedDebugTab(7, async (tabId, debugTabIds) => {
    onCreatedListener?.({ id: 102, openerTabId: tabId, active: true });
    assert.deepEqual([...debugTabIds], [101, 102]);
  });

  assert.deepEqual(updated, [{ tabId: 7, properties: { active: true } }]);
  assert.deepEqual(removed, [102, 101]);
});

test('isolated debug follows the latest non-debug user tab when restoring focus', async () => {
  resetCalls();

  await withIsolatedDebugTab(7, async (tabId) => {
    onActivatedListener?.({ tabId: 8, windowId: 2 });
    onCreatedListener?.({ id: 102, openerTabId: tabId, active: true, windowId: 3 });
  });

  assert.deepEqual(updated, [{ tabId: 8, properties: { active: true } }]);
  assert.deepEqual(focusedWindows, [{ windowId: 2, properties: { focused: true } }]);
  assert.deepEqual(removed, [102, 101]);
});

test('isolated debug follows a user switch that only changes the focused window', async () => {
  resetCalls();

  await withIsolatedDebugTab(7, async (tabId) => {
    onWindowFocusChangedListener?.(2);
    onCreatedListener?.({ id: 102, openerTabId: tabId, active: true, windowId: 3 });
  });

  assert.deepEqual(updated, [{ tabId: 8, properties: { active: true } }]);
  assert.deepEqual(focusedWindows, [{ windowId: 2, properties: { focused: true } }]);
  assert.deepEqual(removed, [102, 101]);
});

test('isolated debug cleans a popup whose creation event arrives after the runner', async () => {
  resetCalls();

  await withIsolatedDebugTab(7, async (tabId) => {
    setTimeout(() => {
      setTimeout(() => onCreatedListener?.({ id: 102, openerTabId: tabId, active: true }), 0);
    }, 0);
  });

  assert.deepEqual(removed, [101, 102]);
});

test('isolated debug discovers and closes descendants even without an onCreated callback', async () => {
  resetCalls();

  await withIsolatedDebugTab(7, async (tabId) => {
    openTabs.set(102, { id: 102, openerTabId: tabId, active: false, status: 'complete' });
  });

  assert.deepEqual(removed, [102, 101]);
});
