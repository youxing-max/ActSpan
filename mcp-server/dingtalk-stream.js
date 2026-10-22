#!/usr/bin/env node
/**
 * 钉钉 Stream 模式机器人连接器
 *
 * 接收群里 @机器人 的文本消息，提交给 ActSpan 的 MCP 服务执行，
 * 再把最终结果回复到同一个会话。Stream 模式不需要公网回调地址。
 *
 * 环境变量：
 *   DINGTALK_CLIENT_ID       企业内部应用 ClientID（AppKey）
 *   DINGTALK_CLIENT_SECRET   企业内部应用 ClientSecret（AppSecret）
 *   ACTSPAN_DINGTALK_TIMEOUT_MS  单任务最长等待时间，默认 15 分钟
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const POLL_INTERVAL_MS = 2_000;
const MAX_REPLY_CHARS = 3_500;
const MAX_REPLY_CHUNKS = 5;
const SEEN_MESSAGE_TTL_MS = 5 * 60 * 1000;

const log = (...args) => {
  console.log(`[actspan-dingtalk] ${new Date().toISOString()}`, ...args);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 去掉消息开头的 @机器人，保留正文。 */
export const normalizeDingTalkQuery = (content) =>
  String(content || '')
    .replace(/^(?:\s*@[^\s@]+)+\s*/, '')
    .trim();

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

/** 按字符数拆分长回复，避免超出钉钉单条消息限制。 */
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

const usage = () => `
ActSpan 钉钉机器人

用法：
  actspan-dingtalk [--config <path>] [--debug]

配置（优先环境变量）：
  DINGTALK_CLIENT_ID       企业内部应用 ClientID（AppKey）
  DINGTALK_CLIENT_SECRET   企业内部应用 ClientSecret（AppSecret）
  ACTSPAN_DINGTALK_TIMEOUT_MS  单任务最长等待时间，默认 900000ms
  DINGTALK_ALLOWED_USER_IDS    可选，逗号分隔的 senderStaffId 白名单

也可以写入 ~/.actspan/dingtalk.json：
  { "clientId": "...", "clientSecret": "..." }
`.trim();

const parseArgs = (argv) => {
  const options = { debug: false, config: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--debug') options.debug = true;
    else if (arg === '--config') options.config = argv[++i] || '';
    else throw new Error(`未知参数：${arg}`);
  }
  return options;
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

/** 凭据只从环境变量或用户目录配置文件读取，不接受命令行明文。 */
export const loadConfig = (env = process.env, options = {}) => {
  const file = options.config || env.DINGTALK_CONFIG || path.join(os.homedir(), '.actspan', 'dingtalk.json');
  const stored = readConfigFile(file);
  const clientId = env.DINGTALK_CLIENT_ID || stored.clientId || '';
  const clientSecret = env.DINGTALK_CLIENT_SECRET || stored.clientSecret || '';
  const timeout = Number(env.ACTSPAN_DINGTALK_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const allowedUserIds = String(env.DINGTALK_ALLOWED_USER_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    clientId: String(clientId).trim(),
    clientSecret: String(clientSecret).trim(),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
    allowedUserIds,
    debug: Boolean(options.debug || env.DINGTALK_DEBUG === '1'),
  };
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

/** 管理一个本机 MCP 子进程，断线时按需重建。 */
class ActspanSession {
  constructor() {
    this.client = null;
    this.connecting = null;
  }

  async connect() {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(HERE, 'index.js'), '--client', 'dingtalk-stream'],
        env: { ...process.env },
        cwd: HERE,
        stderr: 'inherit',
      });
      const client = new Client(
        { name: 'actspan-dingtalk', version: '1.0.0' },
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
      // MCP 子进程可能因扩展重载或桥接重启而退出，重建一次再重试。
      await this.close();
      const retryClient = await this.connect();
      return await retryClient.callTool({ name, arguments: args });
    }
  }

  async submit(query) {
    // 提交任务不做自动重试，避免超时后重复创建浏览器任务。
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
      if (status.state === 'failed' || status.state === 'cancelled') {
        return status;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`等待任务超时（${Math.round(timeoutMs / 1000)} 秒）`);
  }
}

class DingTalkReplier {
  constructor(dwClient) {
    this.dwClient = dwClient;
    this.token = '';
    this.tokenExpiresAt = 0;
  }

  async accessToken() {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const token = await this.dwClient.getAccessToken();
    if (!token) throw new Error('获取钉钉 access_token 失败');
    this.token = token;
    this.tokenExpiresAt = Date.now() + 60 * 60 * 1000;
    return token;
  }

