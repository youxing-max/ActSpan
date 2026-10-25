import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  normalizeDingTalkQuery,
  extractTaskText,
  splitReply,
  loadConfig,
  inferExtensionIds,
} from '../dingtalk-stream.js';

test('strips leading @mentions from DingTalk text', () => {
  assert.equal(normalizeDingTalkQuery('@ActSpan 打开 example.com'), '打开 example.com');
  assert.equal(normalizeDingTalkQuery('@机器人 @张三 汇总今天的新闻'), '汇总今天的新闻');
  assert.equal(normalizeDingTalkQuery('  普通消息  '), '普通消息');
  assert.equal(normalizeDingTalkQuery(''), '');
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'actspan-dingtalk-bridge-'));
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

test('reads DingTalk credentials from env before config file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actspan-dingtalk-test-'));
  const configPath = path.join(dir, 'dingtalk.json');
  fs.writeFileSync(configPath, JSON.stringify({ clientId: 'file-id', clientSecret: 'file-secret' }));

  try {
    const fromFile = loadConfig({}, { config: configPath });
    assert.equal(fromFile.clientId, 'file-id');
    assert.equal(fromFile.clientSecret, 'file-secret');

    const fromEnv = loadConfig(
      { DINGTALK_CLIENT_ID: 'env-id', DINGTALK_CLIENT_SECRET: 'env-secret' },
      { config: configPath },
    );
    assert.equal(fromEnv.clientId, 'env-id');
    assert.equal(fromEnv.clientSecret, 'env-secret');

    const withAllowlist = loadConfig(
      { DINGTALK_ALLOWED_USER_IDS: 'user-1, user-2 ,,' },
      { config: configPath },
    );
    assert.deepEqual(withAllowlist.allowedUserIds, ['user-1', 'user-2']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
