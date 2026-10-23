import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';

const { z } = createRequire(new URL('../../mcp-server/package.json', import.meta.url))('zod');
import { registerInteractionTools } from '../../mcp-server/interaction-tools.js';

const bundle = await build({ stdin: { contents: `export { handleMcpInteraction } from './src/background/mcp-interaction.ts'; export { tabLeaseManager } from './src/background/tab-lease-manager.ts';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node' });
const { handleMcpInteraction, tabLeaseManager } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const context = { clientId: 'client', taskId: 'task', sessionId: 'session', requestId: 'request', owner: 'ide-agent' };

function browser(elements = {}) {
  const events = [], injectedArgs = [];
  globalThis.Event = class { constructor(type, init) { this.type = type; this.bubbles = init?.bubbles; } };
  globalThis.KeyboardEvent = class extends Event { constructor(type, init) { super(type, init); this.key = init.key; this.shiftKey = init.shiftKey; this.ctrlKey = init.ctrlKey; } };
  globalThis.DragEvent = class extends Event { constructor(type, init) { super(type, init); this.dataTransfer = init.dataTransfer; } };
  globalThis.InputEvent = class extends Event { constructor(type, init) { super(type, init); this.inputType = init.inputType; this.data = init.data; } };
  globalThis.WheelEvent = class extends Event { constructor(type, init) { super(type, init); this.deltaX = init.deltaX; this.deltaY = init.deltaY; this.deltaMode = init.deltaMode; } };
  globalThis.File = class { constructor(parts, name, options) { this.content = parts[0]; this.name = name; this.type = options.type; } };
  globalThis.DataTransfer = class { constructor() { this.files = []; this.items = { add: (file) => this.files.push(file) }; } };
  globalThis.atob = (base64) => Buffer.from(base64, 'base64').toString('binary');
  const documentElement = { scrollTop: 0, scrollLeft: 0, clientHeight: 0, clientWidth: 0, scrollHeight: 0, scrollWidth: 0,
    dispatchEvent(event) { events.push(event.type); return true; } };
  globalThis.document = {
    body: { innerText: '', scrollTop: 0 }, readyState: 'complete', activeElement: null,
    documentElement, scrollingElement: documentElement,
    querySelector: (selector) => elements[selector] || null,
    querySelectorAll: () => Object.values(elements),
  };
  globalThis.window = { scrollX: 0, scrollY: 0, scrollBy(x, y) { this.scrollX += x; this.scrollY += y; } };
  // 照抄 Chrome 的两条真实约束：含 undefined 的 args 整条被拒，页面侧 throw 被吞成
  // {result:null}（不带 error 字段）。缺了它们，注入参数与错误还原的缺陷在测试里永远是绿的。
  globalThis.chrome = { scripting: { executeScript: async ({ func, args }) => {
    if (args.some((arg) => arg === undefined)) throw Error("Error at property 'args': Value is unserializable.");
    injectedArgs.push(args);
    try { return [{ result: await func(...args) }]; } catch { return [{ result: null }]; }
  } } };
  const make = (tagName, extra = {}) => ({ tagName, textContent: '', parentElement: null, files: [], value: '',
    getAttribute() { return null; }, matches(pattern) { return pattern.includes(this.tagName.toLowerCase()); }, dispatchEvent(event) { events.push(event.type); return true; },
    focus() { document.activeElement = this; }, click() { events.push('click'); }, ...extra });
  return { events, make, injectedArgs };
}
// A denied write must fail before chrome.scripting.executeScript can touch the page.
test('all five tools register strict schemas and call their real bridge methods', async () => {
  const tools = new Map();
  const calls = [];
  registerInteractionTools({
    registerTool: (name, definition, handler) => tools.set(name, { definition, handler }),
    callBridge: async (method, params) => { calls.push([method, params]); return { done: true }; },
    run: (fn) => fn,
    taskParams: {}, tabIdParam: z.number().int().optional(),
  });
  for (const action of ['select', 'upload', 'key', 'wait', 'scroll']) {
    const tool = tools.get(`actspan_page_${action}`);
    assert.ok(tool, `${action} must be registered`);
    assert.ok(tool.definition.inputSchema);
    const args = action === 'select' ? { selector: '#select', value: 'x' }
      : action === 'upload' ? { selector: '#file', filename: 'x.txt', base64: 'eA==' }
      : action === 'key' ? { keys: ['Tab'] }
      : action === 'wait' ? { for: 'idle' } : { deltaY: 40 };
    await tool.handler(args);
    assert.equal(calls.at(-1)[0], `page.${action}`);
  }
});

test('rejects unsupported or ambiguous interaction arguments before forwarding', async () => {
  const tools = new Map();
  let forwarded = 0;
  registerInteractionTools({ registerTool: (name, _definition, handler) => tools.set(name, handler),
    callBridge: async () => { forwarded++; }, run: (fn) => async (args) => fn(args),
    taskParams: {}, tabIdParam: z.number().int().optional() });
  await assert.rejects(tools.get('actspan_page_key')({ keys: ['Enter'], repeat: 51 }));
  await assert.rejects(tools.get('actspan_page_key')({ keys: ['Enter'], real: true }));
  await assert.rejects(tools.get('actspan_page_upload')({ filename: 'x', base64: 'eA==', selector: '#file', dropSelector: '#drop' }));
  await assert.rejects(tools.get('actspan_page_wait')({ for: 'selector' }));
  assert.equal(forwarded, 0);
});

test('native select dispatches change without debugger and denies unleased write', async () => {
  const { events, make } = browser();
  const option = { value: 'two', textContent: 'Two' };
  const select = make('SELECT', { options: [option], value: 'one' });
  document.querySelector = () => select;
  const authorize = tabLeaseManager.authorizeWrite;
  try {
    tabLeaseManager.authorizeWrite = () => { throw new Error('lease denied'); };
    await assert.rejects(handleMcpInteraction('page.select', { selector: '#select', value: 'two' }, context, 7), /lease denied/);
    assert.equal(select.value, 'one');
    tabLeaseManager.authorizeWrite = () => {};
    const result = await handleMcpInteraction('page.select', { selector: '#select', value: 'two' }, context, 7);
    assert.equal(result.selectedValue, 'two');
    assert.equal(select.value, 'two');
    assert.deepEqual(events, ['change']);
  } finally { tabLeaseManager.authorizeWrite = authorize; }
});

test('upload assigns DataTransfer files, emits change, and drop mode emits drop without dialog', async () => {
  const { events, make } = browser();
  const fileInput = make('INPUT', { type: 'file' });
  const target = make('DIV');
  document.querySelector = (selector) => ({ '#file': fileInput, '#drop': target })[selector];
  const authorize = tabLeaseManager.authorizeWrite;
  tabLeaseManager.authorizeWrite = () => {};
  try {
    await handleMcpInteraction('page.upload', { selector: '#file', filename: 'x.txt', base64: 'eA==', mimeType: 'text/plain' }, context, 7);
    assert.equal(fileInput.files[0].name, 'x.txt');
    assert.equal(fileInput.files[0].content[0], 120);
    assert.deepEqual(events, ['input', 'change']);
    await handleMcpInteraction('page.upload', { dropSelector: '#drop', filename: 'x.txt', base64: 'eA==' }, context, 7);
    assert.deepEqual(events.slice(-3), ['dragenter', 'dragover', 'drop']);
  } finally { tabLeaseManager.authorizeWrite = authorize; }
});

test('key sequence Tab moves focus and Enter clicks ordinary target; payment no longer blocked in free mode', async () => {
  const { events, make } = browser();
  const first = make('BUTTON', { textContent: 'Continue' });
  const second = make('BUTTON', { textContent: 'Save' });
  document.querySelectorAll = () => [first, second];

  const authorize = tabLeaseManager.authorizeWrite;
  tabLeaseManager.authorizeWrite = () => {};
  try {
    document.activeElement = first;
    await handleMcpInteraction('page.key', { keys: ['Tab', 'Enter'] }, context, 7);
    assert.equal(document.activeElement, second);
    assert.ok(events.includes('click'));
    // 自由化模式：支付按钮的 Enter 不再被拦截，直接放行
    second.textContent = 'Pay now';
    await handleMcpInteraction('page.key', { keys: ['Enter'] }, context, 7);
    assert.equal(events.filter((event) => event === 'click').length, 2);
  } finally { tabLeaseManager.authorizeWrite = authorize; }
});

test('key rechecks ownership before each key in a sequence', async () => {
  const { events, make } = browser();
  const button = make('BUTTON', { textContent: 'Save' });
  document.activeElement = button;
  const authorize = tabLeaseManager.authorizeWrite;
  let checks = 0;
  tabLeaseManager.authorizeWrite = () => { if (++checks === 2) throw new Error('lease revoked'); };
  try {
    await assert.rejects(handleMcpInteraction('page.key', { keys: ['a', 'Enter'] }, context, 7), /lease revoked/);
    assert.equal(events.filter((event) => event === 'click').length, 0);
  } finally { tabLeaseManager.authorizeWrite = authorize; }
});

test('key sequence edits a focused input and emits input events', async () => {
  const { events, make } = browser();
  const input = make('INPUT', { type: 'text', value: 'ab', selectionStart: 2, selectionEnd: 2,
    setRangeText(text, start, end) { this.value = this.value.slice(0, start) + text + this.value.slice(end); this.selectionStart = this.selectionEnd = start + text.length; } });
  document.activeElement = input;
  const authorize = tabLeaseManager.authorizeWrite;
  tabLeaseManager.authorizeWrite = () => {};
  try {
    await handleMcpInteraction('page.key', { keys: ['Backspace', 'z'] }, context, 7);
    assert.equal(input.value, 'az');
    assert.deepEqual(events.filter((type) => type === 'input'), ['input', 'input']);
  } finally { tabLeaseManager.authorizeWrite = authorize; }
});
test('upload denied by lease leaves file input unchanged', async () => {
  const { make } = browser();
  const input = make('INPUT', { type: 'file' });
  document.querySelector = () => input;
  const authorize = tabLeaseManager.authorizeWrite;
  tabLeaseManager.authorizeWrite = () => { throw new Error('not owned'); };
  try {
    await assert.rejects(handleMcpInteraction('page.upload', { selector: '#upload', filename: 'x.txt', base64: 'eA==' }, context, 7), /not owned/);
    assert.deepEqual(input.files, []);
  } finally { tabLeaseManager.authorizeWrite = authorize; }
});

test('wait polls text without debugger; scroll mutates only after renewed lease check', async () => {
  browser();
  const authorize = tabLeaseManager.authorizeWrite;
  const authorizeRead = tabLeaseManager.authorize;
  tabLeaseManager.authorize = () => {};
  try {
    document.body.innerText = 'ready';
    const result = await handleMcpInteraction('page.wait', { for: 'text', text: 'ready', timeoutMs: 1000 }, context, 7);
    assert.equal(result.found, true);
    tabLeaseManager.authorizeWrite = () => { throw new Error('lease denied'); };
    await assert.rejects(handleMcpInteraction('page.scroll', { deltaY: 120 }, context, 7), /lease denied/);
    assert.equal(window.scrollY, 0);
    tabLeaseManager.authorizeWrite = () => {};
    await handleMcpInteraction('page.scroll', { deltaY: 120 }, context, 7);
    assert.equal(window.scrollY, 120);
  } finally { tabLeaseManager.authorizeWrite = authorize; tabLeaseManager.authorize = authorizeRead; }
});

test('scroll re-dispatches a synthetic wheel and explains a zero delta with all three causes', async () => {
  const { events, make } = browser();
  const box = make('DIV', { scrollTop: 0, scrollLeft: 0, clientHeight: 100, clientWidth: 100, scrollHeight: 400, scrollWidth: 100,
    scrollBy(x, y) {
      this.scrollLeft = Math.max(0, Math.min(this.scrollLeft + x, this.scrollWidth - this.clientWidth));
      this.scrollTop = Math.max(0, Math.min(this.scrollTop + y, this.scrollHeight - this.clientHeight));
    } });
  document.querySelector = () => box;
  const authorize = tabLeaseManager.authorizeWrite;
  tabLeaseManager.authorizeWrite = () => {};
  try {
    const moved = await handleMcpInteraction('page.scroll', { selector: '#scroll-box', deltaY: 300 }, context, 7);
    assert.equal(moved.changed, true);
    assert.equal(moved.diagnostic, undefined);
    assert.equal(box.scrollTop, 300);
    // 只监听 wheel 的懒加载与自定义滚动容器：scrollBy 自身不产生 wheel，必须补发。
    assert.deepEqual(events, ['wheel', 'scroll']);
    // 已到边界：位置不变时把三种成因并列报出，并指向 focus。
    const stuck = await handleMcpInteraction('page.scroll', { selector: '#scroll-box', deltaY: 300 }, context, 7);
    assert.equal(stuck.changed, false);
    assert.match(stuck.diagnostic, /不可滚动/);
    assert.match(stuck.diagnostic, /焦点/);
    assert.match(stuck.diagnostic, /懒加载/);
    assert.match(stuck.diagnostic, /IntersectionObserver/);
    assert.match(stuck.diagnostic, /focus:true/);
    // 余量是「还能滚多少」：滚到 300/300 后必须报 0，报 300（总量）会让调用方误判成还能滚。
    assert.match(stuck.diagnostic, /余量 x=0 y=0/);
  } finally { tabLeaseManager.authorizeWrite = authorize; }
});

test('idle waits until mutations stop, without requiring debugger', async () => {
  browser();
  const authorizeRead = tabLeaseManager.authorize;
  tabLeaseManager.authorize = () => {};
  let onMutation;
  let observed = false;
  globalThis.MutationObserver = class {
    constructor(callback) { onMutation = callback; }
    observe() { observed = true; }
    disconnect() {}
  };
  try {
    const start = Date.now();
    const pending = handleMcpInteraction('page.wait', { for: 'idle', timeoutMs: 2000 }, context, 7);
    await new Promise((resolve) => setTimeout(resolve, 100));
    onMutation();
    const result = await pending;
    assert.equal(observed, true);
    assert.equal(result.found, true);
    assert.ok(Date.now() - start >= 550);
  } finally { tabLeaseManager.authorize = authorizeRead; }
});

test('injected interaction args never contain undefined, so Chrome accepts every call', async () => {
  // 回归：无 ref 的 scroll/select/upload/key/wait 是常态。尾部参数若占位成 undefined，
  // Chrome 会整条拒绝（"Value is unserializable"），这五条能力全部不可用。
  const { make, injectedArgs } = browser();
  const select = make('SELECT', { options: [{ value: 'two', textContent: 'Two' }], value: 'one' });
  document.querySelector = () => select;
  // page.key 无 selector/ref 时要求页面已有聚焦元素。
  document.activeElement = make('BUTTON', { textContent: 'Save' });
  const authorize = tabLeaseManager.authorizeWrite;
  const authorizeRead = tabLeaseManager.authorize;
  tabLeaseManager.authorizeWrite = () => {};
  // page.wait 只取读租约。
  tabLeaseManager.authorize = () => {};
  try {
    await handleMcpInteraction('page.scroll', { deltaY: 10 }, context, 7);
    await handleMcpInteraction('page.select', { selector: '#select', value: 'two' }, context, 7);
    await handleMcpInteraction('page.key', { keys: ['Tab'] }, context, 7);
    await handleMcpInteraction('page.wait', { for: 'selector', selector: '#select', timeoutMs: 500 }, context, 7);
    assert.equal(injectedArgs.length, 4, 'every call must reach the page through executeScript');
    for (const args of injectedArgs) {
      assert.ok(args.every((arg) => arg !== undefined), `args must be serializable: ${JSON.stringify(args)}`);
    }
  } finally { tabLeaseManager.authorizeWrite = authorize; tabLeaseManager.authorize = authorizeRead; }
});

test('a page-side throw in an interaction surfaces its real reason', async () => {
  // 回归：同一条吞异常约束，interactOnPage 的 throw 也必须还原成可操作的原因。
  const { make } = browser();
  make('SELECT');
  document.querySelector = () => null;
  const authorize = tabLeaseManager.authorizeWrite;
  tabLeaseManager.authorizeWrite = () => {};
  try {
    await assert.rejects(
      handleMcpInteraction('page.select', { selector: '#gone', value: 'two' }, context, 7),
      /元素未找到或句柄已失效: #gone/,
    );
  } finally { tabLeaseManager.authorizeWrite = authorize; }
});
