import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const calls = { updated: [], removed: [], reloaded: [], duplicated: [], moved: [], back: [], forward: [], created: [] };

globalThis.chrome = {
  tabs: {
    async update(tabId, properties) {
      calls.updated.push({ tabId, properties: { ...properties } });
      return {
        id: tabId,
        url: properties.url,
        pendingUrl: properties.url,
        active: properties.active ?? false,
        pinned: properties.pinned ?? false,
        mutedInfo: { muted: properties.muted ?? false },
      };
    },
    async remove(tabId) { calls.removed.push(tabId); },
    async reload(tabId, properties) { calls.reloaded.push({ tabId, properties: { ...properties } }); },
    async duplicate(tabId) { calls.duplicated.push(tabId); return { id: 900, url: 'https://dup.test/', title: 'dup' }; },
    async move(tabId, properties) { calls.moved.push({ tabId, properties: { ...properties } }); return { id: tabId, index: properties.index }; },
    async goBack(tabId) { calls.back.push(tabId); },
    async goForward(tabId) { calls.forward.push(tabId); },
    async get(tabId) { return { id: tabId, url: 'https://owned.test/', title: 'owned', active: true }; },
    async create(properties) {
      calls.created.push({ ...properties });
      return { id: 555, url: properties.url, pendingUrl: properties.url, active: properties.active };
    },
    async query() {
      return [{ id: 100, title: 'owned', url: 'https://owned.test/', active: true, index: 0 }];
    },
  },
};

