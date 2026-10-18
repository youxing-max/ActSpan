import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: { contents: `
    export { screenshotFunction } from './src/functions/screenshot.ts';
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { screenshotFunction } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);


test('captures an explicit background tab without activating it', async () => {
  const updates = [];
  globalThis.chrome = {
    tabs: {
      query: async () => [{ id: 1, windowId: 7, active: true, url: 'https://user.example/' }],
      get: async (id) => id === 2
        ? { id: 2, windowId: 7, active: false, status: 'complete', url: 'https://task.example/result' }
        : { id: 1, windowId: 7, active: true, status: 'complete', url: 'https://user.example/' },
      update: async (id, change) => {
        updates.push({ id, ...change });
        return { id, windowId: 7, active: change.active === true, status: 'complete', url: id === 2 ? 'https://task.example/result' : 'https://user.example/' };
      },
      sendMessage: (_id, _message, callback) => { if (callback) callback({ success: false }); },
      captureVisibleTab: async () => { throw new Error('background screenshot must not use captureVisibleTab'); },
    },
    storage: {
      local: {
        get: (_key, callback) => callback({}),
        set: (_items, callback) => callback?.(),
      },
    },
    debugger: {
      onEvent: { addListener() {} },
      attach: async () => {},
      detach: async () => {},
      sendCommand: async (_target, method) => method === 'Page.captureScreenshot'
        ? { data: 'c2NyZWVuc2hvdA==' }
        : {},
    },
    runtime: { lastError: undefined },
  };

  const result = await screenshotFunction.execute({ tab_id: 2, wait_ms: 3000 });

  assert.equal(result.success, true);
  assert.deepEqual(updates, [{ id: 1, active: true }]);
});
