import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `export { reconcileSessionSyncTask, isSessionVisibleInTab } from './src/content/float-ball/session-sync.ts';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { reconcileSessionSyncTask, isSessionVisibleInTab } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

const task = (overrides = {}) => ({
  id: 'session-1',
  query: '查天气',
  title: '查天气',
  status: 'running',
  resultHtml: '',
  callStack: [],
  errorMsg: '',
  lastAIText: '',
  agentPhase: 'act',
  agentRound: 2,
  failureCode: '',
  startedAt: 100,
  endedAt: null,
  durationMs: null,
  ...overrides,
});

test('terminal session sync updates the active task with final metadata', () => {
  const result = reconcileSessionSyncTask(task(), {
    sessionId: 'session-1',
    status: 'error',
    endedAt: 300,
    durationMs: 200,
    failureCode: 'E_TOOL_EXEC',
    lastError: '页面操作失败',
    agentState: { phase: 'error', round: 3 },
  }, 999);

  assert.equal(result.kind, 'update');
  assert.deepEqual(result.update, {
    status: 'error',
    activeRunId: undefined,
    endedAt: 300,
    durationMs: 200,
    failureCode: 'E_TOOL_EXEC',
    errorMsg: '页面操作失败',
    agentPhase: 'error',
    agentRound: 3,
  });
});

test('terminal sync binds a temporary running task to the real session id', () => {
  const result = reconcileSessionSyncTask(task({ id: 'temp-id' }), {
    sessionId: 'session-2',
    status: 'done',
    summary: '已完成搜索',
    startedAt: 110,
    endedAt: 250,
    durationMs: 140,
  }, 999);

  assert.equal(result.kind, 'update');
  assert.equal(result.update.id, 'session-2');
  assert.equal(result.update.status, 'done');
  assert.equal(result.update.title, '已完成搜索');
});

test('session clear only removes the matching task', () => {
  assert.equal(reconcileSessionSyncTask(task(), { sessionId: 'other', status: 'cleared' }, 999).kind, 'ignore');
  assert.equal(reconcileSessionSyncTask(task(), { sessionId: 'session-1', status: 'cleared' }, 999).kind, 'clear');
});

test('isSessionVisibleInTab 只接受当前标签页的会话事件', () => {
  assert.equal(isSessionVisibleInTab(12, 12), true);
  assert.equal(isSessionVisibleInTab(12, 34), false);
});

test('isSessionVisibleInTab 对缺少来源或自身标签页的旧事件保持兼容', () => {
  assert.equal(isSessionVisibleInTab(undefined, 12), true);
  assert.equal(isSessionVisibleInTab(12, null), false);
  assert.equal(isSessionVisibleInTab(undefined, null), true);
});
