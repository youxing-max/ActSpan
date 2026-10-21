import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);

// 悬浮球入口：esbuild 打包后以 data: URL 引入，断言真实模块的 Shadow DOM 契约
const hostBundle = await build({
  stdin: {
    contents: `export { createFloatBallShadowHost } from './src/content/float-ball-react.tsx';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { createFloatBallShadowHost } = await import(
  `data:text/javascript;base64,${Buffer.from(hostBundle.outputFiles[0].contents).toString('base64')}`
);

// 确认卡片：真实组件 + 真实 React 服务端渲染，取真实 DOM class 契约
const cardBundle = await build({
  stdin: {
    contents: `
      export { ApprovalCard } from './src/content/float-ball/components/ApprovalCard.tsx';
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
const { ApprovalCard, ActspanContext } = cardModule.exports;

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

test('float ball host exposes an open shadow root', () => {
  installFakeDocument();

  const { host, shadow, reactRoot } = createFloatBallShadowHost();

  assert.equal(host.id, 'actspan-root');
  assert.notEqual(host.shadowRoot, null, 'host.shadowRoot must be reachable from page scripts');
  assert.equal(host.shadowRoot, shadow);
  assert.equal(host.shadowRoot.mode, 'open');
  assert.equal(host.shadowRoot.querySelector('#actspan-react-root'), reactRoot);
  assert.match(host.shadowRoot.querySelector('style').textContent, /\.actspan-approval-card/);
});

test('rendered confirmation card is reachable through the shadow root', () => {
  installFakeDocument();

  const { host, reactRoot } = createFloatBallShadowHost();
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

  assert.notEqual(host.shadowRoot, null, 'shadowRoot must stay reachable after the card mounts');
  assert.equal(host.shadowRoot.querySelector('#actspan-react-root .actspan-approval-card'), card);
  assert.match(markup, /data-request-id="req_1"/);
});
