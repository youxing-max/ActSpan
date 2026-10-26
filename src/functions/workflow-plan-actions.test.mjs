import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const bundle = await build({
  stdin: {
    contents: `
      export { getWorkflowPlanForExecution } from './src/background/mcp-bridge.ts';
      export { resolveWorkflowPlanAction, isWorkflowPlanSubActionAllowed } from './src/functions/remote-workflow.ts';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { getWorkflowPlanForExecution, resolveWorkflowPlanAction, isWorkflowPlanSubActionAllowed } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

const planWith = (action, params) => ({ plan: { steps: [{ action, params }] } });

test('every bundled workflow uses supported plan actions and sub-actions', () => {
  const manifest = JSON.parse(readFileSync('public/skills/domains/manifest.json', 'utf8'));
  for (const skill of manifest.skills) {
    for (const workflow of skill.workflows || []) {
      if (!workflow.plan) continue;
      assert.doesNotThrow(() => getWorkflowPlanForExecution(workflow), workflow.name);
    }
  }
});

test('bundled search workflows extract their documented fields with a result limit', () => {
  const manifest = JSON.parse(readFileSync('public/skills/domains/manifest.json', 'utf8'));
  for (const [name, fields] of [['jd', ['name', 'price', 'link']], ['baidu', ['title', 'snippet', 'link']]]) {
    const workflow = manifest.skills.find((skill) => skill.name === name).workflows[0];
    const step = getWorkflowPlanForExecution(workflow).steps.at(-1);
    assert.equal(step.action, 'extract_data');
    assert.equal(step.params.mode, 'schema');
    assert.equal(step.params.max_items, '{{max_results}}');
    assert.deepEqual(step.params.schema.fields.map((field) => field.name), fields);
    assert.equal(step.params.schema.fields.find((field) => field.name === 'link').attribute, 'href');
  }
});

test('cdp_input click passes plan validation', () => {
  const plan = getWorkflowPlanForExecution(planWith('cdp_input', { action: 'click', selector: '#target' }));
  assert.equal(plan.steps[0].action, 'cdp_input');
  assert.equal(plan.steps[0].params.action, 'click');
});

test('cdp_input fill passes plan validation', () => {
  const plan = getWorkflowPlanForExecution(planWith('cdp_input', { action: 'fill', selector: '#email', value: 'a@b.test' }));
  assert.equal(plan.steps[0].params.action, 'fill');
});

test('cdp_input rejects drag as an unsupported sub-action', () => {
  assert.throws(
    () => getWorkflowPlanForExecution(planWith('cdp_input', { action: 'drag', selector: '#target' })),
    /不支持的工作流步骤: cdp_input\.drag/,
  );
  assert.equal(isWorkflowPlanSubActionAllowed('cdp_input', 'drag'), false);
});

test('cdp_input rejects get_info as an unsupported sub-action', () => {
  assert.throws(
    () => getWorkflowPlanForExecution(planWith('cdp_input', { action: 'get_info', selector: '#target' })),
    /不支持的工作流步骤: cdp_input\.get_info/,
  );
  assert.equal(isWorkflowPlanSubActionAllowed('cdp_input', 'get_info'), false);
});

test('page view still passes while page eval is still rejected', () => {
  const plan = getWorkflowPlanForExecution(planWith('page', { action: 'view' }));
  assert.equal(plan.steps[0].action, 'page');
  assert.throws(
    () => getWorkflowPlanForExecution(planWith('page', { action: 'eval', expression: 'document.title' })),
    /不支持的工作流步骤: page\.eval/,
  );
});

test('tab_navigate and screenshot keep their existing plan behavior', () => {
  assert.equal(resolveWorkflowPlanAction('tab_navigate')?.name, 'tab_navigate');
  assert.equal(isWorkflowPlanSubActionAllowed('tab_navigate', 'open'), true);
  assert.equal(isWorkflowPlanSubActionAllowed('tab_navigate', 'anything_not_restricted'), false);
  assert.equal(isWorkflowPlanSubActionAllowed('tab_navigate', 'switch'), false);
  assert.equal(resolveWorkflowPlanAction('screenshot')?.name, 'screenshot');
  assert.equal(isWorkflowPlanSubActionAllowed('screenshot', 'capture'), true);
  assert.throws(
    () => getWorkflowPlanForExecution(planWith('not_a_real_action', {})),
    /不支持的工作流步骤: not_a_real_action/,
  );
});
