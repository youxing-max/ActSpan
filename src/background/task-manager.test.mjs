import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const values = {};
const removedTabs = [];
globalThis.chrome = { storage: { local: {
  async get(key) { return { [key]: values[key] }; },
  async set(items) { Object.assign(values, items); },
} }, tabs: {
  async remove(tabId) { removedTabs.push(tabId); },
} };

const bundle = await build({
  stdin: { contents: `
    export { TaskManager } from './src/background/task-manager.ts';
    export { TabLeaseManager } from './src/background/tab-lease-manager.ts';
    export { PolicyExecutor } from './src/background/policy-executor.ts';
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { TaskManager, TabLeaseManager, PolicyExecutor } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

const context = (task, tabId) => ({ clientId: task.clientId, requestId: `r-${Math.random()}`, taskId: task.taskId, sessionId: task.sessionId, owner: task.owner, tabId });

test('explicit page reads require a task-owned tab', async () => {
  const leases = new TabLeaseManager();
  const tasks = new TaskManager(leases);
  const task = tasks.create({ sessionId: 's', owner: 'ide-agent', clientId: 'c' });
  const executor = new PolicyExecutor(tasks, leases);
  let effects = 0;
  executor.registerCapabilityHandler('page.read', async () => { effects++; return 'read'; });
  await assert.rejects(() => executor.execute(context(task, 15), 'page.read', { tabId: 15 }), /不属于|任务/);
  assert.equal(effects, 0);
});

test('cancelling a task closes its owned tabs', async () => {
  removedTabs.length = 0;
  const leases = new TabLeaseManager();
  const tasks = new TaskManager(leases);
  const task = tasks.create({ sessionId: 's', owner: 'ide-agent', clientId: 'c' });
  leases.acquire(task, 21, 'c');
  assert.equal(tasks.cancel(task.taskId), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(removedTabs, [21]);
});

test('closing an owned tab removes it from later task cleanup', async () => {
  const leases = new TabLeaseManager();
  const tasks = new TaskManager(leases);
  const task = tasks.create({ sessionId: 's', owner: 'ide-agent', clientId: 'c' });
  leases.acquire(task, 22, 'c');
  const executor = new PolicyExecutor(tasks, leases);
  executor.registerCapabilityHandler('tab.close', async () => ({ closed: true }));
  const closeContext = { ...context(task, 22), workflowStep: true };
  executor.approve(closeContext.requestId, closeContext.clientId, closeContext.taskId, 22);
  await executor.execute(closeContext, 'tab.close', { tabId: 22 });
  assert.deepEqual(task.ownedTabIds, []);
  assert.equal(task.activeTabId, undefined);
});

test('cleanup does not remove a tab reassigned after lease expiry', async () => {
  removedTabs.length = 0;
  const leases = new TabLeaseManager();
  const tasks = new TaskManager(leases);
  const oldTask = tasks.create({ sessionId: 'old', owner: 'ide-agent', clientId: 'old-client' });
  leases.acquire(oldTask, 23, 'old-client');
  leases.get(23).expiresAt = Date.now() - 1;
  const newTask = tasks.create({ sessionId: 'new', owner: 'ide-agent', clientId: 'new-client' });
  leases.acquire(newTask, 23, 'new-client');
  await tasks.closeOwnedTabs(oldTask.taskId);
  assert.deepEqual(removedTabs, []);
  assert.equal(leases.get(23).taskId, newTask.taskId);
});
test('cleanup preserves explicitly retained owned tabs', async () => {
  removedTabs.length = 0;
  const leases = new TabLeaseManager();
  const tasks = new TaskManager(leases);
  const task = tasks.create({ sessionId: 's', owner: 'ide-agent', clientId: 'c' });
  leases.acquire(task, 25, 'c');
  leases.acquire(task, 26, 'c');
  await tasks.closeOwnedTabs(task.taskId, new Set([26]));
  assert.deepEqual(removedTabs, [25]);
  assert.deepEqual(task.ownedTabIds, [26]);
  assert.equal(leases.get(25)?.releasedAt !== undefined, true);
  assert.equal(leases.get(26)?.releasedAt, undefined);
});


test('separate task leases isolate explicit tabs and allow independent progress', async () => {
  const leases = new TabLeaseManager();
  const tasks = new TaskManager(leases);
  const a = tasks.create({ sessionId: 's1', owner: 'ide-agent', clientId: 'a' });
  const b = tasks.create({ sessionId: 's2', owner: 'ide-agent', clientId: 'b' });
  leases.acquire(a, 11, 'a');
  leases.acquire(b, 12, 'b');
  assert.throws(() => leases.authorize(context(b, 11), 11), /不属于/);
  const order = [];
  await Promise.all([
    leases.serialize(11, async () => { await new Promise(r => setTimeout(r, 10)); order.push('a'); }),
    leases.serialize(12, async () => { order.push('b'); }),
  ]);
  assert.deepEqual(order.sort(), ['a', 'b']);
});

test('same-tab operations are FIFO and cancellation blocks queued side effects', async () => {
  const leases = new TabLeaseManager();
  const tasks = new TaskManager(leases);
  const task = tasks.create({ sessionId: 's', owner: 'ide-agent', clientId: 'c' });
  leases.acquire(task, 7, 'c');
  const executor = new PolicyExecutor(tasks, leases);
  const effects = [];
  executor.registerCapabilityHandler('page.click', async (_input) => { effects.push('click'); });
  const firstContext = context(task, 7);
  executor.approve(firstContext.requestId, firstContext.clientId, firstContext.taskId, 7);
  const first = executor.execute(firstContext, 'page.click', { tabId: 7 });
  await executor.cancel(task.taskId);
  const cancelledContext = context(task, 7);
  executor.approve(cancelledContext.requestId, cancelledContext.clientId, cancelledContext.taskId, 7);
  await assert.rejects(() => executor.execute(cancelledContext, 'page.click', { tabId: 7 }), /取消/);
  await first.catch(() => undefined);
  assert.equal(effects.length <= 1, true);
});

test('aborting a queued tab operation prevents its handler after the prior operation releases', async () => {
  const leases = new TabLeaseManager();
  let releaseFirst;
  const first = leases.serialize(7, async () => new Promise(resolve => { releaseFirst = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const controller = new AbortController();
  let effects = 0;
  const queued = leases.serialize(7, async () => { effects++; }, controller.signal);
  controller.abort('cancelled');
  await assert.rejects(queued, /取消/);
  let nextEffects = 0;
  const next = leases.serialize(7, async () => { nextEffects++; });
  releaseFirst();
  await first;
  await next;
  assert.equal(effects, 0);
  assert.equal(nextEffects, 1);
});

test('debugger detach is owned and does not detach another task', async () => {
  const leases = new TabLeaseManager();
  const tasks = new TaskManager(leases);
  const task = tasks.create({ sessionId: 's', owner: 'ide-agent', clientId: 'c' });
  leases.acquire(task, 9, 'c');
  const calls = [];
  await leases.withDebugger(context(task, 9), 9, async () => calls.push('attach'), async () => calls.push('detach'), async () => 'ok');
  assert.deepEqual(calls, ['attach']);
  leases.release(task.taskId, 9, 'c');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['attach', 'detach']);
});
test('reading task status does not finalize the task with its own response', async () => {
  const leases = new TabLeaseManager();
  const tasks = new TaskManager(leases);
  const task = tasks.create({ sessionId: 's', owner: 'ide-agent', clientId: 'c' });
  const executor = new PolicyExecutor(tasks, leases);
  const status = await executor.execute(context(task), 'task.status', {});
  assert.equal(status.taskId, task.taskId);
  const result = await executor.execute(context(task), 'task.result', {});
  assert.deepEqual(result, { taskId: task.taskId, state: 'queued', result: undefined, error: undefined });
  assert.equal(tasks.get(task.taskId).state, 'queued');
  assert.equal(tasks.get(task.taskId).result, undefined);
});

test('direct tab.open creates an owned task and rejects a second client before side effects', async () => {
  const leases = new TabLeaseManager();
  const tasks = new TaskManager(leases);
  const executor = new PolicyExecutor(tasks, leases);
  let effects = 0;
  executor.registerCapabilityHandler('tab.open', async () => { effects++; return { tabId: 21 }; });
  const first = { clientId: 'one', requestId: 'r1', taskId: 'direct-1', sessionId: 's1', owner: 'ide-agent' };
  await executor.execute(first, 'tab.open', {});
  assert.equal(tasks.get('direct-1')?.ownedTabIds.includes(21), true);
  await assert.rejects(() => executor.execute({ ...first, clientId: 'two', requestId: 'r2' }, 'tab.open', {}), /client|session|任务/);
  assert.equal(effects, 1);
  assert.equal(await executor.cancel('direct-1'), false);
  assert.equal(leases.get(21)?.taskId, 'direct-1');
  assert.deepEqual(tasks.get('direct-1')?.ownedTabIds, [21]);
});

// tabId 是调用方可选参数：省略它不能成为免确认的理由，否则 page.* 的写动作会直接落到
// 任务的活动标签页上。判据必须来自 capability。
test('page writes and tab.navigate need approval even when the caller omits tabId', async () => {
  const leases = new TabLeaseManager();
  const tasks = new TaskManager(leases);
  const executor = new PolicyExecutor(tasks, leases);
  const task = tasks.create({ taskId: 'approve-1', sessionId: 's1', owner: 'ide-agent', clientId: 'c1' });
  let effects = 0;
  for (const capability of ['page.click', 'page.type', 'page.select', 'page.scroll', 'tab.navigate']) {
    executor.registerCapabilityHandler(capability, async () => { effects++; return { changed: true }; });
  }
  const bare = { clientId: task.clientId, requestId: 'r-bare', taskId: task.taskId, sessionId: task.sessionId, owner: task.owner };
  for (const capability of ['page.click', 'page.type', 'page.select', 'page.scroll', 'tab.navigate']) {
    await assert.rejects(() => executor.execute(bare, capability, {}), /E_APPROVAL_REQUIRED|明确确认/, capability);
  }
  assert.equal(effects, 0);
  // 绑定请求的确认放行后同一调用可以落地。
  executor.approve('r-bare', task.clientId, task.taskId);
  await executor.execute(bare, 'page.click', {});
  assert.equal(effects, 1);
});
test('session tab registry labels default and foreign slots without changing page chrome', async () => {
  const leases = new TabLeaseManager();
  const tasks = new TaskManager(leases);
  const first = tasks.create({ taskId: 'registry-a', sessionId: 'registry-session', owner: 'ide-agent', clientId: 'client-a' });
  const foreign = tasks.create({ taskId: 'registry-b', sessionId: 'other-session', owner: 'ide-agent', clientId: 'client-b' });
  leases.acquire(first, 31, 'client-a');
  leases.registerTab(first, 31, { label: '主线' });
  leases.acquire(first, 32, 'client-a');
  leases.registerTab(first, 32, { label: '副线', defaultSlot: false });
  leases.acquire(foreign, 33, 'client-b');
  leases.registerTab(foreign, 33, { label: '别的会话' });
  assert.deepEqual(leases.listTabs({ sessionId: first.sessionId, clientId: first.clientId }), [
    { tabId: 31, sessionId: 'registry-session', clientId: 'client-a', taskId: 'registry-a', label: '主线', marker: '*' },
    { tabId: 32, sessionId: 'registry-session', clientId: 'client-a', taskId: 'registry-a', label: '副线', marker: '+' },
    { tabId: 33, sessionId: 'other-session', clientId: 'client-b', taskId: 'registry-b', label: '别的会话', marker: '×' },
  ]);
  assert.equal(first.activeTabId, 31);
  assert.equal(chrome.tabs.update, undefined);
  await tasks.persist();
  assert.equal(Array.isArray(values.actspan_task_state.ownTabs), true);
});

test('write authorization rejects foreign durable ownership before side effects', () => {
  const leases = new TabLeaseManager();
  const tasks = new TaskManager(leases);
  const owner = tasks.create({ taskId: 'write-owner', sessionId: 'write-session', owner: 'ide-agent', clientId: 'owner' });
  const other = tasks.create({ taskId: 'write-other', sessionId: 'other-session', owner: 'ide-agent', clientId: 'other' });
  leases.acquire(owner, 34, 'owner');
  leases.registerTab(owner, 34, { label: '主线' });
  let effects = 0;
  assert.throws(() => { leases.authorizeWrite({ ...context(other, 34), tabId: 34 }, 34); effects++; }, /tabs\.list|会话|占用/);
  assert.equal(effects, 0);
});

test('expired owner can be replaced and the replacement updates the registry', () => {
  const leases = new TabLeaseManager();
  const tasks = new TaskManager(leases);
  const oldTask = tasks.create({ taskId: 'dead-owner', sessionId: 'dead-session', owner: 'ide-agent', clientId: 'dead' });
  leases.acquire(oldTask, 35, 'dead');
  leases.registerTab(oldTask, 35, { label: '遗留页' });
  leases.get(35).expiresAt = Date.now() - 1;
  const replacement = tasks.create({ taskId: 'replacement', sessionId: 'new-session', owner: 'ide-agent', clientId: 'new' });
  leases.acquire(replacement, 35, 'new');
  leases.registerTab(replacement, 35, { label: '接管页' });
  assert.deepEqual(leases.listTabs({ sessionId: 'new-session', clientId: 'new' }).map(({ tabId, label, marker }) => ({ tabId, label, marker })), [{ tabId: 35, label: '接管页', marker: '*' }]);
});

test('child attachment returns parent and child only for an actual new tab', () => {
  const leases = new TabLeaseManager();
  const tasks = new TaskManager(leases);
  const task = tasks.create({ taskId: 'child-owner', sessionId: 'child-session', owner: 'ide-agent', clientId: 'child' });
  leases.acquire(task, 36, 'child');
  leases.registerTab(task, 36);
  assert.deepEqual(leases.attachNewTab(task, 36, 37), { parentTabId: 36, tabId: 37 });
  assert.throws(() => leases.attachNewTab(task, 36, 36), /新标签页/);
  assert.equal(task.ownedTabIds.includes(37), true);
});

test('default-slot reminder is emitted at most once per ten minutes', () => {
  const leases = new TabLeaseManager();
  const tasks = new TaskManager(leases);
  const task = tasks.create({ taskId: 'cooldown', sessionId: 'cooldown-session', owner: 'ide-agent', clientId: 'cooldown-client' });
  leases.acquire(task, 38, 'cooldown-client');
  leases.registerTab(task, 38);
  leases.acquire(task, 39, 'cooldown-client');
  leases.registerTab(task, 39, { defaultSlot: false });
  const context = { sessionId: task.sessionId, clientId: task.clientId, taskId: task.taskId };
  assert.match(leases.getReminder(context, 1_000), /tabId/);
  assert.equal(leases.getReminder(context, 1_001), undefined);
  assert.match(leases.getReminder(context, 601_001), /tabId/);
});
test('disconnected owner may be inherited without waiting for its task lease to expire', () => {
  const leases = new TabLeaseManager();
  const tasks = new TaskManager(leases);
  const old = tasks.create({ taskId: 'disconnected', sessionId: 'gone', owner: 'ide-agent', clientId: 'gone' });
  leases.acquire(old, 40, 'gone');
  leases.setSessionConnected({ sessionId: 'gone', clientId: 'gone' }, false);
  const replacement = tasks.create({ taskId: 'inherited', sessionId: 'here', owner: 'ide-agent', clientId: 'here' });
  leases.acquire(replacement, 40, 'here');
  assert.equal(leases.authorizeWrite(context(replacement, 40), 40).taskId, replacement.taskId);
  assert.throws(() => leases.authorizeWrite(context(old, 40), 40), /不属于/);
});

test('durable registry survives task manager restore with multiple labels and ownership intact', async () => {
  const leases = new TabLeaseManager();
  const tasks = new TaskManager(leases);
  const task = tasks.create({ taskId: 'persisted', sessionId: 'persistent-session', owner: 'ide-agent', clientId: 'persistent-client' });
  leases.acquire(task, 41, task.clientId);
  leases.registerTab(task, 41, { label: '详情' });
  leases.acquire(task, 42, task.clientId);
  leases.registerTab(task, 42, { label: '搜索', defaultSlot: false });
  tasks.markSucceeded(task.taskId, { done: true });
  await tasks.persist();
  const restoredLeases = new TabLeaseManager();
  const restored = new TaskManager(restoredLeases);
  await restored.restore();
  assert.deepEqual(restoredLeases.listTabs(context(task)), leases.listTabs(context(task)));
  assert.equal(restoredLeases.authorizeWrite(context(task, 42), 42).taskId, task.taskId);
});

test('new-tab following uses actual creation events and never reports a reused or absent child', async () => {
  const event = () => {
    const listeners = new Set();
    return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: value => { for (const fn of listeners) fn(value); }, get size() { return listeners.size; } };
  };
  const onCreated = event();
  const onCreatedNavigationTarget = event();
  let browserTabs = [{ id: 43 }, { id: 44, openerTabId: 43 }];
  const previousTabs = chrome.tabs;
  const previousNavigation = chrome.webNavigation;
  chrome.tabs = { ...previousTabs, onCreated, query: async () => browserTabs };
  chrome.webNavigation = { onCreatedNavigationTarget };
  try {
    const leases = new TabLeaseManager();
    const tasks = new TaskManager(leases);
    const task = tasks.create({ taskId: 'follow-owner', sessionId: 'follow-session', owner: 'ide-agent', clientId: 'follow' });
    leases.acquire(task, 43, 'follow');
    const noChild = await tasks.withNewTabs(context(task, 43), 43, async () => {
      onCreatedNavigationTarget.emit({ sourceTabId: 43, tabId: 44 });
      return 'same-page';
    });
    assert.deepEqual(noChild, { result: 'same-page', parentTabId: 43 });
    assert.equal(leases.get(44), undefined);
    const child = await tasks.withNewTabs(context(task, 43), 43, async () => {
      const tab = { id: 45, openerTabId: 43 };
      browserTabs = [...browserTabs, tab];
      onCreated.emit(tab);
      onCreatedNavigationTarget.emit({ sourceTabId: 43, tabId: 45 });
      return 'opened';
    });
    assert.deepEqual(child, { result: 'opened', parentTabId: 43, tabId: 45, newTabIds: [45] });
    assert.equal(leases.authorizeWrite(context(task, 45), 45).taskId, task.taskId);
    assert.equal(onCreated.size, 0);
    assert.equal(onCreatedNavigationTarget.size, 0);
    assert.equal(values.actspan_task_state.ownTabs.some(record => record.tabId === 45), true);
  } finally { chrome.tabs = previousTabs; chrome.webNavigation = previousNavigation; }
});
test('same session text does not merge clients and unleased tabs cannot enter the registry', () => {
  const leases = new TabLeaseManager();
  const tasks = new TaskManager(leases);
  const owner = tasks.create({ taskId: 'same-session-owner', sessionId: 'same-text', owner: 'ide-agent', clientId: 'client-one' });
  const stranger = tasks.create({ taskId: 'same-session-stranger', sessionId: 'same-text', owner: 'ide-agent', clientId: 'client-two' });
  leases.acquire(owner, 46, owner.clientId);
  assert.throws(() => leases.registerTab(stranger, 47), /任务/);
  assert.throws(() => leases.acquire(stranger, 46, stranger.clientId), /tabs\.list/);
  assert.match(leases.selectTab(context(stranger), 46).warning, /占用/);
  assert.equal(leases.listTabs(context(stranger))[0].marker, '×');
});

test('debugger operation rechecks ownership after asynchronous attach', async () => {
  const leases = new TabLeaseManager();
  const tasks = new TaskManager(leases);
  const owner = tasks.create({ taskId: 'attach-owner', sessionId: 'attach-owner', owner: 'ide-agent', clientId: 'attach-owner' });
  const next = tasks.create({ taskId: 'attach-next', sessionId: 'attach-next', owner: 'ide-agent', clientId: 'attach-next' });
  leases.acquire(owner, 48, owner.clientId);
  let effects = 0;
  await assert.rejects(leases.withDebugger(context(owner, 48), 48, async () => {
    leases.setSessionConnected(context(owner), false);
    leases.acquire(next, 48, next.clientId);
  }, async () => {}, async () => { effects++; }), /不属于/);
  assert.equal(effects, 0);
});
test('explicit lease client is preserved when legacy tasks omit their client field', () => {
  const leases = new TabLeaseManager();
  const tasks = new TaskManager(leases);
  const task = tasks.create({ taskId: 'legacy-client', sessionId: 'legacy-session', owner: 'ide-agent' });
  leases.acquire(task, 49, 'explicit-client');
  assert.equal(leases.authorizeWrite({ ...context(task, 49), clientId: 'explicit-client' }, 49).clientId, 'explicit-client');
});


test('continue and replace cancel same-session runs but preserve cross-session concurrency', () => {
  const leases = new TabLeaseManager();
  const tasks = new TaskManager(leases);
  const first = tasks.create({ taskId: 'same-1', sessionId: 'same', owner: 'ide-agent', clientId: 'c' });
  tasks.markRunning(first.taskId);
  const other = tasks.create({ taskId: 'other-1', sessionId: 'other', owner: 'ide-agent', clientId: 'c' });
  tasks.markRunning(other.taskId);
  const next = tasks.create({ taskId: 'same-2', sessionId: 'same', owner: 'ide-agent', clientId: 'c', mode: 'continue' });
  assert.equal(tasks.get(first.taskId).state, 'cancelled');
  assert.equal(tasks.get(other.taskId).state, 'running');
  assert.equal(next.state, 'queued');
});

test('continue replacement cannot cancel another client in the same session', () => {
  const tasks = new TaskManager(new TabLeaseManager());
  const foreign = tasks.create({ taskId: 'foreign', sessionId: 'shared', owner: 'ide-agent', clientId: 'other' });
  tasks.markRunning(foreign.taskId);
  const next = tasks.create({ taskId: 'next', sessionId: 'shared', owner: 'ide-agent', clientId: 'current', mode: 'continue' });
  assert.equal(tasks.get(foreign.taskId).state, 'running');
  assert.equal(next.state, 'queued');
});

test('restore deterministically fails interrupted tasks and keeps idempotent cancel state', async () => {
  values.actspan_task_state = { version: 1, tasks: [{ taskId: 'restart-1', sessionId: 's', owner: 'ide-agent', state: 'running', ownedTabIds: [], registryRevision: 3, createdAt: 1, updatedAt: 1 }], leases: [], updatedAt: 1 };
  const tasks = new TaskManager(new TabLeaseManager());
  await tasks.restore();
  const restored = tasks.get('restart-1');
  assert.equal(restored.state, 'failed');
  assert.equal(restored.error.code, 'E_TASK_RUNTIME_INTERRUPTED');
  assert.equal(tasks.cancel('restart-1'), false);
});

test('restore closes tabs owned by interrupted tasks and releases their leases', async () => {
  removedTabs.length = 0;
  values.actspan_task_state = {
    version: 1,
    tasks: [{ taskId: 'restart-owned', sessionId: 's', owner: 'ide-agent', clientId: 'c', state: 'running', ownedTabIds: [24], registryRevision: 1, createdAt: 1, updatedAt: 1 }],
    leases: [{ taskId: 'restart-owned', sessionId: 's', clientId: 'c', tabId: 24, creator: 'ide-agent', createdAt: 1, expiresAt: Date.now() + 10000 }],
    updatedAt: 1,
  };
  const leases = new TabLeaseManager();
  const tasks = new TaskManager(leases);
  await tasks.restore();
  assert.deepEqual(removedTabs, [24]);
  assert.deepEqual(tasks.get('restart-owned')?.ownedTabIds, []);
  assert.equal(leases.get(24)?.releasedAt !== undefined, true);
});

test('cancelling a parent aborts child Agent Loop tasks', () => {
  const tasks = new TaskManager(new TabLeaseManager());
  const parent = tasks.create({ taskId: 'parent', sessionId: 's', owner: 'ide-agent', clientId: 'c' });
  const child = tasks.create({ taskId: 'child', parentTaskId: parent.taskId, sessionId: 's', owner: 'extension-agent', clientId: 'c' });
  tasks.markRunning(parent.taskId);
  tasks.markRunning(child.taskId);
  assert.equal(tasks.cancel(parent.taskId), true);
  assert.equal(tasks.get(child.taskId).state, 'cancelled');
});
test('task cancellation aborts registered workflow controllers', () => {
  const tasks = new TaskManager(new TabLeaseManager());
  const task = tasks.create({ taskId: 'workflow-1', sessionId: 's', owner: 'ide-agent', clientId: 'c' });
  const controller = tasks.createAbortController(task.taskId);
  assert.equal(controller.signal.aborted, false);
  assert.equal(tasks.cancel(task.taskId), true);
  assert.equal(controller.signal.aborted, true);
});

// 取消是终态，但终态必须可读：task.status / task.result / task.cancel 是取消后的唯一
// 观测入口，若它们也走「任务已取消」门禁，客户端永远读不到终态，重试取消也会报错。
test('cancelled task still reports terminal state and repeated cancel is idempotent', async () => {
  const leases = new TabLeaseManager();
  const tasks = new TaskManager(leases);
  const task = tasks.create({ taskId: 'cancelled-read-1', sessionId: 's', owner: 'ide-agent', clientId: 'c' });
  tasks.markRunning(task.taskId);
  const executor = new PolicyExecutor(tasks, leases);
  assert.equal(await executor.cancel(task.taskId), true);

  const status = await executor.execute(context(task), 'task.status', {});
  assert.equal(status.taskId, task.taskId);
  assert.equal(status.state, 'cancelled');

  const result = await executor.execute(context(task), 'task.result', {});
  assert.deepEqual(result, { taskId: task.taskId, state: 'cancelled', result: undefined, error: undefined });

  const again = await executor.execute(context(task), 'task.cancel', {});
  assert.deepEqual(again, { taskId: task.taskId, cancelled: false });
  assert.equal(tasks.get(task.taskId).state, 'cancelled');
});

// 只有本次调用自建的单动作任务才由执行器收尾；agent 任务的 state 归 runner 与 workflow
// 执行器管理，一次旁路能力调用不能把它提前标成 succeeded。
test('a running task is not finalized by unrelated capabilities', async () => {
  const leases = new TabLeaseManager();
  const tasks = new TaskManager(leases);
  const task = tasks.create({ taskId: 'running-bystander-1', sessionId: 's', owner: 'ide-agent', clientId: 'c' });
  tasks.markRunning(task.taskId);
  const executor = new PolicyExecutor(tasks, leases);
  executor.registerCapabilityHandler('ping', async () => 'pong');
  executor.registerCapabilityHandler('tabs.list', async () => []);
  executor.registerCapabilityHandler('feishu.push', async () => ({ ok: true }));

  assert.equal(await executor.execute(context(task), 'ping', {}), 'pong');
  assert.deepEqual(await executor.execute(context(task), 'tabs.list', {}), []);
  assert.deepEqual(await executor.execute(context(task), 'feishu.push', {}), { ok: true });

  assert.equal(tasks.get(task.taskId).state, 'running');
  assert.equal(tasks.get(task.taskId).result, undefined);
});

// data.* 与 tab.open / page.read 一样是单动作入口：没有任务时应当自建任务，而不是要求
// 调用方先凭空拥有一个任务。
test('data capabilities create their own task when none exists', async () => {
  const leases = new TabLeaseManager();
  const tasks = new TaskManager(leases);
  const executor = new PolicyExecutor(tasks, leases);
  const calls = [];
  executor.registerCapabilityHandler('data.fetch', async () => { calls.push('fetch'); return { ok: 'fetch' }; }, 'read');
  executor.registerCapabilityHandler('data.paginate', async () => { calls.push('paginate'); return { ok: 'paginate' }; }, 'read');
  executor.registerCapabilityHandler('data.download', async () => { calls.push('download'); return { ok: 'download' }; }, 'interact');

  for (const capability of ['data.fetch', 'data.paginate', 'data.download']) {
    const taskId = `data-${capability}`;
    const dataContext = { clientId: 'data-client', requestId: `r-${capability}`, taskId, sessionId: 'data-session', owner: 'ide-agent' };
    assert.deepEqual(await executor.execute(dataContext, capability, {}), { ok: capability.slice(5) });
  }

  assert.deepEqual(calls, ['fetch', 'paginate', 'download']);
  assert.equal(tasks.get('data-data.fetch').state, 'succeeded');
  assert.equal(tasks.get('data-data.paginate').state, 'succeeded');
  assert.equal(tasks.get('data-data.download').state, 'succeeded');
});
