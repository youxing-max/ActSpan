import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `
      export { sendToWebhook, selectFeishuWebhooks, sendWebhookEntries } from './src/functions/webhook.ts';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { sendToWebhook, selectFeishuWebhooks, sendWebhookEntries } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`
);

test('formats a Feishu bot webhook as a text message', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (input, init) => {
    request = { input, init };
    return new Response('{"code":0,"msg":"success"}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const result = await sendToWebhook(
      {
        id: 'feishu-1',
        name: '飞书通知群',
        type: 'generic',
        enabled: true,
        createdAt: 1,
        url: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-token',
      },
      { title: '任务完成', message: '处理结果已生成' },
    );

    assert.equal(result.success, true);
    assert.equal(request.input, 'https://open.feishu.cn/open-apis/bot/v2/hook/test-token');
    assert.deepEqual(JSON.parse(request.init.body), {
      msg_type: 'text',
      content: { text: '任务完成\n处理结果已生成' },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('selects only enabled Feishu webhooks and supports exact name targeting', () => {
  const entries = [
    {
      id: 'feishu-1', name: '研发群', type: 'generic', enabled: true, createdAt: 1,
      url: 'https://open.feishu.cn/open-apis/bot/v2/hook/one',
    },
    {
      id: 'feishu-2', name: '运营群', type: 'generic', enabled: true, createdAt: 1,
      url: 'https://open.larksuite.com/open-apis/bot/v2/hook/two',
    },
    {
      id: 'feishu-3', name: '旧群', type: 'generic', enabled: false, createdAt: 1,
      url: 'https://open.feishu.cn/open-apis/bot/v2/hook/three',
    },
    {
      id: 'bark-1', name: '手机', type: 'bark', enabled: true, createdAt: 1,
      bark: { server: 'https://api.day.app', deviceKey: 'device' },
    },
    {
      id: 'generic-1', name: '其他服务', type: 'generic', enabled: true, createdAt: 1,
      url: 'https://example.com/hook',
    },
  ];

  assert.deepEqual(selectFeishuWebhooks(entries).map((entry) => entry.name), ['研发群', '运营群']);
  assert.deepEqual(selectFeishuWebhooks(entries, '研发群').map((entry) => entry.name), ['研发群']);
  assert.deepEqual(selectFeishuWebhooks(entries, '研发').map((entry) => entry.name), []);
  assert.deepEqual(selectFeishuWebhooks(entries, '旧群').map((entry) => entry.name), []);
});
test('sends notifications to every selected Feishu webhook', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('{"code":0,"msg":"success"}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const result = await sendWebhookEntries([
      { id: 'feishu-1', name: '研发群', type: 'generic', enabled: true, createdAt: 1, url: 'https://open.feishu.cn/open-apis/bot/v2/hook/one' },
      { id: 'feishu-2', name: '运营群', type: 'generic', enabled: true, createdAt: 1, url: 'https://open.larksuite.com/open-apis/bot/v2/hook/two' },
    ], { title: '完成', message: '已完成' });
    assert.equal(result.success, true);
    assert.equal(result.data.sent, 2);
    assert.equal(result.data.failed, 0);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('reports a Feishu business error from an HTTP 200 response', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"code":19001,"msg":"keyword mismatch"}', {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  try {
    const result = await sendToWebhook(
      {
        id: 'feishu-1',
        name: '飞书通知群',
        type: 'generic',
        enabled: true,
        createdAt: 1,
        url: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-token',
      },
      { title: '任务完成', message: '处理结果已生成' },
    );

    assert.deepEqual(result, { success: false, message: 'keyword mismatch' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
