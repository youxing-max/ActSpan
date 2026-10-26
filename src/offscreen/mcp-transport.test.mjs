import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

/** The transport imports `../config` (a directory), so Node needs the same esbuild bundling the sibling suites use. */
const bundle = await build({
  stdin: { contents: `export { mcpOffscreenTransport } from './src/offscreen/mcp-transport.ts';`,
    resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { mcpOffscreenTransport } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
globalThis.WebSocket ??= class { static OPEN = 1; };
/**
 * Minimal chrome/WebSocket doubles. `chrome.storage` is deliberately ABSENT: offscreen documents
 * only get `chrome.runtime`, so settings must arrive over the settings RPC. A double that hands the
 * transport a storage API would hide exactly the bug this suite exists to catch.
 */
const makeChrome = () => {
  const runtimeListeners = new Set();
  const store = { actspan_mcp_bridge_settings: { enabled: true, port: 30121, token: 'token-1234' } };
  const written = [];
  return {
    store,
    written,
    runtimeListeners,
    runtime: {
      id: 'offscreen-document',
      lastError: undefined,
      sendMessage(message, callback) {
        if (message?.type === 'actspan_mcp_settings_get') callback?.({ settings: store.actspan_mcp_bridge_settings, auto: {} });
        else callback?.({ delivered: true });
      },
      onMessage: {
        addListener(fn) { runtimeListeners.add(fn); },
        removeListener(fn) { runtimeListeners.delete(fn); },
      },
    },
  };
};

const loadTransport = async () => {
  const chromeDouble = makeChrome();
  globalThis.chrome = chromeDouble;
  const sockets = [];
  globalThis.WebSocket = class {
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.sent = [];
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      sockets.push(this);
      queueMicrotask(() => this.onopen?.());
    }
    send(frame) { this.sent.push(JSON.parse(frame)); }
    close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
  };
  return { module: { mcpOffscreenTransport }, chromeDouble, sockets };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test('the offscreen transport answers a bridge ping with pong and does not forward it', async () => {
  const { module, chromeDouble, sockets } = await loadTransport();
  const transport = module.mcpOffscreenTransport;
  const forwarded = [];
  chromeDouble.runtime.sendMessage = (message, callback) => {
    forwarded.push(message);
    callback?.({ delivered: true });
  };
  try {
    transport.start();
    await settle();
    const socket = sockets.at(-1);
    assert.ok(socket, 'transport must open a socket');
    socket.onmessage({ data: JSON.stringify({ type: 'hello_ok', appVersion: '1.1.0', protocolVersion: 1 }) });
    await settle();
    socket.sent.length = 0;
    forwarded.length = 0;

    socket.onmessage({ data: JSON.stringify({ type: 'ping', at: 123 }) });
    await settle();

    const pong = socket.sent.find((frame) => frame.type === 'pong');
    assert.ok(pong, 'a ping must be answered with pong');
    assert.equal(typeof pong.at, 'number');
    assert.equal(socket.sent.filter((frame) => frame.type === 'ping').length, 0, 'the ping must not be echoed back');
    assert.equal(forwarded.some((message) => message.type === 'actspan_mcp_socket_event'), false,
      'a ping must not be forwarded to the service worker as a socket event');
  } finally {
    transport.stop();
  }
});

test('the offscreen transport still forwards real bridge frames to the service worker', async () => {
  const { module, chromeDouble, sockets } = await loadTransport();
  const transport = module.mcpOffscreenTransport;
  const forwarded = [];
  chromeDouble.runtime.sendMessage = (message, callback) => {
    forwarded.push(message);
    callback?.({ delivered: true });
  };
  try {
    transport.start();
    await settle();
    const socket = sockets.at(-1);
    socket.onmessage({ data: JSON.stringify({ type: 'hello_ok', appVersion: '1.1.0', protocolVersion: 1 }) });
    await settle();
    forwarded.length = 0;

    socket.onmessage({ data: JSON.stringify({ type: 'event', event: { type: 'tab_closed', tabId: 5 } }) });
    await settle();
    assert.ok(forwarded.some((message) => message.type === 'actspan_mcp_socket_event'));
  } finally {
    transport.stop();
  }
});

// offscreen 文档拿不到 chrome.storage（官方限制：runtime 是唯一开放的扩展 API），
// 所以端口/令牌必须走 settings RPC；直接读 storage 的实现在真实文档里会静默不启动。
test('the transport reads its port over the settings RPC and never touches chrome.storage', async () => {
  const { module, chromeDouble, sockets } = await loadTransport();
  const transport = module.mcpOffscreenTransport;
  assert.equal('storage' in chromeDouble, false, 'the double must not hand the transport a storage API');
  chromeDouble.store.actspan_mcp_bridge_settings = { enabled: true, port: 41234, token: 'token-5678' };
  try {
    transport.start();
    await settle();
    const socket = sockets.at(-1);
    assert.ok(socket, 'transport must open a socket');
    assert.match(socket.url, /:41234$/, 'the port must come from the settings RPC');
    const hello = socket.sent[0];
    assert.equal(hello.type, 'hello');
    assert.equal(hello.role, 'extension');
    assert.equal(hello.token, 'token-5678', 'the token must come from the settings RPC');
    assert.equal(hello.protocolVersion, 1);
  } finally {
    transport.stop();
  }
});

test('a settings change relayed by the service worker reconnects with the new port', async () => {
  const { module, chromeDouble, sockets } = await loadTransport();
  const transport = module.mcpOffscreenTransport;
  try {
    transport.start();
    await settle();
    assert.match(sockets.at(-1).url, /:30121$/);

    chromeDouble.store.actspan_mcp_bridge_settings = { enabled: true, port: 41234 };
    for (const listener of chromeDouble.runtimeListeners) {
      listener({ type: 'actspan_mcp_settings_changed' }, { id: chromeDouble.runtime.id }, () => {});
    }
    await settle();
    assert.match(sockets.at(-1).url, /:41234$/, 'a relayed settings change must reconnect on the new port');
  } finally {
    transport.stop();
  }
});

test('pair_ok persists the auto token through the service worker, not chrome.storage', async () => {
  const { module, chromeDouble, sockets } = await loadTransport();
  const transport = module.mcpOffscreenTransport;
  const sent = [];
  chromeDouble.runtime.sendMessage = (message, callback) => {
    sent.push(message);
    callback?.(message?.type === 'actspan_mcp_settings_get'
      ? { settings: chromeDouble.store.actspan_mcp_bridge_settings, auto: {} }
      : { accepted: true });
  };
  try {
    transport.start();
    await settle();
    const socket = sockets.at(-1);
    socket.onmessage({ data: JSON.stringify({ type: 'pair_ok', token: 'fresh-token', port: 30121, pairingSecret: 'proof-1' }) });
    await settle();
    const persist = sent.find((message) => message.type === 'actspan_mcp_settings_set_auto');
    assert.ok(persist, 'the paired token must be handed to the service worker to persist');
    assert.equal(persist.value.token, 'fresh-token');
    assert.equal(persist.value.port, 30121);
    assert.equal(persist.value.pairingSecret, 'proof-1', 'the pairing proof must survive restarts');
  } finally {
    transport.stop();
  }
});

// 桥重启会换令牌。若只在内存里清掉死令牌，下一次 connect 又会从 storage 读回来，
// 于是 hello→4001→清内存→重读死令牌 永远循环，扩展再也连不上。
test('a rejected auto-pair token is cleared from storage so the transport can re-pair', async () => {
  const { module, chromeDouble, sockets } = await loadTransport();
  const transport = module.mcpOffscreenTransport;
  const sent = [];
  // 真实场景里设置里没有 token，令牌只来自自动配对。
  chromeDouble.store.actspan_mcp_bridge_settings = { enabled: true, port: 30121 };
  let auto = { port: 30121, token: 'stale-token' };
  chromeDouble.runtime.sendMessage = (message, callback) => {
    sent.push(message);
    if (message?.type === 'actspan_mcp_settings_get') {
      callback?.({ settings: chromeDouble.store.actspan_mcp_bridge_settings, auto });
    } else {
      if (message?.type === 'actspan_mcp_settings_set_auto') auto = message.value;
      callback?.({ accepted: true });
    }
  };
  try {
    transport.start();
    await settle();
    const first = sockets.at(-1);
    assert.equal(first.sent[0].type, 'hello', 'a stored token must be presented first');
    assert.equal(first.sent[0].token, 'stale-token');

    // 桥拒绝了死令牌。
    first.onclose({ code: 4001 });
    await settle();
    assert.deepEqual(auto, {}, 'the dead token must be cleared from storage, not just memory');

    // 退避后重连必须改成重新配对，而不是再拿死令牌去撞。
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const second = sockets.at(-1);
    assert.equal(second.sent[0].type, 'pair', 'the transport must fall back to pairing');
  } finally {
    transport.stop();
  }
});

test('rejecting an expired auto token preserves the proof needed to re-pair', async (t) => {
  const { module, chromeDouble, sockets } = await loadTransport();
  const transport = module.mcpOffscreenTransport;
  chromeDouble.store.actspan_mcp_bridge_settings = { enabled: true, port: 30121 };
  let auto = { port: 30121, token: 'expired-token', pairingSecret: 'existing-proof' };
  chromeDouble.runtime.sendMessage = (message, callback) => {
    if (message?.type === 'actspan_mcp_settings_get') {
      callback?.({ settings: chromeDouble.store.actspan_mcp_bridge_settings, auto });
    } else {
      if (message?.type === 'actspan_mcp_settings_set_auto') auto = message.value;
      callback?.({ accepted: true });
    }
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  try {
    transport.start();
    await flush();
    sockets.at(-1).onclose({ code: 4001 });
    await flush();
    assert.equal(auto.token, undefined);
    assert.equal(auto.pairingSecret, 'existing-proof');
    t.mock.timers.tick(1000);
    await flush();
    const pair = sockets.at(-1).sent[0];
    assert.equal(pair.type, 'pair');
    assert.equal(pair.role, 'extension');
    assert.equal(pair.protocolVersion, 1);
    assert.equal(pair.pairingSecret, 'existing-proof');
    assert.equal(pair.token, undefined);
  } finally { transport.stop(); }
});

test('authentication failures back off until hello_ok, not just a socket opening', async (t) => {
  const { module, sockets } = await loadTransport();
  const transport = module.mcpOffscreenTransport;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  try {
    transport.start();
    await flush();
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const count = sockets.length;
      sockets.at(-1).onclose({ code: 4001 });
      await flush();
      t.mock.timers.tick(delay - 1);
      await flush();
      assert.equal(sockets.length, count, `must wait the full ${delay}ms after failed authentication`);
      t.mock.timers.tick(1);
      await flush();
      assert.equal(sockets.length, count + 1);
    }
    const authenticated = sockets.at(-1);
    authenticated.onmessage({ data: JSON.stringify({ type: 'hello_ok', protocolVersion: 1 }) });
    await flush();
    authenticated.onclose({ code: 1000 });
    await flush();
    const count = sockets.length;
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(sockets.length, count + 1, 'successful authentication resets backoff');
  } finally { transport.stop(); }
});
