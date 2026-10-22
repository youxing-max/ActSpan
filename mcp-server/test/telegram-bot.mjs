import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  normalizeTelegramQuery,
  isHelpCommand,
  isAskCommand,
  isBotAddressed,
  extractTaskText,
  splitReply,
  loadConfig,
  inferExtensionIds,
} from '../telegram-bot.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const withTimeout = (promise, timeoutMs, label) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 超时`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
};

test('strips Telegram command prefixes and bot mentions', () => {
  assert.equal(normalizeTelegramQuery('/ask@ActBot 打开 example.com', 'ActBot'), '打开 example.com');
  assert.equal(normalizeTelegramQuery('@ActBot 汇总今天的新闻', 'ActBot'), '汇总今天的新闻');
  assert.equal(normalizeTelegramQuery('/ask 查询 @ActBot 的结果', 'ActBot'), '查询 的结果');
  assert.equal(normalizeTelegramQuery('  普通消息  '), '普通消息');
  assert.equal(normalizeTelegramQuery('', 'ActBot'), '');
});

test('recognizes commands addressed to this bot', () => {
  assert.equal(isHelpCommand('/start', 'ActBot'), true);
  assert.equal(isHelpCommand('/help@ActBot', 'ActBot'), true);
  assert.equal(isHelpCommand('/help@OtherBot', 'ActBot'), false);
  assert.equal(isAskCommand('/ask@ActBot 任务', 'ActBot'), true);
  assert.equal(isAskCommand('/ask@OtherBot 任务', 'ActBot'), false);
});

test('only responds to private chats, mentions, replies, or /ask in groups', () => {
  const bot = 'ActBot';
  assert.equal(isBotAddressed({ chat: { type: 'private' }, text: '你好' }, bot), true);
  assert.equal(isBotAddressed({ chat: { type: 'group' }, text: '@ActBot 你好' }, bot), true);
  assert.equal(isBotAddressed({ chat: { type: 'group' }, text: '你好 @ActBot' }, bot), true);
  assert.equal(isBotAddressed({ chat: { type: 'group' }, text: '@ActBot，你好' }, bot), true);
  assert.equal(isBotAddressed({ chat: { type: 'group' }, text: '/ask@ActBot 你好' }, bot), true);
  assert.equal(isBotAddressed({ chat: { type: 'group' }, text: '你好' }, bot), false);
  assert.equal(isBotAddressed({
    chat: { type: 'group' },
    text: '继续',
    reply_to_message: { from: { username: 'ActBot' } },
  }, bot), true);
});

test('extracts assistant text from task result shapes', () => {
  assert.equal(extractTaskText({ result: '纯文本结果' }), '纯文本结果');
  assert.equal(extractTaskText({ result: { content: '助手回答' } }), '助手回答');
  assert.equal(extractTaskText({
    result: { content: [{ text: '第一段' }, { text: '第二段' }] },
  }), '第一段\n第二段');
  assert.match(extractTaskText({ error: { message: '浏览器未连接' } }), /浏览器未连接/);
  assert.equal(extractTaskText({}), '任务已结束，但没有返回文本结果。');
});

test('splits long replies into Telegram-sized chunks and truncates extras', () => {
  const chunks = splitReply('a'.repeat(20_000));
  assert.equal(chunks.length, 5);
  assert.match(chunks[0], /^（1\/5）/);
  assert.match(chunks.at(-1), /已截断/);
  assert.ok(chunks.every((chunk) => chunk.length < 3_900));
  assert.deepEqual(splitReply('短消息'), ['短消息']);
});

