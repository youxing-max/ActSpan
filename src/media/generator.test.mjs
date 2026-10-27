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
        buildVideoSubmitRequest,
        buildVideoPollRequest,
      } from './src/media/generator.ts';
      export {
        IMAGE_MODELS,
        findImageModel,
        resolveImageParams,
        resolutionToPixelSize,
      } from './src/media/models.ts';
      export {
        VIDEO_MODELS,
        findVideoModel,
        resolveVideoParams,
        resolutionToVideoSize,
      } from './src/media/videoModels.ts';
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
  submitVideoJob, pollVideoJob, generateVideo, buildVideoSubmitRequest, buildVideoPollRequest,
  VIDEO_MODELS, findVideoModel, resolveVideoParams, resolutionToVideoSize,
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

/* ---------------- 视频部分 ---------------- */

const videoConfig = { baseUrl: 'https://api.example.test/v1', apiKey: 'k', model: 'm', submitPath: '', queryPath: '' };
const seedance2 = findVideoModel('doubao-seedance-2-0-fast');
const seedance1 = findVideoModel('doubao-seedance-1-0-pro');
const sora = findVideoModel('sora-2');

test('视频模型目录：能力差异（分辨率/比例/时长/声音/参考图）', () => {
  assert.deepEqual(VIDEO_MODELS.map((m2) => m2.shape).sort(), ['ark', 'ark', 'openai']);
  assert.equal(seedance2.audio, true, 'Seedance 2.0 支持音轨');
  assert.equal(seedance1.audio, false, 'Seedance 1.0 Pro 不支持音轨');
  assert.deepEqual(seedance2.durations, [4, 6, 8, 12]);
  assert.equal(seedance2.refs, 2);
  assert.equal(sora.refs, 1);
});

test('分辨率 + 比例折算为 Sora 的 size', () => {
  assert.equal(resolutionToVideoSize('720p', '16:9'), '1280x720');
  assert.equal(resolutionToVideoSize('1080p', '9:16'), '1080x1920');
  assert.equal(resolutionToVideoSize('480p', '1:1'), '480x480');
  assert.equal(resolutionToVideoSize('4k', '16:9'), undefined);
});

test('Seedance（ark）：content 数组 + resolution/ratio/duration/generate_audio', () => {
  const request = buildVideoSubmitRequest(seedance2, videoConfig, {
    prompt: '海浪拍岸',
    resolution: '720p',
    aspect: '9:16',
    duration: 8,
    audio: true,
    refs: ['data:image/png;base64,AAA'],
  });
  assert.equal(request.url, 'https://api.example.test/v1/contents/generations/tasks');
  const body = JSON.parse(request.init.body);
  assert.equal(body.model, 'doubao-seedance-2-0-fast');
  assert.deepEqual(body.content[0], { type: 'text', text: '海浪拍岸' });
  assert.deepEqual(body.content[1], { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } });
  assert.equal(body.resolution, '720p');
  assert.equal(body.ratio, '9:16');
  assert.equal(body.duration, 8);
  assert.equal(body.generate_audio, true);
});

test('Seedance（ark）：不支持的参数被丢弃，参考图按上限截断', () => {
  const request = buildVideoSubmitRequest(seedance1, videoConfig, {
    prompt: 'p',
    duration: 8,
    audio: true,
    resolution: '4K',
    refs: ['data:image/png;base64,A', 'data:image/png;base64,B', 'data:image/png;base64,C'],
  });
  const body = JSON.parse(request.init.body);
  assert.equal(body.duration, 5, '1.0 Pro 只支持 5/10 秒');
  assert.equal(body.resolution, '720p', '4K 不被支持，回落到该模型的默认档位');
  assert.equal(body.generate_audio, undefined, '不支持音轨的模型不下发该字段');
  assert.equal(body.content.length, 3, 'text + 2 张参考图（上限 2）');
});

test('Sora（openai）：prompt + size + seconds，参考图不进 body', () => {
  const request = buildVideoSubmitRequest(sora, videoConfig, {
    prompt: '城市夜景',
    resolution: '1080p',
    aspect: '16:9',
    duration: 8,
    refs: ['data:image/png;base64,AAA'],
  });
  assert.equal(request.url, 'https://api.example.test/v1/videos');
  assert.deepEqual(JSON.parse(request.init.body), {
    model: 'sora-2',
    prompt: '城市夜景',
    size: '1920x1080',
    seconds: '8',
  });
});

