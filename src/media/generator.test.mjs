/**
 * 图片 / 视频生成单测
 *
 * 图片部分重点覆盖「不同模型参数不一样」：
 * OpenAI 只认 size/quality，火山方舟要分辨率+比例折成 WxH、参考图走 image，
 * Gemini 走 generateContent + imageConfig.aspectRatio + inlineData。
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
      export {
        IMAGE_MODELS,
        findImageModel,
        resolveImageParams,
        resolutionToPixelSize,
      } from './src/media/models.ts';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});

const m = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const {
  buildImageRequest, parseImageResponse, generateImage,
  extractVideoTaskId, extractVideoStatus, extractVideoUrl,
  submitVideoJob, pollVideoJob, generateVideo,
  IMAGE_MODELS, findImageModel, resolveImageParams, resolutionToPixelSize,
} = m;

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const config = { baseUrl: 'https://api.example.test/v1/', apiKey: 'sk-test', model: '', size: '' };
const gptImage = findImageModel('gpt-image-1');
const dallE3 = findImageModel('dall-e-3');
const seedream = findImageModel('doubao-seedream-4-0-250828');
const gemini = findImageModel('gemini-2.5-flash-image');

test('模型目录覆盖三家 wire shape，且能力声明完整', () => {
  const shapes = new Set(IMAGE_MODELS.map((item) => item.shape));
  assert.deepEqual([...shapes].sort(), ['ark', 'gemini', 'openai']);
  assert.equal(seedream.refs, 10);
  assert.equal(gptImage.refs, undefined, 'OpenAI 文生图不支持参考图');
  assert.ok(gemini.aspects.includes('21:9'));
});

test('OpenAI：只发 size/quality，模型不支持的参数被丢弃', () => {
  const request = buildImageRequest(gptImage, config, {
    prompt: '一只在打字的水獭',
    size: '1536x1024',
    quality: 'high',
    aspect: '16:9',
    resolution: '2K',
  });
  assert.equal(request.url, 'https://api.example.test/v1/images/generations');
  assert.equal(request.init.headers.Authorization, 'Bearer sk-test');
  assert.deepEqual(JSON.parse(request.init.body), {
    model: 'gpt-image-1',
    prompt: '一只在打字的水獭',
    n: 1,
    size: '1536x1024',
    quality: 'high',
  });
});

test('OpenAI：非法尺寸回落到该模型首个合法值', () => {
  const request = buildImageRequest(dallE3, config, { prompt: 'p', size: '512x512' });
  assert.equal(JSON.parse(request.init.body).size, '1024x1024');
  assert.equal(JSON.parse(request.init.body).quality, 'standard');
});

test('分辨率 × 比例折算为像素尺寸', () => {
  assert.equal(resolutionToPixelSize('1K', '1:1'), '1024x1024');
  assert.equal(resolutionToPixelSize('2K', '16:9'), '3640x2048');
  assert.equal(resolutionToPixelSize('2K', '9:16'), '2048x3640');
  assert.equal(resolutionToPixelSize('', '1:1'), undefined);
  assert.equal(resolutionToPixelSize('8K', '1:1'), undefined);
});

test('火山方舟：size 用折算后的 WxH，参数不回显 OpenAI 字段', () => {
  const request = buildImageRequest(seedream, config, {
    prompt: '海边日落',
    resolution: '2K',
    aspect: '16:9',
  });
  const body = JSON.parse(request.init.body);
  assert.equal(request.url, 'https://api.example.test/v1/images/generations');
  assert.equal(body.model, 'doubao-seedream-4-0-250828');
  assert.equal(body.size, '3640x2048');
  assert.equal(body.response_format, 'b64_json');
  assert.equal(body.watermark, false);
  assert.equal(body.quality, undefined, '火山不吃 quality');
});

test('火山方舟：参考图按数量走 image 字符串或数组，并按模型上限截断', () => {
  const one = buildImageRequest(seedream, config, {
    prompt: 'p', resolution: '1K', aspect: '1:1', refs: ['data:image/png;base64,AAA'],
  });
  assert.equal(JSON.parse(one.init.body).image, 'data:image/png;base64,AAA');

  const many = buildImageRequest(seedream, config, {
    prompt: 'p',
    refs: Array.from({ length: 12 }, (_, i) => `data:image/png;base64,REF${i}`),
  });
  const images = JSON.parse(many.init.body).image;
  assert.ok(Array.isArray(images));
  assert.equal(images.length, 10, '不能超过 Seedream 的 10 张上限');

  const openaiRefs = buildImageRequest(gptImage, config, {
    prompt: 'p', refs: ['data:image/png;base64,AAA'],
  });
  assert.equal(JSON.parse(openaiRefs.init.body).image, undefined, 'OpenAI 文生图不带参考图');
});

test('Gemini：走 generateContent，比例进 imageConfig，参考图转 inlineData', () => {
  const request = buildImageRequest(gemini, config, {
    prompt: '赛博朋克街道',
    aspect: '21:9',
    refs: ['data:image/jpeg;base64,QUJD'],
  });
  assert.equal(
    request.url,
    'https://api.example.test/v1/models/gemini-2.5-flash-image:generateContent',
  );
  const body = JSON.parse(request.init.body);
  assert.deepEqual(body.generationConfig, { imageConfig: { aspectRatio: '21:9' } });
  const parts = body.contents[0].parts;
  assert.deepEqual(parts[0], { text: '赛博朋克街道' });
  assert.deepEqual(parts[1], { inlineData: { mimeType: 'image/jpeg', data: 'QUJD' } });
});

test('Gemini：非法参考图（非 data URL）被过滤', () => {
  const request = buildImageRequest(gemini, config, {
    prompt: 'p', refs: ['https://evil.test/a.png', 'data:image/png;base64,OK'],
  });
  const parts = JSON.parse(request.init.body).contents[0].parts;
  assert.equal(parts.length, 2, '只保留合法 data URL');
});

test('解析响应：OpenAI/火山 走 data[]，Gemini 走 candidates[]', () => {
  assert.equal(parseImageResponse({ data: [{ b64_json: 'AAA' }] }, 'openai').src, 'data:image/png;base64,AAA');
  assert.equal(parseImageResponse({ data: [{ url: 'https://cdn.test/a.png' }] }, 'ark').src, 'https://cdn.test/a.png');
  assert.equal(
    parseImageResponse({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/webp', data: 'ZZZ' } }] } }] }, 'gemini').src,
    'data:image/webp;base64,ZZZ',
  );
  assert.throws(() => parseImageResponse({ candidates: [] }, 'gemini'), /返回异常/);
});

test('generateImage 端到端（注入 fetch），按 shape 解析', async () => {
  const calls = [];
  const image = await generateImage(seedream, config, { prompt: '  一只猫  ', resolution: '1K', aspect: '1:1' }, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ data: [{ b64_json: 'QkJC' }] });
    },
  });
  assert.equal(image.src, 'data:image/png;base64,QkJC');
  assert.equal(JSON.parse(calls[0].init.body).prompt, '一只猫', '提示词需要 trim');
  await assert.rejects(() => generateImage(gptImage, config, { prompt: '  ' }), /输入画面描述/);
  await assert.rejects(
    () => generateImage(gptImage, config, { prompt: 'cat' }, { fetchImpl: async () => jsonResponse({ error: 'quota' }, 429) }),
    /HTTP 429/,
  );
});

test('resolveImageParams 对未知模型参数做收敛', () => {
  const resolved = resolveImageParams(gptImage, { prompt: 'p', size: 'nope', quality: 'nope' });
  assert.equal(resolved.size, '1024x1024');
  assert.equal(resolved.quality, 'auto');
  assert.equal(resolved.aspect, undefined);
  assert.deepEqual(resolved.refs, []);
});

/* ---------------- 视频部分（沿用原有用例） ---------------- */

