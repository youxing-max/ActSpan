#!/usr/bin/env node
/**
 * Telegram 双向机器人连接器（独立适配器）
 *
 * 这是独立文件，不依赖钉钉连接器的传输层。需要接入其他 IM 时，
 * 可以整份复制本文件，只替换“收消息/回消息”两处，任务执行部分保持不变。
 *
 * 工作方式：
 *   Telegram @机器人 或私聊
 *     -> getUpdates 长轮询
 *     -> 本机 MCP Server
 *     -> Chrome 扩展执行浏览器任务
 *     -> sendMessage 回复结果
 *
 * 环境变量：
 *   TELEGRAM_BOT_TOKEN             BotFather 提供的机器人 Token
 *   TELEGRAM_API_BASE              可选，默认 https://api.telegram.org
 *   ACTSPAN_TELEGRAM_TIMEOUT_MS    单任务最长等待时间，默认 15 分钟
 *   TELEGRAM_ALLOWED_USER_IDS      可选，逗号分隔的 Telegram 用户 ID 白名单
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_API_BASE = 'https://api.telegram.org';
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const POLL_TIMEOUT_SECONDS = 50;
const POLL_ERROR_BACKOFF_MS = 3_000;
const TYPING_INTERVAL_MS = 4_500;
const MAX_REPLY_CHARS = 3_800;
const MAX_REPLY_CHUNKS = 5;

const log = (...args) => {
  console.log(`[actspan-telegram] ${new Date().toISOString()}`, ...args);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const usage = () => `
ActSpan Telegram 机器人

用法：
  actspan-telegram [--config <path>]

配置（优先环境变量）：
  TELEGRAM_BOT_TOKEN             BotFather 提供的 Token
  TELEGRAM_API_BASE              可选，默认 https://api.telegram.org
  ACTSPAN_TELEGRAM_TIMEOUT_MS    单任务最长等待时间，默认 900000ms
  TELEGRAM_ALLOWED_USER_IDS      可选，逗号分隔的 Telegram 用户 ID 白名单

也可以写入 ~/.actspan/telegram.json：
  { "botToken": "..." }
`.trim();

/** 去掉命令前缀和 @机器人，保留任务正文。 */
export const normalizeTelegramQuery = (text, botUsername = '') => {
  let value = String(text || '').trim();
  value = value.replace(/^\/ask(?:@[A-Za-z0-9_]+)?\s*/i, '');
  if (botUsername) {
    value = value.replace(new RegExp(`@${escapeRegExp(botUsername)}`, 'gi'), ' ');
  }
  return value.replace(/\s+/g, ' ').trim();
};

export const isHelpCommand = (text, botUsername = '') => {
  const match = String(text || '').match(/^\/(start|help)(?:@([A-Za-z0-9_]+))?(?:\s|$)/i);
  return Boolean(match && (!match[2] || match[2].toLowerCase() === botUsername.toLowerCase()));
};

export const isAskCommand = (text, botUsername = '') => {
  const match = String(text || '').match(/^\/ask(?:@([A-Za-z0-9_]+))?(?:\s|$)/i);
  return Boolean(match && (!match[1] || match[1].toLowerCase() === botUsername.toLowerCase()));
};

/** 群聊里只有 @机器人、回复机器人或发送 /ask 命令时才响应。 */
export const isBotAddressed = (message, botUsername = '') => {
  if (!message) return false;
  if (message.chat?.type === 'private') return true;
  const text = String(message.text || '');
  if (isAskCommand(text, botUsername)) return true;
  if (message.reply_to_message?.from?.username?.toLowerCase() === botUsername.toLowerCase()) return true;
  if (!botUsername) return false;
  return new RegExp(`(^|[\\s@])@${escapeRegExp(botUsername)}(?=\\s|$|[.,!?，。！？])`, 'i').test(text);
};

