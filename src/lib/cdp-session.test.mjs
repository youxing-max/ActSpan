import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const handlers = { onDetach: [], onEvent: [] };
const listeners = (bucket) => ({
  addListener(fn) { bucket.push(fn); },
  removeListener() {},
});
const calls = [];
const debuggerApi = {
  onDetach: listeners(handlers.onDetach),
  onEvent: listeners(handlers.onEvent),
  async attach() { calls.push('attach'); },
  async detach() { calls.push('detach'); },
  async sendCommand() { return {}; },
};
globalThis.chrome = { debugger: debuggerApi };
const bundle = await build({
  stdin: {
    contents: `export { CDPSessionManager, L2_IDLE_MS } from './src/lib/cdp-session.ts';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { CDPSessionManager, L2_IDLE_MS } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

// mock timers 只接管定时器；detach 是异步的，tick 之后让出几轮事件循环再断言。
const flushAsyncWork = async () => {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

test('keeps one L2 attach across a command burst and detaches after idle', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  calls.length = 0;
  await CDPSessionManager.sendCommand(41, 'Input.dispatchMouseEvent', { type: 'mouseMoved' });
  await CDPSessionManager.sendCommand(41, 'Input.dispatchMouseEvent', { type: 'mouseMoved' });
  assert.equal(calls.filter((call) => call === 'attach').length, 1);
  t.mock.timers.tick(L2_IDLE_MS + 50);
  await flushAsyncWork();
  assert.equal(calls.filter((call) => call === 'detach').length, 1);
});

test('holds the L2 attach while network capture is active, releases it after stop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  calls.length = 0;
  assert.deepEqual(await CDPSessionManager.startNetworkListening(43), { success: true });
  t.mock.timers.tick(L2_IDLE_MS + 250);
  await flushAsyncWork();
  assert.equal(calls.filter((call) => call === 'detach').length, 0);
  await CDPSessionManager.stopNetworkListening(43);
  t.mock.timers.tick(L2_IDLE_MS + 250);
  await flushAsyncWork();
  assert.equal(calls.filter((call) => call === 'detach').length, 1);
});

test('holds the L2 attach while console capture is active, releases it after stop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  calls.length = 0;
  assert.deepEqual(await CDPSessionManager.startConsoleListening(44), { success: true });
  t.mock.timers.tick(L2_IDLE_MS + 250);
  await flushAsyncWork();
  assert.equal(calls.filter((call) => call === 'detach').length, 0);
  CDPSessionManager.stopConsoleListening(44);
  t.mock.timers.tick(L2_IDLE_MS + 250);
  await flushAsyncWork();
  assert.equal(calls.filter((call) => call === 'detach').length, 1);
});

test('holds the L2 attach while Fetch interception is active, releases it after stop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  calls.length = 0;
  assert.equal((await CDPSessionManager.startFetchInterception(45)).success, true);
  t.mock.timers.tick(L2_IDLE_MS + 250);
  await flushAsyncWork();
  assert.equal(calls.filter((call) => call === 'detach').length, 0);
  await CDPSessionManager.stopFetchInterception(45);
  t.mock.timers.tick(L2_IDLE_MS + 250);
  await flushAsyncWork();
  assert.equal(calls.filter((call) => call === 'detach').length, 1);
});

test('evicts pending requests that never finish instead of letting the map grow', async (t) => {
  // 驱逐判定基于 Date.now，必须连 Date 一起 mock，否则 tick 不会让请求变“陈旧”。
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const tabId = 51;
  const emit = (method, params) => {
    for (const handler of handlers.onEvent) handler({ tabId }, method, params);
  };
  const startRequest = (requestId) => emit('Network.requestWillBeSent', {
    requestId,
    type: 'Fetch',
    request: { url: `https://example.test/${requestId}`, method: 'GET' },
  });
  const ids = (events) => events.map((event) => event.requestId);

  assert.deepEqual(
    await CDPSessionManager.startNetworkListening(tabId, { pendingTimeoutMs: 80 }),
    { success: true },
  );

  // SSE / 长轮询 / chunked：发出 requestWillBeSent 后永远等不到 loadingFinished。
  ['stuck-1', 'stuck-2', 'stuck-3'].forEach(startRequest);
  t.mock.timers.tick(200);
  await flushAsyncWork();

  const evicted = CDPSessionManager.getNetworkEvents(tabId);
  assert.deepEqual(ids(evicted), ['stuck-1', 'stuck-2', 'stuck-3']);
  for (const event of evicted) {
    assert.equal(event.error, 'pending timeout');
    assert.ok(event.endTime >= event.startTime);
    assert.ok(event.durationMs >= 0);
  }

  // 被驱逐的请求再补一条 loadingFinished 不应产生重复事件，证明它已从 pending 移除。
  emit('Network.loadingFinished', { requestId: 'stuck-1' });
  assert.equal(CDPSessionManager.getNetworkEvents(tabId).length, 3);

  // 后续永不完成的请求同样被驱逐：pending 不会随请求数无限增长。
  ['stuck-4', 'stuck-5', 'stuck-6'].forEach(startRequest);
  t.mock.timers.tick(200);
  await flushAsyncWork();
  assert.deepEqual(
    ids(CDPSessionManager.getNetworkEvents(tabId)),
    ['stuck-1', 'stuck-2', 'stuck-3', 'stuck-4', 'stuck-5', 'stuck-6'],
  );

  await CDPSessionManager.stopNetworkListening(tabId);
  // stop 之后仍会安排一次空闲 detach；tick 掉它，避免真实 5s 定时器把进程吊住。
  t.mock.timers.tick(L2_IDLE_MS + 250);
  await flushAsyncWork();
});