const videoConfig = { baseUrl: 'https://api.example.test/v1', apiKey: 'k', model: 'm', submitPath: '/videos/generations', queryPath: '/videos/{id}' };

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
  const outcome = await submitVideoJob(videoConfig, '海边日落', {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ task_id: 'job-9', status: 'queued' });
    },
  });
  assert.equal(calls[0].url, 'https://api.example.test/v1/videos/generations');
  assert.deepEqual(JSON.parse(calls[0].init.body), { model: 'm', prompt: '海边日落' });
  assert.deepEqual(outcome, { id: 'job-9', status: 'queued', url: undefined });
});

test('轮询路径按模板替换 {id}', async () => {
  const calls = [];
  await pollVideoJob({ ...videoConfig, queryPath: '/jobs/{id}/status' }, 'a b', {
    fetchImpl: async (url) => {
      calls.push(url);
      return jsonResponse({ status: 'succeeded', url: 'https://cdn.test/v.mp4' });
    },
  });
  assert.equal(calls[0], 'https://api.example.test/v1/jobs/a%20b/status');
});

test('generateVideo：直接返回 URL 时不轮询；轮询到成功；失败与超时抛错', async () => {
  let polls = 0;
  const direct = await generateVideo(videoConfig, 'p', {
    fetchImpl: async (url, init) => {
      if (init?.method === 'POST') return jsonResponse({ id: 'j1', url: 'https://cdn.test/direct.mp4' });
      polls += 1;
      return jsonResponse({ status: 'succeeded' });
    },
  });
  assert.deepEqual(direct, { url: 'https://cdn.test/direct.mp4' });
  assert.equal(polls, 0);

  const statuses = ['queued', 'running', 'succeeded'];
  let index = 0;
  const polled = await generateVideo(videoConfig, 'p', {
    intervalMs: 1,
    sleepImpl: async () => {},
    fetchImpl: async (url, init) => {
      if (init?.method === 'POST') return jsonResponse({ id: 'j2', status: 'queued' });
      const status = statuses[Math.min(index, statuses.length - 1)];
      index += 1;
      return jsonResponse({ status, url: status === 'succeeded' ? 'https://cdn.test/done.mp4' : undefined });
    },
  });
  assert.deepEqual(polled, { url: 'https://cdn.test/done.mp4' });

  await assert.rejects(
    () => generateVideo(videoConfig, 'p', {
      intervalMs: 1,
      sleepImpl: async () => {},
      fetchImpl: async (url, init) => (init?.method === 'POST' ? jsonResponse({ id: 'j3' }) : jsonResponse({ status: 'failed' })),
    }),
    /视频生成失败/,
  );

  await assert.rejects(
    () => generateVideo(videoConfig, 'p', {
      intervalMs: 1,
      timeoutMs: 5,
      sleepImpl: async () => { await new Promise((r) => setTimeout(r, 2)); },
      fetchImpl: async (url, init) => (init?.method === 'POST' ? jsonResponse({ id: 'j4' }) : jsonResponse({ status: 'running' })),
    }),
    /超时/,
  );
});