/** 从 task.result 的返回中提取可读文本。 */
export const extractTaskText = (payload) => {
  const errorMessage = payload?.error?.message || (typeof payload?.error === 'string' ? payload.error : '');
  if (errorMessage) return `执行失败：${errorMessage}`;

  const result = payload?.result;
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    if (typeof result.content === 'string') return result.content;
    if (Array.isArray(result.content)) {
      const text = result.content
        .map((part) => (typeof part === 'string' ? part : part?.text))
        .filter((part) => typeof part === 'string' && part.trim())
        .join('\n');
      if (text) return text;
    }
    if (typeof result.text === 'string') return result.text;
    return JSON.stringify(result, null, 2);
  }
  return '任务已结束，但没有返回文本结果。';
};

/** Telegram 单条消息上限 4096 字符，这里留出前缀和截断提示的余量。 */
export const splitReply = (text) => {
  const normalized = String(text || '').trim() || '任务已结束。';
  const chars = Array.from(normalized);
  const chunks = [];
  let cursor = 0;
  while (cursor < chars.length && chunks.length < MAX_REPLY_CHUNKS) {
    chunks.push(chars.slice(cursor, cursor + MAX_REPLY_CHARS).join(''));
    cursor += MAX_REPLY_CHARS;
  }
  if (cursor < chars.length) {
    chunks[chunks.length - 1] += '\n\n…（结果过长，已截断）';
  }
  return chunks.length > 1
    ? chunks.map((chunk, index) => `（${index + 1}/${chunks.length}）\n${chunk}`)
    : chunks;
};

const readConfigFile = (file) => {
  if (!file) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`无法读取配置文件 ${file}: ${error.message}`);
  }
};

