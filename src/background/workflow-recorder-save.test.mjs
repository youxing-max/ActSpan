import assert from 'node:assert/strict';
import { build } from 'esbuild';
import test from 'node:test';

const bundle = await build({
  stdin: {
    contents: `export { saveAuditedWorkflow } from './src/background/workflow-recorder-save.ts';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { saveAuditedWorkflow } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`
);

const workflow = {
  name: 'post_comment',
  label: '发表评论',
  description: '帮助用户向博客文章发表评论',
  triggers: ['发表评论', '给文章留言'],
  plan: { steps: [{ action: 'page', params: { action: 'view' } }] },
};

test('录制审计结果直接调用保存，不要求二次确认', async () => {
  const calls = [];
  const result = await saveAuditedWorkflow(workflow, async (params) => {
    calls.push(params);
    return { success: true, data: { name: 'user-post_comment' } };
  });

  assert.equal(result.success, true);
  assert.deepEqual(calls, [{ workflow_json: JSON.stringify(workflow), unique_name: true }]);
});

test('录制审计结果保存失败时返回明确错误', async () => {
  const result = await saveAuditedWorkflow(workflow, async () => ({
    success: false,
    error: 'workflow.plan.steps is invalid',
  }));

  assert.deepEqual(result, { success: false, error: 'workflow.plan.steps is invalid' });
});
