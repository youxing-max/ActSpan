import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const stored = {
  actspan_webhook_config_v1: {
    version: 1,
    updatedAt: 1,
    webhooks: [{
      id: 'feishu-1',
      name: '调查结果群',
      type: 'generic',
      enabled: true,
      createdAt: 1,
      url: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-token',
    }],
  },
};

globalThis.chrome = {
  storage: {
    local: {
      get(keys, callback) {
        const names = Array.isArray(keys) ? keys : [keys];
        const result = Object.fromEntries(names.filter((key) => key in stored).map((key) => [key, stored[key]]));
        if (callback) {
          callback(result);
          return;
        }
        return Promise.resolve(result);
      },
      set(items, callback) {
        Object.assign(stored, items);
        if (callback) {
          callback();
          return;
        }
        return Promise.resolve();
      },
    },
  },
  tabs: {
    sendMessage() {},
  },
};

const bundle = await build({
  stdin: {
    contents: `
      export { createSessionPushEvent, flushFeishuCompletionNotifications } from './src/background/session-manager.ts';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { createSessionPushEvent, flushFeishuCompletionNotifications } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`
);

const waitForAsyncWork = () => new Promise((resolve) => setImmediate(resolve));

test('pushes a completed investigation result to enabled Feishu webhooks once', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ input, init });
    return new Response('{"code":0,"msg":"success"}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const session = {
      id: 'session-1',
      status: 'done',
      context: [],
      eventLog: [],
      createdAt: 1,
      startedAt: 1,
      agentState: { phase: 'finalize', round: 1, reason: '完成', updatedAt: 1 },
    };
    const pushEvent = createSessionPushEvent(session);
    const content = JSON.stringify({
      sessionId: session.id,
      runId: 'run-1',
      endedAt: 2,
      durationMs: 1,
      taskKind: 'regular',
      status: 'done',
      lastAgentMessage: '调查结果：共发现 3 条有效记录。',
    });

    pushEvent({ type: 'turn_completed', content });
    await waitForAsyncWork();
    await waitForAsyncWork();

    assert.equal(requests.length, 1);
    assert.equal(requests[0].input, stored.actspan_webhook_config_v1.webhooks[0].url);
    assert.deepEqual(JSON.parse(requests[0].init.body), {
      msg_type: 'text',
      content: { text: '调查完成\n调查结果：共发现 3 条有效记录。' },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('falls back to the latest assistant context when completion omits the result', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ input, init });
    return new Response('{"code":0,"msg":"success"}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const session = {
      id: 'session-context-fallback',
      status: 'done',
      context: [
        { role: 'assistant', content: '调查结果：录制审计已完成。' },
        { role: 'assistant', content: '[mole-context-compressed] 历史上下文已压缩。' },
      ],
      eventLog: [],
      createdAt: 1,
      startedAt: 1,
      agentState: { phase: 'finalize', round: 1, reason: '完成', updatedAt: 1 },
    };
    const pushEvent = createSessionPushEvent(session);
    pushEvent({
      type: 'turn_completed',
      content: JSON.stringify({ sessionId: session.id, runId: 'run-context-fallback', status: 'done' }),
    });
    await waitForAsyncWork();
    await waitForAsyncWork();

    assert.equal(requests.length, 1);
    assert.deepEqual(JSON.parse(requests[0].init.body), {
      msg_type: 'text',
      content: { text: '调查完成\n调查结果：录制审计已完成。' },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('flushes an in-flight Feishu completion before the task finishes', async () => {
  const originalFetch = globalThis.fetch;
  let releaseFetch;
  let fetchStarted;
  const started = new Promise((resolve) => { fetchStarted = resolve; });
  globalThis.fetch = async () => {
    fetchStarted();
    return new Promise((resolve) => { releaseFetch = resolve; });
  };

  try {
    const session = {
      id: 'session-flush',
      status: 'done',
      context: [],
      eventLog: [],
      createdAt: 1,
      startedAt: 1,
      agentState: { phase: 'finalize', round: 1, reason: '完成', updatedAt: 1 },
    };
    const pushEvent = createSessionPushEvent(session);
    pushEvent({
      type: 'turn_completed',
      content: JSON.stringify({ sessionId: session.id, status: 'done', lastAgentMessage: '已完成' }),
    });
    await started;
    let flushed = false;
    const flush = flushFeishuCompletionNotifications(session).then(() => { flushed = true; });
    await waitForAsyncWork();
    assert.equal(flushed, false);
    releaseFetch(new Response('{"code":0}', { status: 200 }));
    await flush;
    assert.equal(flushed, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
