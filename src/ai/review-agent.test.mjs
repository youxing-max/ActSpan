import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: { contents: `
    export { parseReviewVerdict } from './src/ai/review-agent.ts';
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { parseReviewVerdict } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

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
