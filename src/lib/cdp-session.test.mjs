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
