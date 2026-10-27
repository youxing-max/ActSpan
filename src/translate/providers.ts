/**
 * 翻译供应商适配层
 *
 * 每个供应商拆成「构造请求」与「解析响应」两步，构造部分是纯函数（便于单测），
 * 实际网络请求统一走 translateText()。
 *
 * 说明：扩展已在 manifest 声明 <all_urls> 主机权限，因此这些跨域请求
 * 不受网页 CORS 限制。
 */
import { md5Hex, sha256Hex } from './signing';
import type {
  TranslateLangCode,
  TranslateProviderConfig,
  TranslateProviderId,
  TranslateSettings,
} from './types';
import { TRANSLATE_PROVIDERS } from './types';

type RequestInitLike = {
  method: string;
  headers: Record<string, string>;
  body?: string;
};

export interface ProviderRequest {
  url: string;
  init: RequestInitLike;
}

const DEEPL_TARGET: Record<string, string> = {
  zh: 'ZH', en: 'EN', ja: 'JA', ko: 'KO', fr: 'FR', de: 'DE', es: 'ES', ru: 'RU',
};
const GOOGLE_TARGET: Record<string, string> = {
  zh: 'zh-CN', en: 'en', ja: 'ja', ko: 'ko', fr: 'fr', de: 'de', es: 'es', ru: 'ru',
};
const YOUDAO_TARGET: Record<string, string> = {
  zh: 'zh-CHS', en: 'en', ja: 'ja', ko: 'ko', fr: 'fr', de: 'de', es: 'es', ru: 'ru',
};
const BAIDU_TARGET: Record<string, string> = {
  zh: 'zh', en: 'en', ja: 'jp', ko: 'kor', fr: 'fra', de: 'de', es: 'spa', ru: 'ru',
};

const mapLang = (table: Record<string, string>, code: TranslateLangCode): string =>
  table[code] || table.en;

const encodeForm = (params: Record<string, string>): string =>
  Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');

const endsWithHttp = (value: string) => /^https?:\/\//i.test(value);

/** DeepL：JSON + DeepL-Auth-Key 头；免费版走 api-free 域名 */
export const buildDeepLRequest = (
  config: TranslateProviderConfig,
  text: string,
  source: TranslateLangCode,
  target: TranslateLangCode,
): ProviderRequest => {
  const endpoint = config.useFreeApi
    ? 'https://api-free.deepl.com/v2/translate'
    : 'https://api.deepl.com/v2/translate';
  const payload: Record<string, unknown> = {
    text: [text],
    target_lang: mapLang(DEEPL_TARGET, target),
  };
  // DeepL 用「不传 source_lang」表示自动检测
  if (source !== 'auto') payload.source_lang = mapLang(DEEPL_TARGET, source);
  return {
    url: endpoint,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `DeepL-Auth-Key ${String(config.apiKey || '').trim()}`,
      },
      body: JSON.stringify(payload),
    },
  };
};

/** Google Cloud Translation v2：API Key 放 query，正文 JSON */
export const buildGoogleRequest = (
  config: TranslateProviderConfig,
  text: string,
  source: TranslateLangCode,
  target: TranslateLangCode,
): ProviderRequest => {
  const key = String(config.apiKey || '').trim();
  const payload: Record<string, unknown> = {
    q: [text],
    target: mapLang(GOOGLE_TARGET, target),
    format: 'text',
  };
  if (source !== 'auto') payload.source = mapLang(GOOGLE_TARGET, source);
  return {
    url: `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(key)}`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  };
};

/** 有道智云文本翻译 v3：form + SHA-256 签名 */
export const buildYoudaoRequest = async (
  config: TranslateProviderConfig,
  text: string,
  source: TranslateLangCode,
  target: TranslateLangCode,
  now = Date.now(),
): Promise<ProviderRequest> => {
  const appKey = String(config.appId || '').trim();
  const appSecret = String(config.appSecret || '').trim();
  const salt = String(now);
  const curtime = String(Math.floor(now / 1000));
  const input = text.length <= 20 ? text : `${text.slice(0, 10)}${text.length}${text.slice(-10)}`;
  const sign = await sha256Hex(`${appKey}${input}${salt}${curtime}${appSecret}`);
  const body = encodeForm({
    q: text,
    from: source === 'auto' ? 'auto' : mapLang(YOUDAO_TARGET, source),
    to: mapLang(YOUDAO_TARGET, target),
    appKey,
    salt,
    curtime,
    sign,
    signType: 'v3',
  });
  return {
    url: 'https://openapi.youdao.com/api',
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    },
  };
};

