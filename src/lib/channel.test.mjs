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

await test('广播遇到已关闭或失去接收端的标签页时回收注册，其他标签页仍收到消息', async () => {
  const send = chrome.tabs.sendMessage;
  const delivered = [];
  chrome.tabs.sendMessage = (tabId) => {
    if (tabId === 7) return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
    delivered.push(tabId);
    return Promise.resolve();
  };
  try {
    Channel.broadcast('test-broadcast', {});
    await new Promise(setImmediate);
    assert.deepEqual(Channel.getRegisteredTabs(), [8]);
    assert.deepEqual(delivered, [8]);
    Channel.broadcast('test-broadcast', {});
    await new Promise(setImmediate);
    assert.deepEqual(delivered, [8, 8]);
  } finally { chrome.tabs.sendMessage = send; }
});

await test('无回调的定向消息异步失败会传给 onError，并保留 frameId', async () => {
  const send = chrome.tabs.sendMessage;
  const failure = new Error('Receiving end does not exist.');
  const errors = [], targets = [];
  chrome.tabs.sendMessage = (tabId, _message, options) => {
    targets.push({ tabId, options });
    return Promise.reject(failure);
  };
  try {
    Channel.sendToTab(8, 'test-message', {}, undefined, 47, error => errors.push(error));
    await new Promise(setImmediate);
    assert.deepEqual(errors, [failure]);
    assert.deepEqual(targets, [{ tabId: 8, options: { frameId: 47 } }]);
  } finally { chrome.tabs.sendMessage = send; }
});

await test('运行时单向消息与内容脚本重注册不会泄漏 Promise rejection', async () => {
  const send = chrome.runtime.sendMessage, log = console.error;
  const logs = [];
  chrome.runtime.sendMessage = () => Promise.reject(new Error('Extension context invalidated.'));
  console.error = (...args) => logs.push(args);
  try {
    Channel.send('test-message', {});
    onMessage({ __channel_tab_register: true }, {}, () => {});
    await new Promise(setImmediate);
    assert.equal(logs.length, 1, '业务消息失败仍有诊断，卸载时重注册失败允许忽略');
  } finally { chrome.runtime.sendMessage = send; console.error = log; }
});
