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

/** 安装 chrome mock，返回所有发往 tab 的消息，便于断言透传字段 */
const installChromeMock = () => {
  const messages = [];
  globalThis.chrome = {
    tabs: {
      query: async () => [{ id: 1, windowId: 7, active: true, url: 'https://user.example/' }],
      get: async (id) => ({ id, windowId: 7, active: id === 1, status: 'complete', url: 'https://user.example/' }),
      update: async (id, change) => ({ id, windowId: 7, active: change.active === true, status: 'complete', url: 'https://user.example/' }),
      remove: async () => {},
      sendMessage: (_id, message, callback) => {
        messages.push(message);
        if (!callback) return;
        callback(message.type === '__get_element_rect'
          ? { success: true, rect: { x: 10, y: 20, width: 100, height: 50 } }
          : { success: true });
      },
      captureVisibleTab: async () => { throw new Error('element screenshot must use CDP'); },
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
  return messages;
};

test('url capture rejects non-http and unowned page creation', async () => {
  installChromeMock();
  let created = 0;
  globalThis.chrome.tabs.create = async (options) => { created += 1; return { id: 9, windowId: 7, active: false, status: 'complete', url: options.url }; };

  const fileResult = await screenshotFunction.execute({ url: 'file:///etc/passwd' });
  assert.equal(fileResult.success, false);
  assert.match(fileResult.error, /http|https/);
  assert.equal(created, 0);

  const noTask = await screenshotFunction.execute({ url: 'https://evil.example/' });
  assert.equal(noTask.success, false);
  assert.match(noTask.error, /任务上下文/);
  assert.equal(created, 0);
});

test('rejects screenshots after a redirect to loopback', async () => {
  globalThis.chrome = {
    tabs: {
      query: async () => [{ id: 1, windowId: 7, active: true, url: 'https://user.example/' }],
      get: async (id) => ({ id, windowId: 7, active: id === 1, status: 'complete',
        url: id === 2 ? 'http://127.0.0.1/admin' : 'https://user.example/' }),
      sendMessage: (_id, _message, callback) => callback?.({ success: false }),
    },
    storage: { local: { get: (_key, callback) => callback({}), set: (_items, callback) => callback?.() } },
    runtime: { lastError: undefined },
  };

  const result = await screenshotFunction.execute({ tab_id: 2, wait_ms: 3000 });

  assert.equal(result.success, false);
  assert.match(result.error, /重定向/);
});

test('forwards snapshot_id when resolving an element rect', async () => {
  const messages = installChromeMock();

  const result = await screenshotFunction.execute({ tab_id: 2, element_id: 'el-1', snapshot_id: 'snap-1' });

  assert.equal(result.success, true);
  const rectMessages = messages.filter((message) => message.type === '__get_element_rect');
  assert.equal(rectMessages.length, 1);
  assert.deepEqual(rectMessages[0].data, { element_id: 'el-1', snapshot_id: 'snap-1' });
});

test('keeps the legacy payload when snapshot_id is omitted', async () => {
  const messages = installChromeMock();

  const result = await screenshotFunction.execute({ tab_id: 2, element_id: 'el-1' });

  assert.equal(result.success, true);
  const rectMessages = messages.filter((message) => message.type === '__get_element_rect');
  assert.equal(rectMessages.length, 1);
  assert.deepEqual(rectMessages[0].data, { element_id: 'el-1' });
  assert.equal(Object.hasOwn(rectMessages[0].data, 'snapshot_id'), false);
});


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
