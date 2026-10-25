import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  stripFeishuMentions,
  normalizeFeishuQuery,
  isAskCommand,
  isHelpCommand,
  isBotMentioned,
  parseFeishuText,
  extractTaskText,
  splitReply,
  loadConfig,
  inferExtensionIds,
} from '../feishu-bot.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('strips Feishu mention placeholders and /ask prefixes', () => {
  assert.equal(stripFeishuMentions('@_user_1 打开 example.com'), '打开 example.com');
  assert.equal(stripFeishuMentions('@_user_1 @_user_2 汇总新闻'), '汇总新闻');
  assert.equal(normalizeFeishuQuery('@_user_1 /ask 打开 example.com'), '打开 example.com');
  assert.equal(normalizeFeishuQuery('/ask 查询 @_user_1 的结果'), '查询 的结果');
  assert.equal(normalizeFeishuQuery('  普通消息  '), '普通消息');
});

test('recognizes Feishu help and ask commands', () => {
  assert.equal(isHelpCommand('@_user_1 /help'), true);
  assert.equal(isHelpCommand('/start'), true);
  assert.equal(isHelpCommand('帮助'), true);
  assert.equal(isHelpCommand('帮我查一下'), false);
  assert.equal(isAskCommand('@_user_1 /ask 任务'), true);
  assert.equal(isAskCommand('/ask@ActSpan 任务'), true);
  assert.equal(isAskCommand('任务'), false);
});

test('matches the bot by open_id or app name and falls back to any mention', () => {
  const mentions = [
    { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'ActSpan' },
    { key: '@_user_2', id: { open_id: 'ou_other' }, name: 'Other' },
  ];
  assert.equal(isBotMentioned(mentions, 'ou_bot', 'ActSpan'), true);
  assert.equal(isBotMentioned(mentions, 'ou_unknown', 'ActSpan'), true);
  assert.equal(isBotMentioned(mentions, 'ou_unknown', 'Unknown'), false);
  assert.equal(isBotMentioned(mentions), true);
  assert.equal(isBotMentioned([], 'ou_bot', 'ActSpan'), false);
  assert.equal(isBotMentioned(undefined), false);
});

test('parses Feishu text content defensively', () => {
  assert.equal(parseFeishuText('{"text":"@_user_1 你好"}'), '@_user_1 你好');
  assert.equal(parseFeishuText('{"text":""}'), '');
  assert.equal(parseFeishuText('not json'), '');
  assert.equal(parseFeishuText(''), '');
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

test('splits long replies into bounded chunks and truncates extras', () => {
  const chunks = splitReply('a'.repeat(18_000));
  assert.equal(chunks.length, 5);
  assert.match(chunks[0], /^（1\/5）/);
  assert.match(chunks.at(-1), /已截断/);
  assert.ok(chunks.every((chunk) => chunk.length < 3_600));
  assert.deepEqual(splitReply('短消息'), ['短消息']);
});

test('reuses the running Bridge extension allowlist from metadata', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'actspan-feishu-bridge-'));
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

test('reads Feishu credentials from env before config file and supports Lark aliases', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actspan-feishu-test-'));
  const configPath = path.join(dir, 'feishu.json');
  fs.writeFileSync(configPath, JSON.stringify({
    appId: 'cli_aaaaaaaaaaaaaaaa',
    appSecret: 'file-secret',
    domain: 'lark',
  }));

  try {
    const fromFile = loadConfig({}, { config: configPath });
    assert.equal(fromFile.appId, 'cli_aaaaaaaaaaaaaaaa');
    assert.equal(fromFile.appSecret, 'file-secret');
    assert.equal(fromFile.domain, 'lark');
    assert.equal(fromFile.timeoutMs, 900_000);

    const fromEnv = loadConfig(
      {
        LARK_APP_ID: 'cli_bbbbbbbbbbbbbbbb',
        LARK_APP_SECRET: 'env-secret',
        ACTSPAN_FEISHU_TIMEOUT_MS: '60000',
        FEISHU_ALLOWED_OPEN_IDS: 'ou_1, ou_2 ,,',
      },
      { config: configPath },
    );
    assert.equal(fromEnv.appId, 'cli_bbbbbbbbbbbbbbbb');
    assert.equal(fromEnv.appSecret, 'env-secret');
    assert.equal(fromEnv.timeoutMs, 60_000);
    assert.deepEqual(fromEnv.allowedOpenIds, ['ou_1', 'ou_2']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fails fast without credentials and validates the app id format', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actspan-feishu-cli-'));
  const configPath = path.join(dir, 'missing.json');
  const baseEnv = {
    ...process.env,
    FEISHU_CONFIG: configPath,
    FEISHU_APP_ID: '',
    FEISHU_APP_SECRET: '',
    LARK_APP_ID: '',
    LARK_APP_SECRET: '',
  };

  try {
    const missing = spawnSync(process.execPath, [path.join(HERE, '..', 'feishu-bot.js')], {
      env: baseEnv,
      encoding: 'utf8',
    });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /缺少 FEISHU_APP_ID/);

    const invalid = spawnSync(process.execPath, [path.join(HERE, '..', 'feishu-bot.js')], {
      env: { ...baseEnv, FEISHU_APP_ID: 'not-an-app-id', FEISHU_APP_SECRET: 'secret' },
      encoding: 'utf8',
    });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /FEISHU_APP_ID 格式不正确/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
