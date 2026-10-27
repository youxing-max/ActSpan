/**
 * 视频模型目录：参数同样按厂商差异声明
 *
 * 已覆盖两种 wire shape：
 * - ark：火山方舟 Seedance，POST {baseUrl}/contents/generations/tasks，
 *   content 里放 text / image_url，参数为 ratio / duration / resolution / generate_audio
 * - openai：Sora 2，POST {baseUrl}/videos，参数为 size / seconds，轮询 {baseUrl}/videos/{id}
 */

export type VideoShape = 'ark' | 'openai';

export interface VideoModelSpec {
  id: string;
  label: string;
  vendor: string;
  shape: VideoShape;
  /** 提交路径；ark 用固定任务接口，openai 用 /videos */
  submitPath: string;
  /** 查询路径模板，{id} 占位 */
  queryPath: string;
  /** 分辨率档位，例如 480p / 720p / 1080p */
  resolutions?: string[];
  aspects?: string[];
  /** 时长选项（秒） */
  durations?: number[];
  /** 是否支持生成音轨 */
  audio?: boolean;
  /** 参考图（首帧 / 参考内容）上限 */
  refs?: number;
  defaults: {
    resolution?: string;
    aspect?: string;
    duration?: number;
    audio?: boolean;
  };
}

export const VIDEO_MODELS: VideoModelSpec[] = [
  {
    id: 'doubao-seedance-2-0-fast',
    label: 'Seedance 2.0 Fast',
    vendor: '火山方舟',
    shape: 'ark',
    submitPath: '/contents/generations/tasks',
    queryPath: '/contents/generations/tasks/{id}',
    resolutions: ['480p', '720p', '1080p'],
    aspects: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    durations: [4, 6, 8, 12],
    audio: true,
    refs: 2,
    defaults: { resolution: '480p', aspect: '16:9', duration: 4, audio: true },
  },
  {
    id: 'doubao-seedance-1-0-pro',
    label: 'Seedance 1.0 Pro',
    vendor: '火山方舟',
    shape: 'ark',
    submitPath: '/contents/generations/tasks',
    queryPath: '/contents/generations/tasks/{id}',
    resolutions: ['480p', '720p', '1080p'],
    aspects: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    durations: [5, 10],
    audio: false,
    refs: 2,
    defaults: { resolution: '720p', aspect: '16:9', duration: 5 },
  },
  {
    id: 'sora-2',
    label: 'Sora 2',
    vendor: 'OpenAI',
    shape: 'openai',
    submitPath: '/videos',
    queryPath: '/videos/{id}',
    resolutions: ['720p', '1080p'],
    aspects: ['16:9', '9:16', '1:1'],
    durations: [4, 8, 12],
    audio: false,
    refs: 1,
    defaults: { resolution: '720p', aspect: '16:9', duration: 4 },
  },
];

export const findVideoModel = (id: string): VideoModelSpec =>
  VIDEO_MODELS.find((item) => item.id === id) || VIDEO_MODELS[0];

export interface VideoSelection {
  prompt: string;
  resolution?: string;
  aspect?: string;
  duration?: number;
  audio?: boolean;
  refs?: string[];
}

export interface ResolvedVideoParams {
  resolution?: string;
  aspect?: string;
  duration?: number;
  audio?: boolean;
  refs: string[];
  /** OpenAI 用：把「分辨率 + 比例」折算成 1280x720 这类 size */
  size?: string;
}

const RESOLUTION_SHORT: Record<string, number> = { '480p': 480, '720p': 720, '1080p': 1080 };

/** 分辨率档位 + 比例 → Sora 的 size（短边取档位，按 8 对齐） */
export const resolutionToVideoSize = (
  resolution: string | undefined,
  aspect: string | undefined,
): string | undefined => {
  const shortEdge = RESOLUTION_SHORT[String(resolution || '').toLowerCase()];
  if (!shortEdge) return undefined;
  const [wRaw, hRaw] = String(aspect || '16:9').split(':').map((part) => Number(part));
  const wRatio = Number.isFinite(wRaw) && wRaw > 0 ? wRaw : 16;
  const hRatio = Number.isFinite(hRaw) && hRaw > 0 ? hRaw : 9;
  const round8 = (value: number) => Math.max(256, Math.round(value / 8) * 8);
  if (wRatio >= hRatio) {
    return `${round8((shortEdge * wRatio) / hRatio)}x${round8(shortEdge)}`;
  }
  return `${round8(shortEdge)}x${round8((shortEdge * hRatio) / wRatio)}`;
};

/** 按模型能力收敛视频参数 */
export const resolveVideoParams = (spec: VideoModelSpec, selection: VideoSelection): ResolvedVideoParams => {
  const pick = <T,>(options: T[] | undefined, value: T | undefined, fallback?: T): T | undefined => {
    if (!options || options.length === 0) return undefined;
    if (value !== undefined && options.includes(value)) return value;
    return fallback !== undefined && options.includes(fallback) ? fallback : options[0];
  };

  const refsLimit = spec.refs || 0;
  const refs = refsLimit > 0
    ? (selection.refs || []).filter((item) => typeof item === 'string' && item.startsWith('data:image/')).slice(0, refsLimit)
    : [];

  const resolution = pick(spec.resolutions, selection.resolution, spec.defaults.resolution);
  const aspect = pick(spec.aspects, selection.aspect, spec.defaults.aspect);
  const duration = pick(spec.durations, selection.duration, spec.defaults.duration);
  const audio = spec.audio ? (selection.audio ?? spec.defaults.audio ?? false) : undefined;

  return {
    resolution,
    aspect,
    duration,
    audio,
    refs,
    size: spec.shape === 'openai' ? resolutionToVideoSize(resolution, aspect) : undefined,
  };
};
