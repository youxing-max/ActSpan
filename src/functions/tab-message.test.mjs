import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const out = await build({
  stdin: { contents: `export { sendToTabWithRetry } from './src/functions/tab-message.ts';`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { sendToTabWithRetry } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].contents).toString('base64')}`);

test('synchronous messaging errors reject promptly rather than becoming a probe timeout', async (t) => {
  t.mock.method(console, 'error', () => {});
  const previous = globalThis.chrome;
  globalThis.chrome = { runtime: {}, tabs: { sendMessage: () => { throw new Error('Invalid tab ID'); } } };
  try {
    await assert.rejects(sendToTabWithRetry(1, 'probe', {}, { deadlineMs: 1000 }), /Invalid tab ID/);
  } finally { globalThis.chrome = previous; }
});

test('undefined probe replies reconnect once and preserve the requested frame', async () => {
  const previous = globalThis.chrome;
  const frames = [];
  let injections = 0;
  globalThis.chrome = { runtime: {},
    tabs: { get: async () => ({ url: 'https://example.test/' }), sendMessage: (_id, _message, options, callback) => {
      frames.push(options.frameId); callback(frames.length === 1 ? undefined : { matched: true });
    } },
    scripting: { executeScript: async () => { injections += 1; } },
  };
  try {
    assert.deepEqual(await sendToTabWithRetry(1, 'probe', {}, { frameId: 47 }), { matched: true });
    assert.deepEqual(frames, [47, 47]); assert.equal(injections, 1);
  } finally { globalThis.chrome = previous; }
});

test('abort during content injection cancels retry and sends no further message', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const previous = globalThis.chrome;
  const controller = new AbortController();
  let sends = 0;
  let finishInjection;
  globalThis.chrome = { runtime: {},
    tabs: { get: async () => ({ url: 'https://example.test/' }), sendMessage: (_id, _message, callback) => {
      sends += 1; globalThis.chrome.runtime.lastError = { message: 'Receiving end does not exist' }; callback(); delete globalThis.chrome.runtime.lastError;
    } },
    scripting: { executeScript: () => new Promise((resolve) => { finishInjection = resolve; }) },
  };
  try {
    const request = sendToTabWithRetry(1, 'probe', {}, { signal: controller.signal });
    const rejected = assert.rejects(request, { name: 'AbortError' });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(); await rejected; finishInjection([]);
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(2000); await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sends, 1);
  } finally { globalThis.chrome = previous; }
});

test('an unanswered probe times out once and ignores its late reply', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const previous = globalThis.chrome;
  let callback;
  globalThis.chrome = { runtime: {}, tabs: { sendMessage: (_id, _message, reply) => { callback = reply; } } };
  try {
    const rejected = assert.rejects(sendToTabWithRetry(1, 'probe', {}, { deadlineMs: 1000, timeoutMessage: 'probe expired' }), /probe expired/);
    t.mock.timers.tick(1000); await rejected; callback({ matched: true });
  } finally { globalThis.chrome = previous; }
});
