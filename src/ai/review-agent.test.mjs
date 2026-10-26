import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: { contents: `
    export { parseReviewVerdict, runReviewAgent, buildReviewGoal } from './src/ai/review-agent.ts';
    export { createDeadlineSignal } from './src/ai/deadline.ts';
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { parseReviewVerdict, runReviewAgent, buildReviewGoal, createDeadlineSignal } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

test('stage review distinguishes delivered text, unsubmitted drafts, and pending work', () => {
  const goal = buildReviewGoal({
    taskGoal: 'Summarize and comment', phaseIndex: 0,
    completedSummaries: ['#1 Summary delivered'],
    todoSnapshot: { items: [{ id: 1, title: 'Summary', status: 'completed' }, { id: 2, title: 'Submit comment', status: 'pending' }], nextId: 3 },
    browserState: { tabs: [], activeTabId: 42, currentUrl: 'https://task.example/' },
    collectedData: {}, observations: [], warnings: [],
    recentMessages: [{ role: 'assistant', content: 'Delivered summary and comment draft: check signatures.' }],
  });
  assert.match(goal, /Delivered summary and comment draft/);
  assert.match(goal, /Submit comment/);
  assert.match(goal, /未完成.*不.*(?:失败|未通过)/);
  assert.match(goal, /草稿.*不.*(?:提交|完成)/);
});

test('parses the structured failed verdict and preserves review feedback', () => {
  const result = parseReviewVerdict([{ role: 'assistant', content: `### 审查结果：未通过\n\n### 发现的问题\n- 页面仍在加载` }]);
  assert.equal(result.passed, false);
  assert.match(result.feedback, /页面仍在加载/);
});

test('does not fail a passing verdict because its body mentions the rubric term', () => {
  const result = parseReviewVerdict([{
    role: 'assistant',
    content: `### 审查结果：通过\n\n### 检查详情\n审查结果中的“未通过”仅是输出格式说明，当前页面符合预期。`,
  }]);
  assert.equal(result.passed, true);
});

test('ignores unstructured mentions and keeps the fail-open default', () => {
  const result = parseReviewVerdict([{ role: 'assistant', content: '请检查是否出现未通过或其他问题。' }]);
  assert.equal(result.passed, true);
});

test('review shares the parent task deadline instead of starting a new task budget', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error('Expired review must not request a model');
  };
  const deadline = createDeadlineSignal(undefined, 0);
  try {
    await new Promise(resolve => setTimeout(resolve, 5));
    const events = [];
    await runReviewAgent({
      taskGoal: 'Check the result', phaseIndex: 0, completedSummaries: [],
      browserState: { tabs: [], activeTabId: 42, currentUrl: 'https://task.example/' },
      collectedData: {},
    }, [], 42, undefined, event => events.push(event), undefined, deadline);

    assert.equal(requests, 0);
    const error = events.find(event => event.type === 'error');
    assert.ok(error);
    assert.equal(JSON.parse(error.content).code, 'E_TIMEOUT');
  } finally {
    deadline.cleanup();
    globalThis.fetch = originalFetch;
  }
});
