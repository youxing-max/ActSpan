/**
 * 会话历史多轮提取测试
 * 覆盖：多轮 query/回复、失败轮次、旧记录兜底
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `
      export { extractSessionTurns, buildSessionHistoryRecord, mergeSessionTurns } from './src/background/session-history.ts';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { extractSessionTurns, buildSessionHistoryRecord, mergeSessionTurns } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`
);

const lifecycle = (status, extra = {}) => JSON.stringify({
  status,
  runId: 'run-1',
  endedAt: 2_000,
  durationMs: 1_000,
  ...extra,
});

test('extractSessionTurns 保留每一轮的用户输入和多轮回复', () => {
  const turns = extractSessionTurns([
    { type: 'turn_started', content: JSON.stringify({ query: '第一轮', runId: 'r1', startedAt: 100 }), timestamp: 100 },
    { type: 'text', content: '第一轮回复', timestamp: 200 },
    { type: 'turn_completed', content: lifecycle('done', { lastAgentMessage: '第一轮回复' }), timestamp: 300 },
    { type: 'turn_started', content: JSON.stringify({ query: '第二轮', runId: 'r2', startedAt: 400 }), timestamp: 400 },
    { type: 'text', content: '第二轮回复', timestamp: 500 },
    { type: 'turn_completed', content: lifecycle('done', { lastAgentMessage: '第二轮回复' }), timestamp: 600 },
  ]);

  assert.equal(turns.length, 2);
  assert.equal(turns[0].query, '第一轮');
  assert.equal(turns[0].reply, '第一轮回复');
  assert.equal(turns[0].status, 'done');
  assert.equal(turns[1].query, '第二轮');
  assert.equal(turns[1].reply, '第二轮回复');
});

test('extractSessionTurns 记录中断轮次的错误信息', () => {
  const turns = extractSessionTurns([
    { type: 'turn_started', content: JSON.stringify({ query: '执行任务', startedAt: 100 }), timestamp: 100 },
    { type: 'text', content: '执行中', timestamp: 200 },
    {
      type: 'turn_aborted',
      content: lifecycle('error', { reason: '会话已清除', failureCode: 'E_CANCELLED', abortReason: 'interrupted' }),
      timestamp: 300,
    },
  ]);

  assert.equal(turns.length, 1);
  assert.equal(turns[0].status, 'error');
  assert.equal(turns[0].error, '会话已清除');
  assert.equal(turns[0].failureCode, 'E_CANCELLED');
});

test('旧 eventLog 没有 turn_started 时用 summary/回复兜底', () => {
  const turns = extractSessionTurns(
    [{ type: 'text', content: '旧回复', timestamp: 100 }],
    { summary: '旧会话', startedAt: 50, reply: '旧回复' },
  );

  assert.equal(turns.length, 1);
  assert.equal(turns[0].query, '旧会话');
  assert.equal(turns[0].reply, '旧回复');
});

test('buildSessionHistoryRecord 同时输出多轮与最新回复', () => {
  const record = buildSessionHistoryRecord({
    id: 'session-1',
    status: 'done',
    context: [],
    eventLog: [
      { type: 'turn_started', content: JSON.stringify({ query: '查天气', startedAt: 100 }), timestamp: 100 },
      { type: 'text', content: '晴', timestamp: 200 },
      { type: 'turn_completed', content: lifecycle('done', { lastAgentMessage: '晴' }), timestamp: 300 },
      { type: 'turn_started', content: JSON.stringify({ query: '查温度', startedAt: 400 }), timestamp: 400 },
      { type: 'text', content: '25 度', timestamp: 500 },
      { type: 'turn_completed', content: lifecycle('done', { lastAgentMessage: '25 度' }), timestamp: 600 },
    ],
    createdAt: 50,
    startedAt: 100,
    endedAt: 700,
    durationMs: 600,
    summary: '查天气',
    agentState: { phase: 'finalize', round: 1, reason: '', updatedAt: 700 },
  });

  assert.equal(record.summary, '查天气');
  assert.equal(record.assistantReply, '25 度');
  assert.deepEqual(record.turns.map((turn) => turn.query), ['查天气', '查温度']);
  assert.deepEqual(record.turns.map((turn) => turn.reply), ['晴', '25 度']);
});

test('buildSessionHistoryRecord 保留用户中断的轮次（点停止后历史仍可查）', () => {
  const record = buildSessionHistoryRecord({
    id: 'session-abort',
    status: 'error',
    failureCode: 'E_CANCELLED',
    lastError: '任务已取消',
    context: [],
    eventLog: [
      { type: 'turn_started', content: JSON.stringify({ query: '整理这份报告', startedAt: 100 }), timestamp: 100 },
      { type: 'text', content: '正在读取页面…', timestamp: 200 },
      {
        type: 'turn_aborted',
        content: lifecycle('error', { reason: '任务已取消', failureCode: 'E_CANCELLED', abortReason: 'interrupted' }),
        timestamp: 300,
      },
    ],
    createdAt: 50,
    startedAt: 100,
    endedAt: 300,
    durationMs: 200,
    summary: '整理这份报告',
    agentState: { phase: 'finalize', round: 1, reason: '用户中断任务', updatedAt: 300 },
  });

  assert.equal(record.status, 'error');
  assert.equal(record.failureCode, 'E_CANCELLED');
  assert.equal(record.turns.length, 1);
  assert.equal(record.turns[0].query, '整理这份报告');
  assert.equal(record.turns[0].status, 'error');
});

test('mergeSessionTurns 合并旧记录，避免 eventLog 裁剪丢失早期轮次', () => {
  const previous = [
    { runId: 'r1', query: '第一轮', reply: '一', status: 'done', startedAt: 100 },
  ];
  const incoming = [
    { runId: 'r2', query: '第二轮', reply: '二', status: 'done', startedAt: 200 },
  ];

  const merged = mergeSessionTurns(previous, incoming);
  assert.deepEqual(merged.map((turn) => turn.query), ['第一轮', '第二轮']);
});

test('buildSessionHistoryRecord 优先使用运行期累积轮次（eventLog 已裁剪）', () => {
  const record = buildSessionHistoryRecord({
    id: 'session-2',
    status: 'done',
    context: [],
    // eventLog 只剩最后一轮，但 session.turns 保留了完整多轮
    eventLog: [
      { type: 'text', content: '第二轮回复', timestamp: 500 },
      { type: 'turn_completed', content: lifecycle('done', { lastAgentMessage: '第二轮回复' }), timestamp: 600 },
    ],
    turns: [
      { runId: 'r1', query: '第一轮', reply: '第一轮回复', status: 'done', startedAt: 100 },
      { runId: 'r2', query: '第二轮', reply: '第二轮回复', status: 'done', startedAt: 500 },
    ],
    createdAt: 50,
    startedAt: 100,
    endedAt: 700,
    durationMs: 600,
    summary: '第一轮',
    agentState: { phase: 'finalize', round: 1, reason: '', updatedAt: 700 },
  });

  assert.deepEqual(record.turns.map((turn) => turn.query), ['第一轮', '第二轮']);
});