test('maps a DevTools collision to L2_BUSY', async () => {
  debuggerApi.attach = async () => { throw new Error('Another debugger is already attached'); };
  const result = await CDPSessionManager.attach(42);
  assert.equal(result.code, 'L2_BUSY');
  assert.match(result.error || '', /L2_BUSY/);
});

test('stops an idle network capture when the max listen duration elapses', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  debuggerApi.attach = async () => { calls.push('attach'); };
  calls.length = 0;
  assert.deepEqual(await CDPSessionManager.startNetworkListening(46), { success: true });
  assert.equal(CDPSessionManager.isNetworkListening(46), true);
  // 30 分钟内没有任何网络事件：到期定时器仍须主动停止监听。
  t.mock.timers.tick(30 * 60_000 + 100);
  await flushAsyncWork();
  assert.equal(CDPSessionManager.isNetworkListening(46), false);
});

test('frame discovery includes out-of-process iframe sessions and routes evaluations to them', async () => {
  const originalSend = debuggerApi.sendCommand;
  const routed = [];
  const tabId = 71;
  const emit = (sessionId, method, params) => {
    for (const handler of handlers.onEvent) handler({ tabId, ...(sessionId ? { sessionId } : {}) }, method, params);
  };
  debuggerApi.sendCommand = async (target, method, params) => {
    routed.push({ target, method, params });
    if (method === 'Target.setAutoAttach' && !target.sessionId) {
      emit(undefined, 'Target.attachedToTarget', { sessionId: 'foreign-session', targetInfo: { type: 'iframe', targetId: 'foreign-frame' } });
    }
    if (method === 'Runtime.enable') {
      emit(target.sessionId, 'Runtime.executionContextCreated', {
        context: { id: 1, auxData: { frameId: target.sessionId ? 'foreign-frame' : 'main-frame', isDefault: true } },
      });
    }
    if (method === 'Page.getFrameTree') return { frameTree: { frame: {
      id: target.sessionId ? 'foreign-frame' : 'main-frame',
      ...(target.sessionId ? { parentId: 'main-frame' } : {}),
      url: target.sessionId ? 'https://foreign.test/' : 'https://main.test/',
    } } };
    return {};
  };
  try {
    const trees = await CDPSessionManager.getFrameTrees(tabId);
    assert.equal(trees.success, true);
    assert.deepEqual(trees.result.frameTrees.map(x => x.frameTree.frame.id), ['main-frame', 'foreign-frame']);
    const foreign = CDPSessionManager.getFrameExecutionContext(tabId, 'foreign-frame');
    assert.deepEqual(foreign, { contextId: 1, sessionId: 'foreign-session' });
    await CDPSessionManager.sendCommand(tabId, 'Runtime.evaluate', { expression: 'document.title', contextId: foreign.contextId, throwOnSideEffect: true }, foreign.sessionId);
    assert.deepEqual(routed.at(-1).target, { tabId, sessionId: 'foreign-session' });
    emit('foreign-session', 'Runtime.executionContextDestroyed', { executionContextId: 1 });
    assert.equal(CDPSessionManager.getFrameExecutionContext(tabId, 'foreign-frame'), null);
    assert.equal(CDPSessionManager.getFrameContextId(tabId, 'main-frame'), 1, 'context ids collide across renderer sessions');
    emit(undefined, 'Target.detachedFromTarget', { sessionId: 'foreign-session' });
    assert.equal(CDPSessionManager.isAttached(tabId), true);
  } finally {
    await CDPSessionManager.detach(tabId);
    debuggerApi.sendCommand = originalSend;
  }
});

