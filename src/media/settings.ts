/**
 * 图片 / 视频生成设置的读写（chrome.storage.local）
 */
import { DEFAULT_MEDIA_SETTINGS, MEDIA_SETTINGS_KEY } from './types';
import type { MediaSettings } from './types';

const cloneDefaults = (): MediaSettings => ({
  image: { ...DEFAULT_MEDIA_SETTINGS.image },
  video: { ...DEFAULT_MEDIA_SETTINGS.video },
});

/** 读取设置，缺失字段用默认值补齐 */
export const loadMediaSettings = async (): Promise<MediaSettings> => {
  try {
    const stored = await new Promise<Record<string, unknown>>((resolve) => {
      chrome.storage.local.get<Record<string, unknown>>(MEDIA_SETTINGS_KEY, resolve);
    });
    const raw = stored?.[MEDIA_SETTINGS_KEY] as Partial<MediaSettings> | undefined;
    if (!raw || typeof raw !== 'object') return cloneDefaults();
    const defaults = cloneDefaults();
    return {
      image: { ...defaults.image, ...(raw.image || {}) },
      video: { ...defaults.video, ...(raw.video || {}) },
    };
  } catch {
    return cloneDefaults();
  }
};

/** 保存设置 */
export const saveMediaSettings = async (settings: MediaSettings): Promise<void> => {
  await new Promise<void>((resolve) => {
    chrome.storage.local.set({ [MEDIA_SETTINGS_KEY]: settings }, () => resolve());
  });
};
