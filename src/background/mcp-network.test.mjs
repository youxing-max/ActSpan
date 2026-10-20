import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { registerNetworkTools } from '../../mcp-server/network-tool.js';

const events = new Set();
const updates = new Set();
const detaches = new Set();
const reloads = [];
let responseBodies = new Map();
globalThis.chrome = {
  debugger: {
    onEvent: { addListener: (listener) => events.add(listener) },
    onDetach: { addListener: (listener) => detaches.add(listener) },
    detach: async () => {},
    attach: async () => {},
    sendCommand: async (_target, method, params) => method === 'Network.getResponseBody'
      ? { body: responseBodies.get(params.requestId) || '', base64Encoded: false } : {},
  },
  tabs: {
    onUpdated: { addListener: (listener) => updates.add(listener), removeListener: (listener) => updates.delete(listener) },
    reload: async (tabId) => {
      reloads.push(tabId);
      emit('initial', 'https://example.test/api/first', 'initial payload');
      for (const listener of updates) listener(tabId, { status: 'complete' }, { id: tabId });
    },
  },
};
const bundle = await build({
  entryPoints: ['src/background/mcp-network.ts'], bundle: true, write: false,
  format: 'esm', platform: 'node',
});
const { handleMcpNetwork } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const context = { clientId: 'client', requestId: 'request', taskId: 'task', sessionId: 'session', owner: 'ide-agent' };
const tabId = 332;
function emit(requestId, url, body, targetTabId = tabId) {
  responseBodies.set(requestId, body);
  const source = { tabId: targetTabId };
  const event = (method, params) => { for (const listener of events) listener(source, method, params); };
  event('Network.requestWillBeSent', { requestId, type: 'XHR', request: { url, method: 'GET', headers: {} } });
  event('Network.responseReceived', { requestId, response: { status: 200, statusText: 'OK', mimeType: 'application/json', headers: { 'content-length': String(body.length) } } });
  event('Network.loadingFinished', { requestId });
}

function simulateDetach(targetTabId = tabId) {
  for (const listener of detaches) listener({ tabId: targetTabId }, 'canceled_by_user');
}

test('query index selects latest matching request backwards, not most recent unrelated request', async () => {
  assert.deepEqual((await handleMcpNetwork('network.list', {}, context, tabId)).events, []);
  emit('batch-1', 'https://example.test/api/posts?cursor=first', 'first page');
  emit('other', 'https://example.test/api/user', 'other');
  emit('batch-2', 'https://example.test/api/posts?cursor=second', 'second page');
  emit('batch-3', 'https://example.test/api/posts?cursor=third', 'third page');
  const filter = { urlFilter: '/api/posts' };
  assert.equal((await handleMcpNetwork('network.query', filter, context, tabId)).body, 'third page');
  assert.equal((await handleMcpNetwork('network.query', { ...filter, index: 1 }, context, tabId)).body, 'second page');
  assert.equal((await handleMcpNetwork('network.query', { ...filter, index: 2 }, context, tabId)).body, 'first page');
  await assert.rejects(handleMcpNetwork('network.query', { ...filter, index: 3 }, context, tabId), /3 matching requests|index 3/);
});

test('reload captures first-load requests only when explicitly requested', async () => {
  assert.equal((await handleMcpNetwork('network.list', { urlFilter: '/api/first' }, context, tabId)).events.length, 0);
  assert.deepEqual(reloads, []);
  const result = await handleMcpNetwork('network.query', { urlFilter: '/api/first', reload: true }, context, tabId);
  assert.equal(result.body, 'initial payload');
  assert.deepEqual(reloads, [tabId]);
  assert.equal(updates.size, 0);
});

test('unknown filter and debugger errors diagnose observations instead of inventing a response', async () => {
  await assert.rejects(handleMcpNetwork('network.query', { urlFilter: '/api/missing' }, context, tabId), /No matching.*observed|No matching.*captured/i);
  const old = chrome.debugger.sendCommand;
  chrome.debugger.sendCommand = async (_target, method) => method === 'Network.getResponseBody' ? Promise.reject(Error('body evicted')) : {};
  try {
    await assert.rejects(handleMcpNetwork('network.detail', { requestId: 'batch-1', includeBody: true }, context, tabId), /body evicted/);
  } finally { chrome.debugger.sendCommand = old; }
});

test('captured requests survive a debugger detach and capture resumes without a manual restart', async () => {
  const tab = 340;
  assert.equal((await handleMcpNetwork('network.list', {}, context, tab)).total, 0);
  emit('keep-1', 'https://example.test/api/keep', 'kept', tab);
  assert.equal((await handleMcpNetwork('network.query', { urlFilter: '/api/keep' }, context, tab)).body, 'kept');
  // 空闲 5s 或浏览器主动断开都会走同一条 detach 清理路径。
  simulateDetach(tab);
  assert.equal((await handleMcpNetwork('network.query', { urlFilter: '/api/keep' }, context, tab)).body, 'kept');
  emit('keep-2', 'https://example.test/api/keep?second', 'fresh', tab);
  assert.equal((await handleMcpNetwork('network.query', { urlFilter: '/api/keep?second' }, context, tab)).body, 'fresh');
});

test('registered network tools forward caller-scoped tab and distinguish list/detail/query', async () => {
  const tools = new Map();
  const calls = [];
  registerNetworkTools({
    registerTool: (name, definition, handler) => tools.set(name, { definition, handler }),
    callBridge: async (method, params) => { calls.push({ method, params }); return { events: [] }; },
    run: (fn) => fn,
    tabIdParam: { optional: () => {} }, taskParams: {},
  });
  assert.match(tools.get('actspan_network_list').definition.description, /^START HERE when you need DATA rather than an action/);
  assert.match(tools.get('actspan_network_list').definition.description, /Never guess an endpoint name from memory — list first, pick by response size/);
  await tools.get('actspan_network_query').handler({ tabId, urlFilter: '/api/posts', index: 2 });
  assert.deepEqual(calls.at(-1), { method: 'network.query', params: { tabId, urlFilter: '/api/posts', index: 2 } });
});