test('视频轮询请求按模型路径拼装', () => {
  const ark = buildVideoPollRequest(seedance2, videoConfig, 'job a');
  assert.equal(ark.url, 'https://api.example.test/v1/contents/generations/tasks/job%20a');
  assert.equal(ark.init.headers.Authorization, 'Bearer k');
  const openai = buildVideoPollRequest(sora, videoConfig, 'vid_1');
  assert.equal(openai.url, 'https://api.example.test/v1/videos/vid_1');
});

test('视频任务字段兼容多种命名', () => {
  assert.equal(extractVideoTaskId({ id: 'job-1' }), 'job-1');
  assert.equal(extractVideoTaskId({ task_id: 'job-2' }), 'job-2');
  assert.equal(extractVideoTaskId({ data: { id: 42 } }), '42');
  assert.throws(() => extractVideoTaskId({}), /任务 ID/);
  assert.equal(extractVideoStatus({ status: 'RUNNING' }), 'running');
  assert.equal(extractVideoStatus({ data: { state: 'succeeded' } }), 'succeeded');
  assert.equal(extractVideoUrl({ url: 'https://cdn.test/v.mp4' }), 'https://cdn.test/v.mp4');
  assert.equal(extractVideoUrl({ content: { video_url: 'https://cdn.test/ark.mp4' } }), 'https://cdn.test/ark.mp4');
  assert.equal(extractVideoUrl({ data: [{ video_url: 'https://cdn.test/v2.mp4' }] }), 'https://cdn.test/v2.mp4');
  assert.equal(extractVideoUrl({}), undefined);
});

test('submitVideoJob 只返回任务 ID 时 url 为空', async () => {
  const calls = [];
  const outcome = await submitVideoJob(seedance2, videoConfig, { prompt: '海边日落' }, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ id: 'cgt-9' });
    },
  });
  assert.equal(calls[0].url, 'https://api.example.test/v1/contents/generations/tasks');
  assert.deepEqual(outcome, { id: 'cgt-9', status: '', url: undefined });
});

test('generateVideo：直接返回 URL 时不轮询；轮询到成功；失败与超时抛错', async () => {
  let polls = 0;
  const direct = await generateVideo(seedance2, videoConfig, { prompt: 'p' }, {
    fetchImpl: async (url, init) => {
      if (init?.method === 'POST') return jsonResponse({ id: 'j1', content: { video_url: 'https://cdn.test/direct.mp4' } });
      polls += 1;
      return jsonResponse({ status: 'succeeded' });
    },
  });
  assert.deepEqual(direct, { url: 'https://cdn.test/direct.mp4' });
  assert.equal(polls, 0, '提交即返回地址时不应轮询');

  const statuses = ['queued', 'running', 'succeeded'];
  let index = 0;
  const polled = await generateVideo(seedance2, videoConfig, { prompt: 'p' }, {
    intervalMs: 1,
    sleepImpl: async () => {},
    fetchImpl: async (url, init) => {
      if (init?.method === 'POST') return jsonResponse({ id: 'j2' });
      const status = statuses[Math.min(index, statuses.length - 1)];
      index += 1;
      return jsonResponse({ status, content: status === 'succeeded' ? { video_url: 'https://cdn.test/done.mp4' } : undefined });
    },
  });
  assert.deepEqual(polled, { url: 'https://cdn.test/done.mp4' });

  await assert.rejects(
    () => generateVideo(seedance2, videoConfig, { prompt: 'p' }, {
      intervalMs: 1,
      sleepImpl: async () => {},
      fetchImpl: async (url, init) => (init?.method === 'POST' ? jsonResponse({ id: 'j3' }) : jsonResponse({ status: 'failed' })),
    }),
    /视频生成失败/,
  );

  await assert.rejects(
    () => generateVideo(seedance2, videoConfig, { prompt: 'p' }, {
      intervalMs: 1,
      timeoutMs: 5,
      sleepImpl: async () => { await new Promise((r) => setTimeout(r, 2)); },
      fetchImpl: async (url, init) => (init?.method === 'POST' ? jsonResponse({ id: 'j4' }) : jsonResponse({ status: 'running' })),
    }),
    /超时/,
  );
});

test('resolveVideoParams 收敛越界参数', () => {
  const resolved = resolveVideoParams(seedance1, {
    prompt: 'p', resolution: '4K', aspect: '21:9', duration: 99, audio: true,
  });
  assert.equal(resolved.resolution, '720p', '回落到模型默认档位而不是列表首项');
  assert.equal(resolved.aspect, '16:9', '21:9 不在 1.0 Pro 支持列表，回落首个');
  assert.equal(resolved.duration, 5);
  assert.equal(resolved.audio, undefined, '不支持音轨的模型返回 undefined');
});