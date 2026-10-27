/**
 * 翻译设置的读写（chrome.storage.local）
 */
import {
  DEFAULT_TRANSLATE_SETTINGS,
  TRANSLATE_SETTINGS_KEY,
} from './types';
import type { TranslateProviderConfig, TranslateProviderId, TranslateSettings } from './types';

const cloneDefaults = (): TranslateSettings => ({
  ...DEFAULT_TRANSLATE_SETTINGS,
  providers: { ...DEFAULT_TRANSLATE_SETTINGS.providers },
});

/** 读取翻译设置，缺失字段用默认值补齐 */
export const loadTranslateSettings = async (): Promise<TranslateSettings> => {
  try {
    const stored = await new Promise<Record<string, unknown>>((resolve) => {
      chrome.storage.local.get<Record<string, unknown>>(TRANSLATE_SETTINGS_KEY, resolve);
    });
    const raw = stored?.[TRANSLATE_SETTINGS_KEY] as Partial<TranslateSettings> | undefined;
    if (!raw || typeof raw !== 'object') return cloneDefaults();
    const defaults = cloneDefaults();
    return {
      ...defaults,
      ...raw,
      providers: {
        ...defaults.providers,
        ...(raw.providers as Record<TranslateProviderId, TranslateProviderConfig> | undefined),
      },
    };
  } catch {
    return cloneDefaults();
  }
};

/** 保存翻译设置 */
export const saveTranslateSettings = async (settings: TranslateSettings): Promise<void> => {
  await new Promise<void>((resolve) => {
    chrome.storage.local.set({ [TRANSLATE_SETTINGS_KEY]: settings }, () => resolve());
  });
};
