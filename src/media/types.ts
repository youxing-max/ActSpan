/**
 * 生成能力（图片 / 视频）：类型与默认配置
 *
 * 两种能力都走「用户自带 API」：只保存 baseUrl + Key + 模型名，
 * 不内置任何服务商额度。
 */

export interface ImageProviderConfig {
  /** OpenAI 兼容的 API 根地址，例如 https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 例如 1024x1024 / 1792x1024 / 1024x1792 */
  size: string;
}

export interface VideoProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 提交任务路径，默认 /videos/generations */
  submitPath: string;
  /** 查询任务路径模板，{id} 会被替换，默认 /videos/{id} */
  queryPath: string;
}

export interface MediaSettings {
  image: ImageProviderConfig;
  video: VideoProviderConfig;
}

export const MEDIA_SETTINGS_KEY = 'actspan_media_settings_v1';

export const DEFAULT_MEDIA_SETTINGS: MediaSettings = {
  image: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-image-1',
    size: '1024x1024',
  },
  video: {
    baseUrl: '',
    apiKey: '',
    model: '',
    submitPath: '/videos/generations',
    queryPath: '/videos/{id}',
  },
};

export const IMAGE_SIZE_OPTIONS = [
  { value: '1024x1024', label: '1024 × 1024（方形）' },
  { value: '1792x1024', label: '1792 × 1024（横版）' },
  { value: '1024x1792', label: '1024 × 1792（竖版）' },
  { value: '512x512', label: '512 × 512（小图）' },
];

/** 去掉末尾斜杠，避免拼出双斜杠 */
export const normalizeBaseUrl = (value: string): string => String(value || '').trim().replace(/\/+$/, '');
