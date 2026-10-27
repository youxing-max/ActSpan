/**
 * 图片模型目录：不同厂商 / 模型支持的参数并不一样
 *
 * 这里把「模型能力」显式声明出来，UI 只渲染该模型支持的控件，
 * 请求层再按 shape 把统一的参数翻译成各家真正的字段。
 *
 * 说明：以下参数按各家公开文档的约定整理
 * - OpenAI: POST {baseUrl}/images/generations，size + quality
 * - 火山方舟 Seedream: POST {baseUrl}/images/generations，size 支持 "1K|2K|4K" 或 "WxH"，
 *   参考图走 image 字段（最多 10 张）
 * - Gemini 图像模型: POST {baseUrl}/models/{model}:generateContent，
 *   比例走 generationConfig.imageConfig.aspectRatio，参考图走 inlineData
 */

export type ImageShape = 'openai' | 'ark' | 'gemini';

export interface ImageModelSpec {
  id: string;
  label: string;
  vendor: string;
  shape: ImageShape;
  /** 相对 baseUrl 的路径；gemini 用 {model} 占位 */
  path: string;
  /** 显式宽高选项 */
  sizes?: string[];
  /** 宽高比选项 */
  aspects?: string[];
  /** 分辨率档位（火山：1K/2K/4K） */
  resolutions?: string[];
  /** 质量档位（OpenAI） */
  qualities?: string[];
  /** 参考图上限，0/缺省表示不支持 */
  refs?: number;
  /** 默认值 */
  defaults: {
    size?: string;
    aspect?: string;
    resolution?: string;
    quality?: string;
  };
}

const ASPECTS_ALL = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'];

export const IMAGE_MODELS: ImageModelSpec[] = [
  {
    id: 'gpt-image-1',
    label: 'GPT Image 1',
    vendor: 'OpenAI',
    shape: 'openai',
    path: '/images/generations',
    sizes: ['1024x1024', '1536x1024', '1024x1536', 'auto'],
    qualities: ['auto', 'low', 'medium', 'high'],
    defaults: { size: '1024x1024', quality: 'auto' },
  },
  {
    id: 'dall-e-3',
    label: 'DALL·E 3',
    vendor: 'OpenAI',
    shape: 'openai',
    path: '/images/generations',
    sizes: ['1024x1024', '1792x1024', '1024x1792'],
    qualities: ['standard', 'hd'],
    defaults: { size: '1024x1024', quality: 'standard' },
  },
  {
    id: 'doubao-seedream-4-0-250828',
    label: 'Seedream 4.0',
    vendor: '火山方舟',
    shape: 'ark',
    path: '/images/generations',
    resolutions: ['1K', '2K', '4K'],
    aspects: ASPECTS_ALL,
    refs: 10,
    defaults: { resolution: '2K', aspect: '1:1' },
  },
  {
    id: 'doubao-seedream-3-0-t2i-250415',
    label: 'Seedream 3.0',
    vendor: '火山方舟',
    shape: 'ark',
    path: '/images/generations',
    resolutions: ['1K', '2K'],
    aspects: ASPECTS_ALL,
    defaults: { resolution: '2K', aspect: '1:1' },
  },
  {
    id: 'gemini-2.5-flash-image',
    label: 'Gemini 2.5 Flash Image',
    vendor: 'Google',
    shape: 'gemini',
    path: '/models/{model}:generateContent',
    aspects: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
    refs: 3,
    defaults: { aspect: '1:1' },
  },
  {
    id: 'imagen-4.0-generate-001',
    label: 'Imagen 4',
    vendor: 'Google',
    shape: 'gemini',
    path: '/models/{model}:generateContent',
    aspects: ['1:1', '3:4', '4:3', '9:16', '16:9'],
    defaults: { aspect: '1:1' },
  },
];

export const findImageModel = (id: string): ImageModelSpec =>
  IMAGE_MODELS.find((item) => item.id === id) || IMAGE_MODELS[0];

export interface ImageSelection {
  prompt: string;
  size?: string;
  aspect?: string;
  resolution?: string;
  quality?: string;
  /** 参考图（data URL） */
  refs?: string[];
}

export interface ResolvedImageParams {
  /** OpenAI 用的显式尺寸 */
  size?: string;
  quality?: string;
  /** 比例 */
  aspect?: string;
  /** 火山：把「档位 + 比例」折算出的 WxH */
  pixelSize?: string;
  /** 送进请求的参考图 */
  refs: string[];
}

/** 分辨率档位对应的基准边长 */
const RESOLUTION_BASE: Record<string, number> = { '1K': 1024, '2K': 2048, '4K': 4096 };

const roundTo8 = (value: number): number => Math.max(256, Math.round(value / 8) * 8);

/** 把「档位 + 比例」折算成宽高（火山方舟的 size 支持 WxH） */
export const resolutionToPixelSize = (resolution: string | undefined, aspect: string | undefined): string | undefined => {
  const base = RESOLUTION_BASE[String(resolution || '').toUpperCase()];
  if (!base) return undefined;
  const [wRaw, hRaw] = String(aspect || '1:1').split(':').map((part) => Number(part));
  const wRatio = Number.isFinite(wRaw) && wRaw > 0 ? wRaw : 1;
  const hRatio = Number.isFinite(hRaw) && hRaw > 0 ? hRaw : 1;
  // 以「短边 = 档位基准」计算，保证总像素与档位一致
  if (wRatio >= hRatio) {
    return `${roundTo8((base * wRatio) / hRatio)}x${roundTo8(base)}`;
  }
  return `${roundTo8(base)}x${roundTo8((base * hRatio) / wRatio)}`;
};

/** 按模型能力收敛用户的参数选择 */
export const resolveImageParams = (spec: ImageModelSpec, selection: ImageSelection): ResolvedImageParams => {
  const pick = (options: string[] | undefined, value: string | undefined, fallback?: string): string | undefined => {
    if (!options || options.length === 0) return undefined;
    if (value && options.includes(value)) return value;
    return fallback && options.includes(fallback) ? fallback : options[0];
  };

  const refsLimit = spec.refs || 0;
  const refs = refsLimit > 0
    ? (selection.refs || []).filter((item) => typeof item === 'string' && item.startsWith('data:image/')).slice(0, refsLimit)
    : [];

  return {
    size: pick(spec.sizes, selection.size, spec.defaults.size),
    quality: pick(spec.qualities, selection.quality, spec.defaults.quality),
    aspect: pick(spec.aspects, selection.aspect, spec.defaults.aspect),
    pixelSize: spec.shape === 'ark'
      ? resolutionToPixelSize(
        pick(spec.resolutions, selection.resolution, spec.defaults.resolution),
        pick(spec.aspects, selection.aspect, spec.defaults.aspect),
      )
      : undefined,
    refs,
  };
};
