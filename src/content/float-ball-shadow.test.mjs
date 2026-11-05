import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);

// 悬浮球入口：esbuild 打包后以 data: URL 引入，断言真实模块的 Shadow DOM 契约
const hostBundle = await build({
  stdin: {
    contents: `export { createFloatBallShadowHost, watchExtensionContext } from './src/content/float-ball-react.tsx';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { createFloatBallShadowHost, watchExtensionContext } = await import(
  `data:text/javascript;base64,${Buffer.from(hostBundle.outputFiles[0].contents).toString('base64')}`
);

test('扩展失效时仅卸载一次，并移除捕获监听和定时检查', () => {
  const oldWindow = globalThis.window, oldChrome = globalThis.chrome;
  const events = new Map();
  globalThis.window = {
    addEventListener(type, fn) { events.set(type, fn); },
    removeEventListener(type) { events.delete(type); },
  };
  globalThis.chrome = { runtime: { id: 'test-extension' } };
  let unmounted = 0;
  const dispose = watchExtensionContext(() => unmounted++);
  try {
    events.get('resize')();
    assert.equal(unmounted, 0);
    delete chrome.runtime.id;
    events.get('mouseover')();
    assert.equal(unmounted, 1);
    assert.equal(events.size, 0);
    dispose();
    assert.equal(unmounted, 1);
  } finally { dispose(); globalThis.window = oldWindow; globalThis.chrome = oldChrome; }
});

test('监视器启动时已失效会立即清理，排队的旧事件不能再次清理', () => {
  const oldWindow = globalThis.window, oldChrome = globalThis.chrome;
  const callbacks = [], events = new Map();
  globalThis.window = {
    addEventListener(type, fn) { events.set(type, fn); callbacks.push(fn); },
    removeEventListener(type) { events.delete(type); },
  };
  globalThis.chrome = { runtime: {} };
  let unmounted = 0;
  const dispose = watchExtensionContext(() => unmounted++);
  try {
    assert.equal(unmounted, 1);
    assert.equal(events.size, 0);
    for (const callback of callbacks) callback();
    assert.equal(unmounted, 1);
  } finally { dispose(); globalThis.window = oldWindow; globalThis.chrome = oldChrome; }
});

// 确认卡片：真实组件 + 真实 React 服务端渲染，取真实 DOM class 契约
const cardBundle = await build({
  stdin: {
    contents: `
      export { ApprovalCard } from './src/content/float-ball/components/ApprovalCard.tsx';
      export { Trigger } from './src/content/float-ball/components/Trigger.tsx';
      export { InputBar } from './src/content/float-ball/components/InputBar.tsx';
      export { ActspanContext } from './src/content/float-ball/context/context.ts';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  external: ['react'],
});
const cardModule = { exports: {} };
new Function('require', 'exports', 'module', cardBundle.outputFiles[0].text)(require, cardModule.exports, cardModule);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { ApprovalCard, Trigger, InputBar, ActspanContext } = cardModule.exports;

test('旧组件首次渲染时不再从失效运行时读取图标 URL', () => {
  const oldWindow = globalThis.window, oldChrome = globalThis.chrome, oldDocument = globalThis.document;
  let calls = 0;
  globalThis.window = { location: { hostname: 'fixture.invalid' } };
  globalThis.document = { documentElement: { clientWidth: 1000 } };
  globalThis.chrome = { runtime: { getURL() { calls++; throw Error('Extension context invalidated.'); } } };
  try {
    for (const component of [Trigger, InputBar]) {
      assert.doesNotThrow(() => renderToStaticMarkup(React.createElement(ActspanContext.Provider, {
        value: { state: {}, dispatch() {} },
      }, React.createElement(component, { onRecordClick() {} }))));
    }
    assert.equal(calls, 0);
  } finally { globalThis.window = oldWindow; globalThis.chrome = oldChrome; globalThis.document = oldDocument; }
});

/**
 * 最小 DOM：按规范实现 attachShadow 的 open/closed 语义（closed 不暴露 shadowRoot），
 * 并支持后代组合选择器（tag / #id / .class）。
 */
const matchesSimpleSelector = (el, part) => {
  const tag = part.match(/^[a-zA-Z][\w-]*/);
  if (tag && el.localName !== tag[0].toLowerCase()) return false;
  const id = part.match(/#([\w-]+)/);
  if (id && el.id !== id[1]) return false;
  const classes = new Set(String(el.className).split(/\s+/).filter(Boolean));
  for (const [, cls] of part.matchAll(/\.([\w-]+)/g)) {
    if (!classes.has(cls)) return false;
  }
  return true;
};

const descendants = (node) => {
  const collected = [];
  for (const child of node.children) {
    collected.push(child, ...descendants(child));
  }
  return collected;
};

class FakeElement {
  constructor(localName) {
    this.localName = localName.toLowerCase();
    this.tagName = this.localName.toUpperCase();
    this.id = '';
    this.className = '';
    this.textContent = '';
    this.style = { cssText: '', left: '', top: '' };
    this.children = [];
    this.parentNode = null;
    this.shadowRoot = null;
    this.closedShadowRoot = null;
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  attachShadow({ mode }) {
    if (this.shadowRoot || this.closedShadowRoot) throw new Error('Shadow root already attached');
    const root = new FakeShadowRoot(this, mode);
    if (mode === 'open') this.shadowRoot = root;
    else this.closedShadowRoot = root;
    return root;
  }

  querySelector(selector) {
    const parts = selector.trim().split(/\s+/);
    const last = parts.pop();
    return descendants(this).find((el) => {
      if (!matchesSimpleSelector(el, last)) return false;
      let ancestor = el.parentNode;
      let index = parts.length - 1;
      while (index >= 0) {
        if (!ancestor) return false;
        if (matchesSimpleSelector(ancestor, parts[index])) index -= 1;
        ancestor = ancestor.parentNode;
      }
      return true;
    }) ?? null;
  }
}

class FakeShadowRoot extends FakeElement {
  constructor(host, mode) {
    super('#shadow-root');
    this.localName = '#shadow-root';
    this.host = host;
    this.mode = mode;
  }
}

const installFakeDocument = () => {
  globalThis.document = { createElement: (tagName) => new FakeElement(tagName) };
};

const lifecycleBundle = await build({
  stdin: {
    contents: `export { initFloatBallReact } from './src/content/float-ball-react.tsx';`,
    resolveDir: process.cwd(), loader: 'tsx',
  },
  bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react'], jsx: 'automatic',
  plugins: [{ name: 'float-lifecycle', setup(build) {
    const mocks = {
      'react-dom/client': `export default { createRoot:()=>({
        render:el=>{globalThis.floatFixture.pending=el},
        unmount:()=>{globalThis.floatFixture.unmounts++}
      }) };`,
      './float-ball/ActspanRoot': `export const ActspanRoot=()=>{globalThis.floatFixture.renders++;return null};`,
    };
    build.onResolve({ filter: /.*/ }, args => {
      if (Object.hasOwn(mocks, args.path)) return { path: args.path, namespace: 'float-fixture' };
    });
    build.onLoad({ filter: /.*/, namespace: 'float-fixture' }, args => ({ contents: mocks[args.path], loader: 'js' }));
  } }],
});
const lifecycleModule = { exports: {} };
new Function('require', 'exports', 'module', lifecycleBundle.outputFiles[0].text)(require, lifecycleModule.exports, lifecycleModule);

test('React 延迟渲染时重新检查上下文，失效后取消宿主、帧回调和所有入口监听', async (t) => {
  const fixture = { renders: 0, unmounts: 0, pending: null };
  const events = new Map(), frames = new Set();
  let disconnected = 0;
  const target = {
    addEventListener(type, fn) { const set = events.get(type) || new Set(); set.add(fn); events.set(type, set); },
    removeEventListener(type, fn) { events.get(type)?.delete(fn); },
  };
  const body = new FakeElement('body');
  const doc = { ...target, body, createElement(tag) {
    const el = new FakeElement(tag);
    el.remove = () => { body.children = body.children.filter(child => child !== el); };
    return el;
  } };
  const globals = {
    floatFixture: fixture, document: doc,
    window: { ...target, location: { protocol: 'https:', hostname: 'fixture.invalid' } },
    chrome: { runtime: { id: 'fixture' }, storage: { local: { get(_keys, cb) { cb({}); } } } },
    MutationObserver: class { observe() {} disconnect() { disconnected++; } },
    requestAnimationFrame: fn => { frames.add(fn); return fn; },
    cancelAnimationFrame: fn => frames.delete(fn),
  };
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, globalThis[key]]));
  Object.assign(globalThis, globals);
  t.mock.method(globalThis, 'setInterval', () => 123);
  t.mock.method(globalThis, 'clearInterval', () => {});
  const render = el => { while (el && typeof el.type === 'function') el = el.type(el.props); };
  try {
    await lifecycleModule.exports.initFloatBallReact();
    render(fixture.pending);
    assert.equal(fixture.renders, 1);
    delete chrome.runtime.id;
    render(fixture.pending);
    assert.equal(fixture.renders, 1, '失效后的首次/后续渲染不能进入扩展组件');
    for (const callback of [...events.get('mouseover')]) callback();
    assert.equal(fixture.unmounts, 1);
    assert.equal(disconnected, 1);
    assert.equal(body.children.length, 0);
    assert.equal(frames.size, 0);
    assert.equal([...events.values()].reduce((sum, set) => sum + set.size, 0), 0);
  } finally { Object.assign(globalThis, previous); }
});

