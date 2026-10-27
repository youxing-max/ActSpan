/**
 * 图片 / 视频生成单测：请求构造、响应解析、轮询流程（注入 fake fetch）
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `
      export {
        buildImageRequest,
        parseImageResponse,
        generateImage,
        extractVideoTaskId,
        extractVideoStatus,
        extractVideoUrl,
        submitVideoJob,
        pollVideoJob,
        generateVideo,
      } from './src/media/generator.ts';
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
  buildImageRequest,
  parseImageResponse,
  generateImage,
  extractVideoTaskId,
  extractVideoStatus,
  extractVideoUrl,
  submitVideoJob,
  pollVideoJob,
  generateVideo,
} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const imageConfig = {
  baseUrl: 'https://api.example.test/v1/',
  apiKey: 'sk-test',
  model: 'gpt-image-1',
  size: '1024x1024',
};

test('图片请求走 /images/generations 并带上 Bearer', () => {
  const request = buildImageRequest(imageConfig, '一只在打字的水獭');
  assert.equal(request.url, 'https://api.example.test/v1/images/generations');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers.Authorization, 'Bearer sk-test');
  const body = JSON.parse(request.init.body);
  assert.deepEqual(body, { model: 'gpt-image-1', prompt: '一只在打字的水獭', n: 1, size: '1024x1024' });
});

test('图片响应支持 b64_json 与 url 两种形态', () => {
  const fromB64 = parseImageResponse({ data: [{ b64_json: 'AAA', revised_prompt: '改写过' }] });
  assert.equal(fromB64.src, 'data:image/png;base64,AAA');
  assert.equal(fromB64.revisedPrompt, '改写过');

  const fromUrl = parseImageResponse({ data: [{ url: 'https://cdn.test/a.png' }] });
  assert.equal(fromUrl.src, 'https://cdn.test/a.png');

  assert.throws(() => parseImageResponse({ data: [{}] }), /b64_json/);
  assert.throws(() => parseImageResponse({}), /返回异常/);
});

test('generateImage 端到端（注入 fetch）', async () => {
  const calls = [];
  const image = await generateImage(imageConfig, '  一只猫  ', {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ data: [{ b64_json: 'QkJC' }] });
    },
  });
  assert.equal(image.src, 'data:image/png;base64,QkJC');
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].init.body).prompt, '一只猫', '提示词需要 trim');
});

test('generateImage 对空提示词与非 2xx 给出可读错误', async () => {
  await assert.rejects(() => generateImage(imageConfig, '   '), /输入画面描述/);
  await assert.rejects(
    () => generateImage(imageConfig, 'cat', { fetchImpl: async () => jsonResponse({ error: 'quota' }, 429) }),
    /HTTP 429/,
  );
});

test('视频任务字段兼容多种命名', () => {
  assert.equal(extractVideoTaskId({ id: 'job-1' }), 'job-1');
  assert.equal(extractVideoTaskId({ task_id: 'job-2' }), 'job-2');
  assert.equal(extractVideoTaskId({ data: { id: 42 } }), '42');
  assert.throws(() => extractVideoTaskId({}), /任务 ID/);

  assert.equal(extractVideoStatus({ status: 'RUNNING' }), 'running');
  assert.equal(extractVideoStatus({ data: { state: 'succeeded' } }), 'succeeded');
  assert.equal(extractVideoStatus({}), '');

  assert.equal(extractVideoUrl({ url: 'https://cdn.test/v.mp4' }), 'https://cdn.test/v.mp4');
  assert.equal(extractVideoUrl({ data: [{ video_url: 'https://cdn.test/v2.mp4' }] }), 'https://cdn.test/v2.mp4');
  assert.equal(extractVideoUrl({ output: ['https://cdn.test/v3.mp4'] }), 'https://cdn.test/v3.mp4');
  assert.equal(extractVideoUrl({}), undefined);
});

test('提交视频任务：默认路径 + 只返回任务 ID 时 url 为空', async () => {
  const calls = [];
  const outcome = await submitVideoJob(
    { baseUrl: 'https://api.example.test/v1', apiKey: 'k', model: 'v-model', submitPath: '/videos/generations', queryPath: '/videos/{id}' },
    '海边日落',
    {
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({ task_id: 'job-9', status: 'queued' });
      },
    },
  );
  assert.equal(calls[0].url, 'https://api.example.test/v1/videos/generations');
  assert.deepEqual(JSON.parse(calls[0].init.body), { model: 'v-model', prompt: '海边日落' });
  assert.deepEqual(outcome, { id: 'job-9', status: 'queued', url: undefined });
});

test('轮询路径按模板替换 {id}', async () => {
  const calls = [];
  await pollVideoJob(
    { baseUrl: 'https://api.example.test/v1', apiKey: 'k', model: 'm', submitPath: '/videos/generations', queryPath: '/jobs/{id}/status' },
    'a b',
    {
      fetchImpl: async (url) => {
        calls.push(url);
        return jsonResponse({ status: 'succeeded', url: 'https://cdn.test/v.mp4' });
      },
    },
  );
  assert.equal(calls[0], 'https://api.example.test/v1/jobs/a%20b/status');
});

test('generateVideo：直接返回 URL 时不轮询', async () => {
  let polls = 0;
  const result = await generateVideo(
    { baseUrl: 'https://api.example.test/v1', apiKey: 'k', model: 'm', submitPath: '/videos/generations', queryPath: '/videos/{id}' },
    '一只猫在弹钢琴',
    {
      fetchImpl: async (url, init) => {
        if (init?.method === 'POST') return jsonResponse({ id: 'j1', url: 'https://cdn.test/direct.mp4' });
        polls += 1;
        return jsonResponse({ status: 'succeeded', url: 'https://cdn.test/poll.mp4' });
      },
    },
  );
  assert.deepEqual(result, { url: 'https://cdn.test/direct.mp4' });
  assert.equal(polls, 0);
});

test('generateVideo：轮询到成功并拿到地址', async () => {
  const statuses = ['queued', 'running', 'succeeded'];
  let index = 0;
  const result = await generateVideo(
    { baseUrl: 'https://api.example.test/v1', apiKey: 'k', model: 'm', submitPath: '/videos/generations', queryPath: '/videos/{id}' },
    'p',
    {
      intervalMs: 1,
      sleepImpl: async () => {},
      fetchImpl: async (url, init) => {
        if (init?.method === 'POST') return jsonResponse({ id: 'j2', status: 'queued' });
        const status = statuses[Math.min(index, statuses.length - 1)];
        index += 1;
        return jsonResponse({
          status,
          url: status === 'succeeded' ? 'https://cdn.test/done.mp4' : undefined,
        });
      },
    },
  );
  assert.deepEqual(result, { url: 'https://cdn.test/done.mp4' });
});

test('generateVideo：失败状态与超时都会抛错', async () => {
  await assert.rejects(
    () => generateVideo(
      { baseUrl: 'https://api.example.test/v1', apiKey: 'k', model: 'm', submitPath: '/videos/generations', queryPath: '/videos/{id}' },
      'p',
      {
        intervalMs: 1,
        sleepImpl: async () => {},
        fetchImpl: async (url, init) => (init?.method === 'POST'
          ? jsonResponse({ id: 'j3', status: 'queued' })
          : jsonResponse({ status: 'failed' })),
      },
    ),
    /视频生成失败/,
  );

  await assert.rejects(
    () => generateVideo(
      { baseUrl: 'https://api.example.test/v1', apiKey: 'k', model: 'm', submitPath: '/videos/generations', queryPath: '/videos/{id}' },
      'p',
      {
        intervalMs: 1,
        timeoutMs: 5,
        sleepImpl: async () => { await new Promise((resolve) => setTimeout(resolve, 2)); },
        fetchImpl: async (url, init) => (init?.method === 'POST'
          ? jsonResponse({ id: 'j4', status: 'queued' })
          : jsonResponse({ status: 'running' })),
      },
    ),
    /超时/,
  );
});
