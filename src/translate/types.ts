/**
 * 翻译功能：类型、语言表与供应商元数据
 *
 * 设计：用户自行接入翻译服务（自带 Key），扩展只做请求转发与结果展示，
 * 不内置任何默认密钥。
 */

export type TranslateProviderId = 'deepl' | 'google' | 'youdao' | 'baidu';

/** 统一语言代码（各供应商在 providers.ts 内自行映射） */
export const TRANSLATE_LANGS = [
  { code: 'auto', label: '自动检测' },
  { code: 'zh', label: '中文' },
  { code: 'en', label: '英语' },
  { code: 'ja', label: '日语' },
  { code: 'ko', label: '韩语' },
  { code: 'fr', label: '法语' },
  { code: 'de', label: '德语' },
  { code: 'es', label: '西班牙语' },
  { code: 'ru', label: '俄语' },
] as const;

export type TranslateLangCode = (typeof TRANSLATE_LANGS)[number]['code'];

/** 目标语言不支持 auto，单独给出可选列表 */
export const TRANSLATE_TARGET_LANGS = TRANSLATE_LANGS.filter((item) => item.code !== 'auto');

export interface TranslateProviderMeta {
  id: TranslateProviderId;
  label: string;
  /** 供应商需要的凭据形态 */
  auth: 'apiKey' | 'appIdSecret';
  endpoint: string;
  hint: string;
  docs: string;
}

export const TRANSLATE_PROVIDERS: TranslateProviderMeta[] = [
  {
    id: 'deepl',
    label: 'DeepL',
    auth: 'apiKey',
    endpoint: 'https://api.deepl.com/v2/translate',
    hint: '免费版请勾选「使用 Free 接口」，Key 以 :fx 结尾的为免费版。',
    docs: 'https://developers.deepl.com/docs',
  },
  {
    id: 'google',
    label: 'Google 翻译',
    auth: 'apiKey',
    endpoint: 'https://translation.googleapis.com/language/translate/v2',
    hint: 'Google Cloud Translation v2 的 API Key，需在 Cloud Console 启用该 API。',
    docs: 'https://cloud.google.com/translate/docs/reference/rest',
  },
  {
    id: 'youdao',
    label: '有道智云',
    auth: 'appIdSecret',
    endpoint: 'https://openapi.youdao.com/api',
    hint: '有道智云「文本翻译」应用的 应用ID + 应用密钥（v3 签名，SHA-256）。',
    docs: 'https://ai.youdao.com/DOCSIRMA/html/trans/api/wbfy/index.html',
  },
  {
    id: 'baidu',
    label: '百度翻译',
    auth: 'appIdSecret',
    endpoint: 'https://fanyi-api.baidu.com/api/trans/vip/translate',
    hint: '百度翻译开放平台的 APPID + 密钥（标准版/高级版通用，MD5 签名）。',
    docs: 'https://fanyi-api.baidu.com/doc/21',
  },
];

export interface TranslateProviderConfig {
  apiKey?: string;
  appId?: string;
  appSecret?: string;
  /** DeepL 免费版使用 api-free.deepl.com */
  useFreeApi?: boolean;
}

export interface TranslateSettings {
  provider: TranslateProviderId;
  source: TranslateLangCode;
  target: TranslateLangCode;
  providers: Record<TranslateProviderId, TranslateProviderConfig>;
}

export const TRANSLATE_SETTINGS_KEY = 'actspan_translate_settings_v1';

export const DEFAULT_TRANSLATE_SETTINGS: TranslateSettings = {
  provider: 'deepl',
  source: 'auto',
  target: 'zh',
  providers: {
    deepl: {},
    google: {},
    youdao: {},
    baidu: {},
  },
};

/** 判断某个供应商是否已填好凭据 */
export const isProviderConfigured = (
  id: TranslateProviderId,
  config: TranslateProviderConfig | undefined,
): boolean => {
  if (!config) return false;
  const meta = TRANSLATE_PROVIDERS.find((item) => item.id === id);
  if (!meta) return false;
  if (meta.auth === 'apiKey') return Boolean(String(config.apiKey || '').trim());
  return Boolean(String(config.appId || '').trim() && String(config.appSecret || '').trim());
};