  async send(message, content) {
    if (!message.sessionWebhook) throw new Error('消息缺少 sessionWebhook，无法回复');
    const chunks = splitReply(content);
    for (let index = 0; index < chunks.length; index += 1) {
      const headers = { 'Content-Type': 'application/json' };
      try {
        headers['x-acs-dingtalk-access-token'] = await this.accessToken();
      } catch {
        // 部分会话 Webhook 不校验 access token；取不到时仍尝试发送。
        log('获取 access_token 失败，尝试直接发送会话消息');
      }
      const response = await fetch(message.sessionWebhook, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          msgtype: 'text',
          text: { content: chunks[index] },
          ...(index === 0 && message.senderStaffId
            ? { at: { atUserIds: [message.senderStaffId], isAtAll: false } }
            : {}),
        }),
      });
      if (!response.ok) throw new Error(`钉钉回复失败：HTTP ${response.status}`);
      let payload = null;
      try { payload = await response.json(); } catch { /* 某些会话 Webhook 返回空响应 */ }
      if (payload && payload.errcode !== undefined && Number(payload.errcode) !== 0) {
        throw new Error(`钉钉回复失败：${payload.errmsg || payload.message || `errcode ${payload.errcode}`}`);
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
  const expiresIn = Number(message.sessionWebhookExpiredTime) - Date.now();
  const effectiveTimeout = Number.isFinite(expiresIn)
    ? Math.min(timeoutMs, expiresIn - 10_000)
    : timeoutMs;
  if (effectiveTimeout <= 0) throw new Error('会话回复地址已过期，请重新 @机器人');

  log(`收到任务：${query.slice(0, 120)}`);
  const handle = await actspan.submit(query);
  const result = await actspan.waitForCompletion(handle.taskId, effectiveTimeout);
  const text = extractTaskText(result);
  await replier.send(message, `ActSpan 执行完成\n\n${text}`);
};

const start = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const config = loadConfig(process.env, options);
  if (!config.clientId || !config.clientSecret) {
    console.error('缺少 DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET。\n');
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  const dwClient = new DWClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    keepAlive: true,
    debug: config.debug,
  });
  const replier = new DingTalkReplier(dwClient);
  const actspan = new ActspanSession();
  const seen = new Map();
  const conversationQueues = new Map();

  const remember = (messageId) => {
    const now = Date.now();
    for (const [id, timestamp] of seen) {
      if (now - timestamp > SEEN_MESSAGE_TTL_MS) seen.delete(id);
    }
    if (seen.has(messageId)) return false;
    seen.set(messageId, now);
    return true;
  };

  const enqueue = (conversationId, job) => {
    const previous = conversationQueues.get(conversationId) || Promise.resolve();
    const next = previous.catch(() => undefined).then(job);
    conversationQueues.set(conversationId, next);
    void next.finally(() => {
      if (conversationQueues.get(conversationId) === next) conversationQueues.delete(conversationId);
    });
    return next;
  };

  dwClient.registerCallbackListener(TOPIC_ROBOT, (upstream) => {
    const messageId = upstream.headers?.messageId;
    // 先 ACK，避免钉钉在任务执行期间重投同一条消息。
    if (messageId) dwClient.socketCallBackResponse(messageId, { status: 'SUCCESS' });
    if (messageId && !remember(messageId)) return;

    let message;
    try { message = JSON.parse(upstream.data); } catch {
      log('收到无法解析的机器人消息');
      return;
    }

    if (message.conversationType === '2' && message.isInAtList === false) return;

    if (config.allowedUserIds.length && !config.allowedUserIds.includes(message.senderStaffId)) {
      log(`拒绝未授权用户：${message.senderStaffId || message.senderId || 'unknown'}`);
      void sendQuietly(replier, message, '你不在这个机器人的允许使用名单中。');
      return;
    }

    if (message.msgtype !== 'text') {
      void sendQuietly(replier, message, '目前只支持文本消息，请直接 @我 并输入任务描述。');
      return;
    }

    const query = normalizeDingTalkQuery(message.text?.content);
    if (!query) {
      void sendQuietly(replier, message, '请 @我 并输入要执行的任务，例如：@ActSpan 打开 example.com 并读取标题');
      return;
    }
    if (/^(\/help|help|帮助)$/i.test(query)) {
      void sendQuietly(replier, message, '用法：@我 + 任务描述。例如：@ActSpan 打开 GitHub 搜索 ActSpan，把第一条结果发给我。');
      return;
    }

    // 先确认收到，再进入队列；同一会话内按顺序执行任务。
    void sendQuietly(replier, message, `收到，正在让 ActSpan 处理：\n${query}\n\n任务结束后我会把结果发到这里。`);
    void enqueue(message.conversationId || message.senderId || 'unknown', async () => {
      try {
        await runTask({ message, query, replier, actspan, timeoutMs: config.timeoutMs });
      } catch (error) {
        log('处理消息失败：', error instanceof Error ? error.message : String(error));
        await sendQuietly(replier, message, `处理失败：${error instanceof Error ? error.message : String(error)}`);
      }
    });
  });

  await dwClient.connect();
  const readyDeadline = Date.now() + 10_000;
  while (!dwClient.registered && Date.now() < readyDeadline) await sleep(200);
  if (dwClient.registered) {
    log(`已连接钉钉 Stream；等待群内 @机器人 消息（超时 ${Math.round(config.timeoutMs / 60000)} 分钟）`);
  } else {
    log('尚未完成 Stream 注册；SDK 会继续重试，请检查应用是否已发布并选择 Stream 模式');
  }

  const shutdown = async () => {
    log('正在退出');
    try { dwClient.disconnect(); } catch { /* 已断开 */ }
    await actspan.close();
    process.exit(0);
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  start().catch((error) => {
    console.error(`[actspan-dingtalk] 启动失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
