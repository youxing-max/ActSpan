import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: { contents: `
    export { askUserFunction } from './src/functions/ask-user.ts';
    export { requestConfirmationFunction } from './src/functions/request-confirmation.ts';
    export { default as Channel } from './src/lib/channel.ts';
    export { chatStream } from './src/ai/llm-client.ts';
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { askUserFunction, requestConfirmationFunction, Channel, chatStream } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

globalThis.chrome = {
  storage: { local: { get: async () => ({ actspan_ai_settings: { apiKey: 'test-key', endpoint: 'https://test.invalid/responses' }, actspan_migrated_actspan_ai_settings: true }), set: async () => {} } },
};

const withShortTimers = async (fn, delayFor = delay => Math.min(delay, 5)) => {
  const original = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => original(callback, delayFor(delay), ...args);
  try {
    return await fn();
  } finally {
    globalThis.setTimeout = original;
  }
};

const captureChannel = () => {
  const handlers = new Map();
  const broadcasts = [];
  const original = { on: Channel.on, off: Channel.off, broadcast: Channel.broadcast };
  Channel.on = (type, handler) => {
    handlers.set(type, handler);
  };
  Channel.off = (type) => {
    handlers.delete(type);
  };
  Channel.broadcast = (type, data) => {
    broadcasts.push({ type, data });
  };
  return {
    broadcasts,
    handlers,
    restore() {
      Channel.on = original.on;
      Channel.off = original.off;
      Channel.broadcast = original.broadcast;
    },
  };
};

test('ask_user times out, removes its listener, and broadcasts cancellation', async () => {
  const channel = captureChannel();
  try {
    const result = await withShortTimers(() => askUserFunction.execute({ question: 'No response?' }));
    assert.equal(result.success, false);
    assert.match(result.error, /E_TIMEOUT/);
    assert.equal(result.data.code, 'timed_out');
    assert.equal(channel.handlers.size, 0);
    assert.ok(channel.broadcasts.some(({ type }) => type === '__ask_user_cancel'));
  } finally {
    channel.restore();
  }
});

test('ask_user allows the existing option response and distinguishes denial and cancellation', async () => {
  const channel = captureChannel();
  try {
    const approve = askUserFunction.execute({ question: 'Choose?', options: ['Yes', 'No'] });
    const requestId = channel.broadcasts.find(({ type }) => type === '__ask_user_request').data.requestId;
    channel.handlers.get('__ask_user_response')({ requestId, answer: 'Yes', source: 'option' });
    assert.deepEqual((await approve).data, { answer: 'Yes', source: 'option' });

    const deny = askUserFunction.execute({ question: 'Choose?' });
    const deniedId = channel.broadcasts.filter(({ type }) => type === '__ask_user_request').at(-1).data.requestId;
    channel.handlers.get('__ask_user_response')({ requestId: deniedId, denied: true });
    const denied = await deny;
    assert.equal(denied.success, false);
    assert.equal(denied.data.code, 'denied');
    assert.equal(channel.broadcasts.find(({ type, data }) => type === '__ask_user_cancel' && data.requestId === deniedId).data.code, 'denied');

    const controller = new AbortController();
    const cancelledPromise = askUserFunction.execute({ question: 'Wait?' }, { signal: controller.signal });
    controller.abort();
    const cancelled = await cancelledPromise;
    assert.equal(cancelled.success, false);
    assert.equal(cancelled.data.code, 'cancelled');
    assert.equal(channel.handlers.size, 0);
  } finally {
    channel.restore();
  }
});

test('ask_user unattended mode returns without broadcasting or waiting', async () => {
  const channel = captureChannel();
  try {
    const result = await askUserFunction.execute({ question: 'Can anyone answer?', unattended: true });
    assert.equal(result.success, false);
    assert.equal(result.data.code, 'unattended');
    assert.deepEqual(channel.broadcasts, []);
    assert.equal(channel.handlers.size, 0);
  } finally {
    channel.restore();
  }
});

test('ask_user until settles when a condition becomes true on the controlled tab', async () => {
  const channel = captureChannel();
  const originalScripting = globalThis.chrome.scripting;
  const inspectedTabs = [];
  let attempts = 0;
  globalThis.chrome.scripting = {
    async executeScript({ target, func, args }) {
      inspectedTabs.push(target.tabId);
      attempts++;
      return [{ result: func(...args) }];
    },
  };
  const originalDocument = globalThis.document;
  globalThis.document = { querySelector: () => attempts > 1 ? {} : null, body: { innerText: '' } };
  try {
    const result = await withShortTimers(() => askUserFunction.execute(
      { question: 'Wait for completion?', until: { selectorExists: '#done' } },
      { tabId: 17 },
    ), delay => delay > 1000 ? 40 : 1);
    assert.equal(result.success, true);
    assert.equal(result.data.code, 'until');
    assert.deepEqual(inspectedTabs, [17, 17]);
    assert.equal(channel.handlers.size, 0);
    assert.equal(channel.broadcasts.find(({ type }) => type === '__ask_user_cancel').data.code, 'until');
  } finally {
    globalThis.document = originalDocument;
    globalThis.chrome.scripting = originalScripting;
    channel.restore();
  }
});

test('ask_user until requires a controlled tab and all supplied page conditions', async () => {
  const channel = captureChannel();
  const originalScripting = globalThis.chrome.scripting;
  const originalDocument = globalThis.document;
  const originalLocation = globalThis.location;
  let attempts = 0;
  globalThis.document = { querySelector: () => ({}), body: { innerText: 'Ready' } };
  globalThis.location = { href: 'https://test.invalid/start' };
  globalThis.chrome.scripting = {
    async executeScript({ target, func, args }) {
      assert.equal(target.tabId, 19);
      attempts++;
      if (attempts === 2) globalThis.location.href = 'https://test.invalid/finish';
      return [{ result: func(...args) }];
    },
  };
  try {
    const missingTab = await askUserFunction.execute({ question: 'Wait?', until: { selectorExists: '#done' } });
    assert.equal(missingTab.success, false);
    assert.match(missingTab.error, /tabId/);
    assert.equal(channel.broadcasts.length, 0);
    const result = await withShortTimers(() => askUserFunction.execute(
      { question: 'Wait?', until: { selectorExists: '#done', textContains: 'Ready', urlContains: '/finish' } },
      { tabId: 19 },
    ), delay => delay > 1000 ? 40 : 1);
    assert.equal(result.data.code, 'until');
    assert.equal(attempts, 2);
  } finally {
    globalThis.document = originalDocument;
    globalThis.location = originalLocation;
    globalThis.chrome.scripting = originalScripting;
    channel.restore();
  }
});

test('ask_user until polling stops on cancellation even when a page check is pending', async () => {
  const channel = captureChannel();
  const originalScripting = globalThis.chrome.scripting;
  let completeCheck;
  globalThis.chrome.scripting = { executeScript: () => new Promise(resolve => { completeCheck = resolve; }) };
  try {
    const controller = new AbortController();
    const pending = askUserFunction.execute({ question: 'Wait?', until: { selectorExists: '#done' } }, { tabId: 17, signal: controller.signal });
    controller.abort();
    const result = await pending;
    completeCheck?.([{ result: true }]);
    await Promise.resolve();
    assert.equal(result.data.code, 'cancelled');
    assert.equal(channel.handlers.size, 0);
    assert.equal(channel.broadcasts.some(({ type }) => type === '__ask_user_settled'), false);
  } finally {
    globalThis.chrome.scripting = originalScripting;
    channel.restore();
  }
});

test('request_confirmation times out, removes its listener, and broadcasts cancellation', async () => {
  const channel = captureChannel();
  try {
    const result = await withShortTimers(() => requestConfirmationFunction.execute({ message: 'Approve?' }));
    assert.equal(result.success, false);
    assert.match(result.error, /E_TIMEOUT/);
    assert.equal(channel.handlers.size, 0);
    assert.ok(channel.broadcasts.some(({ type }) => type === '__approval_cancel'));
  } finally {
    channel.restore();
  }
});

test('chatStream aborts an idle response without a completion frame', async () => {
  const channel = captureChannel();
  const reader = {
    async read() {
      return await new Promise(() => {});
    },
    cancel() {
      reader.cancelled = true;
      return Promise.resolve();
    },
    releaseLock() {
      reader.released = true;
    },
    released: false,
    cancelled: false,
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    reader.signal = options.signal;
    return { ok: true, body: { getReader: () => reader } };
  };
  try {
    await assert.rejects(
      withShortTimers(async () => {
        for await (const _chunk of chatStream([])) {
          // no chunks expected
        }
      }),
      error => /E_TIMEOUT/.test(String(error?.message || error?.code)),
    );
    assert.equal(reader.released, true);
    assert.equal(reader.signal.aborted, true);
  } finally {
    globalThis.fetch = previousFetch;
    channel.restore();
  }
});