export const loadConfig = (env = process.env, options = {}) => {
  const file = options.config || env.TELEGRAM_CONFIG || path.join(os.homedir(), '.actspan', 'telegram.json');
  const stored = readConfigFile(file);
  const timeout = Number(env.ACTSPAN_TELEGRAM_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const apiBase = String(env.TELEGRAM_API_BASE || DEFAULT_API_BASE).trim().replace(/\/+$/, '');
  return {
    botToken: String(env.TELEGRAM_BOT_TOKEN || stored.botToken || stored.token || '').trim(),
    apiBase,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
    allowedUserIds: String(env.TELEGRAM_ALLOWED_USER_IDS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  };
};

const parseArgs = (argv) => {
  const options = { config: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--config') options.config = argv[++i] || '';
    else throw new Error(`未知参数：${arg}`);
  }
  return options;
};

/**
 * 复用已运行 Bridge 的扩展白名单。
 * 连接器从 shell 启动时通常没有 ACTSPAN_EXTENSION_IDS，需要从
 * ~/.actspan/bridge-<port>.json 读取现有 origins，避免和 daemon 不兼容。
 */
export const inferExtensionIds = (env = process.env, home = os.homedir()) => {
  const configured = String(env.ACTSPAN_EXTENSION_IDS || '').trim();
  if (configured) return configured;

  let port = 30121;
  try {
    const bridgeUrl = new URL(env.ACTSPAN_BRIDGE_URL || 'ws://127.0.0.1:30121');
    if (bridgeUrl.port) port = Number(bridgeUrl.port);
  } catch {
    return '';
  }

  try {
    const metadata = JSON.parse(fs.readFileSync(path.join(home, '.actspan', `bridge-${port}.json`), 'utf8'));
    return (metadata.origins || [])
      .map((origin) => String(origin).replace(/^chrome-extension:\/\//, ''))
      .filter((id) => /^[a-p]{32}$/.test(id))
      .join(',');
  } catch {
    return '';
  }
};

const parseToolResult = (result) => {
  const text = (result?.content || [])
    .filter((item) => item?.type === 'text')
    .map((item) => item.text)
    .join('\n')
    .trim();
  if (result?.isError) throw new Error(text || 'ActSpan 工具调用失败');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
};

/** 管理本机 MCP 子进程；与钉钉连接器逻辑相同，但保持适配器独立。 */
class ActspanSession {
  constructor() {
    this.client = null;
    this.connecting = null;
  }

  async connect() {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const env = { ...process.env };
      const inferred = inferExtensionIds(env);
      if (inferred) env.ACTSPAN_EXTENSION_IDS = inferred;
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(HERE, 'index.js'), '--client', 'telegram-bot'],
        env,
        cwd: HERE,
        stderr: 'inherit',
      });
      const client = new Client(
        { name: 'actspan-telegram', version: '1.0.0' },
        { capabilities: {} },
      );
      await client.connect(transport);
      this.client = client;
      return client;
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async close() {
    const client = this.client;
    this.client = null;
    if (client) {
      try { await client.close(); } catch { /* 关闭失败不影响进程退出 */ }
    }
  }

  async call(name, args, { retry = true } = {}) {
    const client = await this.connect();
    try {
      return await client.callTool({ name, arguments: args });
    } catch (error) {
      if (!retry) throw error;
      await this.close();
      const retryClient = await this.connect();
      return await retryClient.callTool({ name, arguments: args });
    }
  }

  async submit(query) {
    // 提交任务不自动重试，避免超时后重复创建浏览器任务。
    const handle = parseToolResult(await this.call('actspan_agent_submit', { input: { query } }, { retry: false }));
    if (!handle.taskId) throw new Error(handle.text || 'ActSpan 未返回任务 ID');
    return handle;
  }

  async waitForCompletion(taskId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = parseToolResult(await this.call('actspan_agent_status', { taskId }));
      if (status.state === 'succeeded') {
        return parseToolResult(await this.call('actspan_agent_result', { taskId }));
      }
      if (status.state === 'failed' || status.state === 'cancelled') return status;
      await sleep(2_000);
    }
    throw new Error(`等待任务超时（${Math.round(timeoutMs / 1000)} 秒）`);
  }
}

class TelegramApi {
  constructor(token, apiBase) {
    this.token = token;
    this.apiBase = apiBase;
  }

  redact(value) {
    return String(value || '').replaceAll(this.token, '[redacted]');
  }

  async call(method, payload = {}, { signal } = {}) {
    const timeout = method === 'getUpdates' ? 65_000 : 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    let response;
    try {
      response = await fetch(`${this.apiBase}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch {
      throw new Error(`Telegram API ${method} 网络请求失败`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    let data = null;
    try { data = await response.json(); } catch { /* 非 JSON 响应在下面统一报错 */ }
    if (!response.ok || data?.ok !== true) {
      const description = this.redact(data?.description || `HTTP ${response.status}`);
      throw new Error(`Telegram API ${method} 失败：${description}`);
    }
    return data.result;
  }

  getMe() {
    return this.call('getMe');
  }

  getWebhookInfo() {
    return this.call('getWebhookInfo');
  }

  getUpdates(offset, signal) {
    return this.call('getUpdates', {
      offset,
      timeout: POLL_TIMEOUT_SECONDS,
      allowed_updates: ['message'],
    }, { signal });
  }

  sendMessage(chatId, text, replyToMessageId) {
    return this.call('sendMessage', {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...(replyToMessageId
        ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } }
        : {}),
    });
  }

  sendTyping(chatId) {
    return this.call('sendChatAction', { chat_id: chatId, action: 'typing' });
  }
}

const sendQuietly = async (replier, message, content) => {
  try {
    await replier(message, content);
  } catch (error) {
    log('回复失败：', error instanceof Error ? error.message : String(error));
  }
};

const runTask = async ({ message, query, reply, api, actspan, timeoutMs }) => {
  log(`收到任务：${query.slice(0, 120)}`);
  const typing = setInterval(() => {
    void api.sendTyping(message.chat.id).catch(() => undefined);
  }, TYPING_INTERVAL_MS);
  try {
    const handle = await actspan.submit(query);
    const result = await actspan.waitForCompletion(handle.taskId, timeoutMs);
    await reply(message, `ActSpan 执行完成\n\n${extractTaskText(result)}`);
  } finally {
    clearInterval(typing);
  }
};

const start = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const config = loadConfig(process.env, options);
  if (!config.botToken) {
    console.error('缺少 TELEGRAM_BOT_TOKEN。\n');
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  const api = new TelegramApi(config.botToken, config.apiBase);
  let me;
  try {
    me = await api.getMe();
  } catch (error) {
    console.error(`Telegram 连接失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  try {
    const webhook = await api.getWebhookInfo();
    if (webhook?.url) {
      console.error('该机器人已配置 Telegram Webhook，长轮询无法接收消息。请先在 BotFather 或 API 中删除 Webhook。');
      process.exitCode = 1;
      return;
    }
  } catch {
    // 没有权限读取 Webhook 信息时继续尝试长轮询。
  }

  const username = me.username || '';
  const actspan = new ActspanSession();
  const conversationQueues = new Map();
  const stopController = new AbortController();
  let running = true;

  const reply = async (message, content) => {
    for (const chunk of splitReply(content)) {
      await api.sendMessage(message.chat.id, chunk, message.message_id);
    }
  };

  const enqueue = (chatId, job) => {
    const previous = conversationQueues.get(chatId) || Promise.resolve();
    const next = previous.catch(() => undefined).then(job);
    conversationQueues.set(chatId, next);
    void next.finally(() => {
      if (conversationQueues.get(chatId) === next) conversationQueues.delete(chatId);
    });
    return next;
  };

  const handleUpdate = async (update) => {
    const message = update.message;
    if (!message?.chat?.id) return;

    const text = typeof message.text === 'string' ? message.text : '';
    const isPrivate = message.chat.type === 'private';
    const userId = String(message.from?.id || '');

    if (config.allowedUserIds.length && !config.allowedUserIds.includes(userId)) {
      log(`拒绝未授权用户：${userId || 'unknown'}`);
      if (isPrivate) await sendQuietly(reply, message, '你不在这个机器人的允许使用名单中。');
      return;
    }

    if (!text) {
      if (isPrivate) await sendQuietly(reply, message, '目前只支持文本消息，请直接输入任务描述。');
      return;
    }

    const helpCommand = isHelpCommand(text, username);
    if (!isPrivate && !isBotAddressed(message, username) && !helpCommand) return;

    if (helpCommand) {
      await sendQuietly(reply, message, [
        '用法：',
        '私聊直接输入任务；群聊 @我 或使用 /ask 任务描述。',
        '例如：@ActSpan 打开 example.com 并告诉我页面标题',
      ].join('\n'));
      return;
    }

    const query = normalizeTelegramQuery(text, username);
    if (!query) {
      await sendQuietly(reply, message, '请 @我 并输入要执行的任务，例如：@ActSpan 打开 example.com 并读取标题');
      return;
    }

    await sendQuietly(reply, message, `收到，正在让 ActSpan 处理：\n${query}\n\n任务结束后我会把结果发到这里。`);
    void enqueue(message.chat.id, async () => {
      try {
        await runTask({ message, query, reply, api, actspan, timeoutMs: config.timeoutMs });
      } catch (error) {
        log('处理消息失败：', error instanceof Error ? error.message : String(error));
        await sendQuietly(reply, message, `处理失败：${error instanceof Error ? error.message : String(error)}`);
      }
    });
  };

  let offset = 0;
  try {
    const latest = await api.call('getUpdates', { offset: -1, limit: 1, timeout: 0 });
    if (latest.length) offset = latest[0].update_id + 1;
  } catch (error) {
    console.error(`读取 Telegram 更新失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  const shutdown = async () => {
    running = false;
    stopController.abort();
    log('正在退出');
    await actspan.close();
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });

  log(`已连接 Telegram @${username || '(unknown)'}；等待私聊或群内 @机器人 消息（超时 ${Math.round(config.timeoutMs / 60000)} 分钟）`);

  while (running) {
    try {
      const updates = await api.getUpdates(offset, stopController.signal);
      for (const update of updates) {
        offset = update.update_id + 1;
        void handleUpdate(update).catch((error) => {
          log('处理更新失败：', error instanceof Error ? error.message : String(error));
        });
      }
    } catch (error) {
      if (!running) break;
      log('轮询失败：', error instanceof Error ? error.message : String(error));
      await sleep(POLL_ERROR_BACKOFF_MS);
    }
  }

  await actspan.close();
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  start().catch((error) => {
    console.error(`[actspan-telegram] 启动失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