test('float ball host exposes an open shadow root', () => {
  installFakeDocument();

  const { host, shadow, reactRoot } = createFloatBallShadowHost();

  assert.equal(host.id, 'actspan-root');
  assert.equal(host.shadowRoot, null, 'page scripts must not reach the shadow root');
  assert.equal(shadow.mode, 'closed');
  assert.equal(shadow.querySelector('#actspan-react-root'), reactRoot);
  assert.match(shadow.querySelector('style').textContent, /\.actspan-approval-card/);
});

test('rendered confirmation card is reachable through the shadow root', () => {
  installFakeDocument();

  const { host, shadow, reactRoot } = createFloatBallShadowHost();
  const markup = renderToStaticMarkup(
    React.createElement(
      ActspanContext.Provider,
      { value: { state: {}, dispatch() {} } },
      React.createElement(ApprovalCard, { requestId: 'req_1', message: '确认执行该操作？' }),
    ),
  );
  const cardClass = markup.match(/class="([^"]*\bactspan-approval-card\b[^"]*)"/)?.[1];
  assert.ok(cardClass, 'confirmation card render must expose the actspan-approval-card class');

  // 无 DOM 库可用，按 React 会生成的 DOM 形态把卡片根节点挂进挂载容器
  const card = document.createElement('div');
  card.className = cardClass;
  reactRoot.appendChild(card);

  assert.equal(host.shadowRoot, null, 'shadowRoot must stay closed after the card mounts');
  assert.equal(shadow.querySelector('#actspan-react-root .actspan-approval-card'), card);
  assert.match(markup, /data-request-id="req_1"/);
});
