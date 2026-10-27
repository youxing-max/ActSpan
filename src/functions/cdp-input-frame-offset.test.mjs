import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const plugin = { name: 'fake-cdp', setup(b) {
  b.onResolve({ filter: /lib\/cdp-session$/ }, () => ({ path: 'fake-cdp', namespace: 'fake' }));
  b.onLoad({ filter: /^fake-cdp$/, namespace: 'fake' }, () => ({ contents: `
    export const CDPSessionManager = {
      isSupported: () => true, attach: async () => ({ success: true }),
      sendCommand: async (_tabId, method, params) => {
        globalThis.__frameCommands.push({ method, params });
        if (method.startsWith('DOM.')) return { success: false, error: 'Invalid parameters: frameId must be a string' };
        return { success: true, result: {} };
      },
    };`, loader: 'js' }));
} };
const out = await build({
  stdin: { contents: `export { resolveFrameOffset, realClickAt } from './src/functions/cdp-input.ts';`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node', plugins: [plugin],
});
const { resolveFrameOffset, realClickAt } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].contents).toString('base64')}`);

const withFrames = async (frames, run) => {
  const previous = { chrome: globalThis.chrome, window: globalThis.window, document: globalThis.document, getComputedStyle: globalThis.getComputedStyle };
  globalThis.__frameCommands = [];
  const windows = new Map(frames.map((frame) => [frame.frameId, { listeners: new Set() }]));
  const elements = new Map();
  for (const frame of frames.filter((item) => item.frameId !== 0)) {
    const owner = {
      contentWindow: windows.get(frame.frameId),
      getBoundingClientRect: () => ({ x: frame.x, y: frame.y, left: frame.x, top: frame.y, width: 300, height: 200 }),
      clientLeft: frame.borderX ?? 0, clientTop: frame.borderY ?? 0,
      offsetWidth: 300, offsetHeight: 200, style: { transform: frame.transform ?? 'none', zoom: '1' },
    };
    const list = elements.get(frame.parentFrameId) ?? [];
    list.push(owner); elements.set(frame.parentFrameId, list);
  }
  globalThis.chrome = {
    webNavigation: { getAllFrames: async () => frames },
    scripting: { executeScript: async ({ target, func, args = [] }) => {
      const id = target.frameIds[0];
      const frame = frames.find((item) => item.frameId === id);
      if (!frame || frame.unavailable) throw new Error('Frame was removed');
      const win = windows.get(id);
      win.addEventListener = (_type, listener) => win.listeners.add(listener);
      win.removeEventListener = (_type, listener) => win.listeners.delete(listener);
      win.parent = { postMessage: (data) => {
        const parent = windows.get(frame.parentFrameId);
        for (const listener of [...parent.listeners]) listener({ data, source: win });
      } };
      globalThis.window = win;
      globalThis.document = { querySelectorAll: () => elements.get(id) ?? [] };
      globalThis.getComputedStyle = (element) => element.style;
      const result = await func(...args);
      return [{ frameId: id, documentId: `doc-${id}`, result }];
    } },
  };
  try { await run(windows); } finally { Object.assign(globalThis, previous); }
};

test('main frame offsets require neither CDP nor script injection', async () => {
  assert.deepEqual(await resolveFrameOffset(1, 0), { x: 0, y: 0 });
  assert.deepEqual(await resolveFrameOffset(1), { x: 0, y: 0 });
});

test('Chrome iframe viewport offsets include borders without subtracting scroll twice', async () => {
  await withFrames([{ frameId: 0, parentFrameId: -1 }, { frameId: 476, parentFrameId: 0, x: 100, y: -30, borderX: 3, borderY: 4 }], async () => {
    assert.deepEqual(await resolveFrameOffset(1, 476), { x: 103, y: -26 });
    assert.equal(globalThis.__frameCommands.length, 0);
  });
});

test('nested same-URL cross-origin frames use window identity, not URL matching', async () => {
  await withFrames([
    { frameId: 0, parentFrameId: -1 },
    { frameId: 1, parentFrameId: 0, x: 20, y: 10, borderX: 2, borderY: 2, url: 'https://same.test/' },
    { frameId: 5, parentFrameId: 1, x: 100, y: -50, borderX: 3, borderY: 4, url: 'https://same.test/' },
    { frameId: 6, parentFrameId: 1, x: 999, y: 999, url: 'https://same.test/' },
  ], async (windows) => {
    assert.deepEqual(await resolveFrameOffset(1, 5), { x: 125, y: -34 });
    assert.ok([...windows.values()].every((win) => win.listeners.size === 0));
    const result = await realClickAt(1, 10, 20, undefined, 5);
    assert.equal(result.success, true);
    const mouse = globalThis.__frameCommands.filter(({ method }) => method === 'Input.dispatchMouseEvent');
    assert.ok(mouse.length >= 3);
    assert.ok(mouse.every(({ params }) => params.x === 135 && params.y === -14));
  });
});

test('missing frames never dispatch input to the parent', async () => {
  await withFrames([{ frameId: 0, parentFrameId: -1 }], async () => {
    const result = await realClickAt(1, 10, 20, undefined, 476);
    assert.equal(result.success, false); assert.match(result.error, /iframe/);
    assert.equal(globalThis.__frameCommands.some(({ method }) => method.startsWith('Input.')), false);
  });
});

test('removed child frames clean up the parent listener and reject partial offsets', async () => {
  await withFrames([{ frameId: 0, parentFrameId: -1 }, { frameId: 9, parentFrameId: 0, x: 1, y: 2, unavailable: true }], async (windows) => {
    await assert.rejects(() => resolveFrameOffset(1, 9), /iframe/);
    assert.ok([...windows.values()].every((win) => win.listeners.size === 0));
  });
});

test('scaled iframe geometry fails safely instead of guessing coordinates', async () => {
  await withFrames([{ frameId: 0, parentFrameId: -1 }, { frameId: 9, parentFrameId: 0, x: 1, y: 2, transform: 'matrix(2, 0, 0, 2, 0, 0)' }], async () => {
    const result = await realClickAt(1, 10, 20, undefined, 9);
    assert.equal(result.success, false); assert.match(result.error, /iframe/);
    assert.equal(globalThis.__frameCommands.some(({ method }) => method.startsWith('Input.')), false);
  });
});

test('navigated documents and cancelled actions never dispatch input', async () => {
  await withFrames([{ frameId: 0, parentFrameId: -1 }, { frameId: 9, parentFrameId: 0, documentId: 'old-document', x: 1, y: 2 }], async (windows) => {
    const result = await realClickAt(1, 10, 20, undefined, 9);
    assert.equal(result.success, false);
    assert.ok([...windows.values()].every((win) => win.listeners.size === 0));
    assert.equal(globalThis.__frameCommands.length, 0);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(() => realClickAt(1, 10, 20, controller.signal), { name: 'AbortError' });
    assert.equal(globalThis.__frameCommands.length, 0);
  });
});
