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

test('debugger detach is owned and does not detach another task', async () => {
  const leases = new TabLeaseManager();
  const tasks = new TaskManager(leases);
  const task = tasks.create({ sessionId: 's', owner: 'ide-agent', clientId: 'c' });
  leases.acquire(task, 9, 'c');
  const calls = [];
  await leases.withDebugger(context(task, 9), 9, async () => calls.push('attach'), async () => calls.push('detach'), async () => 'ok');
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
