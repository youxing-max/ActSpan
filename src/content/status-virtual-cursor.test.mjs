import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `
      export { normalizeStatusText, parseStatusUpdate } from './src/content/float-ball/text-utils.ts';
      export { default as Channel } from './src/lib/channel.ts';
      export {
        VIRTUAL_CURSOR_EVENT,
        VIRTUAL_CURSOR_HOOKS,
        normalizeVirtualCursorUpdate,
        applyVirtualCursorUpdate,
        detectObstruction,
        withVirtualCursorBeforeObstruction,
        initVirtualCursor,
        emitVirtualCursorHook,
      } from './src/content/virtual-cursor.ts';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});

const {
  normalizeStatusText,
  parseStatusUpdate,
  VIRTUAL_CURSOR_EVENT,
  VIRTUAL_CURSOR_HOOKS,
  normalizeVirtualCursorUpdate,
  applyVirtualCursorUpdate,
  detectObstruction,
  withVirtualCursorBeforeObstruction,
  initVirtualCursor,
  emitVirtualCursorHook,
  Channel,
} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

test('status text stays user-facing, preserves language, and fits the 80-character contract', () => {
  const text = normalizeStatusText('  Read the page and compare the visible prices.  ', 'en');
  assert.equal(text, 'Read the page and compare the visible prices.');
  assert.ok(text.length <= 80);
});

test('status text removes internal tool details instead of guessing from a tool name', () => {
  const text = normalizeStatusText('post_tool_execution_verify page_snapshot ec-12', 'zh');
  assert.equal(text, '我正在确认刚才的操作是否成功');
  assert.ok(!text.includes('page_snapshot'));
});
test('internal detail sanitization retains English for English status', () => {
  assert.equal(normalizeStatusText('post_tool_execution_verify page_snapshot ec-12', 'en'), 'I am verifying the action.');
});

test('user-facing status never echoes declared user input content', () => {
  const text = normalizeStatusText('正在把 hunter2 填进密码框', 'zh', ['hunter2']);
  assert.doesNotMatch(text, /hunter2/);
  assert.match(text, /已隐藏用户输入/);

  const payload = parseStatusUpdate({
    text: 'Typing "Alice-Chen" into #checkout-form',
    language: 'en',
    userInputs: ['Alice-Chen', '#checkout-form'],
  });
  assert.ok(payload);
  assert.doesNotMatch(payload.text, /Alice-Chen|#checkout-form/);
  assert.match(payload.text, /已隐藏用户输入/);
  assert.equal('userInputs' in payload, false);

  // 两字中文姓名同样属于用户输入，不能因为短就放行
  const zh = normalizeStatusText('正在输入 张三 的收货地址', 'zh', ['张三']);
  assert.doesNotMatch(zh, /张三/);
  assert.equal(zh, '正在输入 [已隐藏用户输入] 的收货地址');
});

test('credential fragments are masked even when no user input is declared', () => {
  const text = normalizeStatusText('正在提交 password=R4ndom!Pass token: abc123', 'zh');
  assert.doesNotMatch(text, /R4ndom!Pass|abc123/);
  assert.match(text, /password=\[已隐藏用户输入\]/);
  assert.match(text, /token: \[已隐藏用户输入\]/);
});

test('status that only repeats user input still yields user-facing copy without it', () => {
  assert.doesNotMatch(normalizeStatusText('hunter2', 'zh', ['hunter2']), /hunter2/);
  assert.doesNotMatch(normalizeStatusText('post_tool_execution_verify hunter2', 'zh', ['hunter2']), /hunter2/);
});

test('explicit Spanish status keeps its language and is clipped to eighty characters', () => {
  const text = normalizeStatusText('Voy a revisar los resultados y comparar los precios visibles. '.repeat(3), 'es');
  assert.ok(text.startsWith('Voy a revisar'));
  assert.ok(text.length <= 80);
});
test('status payload rejects empty text and accepts the optional language', () => {
  assert.equal(parseStatusUpdate({ text: '   ' }), null);
  assert.deepEqual(parseStatusUpdate({ text: 'Open the menu', language: 'en-US' }), {
    text: 'Open the menu',
    language: 'en-US',
  });
});

test('virtual cursor updates require finite viewport coordinates', () => {
  assert.deepEqual(normalizeVirtualCursorUpdate({ x: 12, y: 24, phase: 'press', label: 'Save' }), {
    x: 12,
    y: 24,
    phase: 'press',
    label: 'Save',
    visible: true,
  });
  assert.equal(normalizeVirtualCursorUpdate({ x: Number.NaN, y: 24 }), null);
  assert.equal(normalizeVirtualCursorUpdate({ x: '12', y: 24 }), null);
  assert.equal(normalizeVirtualCursorUpdate({ x: null, y: 24 }), null);
});

test('virtual cursor visibly moves and restores to idle', () => {
  const classNames = new Set();
  const cursor = {
    style: { display: '', transform: '' },
    classList: {
      add: (name) => classNames.add(name),
      remove: (name) => classNames.delete(name),
    },
  };

  applyVirtualCursorUpdate(cursor, { x: 12, y: 24, phase: 'move', visible: true });
  assert.equal(cursor.style.display, 'block');
  assert.equal(cursor.style.transform, 'translate3d(12px, 24px, 0)');
  assert.ok(classNames.has('is-move'));

  applyVirtualCursorUpdate(cursor, { x: 12, y: 24, phase: 'idle', visible: false });
  assert.equal(cursor.style.display, 'none');
  assert.ok(!classNames.has('is-move'));
});

test('obstruction check treats a target hit above background as unobstructed', () => {
  const target = { contains: () => false, closest: () => null };
  const background = { closest: () => null };
  assert.deepEqual(detectObstruction(target, { x: 3, y: 4 }, { elementsFromPoint: () => [target, background] }), { obstructed: false });
  assert.deepEqual(detectObstruction(target, { x: 3, y: 4 }, { elementsFromPoint: () => [background, target] }), { obstructed: true, element: background });
});

test('virtual cursor hook is emitted before obstruction detection', () => {
  const events = [];
  const result = withVirtualCursorBeforeObstruction(
    { x: 10, y: 20, phase: 'move' },
    () => {
      events.push('obstruction');
      return 'checked';
    },
    (hook) => events.push(hook),
  );

  assert.equal(VIRTUAL_CURSOR_EVENT, '__virtual_cursor');
  assert.equal(VIRTUAL_CURSOR_HOOKS.beforeObstruction, 'before_obstruction');
  assert.equal(result, 'checked');
  assert.deepEqual(events, ['before_obstruction', 'obstruction', 'after_obstruction']);
});

test('mounted page cursor appears before hit-testing and returns to idle after a paint interval', () => {
  const listeners = new Map();
  const timers = [];
  const win = {
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: (name) => listeners.delete(name),
    dispatchEvent: (event) => { listeners.get(event.type)?.(event); return true; },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
  };
  const makeElement = () => {
    const classes = new Set();
    return {
      style: { cssText: '', display: '', transform: '' },
      classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) },
      setAttribute: () => {},
      append(...children) { this.firstElementChild = children[0]; this.label = children[1]; },
      appendChild(child) { this.child = child; },
      querySelector() { return this.label; },
      remove() { this.removed = true; },
    };
  };
  const body = makeElement();
  const doc = { body, querySelector: () => null, createElement: makeElement };
  const dispose = initVirtualCursor(doc, win);
  const cursor = body.child;
  const events = [];
  const result = withVirtualCursorBeforeObstruction(
    { x: 10, y: 20, phase: 'move' },
    () => { events.push(cursor.style.display); return 'clear'; },
    (hook, update) => emitVirtualCursorHook(hook, update, win),
  );
  assert.equal(result, 'clear');
  assert.deepEqual(events, ['block']);
  assert.equal(cursor.style.display, 'block');
  for (const hide of Channel.handlers.get('__screenshot_hide')) hide();
  assert.equal(cursor.style.display, 'none');
  withVirtualCursorBeforeObstruction({ x: 12, y: 24 }, () => null, (hook, update) => emitVirtualCursorHook(hook, update, win));
  assert.equal(cursor.style.display, 'block');
  timers.at(-1)();
  assert.equal(cursor.style.display, 'none');
  dispose();
  assert.equal(cursor.removed, true);
});
