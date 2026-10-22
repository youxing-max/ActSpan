import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const registrations = [];
const connectedPorts = [];
let onMessage;

/** 假 Port：测试里手动触发 onDisconnect 模拟 background 被回收 */
function createPort() {
  const disconnectListeners = [];
  return {
    onMessage: { addListener() {} },
    onDisconnect: { addListener(fn) { disconnectListeners.push(fn); } },
    postMessage() {},
    disconnect() { disconnectListeners.forEach(fn => fn()); },
    emitDisconnect() { disconnectListeners.forEach(fn => fn()); },
  };
}

globalThis.chrome = {
  runtime: {
    onMessage: { addListener(listener) { onMessage = listener; } },
    onConnect: { addListener() {} },
    sendMessage() {},
    connect() {
      const port = createPort();
      connectedPorts.push(port);
      return port;
    },
    lastError: undefined,
  },
  tabs: {
    async query() { return [{ id: 7 }, { id: 8 }]; },
    sendMessage(tabId, message, callback) {
      registrations.push({ tabId, message });
      callback?.({ success: true });
    },
  },
};

const bundle = await build({
  stdin: { contents: `export { default as Channel } from './src/lib/channel.ts';`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { Channel } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

await test('background Channel re-registers tabs that survived a service worker restart', async () => {
  Channel.listen();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(onMessage);
  assert.deepEqual(registrations, [
    { tabId: 7, message: { __channel_tab_register: true } },
    { tabId: 8, message: { __channel_tab_register: true } },
  ]);
  assert.deepEqual(Channel.getRegisteredTabs().sort(), [7, 8]);
});

await test('content script notifies local subscribers when background asks it to re-register', () => {
  let reconnected = 0;
  const handler = () => { reconnected += 1; };
  Channel.on('__channel_tab_reconnected', handler);
  onMessage({ __channel_tab_register: true }, {}, () => {});
  Channel.off('__channel_tab_reconnected', handler);
  assert.equal(reconnected, 1);
});

await test('extension page reconnects after background drops the port and notifies subscribers', async () => {
  let reconnected = 0;
  Channel.on('__channel_extension_reconnected', () => { reconnected += 1; });
  Channel.connectAsExtensionPage();
  assert.equal(connectedPorts.length, 1);

  // MV3 background 空闲 30s 被回收 → port 断开，页面必须自己重连，否则再也收不到广播
  connectedPorts[0].emitDisconnect();
  await delay(1200);

  assert.equal(connectedPorts.length, 2);
  assert.equal(reconnected, 1);
});

await test('explicit disconnect stops reconnecting', async () => {
  Channel.disconnectExtensionPage();
  const before = connectedPorts.length;
  await delay(1200);
  assert.equal(connectedPorts.length, before);
});

await test('extension page retries when the first connect throws', async () => {
  Channel.disconnectExtensionPage();
  const before = connectedPorts.length;
  const original = chrome.runtime.connect;
  chrome.runtime.connect = () => { throw new Error('context invalidated'); };
  Channel.connectAsExtensionPage();
  chrome.runtime.connect = original;
  await delay(1200);
  assert.equal(connectedPorts.length, before + 1);
});
