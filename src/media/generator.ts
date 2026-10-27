/**
 * 图片 / 视频生成的请求构造与响应解析
 *
 * 两处都接受可注入的 fetchImpl，便于在 Node 单测里跑完整流程而不真的联网。
 */
import { normalizeBaseUrl } from './types';
import type { ImageProviderConfig, VideoProviderConfig } from './types';
import { resolveImageParams } from './models';
import type { ImageModelSpec, ImageSelection } from './models';

type FetchLike = typeof fetch;

export interface GeneratedImage {
  /** 可直接用于 <img src> 的值：http(s) URL 或 data URL */
  src: string;
  /** 服务端改写过的提示词（部分模型会返回） */
  revisedPrompt?: string;
}

export interface GeneratedVideo {
  url: string;
}

const authHeaders = (apiKey: string): Record<string, string> => {
  const key = String(apiKey || '').trim();
  return key ? { Authorization: `Bearer ${key}` } : {};
};

const readError = async (response: Response, label: string): Promise<never> => {
  const text = await response.text().catch(() => '');
  throw new Error(`${label}请求失败（HTTP ${response.status}）${text ? `：${text.slice(0, 200)}` : ''}`);
};

const joinUrl = (baseUrl: string, path: string): string => {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new Error('请先在设置里填写 API 根地址');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
};

const jsonPost = (body: unknown, apiKey: string) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...authHeaders(apiKey) },
  body: JSON.stringify(body),
});

/**
 * 按模型能力构造图片请求
 * 三种 wire shape：OpenAI 兼容、火山方舟（size 支持 WxH / 参考图走 image）、
 * Gemini（generateContent + inlineData 参考图 + aspectRatio）
 */
export const buildImageRequest = (
  spec: ImageModelSpec,
  config: ImageProviderConfig,
  selection: ImageSelection,
): { url: string; init: { method: string; headers: Record<string, string>; body: string } } => {
  const prompt = String(selection.prompt || '').trim();
  const params = resolveImageParams(spec, selection);
  const base = normalizeBaseUrl(config.baseUrl);

  if (spec.shape === 'gemini') {
    const parts: Array<Record<string, unknown>> = [{ text: prompt }];
    for (const ref of params.refs) {
      const match = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i.exec(ref);
      if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
    }
    const generationConfig: Record<string, unknown> = {};
    if (params.aspect) generationConfig.imageConfig = { aspectRatio: params.aspect };
    return {
      url: `${base}${spec.path.replace('{model}', spec.id)}`,
      init: jsonPost({ contents: [{ role: 'user', parts }], generationConfig }, config.apiKey),
    };
  }

  if (spec.shape === 'ark') {
    const body: Record<string, unknown> = {
      model: spec.id,
      prompt,
      response_format: 'b64_json',
      watermark: false,
    };
    if (params.pixelSize) body.size = params.pixelSize;
    if (params.refs.length > 0) body.image = params.refs.length === 1 ? params.refs[0] : params.refs;
    return { url: `${base}${spec.path}`, init: jsonPost(body, config.apiKey) };
  }

  // openai 兼容
  const body: Record<string, unknown> = { model: spec.id, prompt, n: 1 };
  if (params.size) body.size = params.size;
  if (params.quality) body.quality = params.quality;
  return { url: `${base}${spec.path}`, init: jsonPost(body, config.apiKey) };
};

/** 解析图片生成响应：兼容 OpenAI/火山（data[]）与 Gemini（candidates[]） */
export const parseImageResponse = (json: any, shape: string = 'openai'): GeneratedImage => {
  if (shape === 'gemini') {
    const parts = json?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        const inline = part?.inlineData || part?.inline_data;
        if (inline?.data) {
          const mime = inline.mimeType || inline.mime_type || 'image/png';
          return { src: `data:${mime};base64,${inline.data}` };
        }
        const fileUri = part?.fileData?.fileUri || part?.file_data?.file_uri;
        if (typeof fileUri === 'string' && fileUri) return { src: fileUri };
      }
    }
    throw new Error(`图片接口返回异常：${JSON.stringify(json).slice(0, 200)}`);
  }

  const item = Array.isArray(json?.data) ? json.data[0] : undefined;
  if (!item) throw new Error(`图片接口返回异常：${JSON.stringify(json).slice(0, 200)}`);
  if (typeof item.b64_json === 'string' && item.b64_json) {
    return {
      src: `data:image/png;base64,${item.b64_json}`,
      revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined,
    };
  }
  if (typeof item.url === 'string' && item.url) {
    return {
      src: item.url,
      revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined,
    };
  }
  throw new Error('图片接口既没有返回 b64_json 也没有 url');
};

/** 生成一张图片 */
export const generateImage = async (
  spec: ImageModelSpec,
  config: ImageProviderConfig,
  selection: ImageSelection,
  options: { signal?: AbortSignal; fetchImpl?: FetchLike } = {},
): Promise<GeneratedImage> => {
  const content = String(selection.prompt || '').trim();
  if (!content) throw new Error('请先输入画面描述');
  const fetchImpl = options.fetchImpl || fetch;
  const request = buildImageRequest(spec, config, { ...selection, prompt: content });
  const response = await fetchImpl(request.url, { ...request.init, signal: options.signal });
  if (!response.ok) await readError(response, '图片生成');
  return parseImageResponse(await response.json(), spec.shape);
};

const VIDEO_SUCCESS = new Set(['succeeded', 'success', 'completed', 'done', 'finished']);
const VIDEO_FAILED = new Set(['failed', 'error', 'cancelled', 'canceled']);