test('reuses the running Bridge extension allowlist from metadata', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'actspan-telegram-bridge-'));
  const dir = path.join(home, '.actspan');
  fs.mkdirSync(dir, { recursive: true });
  const extensionId = 'kcmnglipboiheaicckjcinkdmpgjcgog';
  fs.writeFileSync(path.join(dir, 'bridge-30121.json'), JSON.stringify({
    origins: [`chrome-extension://${extensionId}`],
  }));

  try {
    assert.equal(inferExtensionIds({}, home), extensionId);
    assert.equal(
      inferExtensionIds({ ACTSPAN_EXTENSION_IDS: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, home),
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    assert.equal(inferExtensionIds({ ACTSPAN_BRIDGE_URL: 'ws://127.0.0.1:39999' }, home), '');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('reads Telegram credentials from env before config file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actspan-telegram-test-'));
  const configPath = path.join(dir, 'telegram.json');
  fs.writeFileSync(configPath, JSON.stringify({ botToken: 'file-token' }));

  try {
    const fromFile = loadConfig({}, { config: configPath });
    assert.equal(fromFile.botToken, 'file-token');
    assert.equal(fromFile.apiBase, 'https://api.telegram.org');
    assert.equal(fromFile.timeoutMs, 900_000);

    const fromEnv = loadConfig(
      {
        TELEGRAM_BOT_TOKEN: 'env-token',
        TELEGRAM_API_BASE: 'https://tg.example.com/',
        ACTSPAN_TELEGRAM_TIMEOUT_MS: '60000',
        TELEGRAM_ALLOWED_USER_IDS: '10001, 10002 ,,',
      },
      { config: configPath },
    );
    assert.equal(fromEnv.botToken, 'env-token');
    assert.equal(fromEnv.apiBase, 'https://tg.example.com');
    assert.equal(fromEnv.timeoutMs, 60_000);
    assert.deepEqual(fromEnv.allowedUserIds, ['10001', '10002']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('polls a Telegram-compatible API and replies without leaking the token', { timeout: 15_000 }, async () => {
  const token = '123456:TEST-TOKEN';
  const botUsername = 'ActSpanTestBot';
  let updateSent = false;
  let resolveReply;
  const replyReceived = new Promise((resolve) => { resolveReply = resolve; });
  const methods = [];

  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const method = new URL(request.url, 'http://127.0.0.1').pathname.split('/').pop();
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* 空请求体 */ }
      methods.push(method);
      const send = (payload) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(payload));
      };

      if (method === 'getMe') {
        send({ ok: true, result: { id: 1, is_bot: true, first_name: 'Test', username: botUsername } });
      } else if (method === 'getWebhookInfo') {
        send({ ok: true, result: { url: '' } });
      } else if (method === 'getUpdates') {
        if (body.offset === -1) {
          send({ ok: true, result: [] });
        } else if (!updateSent) {
          updateSent = true;
          send({
            ok: true,
            result: [{
              update_id: 100,
              message: {
                message_id: 10,
                date: Math.floor(Date.now() / 1000),
                chat: { id: 42, type: 'private' },
                from: { id: 42, is_bot: false, first_name: 'Tester', username: 'tester' },
                text: '/help',
                entities: [{ type: 'bot_command', offset: 0, length: 5 }],
              },
            }],
          });
        } else {
          setTimeout(() => send({ ok: true, result: [] }), 100);
        }
      } else if (method === 'sendMessage') {
        resolveReply(body.text);
        send({ ok: true, result: { message_id: 11 } });
      } else {
        send({ ok: false, description: 'unsupported method' });
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actspan-telegram-live-'));
  const child = spawn(process.execPath, [path.join(HERE, '..', 'telegram-bot.js')], {
    cwd: path.join(HERE, '..'),
    env: {
      ...process.env,
      TELEGRAM_BOT_TOKEN: token,
      TELEGRAM_API_BASE: `http://127.0.0.1:${port}`,
      TELEGRAM_CONFIG: path.join(tempDir, 'missing.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });

  try {
    const reply = await withTimeout(replyReceived, 8_000, '等待 Telegram 回复');
    assert.match(reply, /用法/);
    assert.match(reply, /@ActSpan/);
    assert.deepEqual(methods.slice(0, 3), ['getMe', 'getWebhookInfo', 'getUpdates']);
    assert.equal(output.includes(token), false);
  } finally {
    child.kill('SIGTERM');
    await withTimeout(new Promise((resolve) => child.once('exit', resolve)), 5_000, '等待连接器退出');
    server.closeAllConnections();
    server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
