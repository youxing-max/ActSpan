/**
 * Webhook 远端通知工具
 * 向用户配置的 webhook URL 发送推送通知
 * 支持通用 webhook 和 Bark（iOS 推送）深度适配
 */

import type { FunctionDefinition, FunctionResult } from './types';
import { readMigratedStorage } from '../lib/legacy-storage';

const WEBHOOK_CONFIG_KEY = 'actspan_webhook_config_v1';
const LEGACY_WEBHOOK_CONFIG_KEY = 'mole_webhook_config_v1';
const WEBHOOK_TIMEOUT_MS = 10_000;

const storageArea = {
  get: (keys: string | string[]) => new Promise<Record<string, unknown>>((resolve) => chrome.storage.local.get<Record<string, unknown>>(keys, resolve)),
  set: (items: Record<string, unknown>) => new Promise<void>((resolve) => chrome.storage.local.set(items, resolve)),
};

/** webhook 类型 */
export type WebhookType = 'generic' | 'bark';

/** Bark 专属配置 */
export interface BarkConfig {
  /** Bark 服务器地址（如 https://api.day.app） */
  server: string;
  /** 设备 Key */
  deviceKey: string;
  /** 推送分组 */
  group?: string;
  /** 自定义图标 URL */
  icon?: string;
  /** 提示音 */
  sound?: string;
  /** 点击跳转 URL */
  clickUrl?: string;
  /** 时效性通知级别 */
  level?: 'active' | 'timeSensitive' | 'passive';
}

/** 单条 webhook 配置 */
export interface WebhookEntry {
  id: string;
  name: string;
  type: WebhookType;
  enabled: boolean;
  createdAt: number;
  /** 通用 webhook 字段 */
  url?: string;
  headers?: Record<string, string>;
  /** Bark 专属配置 */
  bark?: BarkConfig;
}

interface WebhookConfigStore {
  version: 1;
  updatedAt: number;
  webhooks: WebhookEntry[];
}

export const readWebhookConfig = async (): Promise<WebhookEntry[]> => {
  const raw = await readMigratedStorage<WebhookConfigStore>(storageArea, WEBHOOK_CONFIG_KEY, LEGACY_WEBHOOK_CONFIG_KEY);
  if (!raw || !Array.isArray(raw.webhooks)) return [];
  return raw.webhooks;
};

/** 保存 webhook 配置列表 */
export const saveWebhookConfig = async (entries: WebhookEntry[]): Promise<void> => {
  const payload: WebhookConfigStore = {
    version: 1,
    updatedAt: Date.now(),
    webhooks: entries,
  };
  await new Promise<void>((resolve) => {
    chrome.storage.local.set({ [WEBHOOK_CONFIG_KEY]: payload }, resolve);
  });
};

/* ---------- 发送逻辑 ---------- */

/** 构建 Bark 推送请求：正文走 POST body，避免消息进入 URL 路径、代理与网关日志 */
const buildBarkRequest = (
  bark: BarkConfig,
  body: { title: string; message: string },
): { url: string; init: RequestInit } => {
  const server = bark.server.replace(/\/+$/, '');
  const payload: Record<string, string> = {
    device_key: bark.deviceKey,
    title: body.title,
    body: body.message,
  };
  if (bark.group) payload.group = bark.group;
  if (bark.icon) payload.icon = bark.icon;
  if (bark.sound) payload.sound = bark.sound;
  if (bark.clickUrl) payload.url = bark.clickUrl;
  if (bark.level) payload.level = bark.level;

  return {
    url: `${server}/push`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    },
  };
};

/** 判断是否为飞书/Lark 机器人 Webhook */
const isFeishuWebhookUrl = (url: string): boolean => {
  try {
    const host = new URL(url).hostname;
    return host === 'open.feishu.cn' || host === 'open.larksuite.com';
  } catch {
    return false;
  }
};

/** 选择已启用的飞书 Webhook；名称匹配时必须完全相等 */
export const selectFeishuWebhooks = (entries: WebhookEntry[], name?: string): WebhookEntry[] => {
  const target = name?.trim();
  return entries.filter((entry) =>
    entry.enabled &&
    entry.type === 'generic' &&
    typeof entry.url === 'string' &&
    isFeishuWebhookUrl(entry.url) &&
    (!target || entry.name === target),
  );
};

/** 构建通用 webhook 请求 */
const buildGenericRequest = (
  entry: WebhookEntry,
  body: { title: string; message: string },
): { url: string; init: RequestInit } => {
  if (isFeishuWebhookUrl(entry.url!)) {
    return {
      url: entry.url!,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(entry.headers || {}),
        },
        body: JSON.stringify({
          msg_type: 'text',
          content: { text: [body.title, body.message].filter(Boolean).join('\n') },
        }),
      },
    };
  }

  return {
    url: entry.url!,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(entry.headers || {}),
      },
      body: JSON.stringify({
        ...body,
        timestamp: Date.now(),
        source: 'actspan-extension',
      }),
    },
  };
};