const bundle = await build({
  stdin: {
    contents: `
      export { tabNavigateFunction } from './src/functions/tab-navigate.ts';
      export { tabLeaseManager } from './src/background/tab-lease-manager.ts';
      export { taskManager } from './src/background/task-manager.ts';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { tabNavigateFunction, tabLeaseManager, taskManager } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`
);

const OWNED_TAB_ID = 100;
const makeTask = (overrides = {}) => ({
  taskId: 't1', sessionId: 's1', owner: 'extension-agent', clientId: 'c1',
  state: 'running', ownedTabIds: [], registryRevision: 0,
  createdAt: Date.now(), updatedAt: Date.now(), ...overrides,
});
const leaseTask = makeTask();
tabLeaseManager.acquire(leaseTask, OWNED_TAB_ID, 'c1');

const ownerContext = { clientId: 'c1', requestId: 'r1', taskId: 't1', sessionId: 's1', owner: 'extension-agent' };
const foreignContext = { clientId: 'c2', requestId: 'r2', taskId: 't2', sessionId: 's2', owner: 'extension-agent' };

const resetCalls = () => {
  for (const key of Object.keys(calls)) calls[key].length = 0;
};

const writeActions = [
  ['navigate', { action: 'navigate', url: 'https://other.test/', tab_id: OWNED_TAB_ID }],
  ['close', { action: 'close', tab_id: OWNED_TAB_ID }],
  ['switch', { action: 'switch', tab_id: OWNED_TAB_ID }],
  ['reload', { action: 'reload', tab_id: OWNED_TAB_ID }],
  ['duplicate', { action: 'duplicate', tab_id: OWNED_TAB_ID }],
  ['pin', { action: 'pin', tab_id: OWNED_TAB_ID }],
  ['mute', { action: 'mute', tab_id: OWNED_TAB_ID }],
  ['move', { action: 'move', tab_id: OWNED_TAB_ID, index: 1 }],
  ['go_back', { action: 'go_back', tab_id: OWNED_TAB_ID }],
  ['go_forward', { action: 'go_forward', tab_id: OWNED_TAB_ID }],
];

for (const [label, params] of writeActions) {
  test(`tab_navigate ${label} rejects a tab owned by another task`, async () => {
    resetCalls();
    await assert.rejects(
      () => tabNavigateFunction.execute(params, foreignContext),
      (error) => error?.code === 'E_TAB_OWNERSHIP' && error?.name === 'TabLeaseError',
    );
    assert.equal(calls.updated.length + calls.removed.length + calls.reloaded.length
      + calls.duplicated.length + calls.moved.length + calls.back.length + calls.forward.length, 0,
    'no chrome tab mutation may run after a rejected lease check');
  });
}

test('tab_navigate uses the context tab when a write action omits tab_id', async () => {
  resetCalls();
  await assert.rejects(
    () => tabNavigateFunction.execute(
      { action: 'navigate', url: 'https://other.test/' },
      { ...foreignContext, tabId: OWNED_TAB_ID },
    ),
    (error) => error?.code === 'E_TAB_OWNERSHIP',
  );
  assert.equal(calls.updated.length, 0);
});

test('tab_navigate write actions still run for the owning task', async () => {
  resetCalls();
  const navigate = await tabNavigateFunction.execute(
    { action: 'navigate', url: 'https://owned.test/next' },
    { ...ownerContext, tabId: OWNED_TAB_ID },
  );
  assert.equal(navigate.success, true);
  assert.equal(navigate.data.tab_id, OWNED_TAB_ID);

  const close = await tabNavigateFunction.execute({ action: 'close', tab_id: OWNED_TAB_ID }, ownerContext);
  assert.equal(close.success, true);

  const reload = await tabNavigateFunction.execute({ action: 'reload', tab_id: OWNED_TAB_ID, bypass_cache: true }, ownerContext);
  assert.equal(reload.success, true);

  const pin = await tabNavigateFunction.execute({ action: 'pin', tab_id: OWNED_TAB_ID, pinned: false }, ownerContext);
  assert.equal(pin.success, true);

  assert.equal(calls.updated.length, 2);
  assert.deepEqual(calls.removed, [OWNED_TAB_ID]);
  assert.deepEqual(calls.reloaded, [{ tabId: OWNED_TAB_ID, properties: { bypassCache: true } }]);
});

test('tab_navigate without task lease context keeps working (workflow/debug callers)', async () => {
  resetCalls();
  const result = await tabNavigateFunction.execute(
    { action: 'navigate', url: 'https://debug.test/', tab_id: OWNED_TAB_ID },
    { tabId: OWNED_TAB_ID, isolatedDebug: true },
  );
  assert.equal(result.success, true);
  assert.equal(calls.updated.length, 1);
});

test('tab_navigate open attaches the new tab to the caller task lease', async () => {
  resetCalls();
  taskManager.create({ taskId: 't-open', sessionId: 's-open', clientId: 'c-open', owner: 'extension-agent' });
  const openContext = { clientId: 'c-open', requestId: 'r-open', taskId: 't-open', sessionId: 's-open', owner: 'extension-agent' };

  const opened = await tabNavigateFunction.execute({ action: 'open', url: 'https://fresh.test/' }, openContext);
  assert.equal(opened.success, true);
  const newTabId = opened.data.tab_id;
  assert.equal(tabLeaseManager.get(newTabId)?.taskId, 't-open');

  const navigated = await tabNavigateFunction.execute(
    { action: 'navigate', url: 'https://fresh.test/next', tab_id: newTabId },
    openContext,
  );
  assert.equal(navigated.success, true);

  await assert.rejects(
    () => tabNavigateFunction.execute({ action: 'close', tab_id: newTabId }, foreignContext),
    (error) => error?.code === 'E_TAB_OWNERSHIP',
  );
});

test('tab_navigate read and open actions are not lease-gated', async () => {
  resetCalls();
  const opened = await tabNavigateFunction.execute(
    { action: 'open', url: 'https://new.test/' },
    foreignContext,
  );
  assert.equal(opened.success, true);
  assert.equal(calls.created.length, 1);

  const listed = await tabNavigateFunction.execute({ action: 'list' }, foreignContext);
  assert.equal(listed.success, true);
  assert.equal(listed.data.total, 1);

  const current = await tabNavigateFunction.execute({ action: 'current' }, foreignContext);
  assert.equal(current.success, true);
  assert.equal(current.data.tab_id, OWNED_TAB_ID);
});