/** 百度翻译通用 API：form + MD5(appid+q+salt+key) */
export const buildBaiduRequest = (
  config: TranslateProviderConfig,
  text: string,
  source: TranslateLangCode,
  target: TranslateLangCode,
  now = Date.now(),
): ProviderRequest => {
  const appid = String(config.appId || '').trim();
  const secret = String(config.appSecret || '').trim();
  const salt = String(now);
  const sign = md5Hex(`${appid}${text}${salt}${secret}`);
  const body = encodeForm({
    q: text,
    from: source === 'auto' ? 'auto' : mapLang(BAIDU_TARGET, source),
    to: mapLang(BAIDU_TARGET, target),
    appid,
    salt,
    sign,
  });
  return {
    url: 'https://fanyi-api.baidu.com/api/trans/vip/translate',
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    },
  };
};

/** 解析各供应商响应，失败时抛出带供应商错误码的可读异常 */
export const parseProviderResponse = (id: TranslateProviderId, json: any): string => {
  const fail = (message: string): never => {
    throw new Error(message);
  };
  switch (id) {
    case 'deepl': {
      const text = json?.translations?.[0]?.text;
      if (typeof text === 'string' && text) return text;
      return fail(`DeepL 返回异常：${JSON.stringify(json).slice(0, 200)}`);
    }
    case 'google': {
      const text = json?.data?.translations?.[0]?.translatedText;
      if (typeof text === 'string' && text) return decodeHtmlEntities(text);
      return fail(`Google 返回异常：${JSON.stringify(json).slice(0, 200)}`);
    }
    case 'youdao': {
      const code = String(json?.errorCode ?? '');
      if (code === '0' && Array.isArray(json?.translation) && json.translation[0]) {
        return String(json.translation[0]);
      }
      return fail(`有道返回错误（errorCode=${code || 'unknown'}）`);
    }
    case 'baidu': {
      const code = json?.error_code;
      if ((code === undefined || String(code) === '0') && Array.isArray(json?.trans_result)) {
        const joined = json.trans_result.map((item: any) => String(item?.dst || '')).join('\n');
        if (joined) return joined;
      }
      return fail(`百度返回错误（error_code=${code ?? 'unknown'}）`);
    }
    default:
      return fail(`未知翻译供应商：${String(id)}`);
  }
};

const decodeHtmlEntities = (value: string): string => value
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>');

const buildRequest = async (
  id: TranslateProviderId,
  config: TranslateProviderConfig,
  text: string,
  source: TranslateLangCode,
  target: TranslateLangCode,
): Promise<ProviderRequest> => {
  switch (id) {
    case 'deepl': return buildDeepLRequest(config, text, source, target);
    case 'google': return buildGoogleRequest(config, text, source, target);
    case 'youdao': return buildYoudaoRequest(config, text, source, target);
    case 'baidu': return buildBaiduRequest(config, text, source, target);
    default: throw new Error(`未知翻译供应商：${String(id)}`);
  }
};

/** 对外的统一入口：按设置翻译一段文本 */
export const translateText = async (
  settings: TranslateSettings,
  text: string,
  signal?: AbortSignal,
): Promise<string> => {
  const content = String(text || '').trim();
  if (!content) throw new Error('请先输入要翻译的内容');

  const meta = TRANSLATE_PROVIDERS.find((item) => item.id === settings.provider);
  if (!meta) throw new Error(`未知翻译供应商：${String(settings.provider)}`);

  const config = settings.providers?.[settings.provider];
  if (!endsWithHttp(meta.endpoint)) throw new Error('供应商地址无效');

  const request = await buildRequest(settings.provider, config || {}, content, settings.source, settings.target);
  const response = await fetch(request.url, { ...request.init, signal });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`${meta.label} 请求失败（HTTP ${response.status}）：${raw.slice(0, 200)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`${meta.label} 返回的不是 JSON：${raw.slice(0, 200)}`);
  }
  return parseProviderResponse(settings.provider, json);
};
