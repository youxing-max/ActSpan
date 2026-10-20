import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: { contents: `
    export { updateStatus, clearStatusForTask, validateStatusText } from './src/background/status-bridge.ts';
    export { taskManager } from './src/background/task-manager.ts';
    export { tabLeaseManager } from './src/background/tab-lease-manager.ts';
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { updateStatus, clearStatusForTask, validateStatusText, taskManager, tabLeaseManager } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`
);

const sent = [];
globalThis.chrome = {
  tabs: { sendMessage: (tabId, message) => sent.push({ tabId, message }) },
};

const context = (task, tabId) => ({
  clientId: task.clientId,
  requestId: `request-${task.taskId}`,
  taskId: task.taskId,
  sessionId: task.sessionId,
  owner: task.owner,
  tabId,
});

test('status update emits exact event to the matching leased session tab', async () => {
  sent.length = 0;
  const task = taskManager.create({ taskId: 'status-task-a', sessionId: 'status-session-a', owner: 'ide-agent', clientId: 'status-client-a' });
  tabLeaseManager.acquire(task, 101, 'status-client-a');
  const result = await updateStatus({ text: '准备读取结果', language: 'zh-CN' }, context(task, 101));
  assert.deepEqual(result, { acknowledged: true, tabId: 101 });
  assert.deepEqual(sent.at(-1), { tabId: 101, message: { type: '__status_update', data: { text: '准备读取结果', language: 'zh-CN', active: true } } });
});

test('status update never targets another session and enforces 80 characters', async () => {
  const taskA = taskManager.create({ taskId: 'status-task-b', sessionId: 'status-session-b', owner: 'ide-agent', clientId: 'status-client-b' });
  const taskB = taskManager.create({ taskId: 'status-task-c', sessionId: 'status-session-c', owner: 'ide-agent', clientId: 'status-client-c' });
  tabLeaseManager.acquire(taskA, 102, 'status-client-b');
  tabLeaseManager.acquire(taskB, 103, 'status-client-c');
  await assert.rejects(() => updateStatus({ text: '不应发送', tabId: 103 }, context(taskA, 103)), /not owned/);
  assert.throws(() => validateStatusText('a'.repeat(81)), /80/);
  assert.equal(sent.some((item) => item.tabId === 103), false);
});

test('terminal clear sends inactive status to each tab owned by the task', () => {
  sent.length = 0;
  const task = taskManager.create({ taskId: 'status-task-d', sessionId: 'status-session-d', owner: 'ide-agent', clientId: 'status-client-d' });
  tabLeaseManager.acquire(task, 104, 'status-client-d');
  tabLeaseManager.acquire(task, 105, 'status-client-d');
  assert.equal(clearStatusForTask(task.taskId), true);
  assert.deepEqual(sent.map((entry) => entry.tabId).sort(), [104, 105]);
  assert.ok(sent.every((entry) => entry.message.data.active === false && entry.message.data.text === ''));
});

test('task terminal transition automatically clears its status overlay', () => {
  sent.length = 0;
  const task = taskManager.create({ taskId: 'status-task-e', sessionId: 'status-session-e', owner: 'ide-agent', clientId: 'status-client-e' });
  tabLeaseManager.acquire(task, 106, 'status-client-e');
  taskManager.markSucceeded(task.taskId, { done: true });
  assert.deepEqual(sent.at(-1), { tabId: 106, message: { type: '__status_update', data: { text: '', active: false } } });
});