/** 向单个 webhook 发送通知 */
export const sendToWebhook = async (
  entry: WebhookEntry,
  body: { title: string; message: string },
): Promise<{ success: boolean; message: string }> => {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const { url, init } =
      entry.type === 'bark' && entry.bark
        ? buildBarkRequest(entry.bark, body)
        : buildGenericRequest(entry, body);

    const response = await fetch(url, { ...init, signal: controller.signal });

    if (!response.ok) {
      return { success: false, message: `HTTP ${response.status}` };
    }

    const isFeishu = entry.type === 'generic' && isFeishuWebhookUrl(url);
    const inspectJson = entry.type === 'bark' || isFeishu;
    if (inspectJson) {
      try {
        const json = await response.json();
        const successCode = entry.type === 'bark' ? 200 : 0;
        if (isFeishu && (json === null || typeof json !== 'object' || json.code === undefined)) {
          return { success: false, message: '飞书响应缺少成功码' };
        }
        if (json?.code !== undefined && Number(json.code) !== successCode) {
          return { success: false, message: json.message || json.msg || `Webhook code ${json.code}` };
        }
      } catch {
        if (isFeishu) {
          return { success: false, message: '飞书响应不是有效 JSON' };
        }
        // 非 JSON 响应，HTTP 200 视为成功
      }
    }

    return { success: true, message: 'OK' };
  } catch (err: any) {
    if (controller.signal.aborted) {
      return { success: false, message: '请求超时（10s）' };
    }
    return { success: false, message: err?.message || '请求失败' };
  } finally {
    clearTimeout(timer);
  }
};

/** 向一组 webhook 发送通知 */
export const sendWebhookEntries = async (
  entries: WebhookEntry[],
  body: { title: string; message: string },
): Promise<FunctionResult> => {
  const results: string[] = [];
  let hasError = false;

  for (const entry of entries) {
    const result = await sendToWebhook(entry, body);
    if (result.success) {
      results.push(`[${entry.name}] 发送成功`);
    } else {
      hasError = true;
      results.push(`[${entry.name}] 失败: ${result.message}`);
    }
  }

  return {
    success: !hasError,
    data: {
      message: results.join('；'),
      sent: entries.length,
      failed: hasError ? results.filter((r) => r.includes('失败')).length : 0,
    },
  };
};
/** 自动推送开关：默认开启；用户可在 Webhook 设置页关闭，避免页面内容在不知情时外发。 */
const AUTO_PUSH_KEY = 'actspan_feishu_auto_push';

export const isFeishuAutoPushEnabled = async (): Promise<boolean> => {
  try {
    const stored = await new Promise<Record<string, unknown>>((resolve) => {
      chrome.storage.local.get(AUTO_PUSH_KEY, (result) => resolve(result || {}));
    });
    return stored[AUTO_PUSH_KEY] !== false;
  } catch {
    return true;
  }
};

export const setFeishuAutoPushEnabled = async (enabled: boolean): Promise<void> => {
  await new Promise<void>((resolve) => {
    chrome.storage.local.set({ [AUTO_PUSH_KEY]: enabled }, resolve);
  });
};

/** 向已启用的飞书 Webhook 推送 AI 完成结果 */
export const sendFeishuCompletion = async (message: string): Promise<FunctionResult> => {  const entries = selectFeishuWebhooks(await readWebhookConfig());
  if (entries.length === 0) {
    return {
      success: false,
      error: '未配置启用的飞书 Webhook',
      data: { message: '未配置启用的飞书 Webhook', sent: 0, failed: 0 },
    };
  }
  return sendWebhookEntries(entries, {
    title: '调查完成',
    message,
  });
};


/** 获取 entry 的展示 URL（用于 Options 页面） */
export const getEntryDisplayUrl = (entry: WebhookEntry): string => {
  if (entry.type === 'bark' && entry.bark) {
    const server = entry.bark.server.replace(/\/+$/, '');
    return `${server}/${entry.bark.deviceKey.slice(0, 8)}…`;
  }
  return entry.url || '';
};

/* ---------- 工具定义 ---------- */

export const webhookFunction: FunctionDefinition = {
  name: 'webhook',
  description:
    'Send a notification to remote webhook endpoints (Bark, Feishu, Slack, Discord, WeChat Work, etc.) configured by the user in Options page. ' +
    'Use this tool when you need to push results, alerts, or reminders to external platforms. ' +
    'The user must configure at least one enabled webhook in Options > Webhook before this tool works.\n\n' +
    '⚠️ Do NOT use this tool for browser desktop notifications — use the "notification" tool instead.',
  supportsParallel: true,
  // webhook 可把任意文本 POST 到外部平台，属于数据外带通道
  permissionLevel: 'sensitive',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Notification title',
      },
      message: {
        type: 'string',
        description: 'Notification body text',
      },
    },
    required: ['title', 'message'],
  },
  execute: async (params: { title: string; message: string }) => {
    const { title, message } = params;

    const entries = await readWebhookConfig();
    const enabled = entries.filter((e) => e.enabled);

    if (enabled.length === 0) {
      return {
        success: false,
        error: '没有已启用的 Webhook，请在 Options > Webhook 页面添加并启用至少一个 Webhook',
      };
    }

    return sendWebhookEntries(enabled, { title, message });
  },
};
