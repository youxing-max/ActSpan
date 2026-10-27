import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `export { cdpInputFunction } from './src/functions/cdp-input.ts';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { cdpInputFunction } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

test('rejects ambiguous element_id and selector locators', () => {
  assert.match(
    cdpInputFunction.validate({ action: 'fill', element_id: 'ec-1', selector: '#email', value: 'a@b.test' }) || '',
    /同时|either|ambiguous|mutually/i,
  );
});

test('mouse targeting errors explain the supported recovery instead of suggesting selector retries', () => {
  for (const action of ['click', 'double_click', 'right_click', 'hover', 'drag']) {
    const error = cdpInputFunction.validate({ action, selector: '#comment-entry' });
    assert.match(error, /selector.*not supported/i, action);
    assert.match(error, /snapshot_id/, action);
    assert.match(error, /page.*snapshot/i, action);
  }
  assert.equal(cdpInputFunction.validate({ action: 'click', x: 10, y: 20 }), null);
  assert.equal(cdpInputFunction.validate({ action: 'click', element_id: 'ec-1', snapshot_id: 'snap-1' }), null);
  assert.equal(cdpInputFunction.validate({ action: 'fill', selector: '#comment', value: 'draft' }), null);
});

test('selector help lists only actions that actually use a CSS selector', () => {
  const help = cdpInputFunction.parameters.properties.selector.description;
  assert.match(help, /type/);
  assert.doesNotMatch(help, /click_text/);
  assert.match(cdpInputFunction.description, /click\/double_click\/right_click\/hover\/drag.*not.*selector/i);
});

// 用假的 CDPSessionManager + 假页面状态验证 performType：CDP 按键只发给 activeElement，
// 焦点不对时事件全部丢失但 sendCommand 仍返回 success，这正是要挡住的路径。
const FAKE_SESSION_SRC = `
const page = () => globalThis.__actspanFakePage;
export const CDPSessionManager = {
  isSupported: () => true,
  attach: async () => ({ success: true }),
  sendCommand: async (tabId, method, params) => {
    const p = page();
    (p.commands ??= []).push({ method, params });
    if (method === 'Emulation.setFocusEmulationEnabled') p.focusEmulated = params.enabled;
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed' && p.failMousePress) {
      return { success: false, error: 'Mouse press rejected' };
    }
    if (method === 'Runtime.evaluate') {
      const f = p.focus;
      const value = f
        ? { editable: f.editable, tag: f.tag, value: f.value }
        : { editable: false, tag: '', value: '' };
      return { success: true, result: { result: { value } } };
    }
    if (method === 'Input.insertText' || method === 'Input.dispatchKeyEvent') {
      p.dispatched += 1;
      const inserts = method === 'Input.insertText' || params.type === 'char';
      if (inserts && p.focus && p.focus.editable && !p.dropKeys) p.focus.value += params.text || '';
      return { success: true, result: {} };
    }
    return { success: true, result: {} };
  },
};
`;

const bundleWithFakeSession = async () => {
  const out = await build({
    stdin: {
      contents: `export { cdpInputFunction, realClickAt } from './src/functions/cdp-input.ts';`,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    plugins: [{
      name: 'fake-cdp-session',
      setup(b) {
        b.onResolve({ filter: /lib\/cdp-session$/ }, () => ({ path: 'fake-cdp-session', namespace: 'fake' }));
        b.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: FAKE_SESSION_SRC, loader: 'js' }));
      },
    }],
  });
  const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].contents).toString('base64')}`);
  return mod;
};

const { cdpInputFunction: cdpInputWithFakePage, realClickAt } = await bundleWithFakeSession();
const setPage = (focus, dropKeys = false) => {
  globalThis.__actspanFakePage = { focus, dispatched: 0, dropKeys };
  return globalThis.__actspanFakePage;
};

test('real clicks temporarily emulate focus so hidden tabs receive the complete mouse sequence', async () => {
  const page = setPage(null);
  assert.deepEqual(await realClickAt(5, 10, 20), { success: true });
  assert.deepEqual(page.commands.map(({ method, params }) =>
    method === 'Emulation.setFocusEmulationEnabled' ? `focus:${params.enabled}` : params.type),
  ['focus:true', 'mouseMoved', 'mousePressed', 'mouseReleased', 'focus:false']);
  assert.equal(page.focusEmulated, false);
});

test('real clicks restore focus emulation when pressing fails or the operation is aborted', async () => {
  const page = setPage(null);
  page.failMousePress = true;
  assert.deepEqual(await realClickAt(5, 10, 20), { success: false, error: 'Mouse press rejected' });
  assert.equal(page.focusEmulated, false);
  assert.deepEqual(page.commands.at(-1), {
    method: 'Emulation.setFocusEmulationEnabled', params: { enabled: false },
  });

  const aborted = setPage(null);
  await assert.rejects(() => realClickAt(5, 10, 20, AbortSignal.abort()), { name: 'AbortError' });
  assert.notEqual(aborted.focusEmulated, true);
  assert.equal((aborted.commands ?? []).some(({ method }) => method.startsWith('Input.')), false);
});

test('type fails when no element has focus', async () => {
  const page = setPage(null);
  const result = await cdpInputWithFakePage.execute({ action: 'type', text: 'hello', tab_id: 5, interval_ms: 0 });
  assert.equal(result.success, false);
  assert.match(result.error || '', /焦点/);
  assert.equal(page.dispatched, 0, '不得在没有焦点时发送按键');
});

test('type fails when the focused element is not editable', async () => {
  const page = setPage({ tag: 'div', editable: false, value: '' });
  const result = await cdpInputWithFakePage.execute({ action: 'type', text: 'hello', tab_id: 5, interval_ms: 0 });
  assert.equal(result.success, false);
  assert.match(result.error || '', /焦点/);
  assert.equal(result.data?.focused_tag, 'div');
  assert.equal(page.dispatched, 0);
});

test('type succeeds and reports the observed text when the field receives it', async () => {
  setPage({ tag: 'input', editable: true, value: '' });
  const result = await cdpInputWithFakePage.execute({ action: 'type', text: 'hello', tab_id: 5, interval_ms: 0 });
  assert.equal(result.success, true);
  assert.equal(result.data?.tag, 'input');
  assert.equal(result.data?.length, 5);
  assert.equal(result.data?.value, 'hello');
});

test('type fails when keys were dispatched but the value never changed', async () => {
  setPage({ tag: 'input', editable: true, value: '' }, true);
  const result = await cdpInputWithFakePage.execute({ action: 'type', text: 'hello', tab_id: 5, interval_ms: 0 });
  assert.equal(result.success, false);
  assert.match(result.error || '', /未变化/);
  assert.equal(result.data?.value, '');
});

test('reports NEEDS_L2 when the debugger API is unavailable', async () => {
  const result = await cdpInputFunction.execute({ action: 'key_press', key: 'Enter', tab_id: 7 });
  assert.equal(result.success, false);
  assert.match(result.error || '', /NEEDS_L2/);
  assert.equal(result.diagnostic?.action, 'key_press');
});
