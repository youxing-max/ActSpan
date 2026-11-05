import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

let settings = { enabled: false, serverUrl: 'wss://cloud.test/ws', token: 'local-test-token' };
const sockets = [];
const statusEvents = [];
const harness = {
  callTool: async () => ({ content: [{ type: 'text', text: 'read result' }] }),
  broadcast: (_type, status) => { statusEvents.push(status); },
};
globalThis.cloudBridgeTestHarness = harness;
globalThis.chrome = {
  storage: { local: { get(_keys, callback) { callback({ actspan_cloud_bridge_settings: settings }); } } },
  runtime: { getPlatformInfo(callback) { callback({}); } },
};
class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  sent = [];
  constructor(url) { this.url = url; sockets.push(this); }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  remoteClose(code) { this.readyState = 3; this.onclose?.({ code, reason: '' }); }
}
globalThis.WebSocket = FakeSocket;
const bundle = await build({
  stdin: { contents: `export { applyCloudBridgeSettings } from './src/background/cloud-bridge.ts';
    export { getServiceWorkerKeepAliveState } from './src/background/service-worker-keepalive.ts';`,
  loader: 'ts', resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'cloud-dependencies', setup(b) {
    b.onResolve({ filter: /(?:functions\/registry|lib\/channel|lib\/console)$/ }, args => ({ path: args.path, namespace: 'cloud-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'cloud-stub' }, ({ path }) => ({ contents: path.endsWith('/registry')
      ? 'export const ensureToolRegistryReady=async()=>{}; export const mcpClient={listTools:async()=>[],callTool:(...args)=>globalThis.cloudBridgeTestHarness.callTool(...args)};'
      : path.endsWith('/channel') ? 'export default {broadcast:(...args)=>globalThis.cloudBridgeTestHarness.broadcast(...args),on(){}};'
        : 'export default {log(){},warn(){}};' }));
  } }],
});
const { applyCloudBridgeSettings, getServiceWorkerKeepAliveState } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const flush = async () => { for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve)); };
const start = async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  settings = { enabled: true, serverUrl: 'wss://cloud.test/ws', token: 'local-test-token' };
  await applyCloudBridgeSettings();
  const socket = sockets.at(-1);
  socket.open();
  await flush();
  t.after(async () => { settings = { ...settings, enabled: false }; await applyCloudBridgeSettings(); await flush(); });
  return socket;
};

test('disabling cloud bridge closes its socket and releases its worker keepalive', async t => {
  const socket = await start(t);
  assert.equal(getServiceWorkerKeepAliveState().active, true);
  settings = { ...settings, enabled: false };
  await applyCloudBridgeSettings();
  assert.equal(socket.readyState, 3);
  assert.deepEqual(getServiceWorkerKeepAliveState(), { refCount: 0, active: false });
  const count = sockets.length;
  t.mock.timers.tick(10000);
  await flush();
  assert.equal(sockets.length, count);
});

for (const [code, state] of [[4001, 'auth_failed'], [4002, 'replaced']]) {
  test(`cloud close ${code} stops reconnecting and releases keepalive until settings change`, async t => {
    const socket = await start(t);
    socket.remoteClose(code);
    await flush();
    assert.equal(statusEvents.at(-1)?.state, state);
    assert.deepEqual(getServiceWorkerKeepAliveState(), { refCount: 0, active: false });
    const count = sockets.length;
    t.mock.timers.tick(10000);
    await flush();
    assert.equal(sockets.length, count);
    await applyCloudBridgeSettings();
    assert.equal(sockets.length, count + 1, 'explicit save can reconnect');
  });
}

test('a late tool result from the previous cloud connection cannot reach the new token connection', async t => {
  const old = await start(t);
  let resolveTool;
  harness.callTool = async () => new Promise(resolve => { resolveTool = resolve; });
  old.onmessage({ data: JSON.stringify({ id: 17, method: 'tools/call', params: { name: 'page', arguments: {} } }) });
  await flush();
  const staleClose = old.onclose;
  settings = { ...settings, token: 'different-local-test-token' };
  await applyCloudBridgeSettings();
  const next = sockets.at(-1);
  next.open();
  await flush();
  resolveTool({ content: [{ type: 'text', text: 'previous connection private result' }] });
  await flush();
  assert.equal(next.sent.some(frame => frame.id === 17), false);
  staleClose({ code: 4001, reason: 'old token rejected' });
  await flush();
  assert.equal(statusEvents.at(-1)?.state, 'connected');
  assert.equal(getServiceWorkerKeepAliveState().refCount, 1);
});

test('transient cloud disconnect reconnects once and keeps normal tool routing', async t => {
  const socket = await start(t);
  harness.callTool = async () => ({ content: [{ type: 'text', text: 'current result' }] });
  const count = sockets.length;
  socket.remoteClose(1006);
  await flush();
  assert.equal(statusEvents.at(-1)?.state, 'disconnected');
  t.mock.timers.tick(2500);
  await flush();
  assert.equal(sockets.length, count + 1);
  const next = sockets.at(-1);
  next.open();
  next.onmessage({ data: JSON.stringify({ id: 19, method: 'tools/call', params: { name: 'page', arguments: {} } }) });
  await flush();
  assert.equal(next.sent.find(frame => frame.id === 19)?.result.content[0].text, 'current result');
});

test('malformed cloud frames return a protocol error without breaking the live connection', async t => {
  const socket = await start(t);
  for (const data of ['{', 'null', '[]', '"invalid"']) socket.onmessage({ data });
  await flush();
  assert.deepEqual(socket.sent.filter(frame => frame.error).map(frame => frame.error.code), [-32700, -32600, -32600, -32600]);
  assert.equal(socket.readyState, FakeSocket.OPEN);
});
