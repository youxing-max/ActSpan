import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `
      export { sendCompletionNotifications, sendFeishuCompletion, sendToWebhook, selectCompletionWebhooks, selectFeishuWebhooks, sendWebhookEntries, isDingTalkWebhookUrl } from './src/functions/webhook.ts';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { sendCompletionNotifications, sendFeishuCompletion, sendToWebhook, selectCompletionWebhooks, selectFeishuWebhooks, sendWebhookEntries, isDingTalkWebhookUrl } = await import(
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

test('rejects malformed Feishu responses', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('accepted', { status: 200 });

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

    assert.equal(result.success, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects Feishu responses without a success code', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"msg":"accepted"}', {
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

    assert.equal(result.success, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('formats a DingTalk bot webhook as a text message', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (input, init) => {
    request = { input, init };
    return new Response('{"errcode":0,"errmsg":"ok"}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const result = await sendToWebhook(
      {
        id: 'dingtalk-1',
        name: '钉钉通知群',
        type: 'generic',
        enabled: true,
        createdAt: 1,
        url: 'https://oapi.dingtalk.com/robot/send?access_token=test-token',
      },
      { title: '任务完成', message: '处理结果已生成' },
    );

    assert.equal(result.success, true);
    assert.equal(request.input, 'https://oapi.dingtalk.com/robot/send?access_token=test-token');
    assert.deepEqual(JSON.parse(request.init.body), {
      msgtype: 'text',
      text: { content: '任务完成\n处理结果已生成' },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('signs a DingTalk webhook when a secret is configured', async () => {
  const originalFetch = globalThis.fetch;
  const secret = 'SECtest-secret';
  let request;
  globalThis.fetch = async (input, init) => {
    request = { input, init };
    return new Response('{"errcode":0,"errmsg":"ok"}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const result = await sendToWebhook(
      {
        id: 'dingtalk-1',
        name: '钉钉通知群',
        type: 'generic',
        enabled: true,
        createdAt: 1,
        url: 'https://oapi.dingtalk.com/robot/send?access_token=test-token',
        dingtalkSecret: secret,
      },
      { title: '任务完成', message: '处理结果已生成' },
    );

    assert.equal(result.success, true);
    const signed = new URL(String(request.input));
    const timestamp = signed.searchParams.get('timestamp');
    assert.ok(timestamp);
    assert.equal(signed.searchParams.get('access_token'), 'test-token');
    assert.equal(
      signed.searchParams.get('sign'),
      createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64'),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('reports a DingTalk business error from an HTTP 200 response', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"errcode":310000,"errmsg":"keywords not in content"}', {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  try {
    const result = await sendToWebhook(
      {
        id: 'dingtalk-1',
        name: '钉钉通知群',
        type: 'generic',
        enabled: true,
        createdAt: 1,
        url: 'https://oapi.dingtalk.com/robot/send?access_token=test-token',
      },
      { title: '任务完成', message: '处理结果已生成' },
    );

    assert.deepEqual(result, { success: false, message: 'keywords not in content' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('selects enabled Feishu and DingTalk completion webhooks', () => {
  const entries = [
    { id: 'feishu-1', name: '研发群', type: 'generic', enabled: true, createdAt: 1, url: 'https://open.feishu.cn/open-apis/bot/v2/hook/one' },
    { id: 'dingtalk-1', name: '钉钉群', type: 'generic', enabled: true, createdAt: 1, url: 'https://oapi.dingtalk.com/robot/send?access_token=token' },
    { id: 'dingtalk-2', name: '旧钉钉群', type: 'generic', enabled: false, createdAt: 1, url: 'https://oapi.dingtalk.com/robot/send?access_token=old' },
    { id: 'other-1', name: '其他服务', type: 'generic', enabled: true, createdAt: 1, url: 'https://example.com/hook' },
    { id: 'bark-1', name: '手机', type: 'bark', enabled: true, createdAt: 1, bark: { server: 'https://api.day.app', deviceKey: 'device' } },
  ];

  assert.equal(isDingTalkWebhookUrl('https://oapi.dingtalk.com/robot/send?access_token=token'), true);
  assert.equal(isDingTalkWebhookUrl('https://oapi.dingtalk.com/robot/send/?access_token=token'), true);
  assert.equal(isDingTalkWebhookUrl('https://example.com/robot/send'), false);
  assert.deepEqual(selectCompletionWebhooks(entries).map((entry) => entry.name), ['研发群', '钉钉群']);
  assert.deepEqual(selectCompletionWebhooks(entries, '钉钉群').map((entry) => entry.name), ['钉钉群']);
  assert.deepEqual(selectCompletionWebhooks(entries, '旧钉钉群'), []);
});

test('completion notifications reach both Feishu and DingTalk', async () => {
  const originalFetch = globalThis.fetch;
  const originalChrome = globalThis.chrome;
  const calls = [];
  globalThis.chrome = {
    storage: {
      local: {
        get(_keys, callback) {
          callback({
            actspan_webhook_config_v1: {
              version: 1,
              updatedAt: 1,
              webhooks: [
                { id: 'feishu-1', name: '飞书群', type: 'generic', enabled: true, createdAt: 1, url: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-token' },
                { id: 'dingtalk-1', name: '钉钉群', type: 'generic', enabled: true, createdAt: 1, url: 'https://oapi.dingtalk.com/robot/send?access_token=test-token' },
              ],
            },
          });
        },
        set(_items, callback) {
          callback?.();
        },
      },
    },
  };
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response(String(input).includes('dingtalk')
      ? '{"errcode":0,"errmsg":"ok"}'
      : '{"code":0,"msg":"success"}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const result = await sendCompletionNotifications('处理结果已生成');
    assert.equal(result.success, true);
    assert.equal(result.data.sent, 2);
    assert.equal(result.data.failed, 0);
    assert.deepEqual(calls.map((url) => new URL(url).hostname), ['open.feishu.cn', 'oapi.dingtalk.com']);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.chrome = originalChrome;
  }
});

test('reports when no enabled Feishu webhook is configured', async () => {
  const originalChrome = globalThis.chrome;
  globalThis.chrome = {
    storage: {
      local: {
        get(_keys, callback) {
          callback({
            actspan_webhook_config_v1: { version: 1, updatedAt: 1, webhooks: [] },
          });
        },
        set(_items, callback) {
          callback?.();
        }
      },
    },
  };

  try {
    const result = await sendFeishuCompletion('处理结果已生成');
    assert.equal(result.success, false);
    assert.equal(result.data.sent, 0);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('Bark 推送把正文放进 POST body，不写入 URL 路径或查询串', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response('{"code":200,"message":"success"}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const result = await sendWebhookEntries([{
      id: 'bark-1', name: '手机', type: 'bark', enabled: true, createdAt: 1,
      bark: { server: 'https://api.day.app', deviceKey: 'device-key', group: 'actspan' },
    }], { title: '调查完成', message: '结论：账号存在风险 token=secret' });

    assert.equal(result.success, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.day.app/push');
    assert.equal(calls[0].init.method, 'POST');
    const payload = JSON.parse(calls[0].init.body);
    assert.equal(payload.device_key, 'device-key');
    assert.equal(payload.title, '调查完成');
    assert.equal(payload.body, '结论：账号存在风险 token=secret');
    assert.equal(payload.group, 'actspan');
    assert.doesNotMatch(calls[0].url, /secret|调查完成/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
