#!/usr/bin/env node
/**
 * 飞书 / Lark 双向机器人连接器（独立适配器）
 *
 * 这是独立文件，不依赖钉钉连接器的传输层。
 * 使用飞书官方 SDK 的 WebSocket 长连接接收消息，不需要公网回调地址。
 *
 * 工作方式：
 *   飞书私聊 / 群内 @机器人
 *     -> 飞书 WebSocket 长连接（im.message.receive_v1）
 *     -> 本机 MCP Server
 *     -> Chrome 扩展执行浏览器任务
 *     -> 飞书回复消息
 *
 * 环境变量：
 *   FEISHU_APP_ID                 自建应用 App ID（也可用 LARK_APP_ID）
 *   FEISHU_APP_SECRET             自建应用 App Secret（也可用 LARK_APP_SECRET）
 *   FEISHU_DOMAIN                 feishu（默认）或 lark（国际版）
 *   ACTSPAN_FEISHU_TIMEOUT_MS     单任务最长等待时间，默认 15 分钟
 *   FEISHU_ALLOWED_OPEN_IDS       可选，逗号分隔的发送者 open_id 白名单
 *   FEISHU_DEBUG                  设为 1 输出 SDK 日志
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as Lark from '@larksuiteoapi/node-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const SEEN_MESSAGE_TTL_MS = 5 * 60 * 1000;
const MAX_REPLY_CHARS = 3_500;
const MAX_REPLY_CHUNKS = 5;

const log = (...args) => {
  console.log(`[actspan-feishu] ${new Date().toISOString()}`, ...args);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const usage = () => `
ActSpan 飞书机器人

用法：
  actspan-feishu [--config <path>] [--debug]

配置（优先环境变量）：
  FEISHU_APP_ID                 自建应用 App ID（也可用 LARK_APP_ID）
  FEISHU_APP_SECRET             自建应用 App Secret（也可用 LARK_APP_SECRET）
  FEISHU_DOMAIN                 feishu（默认）或 lark（国际版）
  ACTSPAN_FEISHU_TIMEOUT_MS     单任务最长等待时间，默认 900000ms
  FEISHU_ALLOWED_OPEN_IDS       可选，逗号分隔的发送者 open_id 白名单

也可以写入 ~/.actspan/feishu.json：
  { "appId": "...", "appSecret": "..." }
`.trim();

/** 飞书文本消息里的 @ 会被替换成 @_user_N，这里统一去掉。 */
export const stripFeishuMentions = (text) =>
  String(text || '')
    .replace(/@_user_\d+/g, ' ')
    .replace(/<at[^>]*>.*?<\/at>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** 去掉 @提及 和 /ask 命令前缀，保留任务正文。 */
export const normalizeFeishuQuery = (text) => {
  const value = stripFeishuMentions(text);
  return value.replace(/^\/ask(?:@[A-Za-z0-9_]+)?\s*/i, '').trim();
};

export const isAskCommand = (text) => /^\/ask(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(stripFeishuMentions(text));

export const isHelpCommand = (text) => {
  const value = stripFeishuMentions(text);
  return /^\/(start|help)(?:\s|$)/i.test(value) || /^(help|帮助)$/i.test(value);
};

/** 判断消息是否真的 @ 了当前机器人。 */
export const isBotMentioned = (mentions, botOpenId = '', botName = '') => {
  if (!Array.isArray(mentions) || mentions.length === 0) return false;
  const matched = mentions.some((mention) => {
    const id = mention?.id;
    const openId = typeof id === 'string' ? id : id?.open_id;
    return Boolean(
      (botOpenId && openId === botOpenId)
      || (botName && mention?.name === botName),
    );
  });
  if (matched) return true;
  // 获取不到机器人身份时，只要事件带 mention 就按 @机器人 处理。
  return !botOpenId && !botName;
};

/** 解析飞书文本消息 content（JSON 字符串）。 */
export const parseFeishuText = (content) => {
  try {
    const parsed = JSON.parse(String(content || '{}'));
    return typeof parsed?.text === 'string' ? parsed.text : '';
  } catch {
    return '';
  }
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

/** 按字符数拆分长回复，避免超出单条消息限制。 */
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
  const file = options.config || env.FEISHU_CONFIG || path.join(os.homedir(), '.actspan', 'feishu.json');
  const stored = readConfigFile(file);
  const timeout = Number(env.ACTSPAN_FEISHU_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return {
    appId: String(env.FEISHU_APP_ID || env.LARK_APP_ID || stored.appId || stored.app_id || '').trim(),
    appSecret: String(
      env.FEISHU_APP_SECRET || env.LARK_APP_SECRET || stored.appSecret || stored.app_secret || '',
    ).trim(),
    domain: String(env.FEISHU_DOMAIN || stored.domain || 'feishu').trim().toLowerCase(),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
    allowedOpenIds: String(env.FEISHU_ALLOWED_OPEN_IDS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    debug: Boolean(options.debug || env.FEISHU_DEBUG === '1'),
  };
};

const parseArgs = (argv) => {
  const options = { config: '', debug: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--debug') options.debug = true;
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
        args: [path.join(HERE, 'index.js'), '--client', 'feishu-bot'],
        env,
        cwd: HERE,
        stderr: 'inherit',
      });
      const client = new Client(
        { name: 'actspan-feishu', version: '1.0.0' },
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

class FeishuReplier {
  constructor(client) {
    this.client = client;
  }

  assertOk(response, action) {
    if (response && typeof response.code === 'number' && response.code !== 0) {
      throw new Error(`${action}失败：${response.msg || `code ${response.code}`}`);
    }
    return response;
  }

  async send(message, content) {
    const chunks = splitReply(content);
    for (const chunk of chunks) {
      const data = {
        msg_type: 'text',
        content: JSON.stringify({ text: chunk }),
      };
      try {
        const response = await this.client.im.message.reply({
          path: { message_id: message.message_id },
          data,
        });
        this.assertOk(response, '飞书回复');
      } catch (error) {
        // 原消息不可回复时，退化为直接发到当前会话，避免结果丢失。
        log('回复原消息失败，尝试直接发送到会话：', error instanceof Error ? error.message : String(error));
        const response = await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { ...data, receive_id: message.chat_id },
        });
        this.assertOk(response, '飞书发送');
      }
    }
  }
}

const sendQuietly = async (replier, message, content) => {
  try {
    await replier.send(message, content);
  } catch (error) {
    log('回复失败：', error instanceof Error ? error.message : String(error));
  }
};

const runTask = async ({ message, query, replier, actspan, timeoutMs }) => {
  log(`收到任务：${query.slice(0, 120)}`);
  const handle = await actspan.submit(query);
  const result = await actspan.waitForCompletion(handle.taskId, timeoutMs);
  await replier.send(message, `ActSpan 执行完成\n\n${extractTaskText(result)}`);
};

const start = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const config = loadConfig(process.env, options);
  if (!config.appId || !config.appSecret) {
    console.error('缺少 FEISHU_APP_ID / FEISHU_APP_SECRET。\n');
    console.error(usage());
    process.exitCode = 1;
    return;
  }
  if (!/^cli_[0-9a-fA-F]{16}$/.test(config.appId)) {
    console.error('FEISHU_APP_ID 格式不正确，应类似 cli_a1b2c3d4e5f67890。');
    process.exitCode = 1;
    return;
  }

  const domain = config.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu;
  const loggerLevel = config.debug ? Lark.LoggerLevel.info : Lark.LoggerLevel.warn;
  const client = new Lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    appType: Lark.AppType.SelfBuild,
    domain,
  });
  const actspan = new ActspanSession();
  const seen = new Map();
  const conversationQueues = new Map();
  let botOpenId = '';
  let botName = '';

  try {
    const response = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' });
    const bot = response?.bot || response?.data?.bot;
    if (bot?.open_id) {
      botOpenId = String(bot.open_id);
      botName = String(bot.app_name || '');
      log(`机器人身份：${botName || '(未命名)'}`);
    }
  } catch (error) {
    log('读取机器人信息失败，群聊将按 mention 兜底判断：', error instanceof Error ? error.message : String(error));
  }

  const remember = (messageId) => {
    const now = Date.now();
    for (const [id, timestamp] of seen) {
      if (now - timestamp > SEEN_MESSAGE_TTL_MS) seen.delete(id);
    }
    if (seen.has(messageId)) return false;
    seen.set(messageId, now);
    return true;
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

  const replier = new FeishuReplier(client);

  const handleMessage = async ({ message, sender }) => {
    const isPrivate = message.chat_type === 'p2p';
    const text = parseFeishuText(message.content);
    const cleanText = stripFeishuMentions(text);
    const mentions = message.mentions || [];
    const senderId = sender?.sender_id?.open_id || sender?.sender_id?.user_id || '';
    const mentionedBot = isBotMentioned(mentions, botOpenId, botName);
    const asked = isAskCommand(cleanText);

    if (config.allowedOpenIds.length && !config.allowedOpenIds.includes(String(senderId))) {
      log(`拒绝未授权用户：${senderId || 'unknown'}`);
      if (isPrivate) await sendQuietly(replier, message, '你不在这个机器人的允许使用名单中。');
      return;
    }

    if (!isPrivate && !mentionedBot && !asked) return;

    if (message.message_type !== 'text') {
      await sendQuietly(replier, message, '目前只支持文本消息，请直接输入任务描述。');
      return;
    }

    if (!text) {
      await sendQuietly(replier, message, '请 @我 并输入要执行的任务，例如：@ActSpan 打开 example.com 并读取标题');
      return;
    }

    if (isHelpCommand(cleanText)) {
      await sendQuietly(replier, message, [
        '用法：',
        '私聊直接输入任务；群聊 @我 或使用 /ask 任务描述。',
        '例如：@ActSpan 打开 example.com 并告诉我页面标题',
      ].join('\n'));
      return;
    }

    const query = normalizeFeishuQuery(text);
    if (!query) {
      await sendQuietly(replier, message, '请 @我 并输入要执行的任务，例如：@ActSpan 打开 example.com 并读取标题');
      return;
    }

    await sendQuietly(replier, message, `收到，正在让 ActSpan 处理：\n${query}\n\n任务结束后我会把结果发到这里。`);
    void enqueue(message.chat_id, async () => {
      try {
        await runTask({ message, query, replier, actspan, timeoutMs: config.timeoutMs });
      } catch (error) {
        log('处理消息失败：', error instanceof Error ? error.message : String(error));
        await sendQuietly(replier, message, `处理失败：${error instanceof Error ? error.message : String(error)}`);
      }
    });
  };

  const dispatcher = new Lark.EventDispatcher({ loggerLevel }).register({
    'im.message.receive_v1': async (data) => {
      const message = data?.message;
      if (!message?.message_id) return;
      if (data?.sender?.sender_type && data.sender.sender_type !== 'user') return;
      if (!remember(message.message_id)) return;
      // 先返回 ACK，避免飞书 3 秒超时重推；实际处理放到后台。
      void handleMessage(data).catch((error) => {
        log('处理消息失败：', error instanceof Error ? error.message : String(error));
      });
    },
  });

  const wsClient = new Lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    domain,
    loggerLevel,
    handshakeTimeoutMs: 15_000,
    onReady: () => {
      log(`已连接飞书长连接；等待私聊或群内 @机器人 消息（超时 ${Math.round(config.timeoutMs / 60000)} 分钟）`);
    },
    onError: (error) => {
      log('飞书长连接失败：', error instanceof Error ? error.message : String(error));
    },
    onReconnecting: () => log('飞书长连接断开，正在重连'),
    onReconnected: () => log('飞书长连接已恢复'),
  });

  log('正在连接飞书长连接…');
  await wsClient.start({ eventDispatcher: dispatcher });

  const shutdown = async () => {
    log('正在退出');
    try { wsClient.close({ force: true }); } catch { /* 已关闭 */ }
    await actspan.close();
    process.exit(0);
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  start().catch((error) => {
    console.error(`[actspan-feishu] 启动失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