/** 从任务响应里取任务 ID（兼容 id / task_id / data.id） */
export const extractVideoTaskId = (json: any): string => {
  const candidate = json?.id ?? json?.task_id ?? json?.taskId ?? json?.data?.id ?? json?.data?.task_id;
  if (typeof candidate === 'string' && candidate) return candidate;
  if (typeof candidate === 'number') return String(candidate);
  throw new Error(`视频接口未返回任务 ID：${JSON.stringify(json).slice(0, 200)}`);
};

/** 从任务响应里取状态（缺省视为处理中） */
export const extractVideoStatus = (json: any): string => {
  const raw = json?.status ?? json?.state ?? json?.data?.status ?? json?.data?.state ?? '';
  return String(raw).toLowerCase();
};

/** 从任务响应里取视频地址 */
export const extractVideoUrl = (json: any): string | undefined => {
  const direct = json?.url ?? json?.video_url ?? json?.videoUrl ?? json?.output?.url;
  if (typeof direct === 'string' && direct) return direct;
  const first = Array.isArray(json?.data) ? json.data[0] : undefined;
  const fromData = first?.url ?? first?.video_url;
  if (typeof fromData === 'string' && fromData) return fromData;
  const output = Array.isArray(json?.output) ? json.output[0] : undefined;
  return typeof output === 'string' && output ? output : undefined;
};

export interface VideoJobOutcome {
  id: string;
  status: string;
  url?: string;
}

/** 提交视频生成任务（可能直接返回成品 URL，也可能只给任务 ID） */
export const submitVideoJob = async (
  config: VideoProviderConfig,
  prompt: string,
  options: { signal?: AbortSignal; fetchImpl?: FetchLike } = {},
): Promise<VideoJobOutcome> => {
  const content = String(prompt || '').trim();
  if (!content) throw new Error('请先输入视频描述');
  const fetchImpl = options.fetchImpl || fetch;
  const submitPath = String(config.submitPath || '/videos/generations').trim();
  const url = joinUrl(config.baseUrl, submitPath);
  const body = JSON.stringify({
    model: String(config.model || '').trim() || undefined,
    prompt: content,
  });
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(config.apiKey) },
    body,
    signal: options.signal,
  });
  if (!response.ok) await readError(response, '视频生成');
  const json = await response.json();
  return {
    id: extractVideoTaskId(json),
    status: extractVideoStatus(json),
    url: extractVideoUrl(json),
  };
};

/** 轮询一次任务状态 */
export const pollVideoJob = async (
  config: VideoProviderConfig,
  jobId: string,
  options: { signal?: AbortSignal; fetchImpl?: FetchLike } = {},
): Promise<VideoJobOutcome> => {
  const fetchImpl = options.fetchImpl || fetch;
  const template = String(config.queryPath || '/videos/{id}').trim();
  const path = template.includes('{id}')
    ? template.replace(/\{id\}/g, encodeURIComponent(jobId))
    : `${template.replace(/\/+$/, '')}/${encodeURIComponent(jobId)}`;
  const url = joinUrl(config.baseUrl, path);
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { ...authHeaders(config.apiKey) },
    signal: options.signal,
  });
  if (!response.ok) await readError(response, '视频状态查询');
  const json = await response.json();
  const status = extractVideoStatus(json);
  return { id: jobId, status, url: extractVideoUrl(json) };
};

export interface WaitVideoOptions {
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  /** 轮询间隔，默认 5 秒 */
  intervalMs?: number;
  /** 总超时，默认 5 分钟 */
  timeoutMs?: number;
  /** 每次轮询后回调，便于 UI 展示进度 */
  onProgress?: (outcome: VideoJobOutcome) => void;
  /** 便于测试注入的等待实现 */
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(new Error('已取消'));
    return;
  }
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  const onAbort = () => {
    clearTimeout(timer);
    reject(new Error('已取消'));
  };
  signal?.addEventListener('abort', onAbort, { once: true });
});

/** 提交并轮询直到拿到视频地址或失败 */
export const generateVideo = async (
  config: VideoProviderConfig,
  prompt: string,
  options: WaitVideoOptions = {},
): Promise<GeneratedVideo> => {
  const intervalMs = options.intervalMs ?? 5000;
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const sleep = options.sleepImpl || defaultSleep;

  let outcome = await submitVideoJob(config, prompt, { signal: options.signal, fetchImpl: options.fetchImpl });
  options.onProgress?.(outcome);
  if (outcome.url) return { url: outcome.url };

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (outcome.status && VIDEO_FAILED.has(outcome.status)) {
      throw new Error(`视频生成失败（status=${outcome.status}）`);
    }
    await sleep(intervalMs, options.signal);
    outcome = await pollVideoJob(config, outcome.id, { signal: options.signal, fetchImpl: options.fetchImpl });
    options.onProgress?.(outcome);
    if (outcome.url) return { url: outcome.url };
    if (outcome.status && VIDEO_FAILED.has(outcome.status)) {
      throw new Error(`视频生成失败（status=${outcome.status}）`);
    }
    if (outcome.status && VIDEO_SUCCESS.has(outcome.status)) {
      // 状态成功但没给地址：再查一次，仍没有就报错
      const final = await pollVideoJob(config, outcome.id, { signal: options.signal, fetchImpl: options.fetchImpl });
      if (final.url) return { url: final.url };
      throw new Error('视频任务已完成但没有返回可播放地址');
    }
  }
  throw new Error('视频生成超时，请稍后在服务商侧查看结果');
};