test('nested iframe discovery isolates context clearing, listener events and child detaches', async () => {
  const originalSend = debuggerApi.sendCommand;
  const tabId = 72;
  const emit = (sessionId, method, params) => {
    for (const handler of handlers.onEvent) handler({ tabId, ...(sessionId ? { sessionId } : {}) }, method, params);
  };
  const createContext = (sessionId) => emit(sessionId, 'Runtime.executionContextCreated', {
    context: { id: 1, auxData: { frameId: sessionId || 'main', isDefault: true } },
  });
  debuggerApi.sendCommand = async ({ sessionId }, method) => {
    if (method === 'Target.setAutoAttach' && sessionId !== 'nested') {
      const childId = sessionId ? 'nested' : 'child';
      emit(sessionId, 'Target.attachedToTarget', { sessionId: childId, targetInfo: { type: 'iframe', targetId: childId } });
    }
    if (method === 'Runtime.enable') createContext(sessionId);
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: sessionId || 'main' } } };
    if (method === 'Runtime.evaluate' && sessionId === 'child') throw new Error('Debugger is not attached');
    return {};
  };
  try {
    const trees = await CDPSessionManager.getFrameTrees(tabId);
    assert.equal(trees.success, true);
    assert.deepEqual(trees.result.frameTrees.map(x => x.frameTree.frame.id), ['main', 'child', 'nested']);
    emit('child', 'Runtime.executionContextsCleared', {});
    assert.equal(CDPSessionManager.getFrameContextId(tabId, 'child'), null);
    assert.equal(CDPSessionManager.getFrameContextId(tabId, 'main'), 1);
    assert.equal(CDPSessionManager.getFrameContextId(tabId, 'nested'), 1);
    createContext('child');
    emit(undefined, 'Runtime.executionContextsCleared', {});
    assert.equal(CDPSessionManager.getFrameContextId(tabId, 'main'), null);
    assert.equal(CDPSessionManager.getFrameContextId(tabId, 'child'), 1);
    createContext(undefined);

    await CDPSessionManager.startConsoleListening(tabId);
    emit('child', 'Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'child' }] });
    emit(undefined, 'Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'main' }] });
    assert.deepEqual(CDPSessionManager.getConsoleEntries(tabId).map(x => x.text), ['main']);
    emit('child', 'Page.javascriptDialogOpening', { message: 'child dialog' });
    assert.equal(CDPSessionManager.getPendingDialog(tabId), null);

    const result = await CDPSessionManager.sendCommand(tabId, 'Runtime.evaluate', {}, 'child');
    assert.equal(result.success, false);
    assert.equal(CDPSessionManager.isAttached(tabId), true);
    assert.equal(CDPSessionManager.getFrameContextId(tabId, 'child'), null);
    assert.equal(CDPSessionManager.getFrameContextId(tabId, 'nested'), null);
    assert.equal(CDPSessionManager.getFrameContextId(tabId, 'main'), 1);
    createContext('child');
    assert.equal(CDPSessionManager.getFrameContextId(tabId, 'child'), null, 'late events cannot resurrect a detached child');
  } finally {
    await CDPSessionManager.detach(tabId);
    debuggerApi.sendCommand = originalSend;
  }
});

test('a stale debugger connection retries a main-frame read once but never replays input or a frame context', async () => {
  const originalSend = debuggerApi.sendCommand;
  let attempts = 0;
  debuggerApi.sendCommand = async (_target, method) => {
    if (method.endsWith('.enable')) return {};
    attempts++;
    if (attempts === 1) throw new Error('Debugger is not attached to the tab with id: 73.');
    return { result: { value: 'reconnected' } };
  };
  try {
    const read = await CDPSessionManager.sendCommand(73, 'Runtime.evaluate', { expression: 'document.title', throwOnSideEffect: true });
    assert.equal(read.success, true);
    assert.equal(read.result.result.value, 'reconnected');
    assert.equal(attempts, 2);

    attempts = 0;
    const write = await CDPSessionManager.sendCommand(73, 'Input.dispatchMouseEvent', { type: 'mousePressed' });
    assert.equal(write.success, false);
    assert.equal(attempts, 1);

    attempts = 0;
    const frameRead = await CDPSessionManager.sendCommand(73, 'Runtime.evaluate', { expression: 'document.title', contextId: 1, throwOnSideEffect: true });
    assert.equal(frameRead.success, false);
    assert.equal(attempts, 1, 'a frame context id must not be reused after reattach');

    attempts = 0;
    debuggerApi.sendCommand = async (_target, method) => {
      if (method.endsWith('.enable')) return {};
      attempts++;
      throw new Error('Debugger is not attached');
    };
    const missing = await CDPSessionManager.sendCommand(73, 'Page.getFrameTree');
    assert.equal(missing.success, false);
    assert.equal(attempts, 2, 'retry is bounded');
  } finally {
    await CDPSessionManager.detach(73);
    debuggerApi.sendCommand = originalSend;
  }
});
