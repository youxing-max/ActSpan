import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `
      export { executeDebugRemotePlan, registerBuiltinFunctionResolver } from './src/functions/remote-workflow.ts';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { executeDebugRemotePlan, registerBuiltinFunctionResolver } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

globalThis.chrome = {
  tabs: {
    sendMessage: async () => {},
    remove: async () => {},
  },
  runtime: { onMessage: { addListener() {}, removeListener() {} } },
};

const calls = [];
const makeTool = (name) => ({
  name,
  description: name,
  parameters: { type: 'object', properties: {} },
  supportsParallel: false,
  execute: async (params) => {
    calls.push({ name, params });
    return { success: true, data: { ran: name } };
  },
});
const builtins = new Map([
  ['cdp_input', makeTool('cdp_input')],
  ['page', makeTool('page')],
  ['tab_navigate', makeTool('tab_navigate')],
  ['extract_data', makeTool('extract_data')],
  ['screenshot', makeTool('screenshot')],
]);
registerBuiltinFunctionResolver((name) => builtins.get(name), () => [...builtins.keys()]);

const quietParams = { float_ball_execution_state: false };

const planWith = (steps) => ({ version: 1, closeOpenedTabs: 'never', steps });

// 自由化模式：写步骤不再审批，直接执行。
test('write step executes without approval', async () => {
  calls.length = 0;
  const result = await executeDebugRemotePlan('wf', planWith([
    { action: 'cdp_input', params: { action: 'click', selector: '#buy' }, note: '下单' },
  ]), quietParams, { tabId: 5 });

  assert.equal(result.success, true);
  assert.deepEqual(calls, [{ name: 'cdp_input', params: { action: 'click', selector: '#buy', tab_id: 5 } }]);
});

test('wait_for_element executes without approval', async () => {
  calls.length = 0;
  const result = await executeDebugRemotePlan('wf', planWith([
    { action: 'cdp_input', params: { action: 'wait_for_element', selector: '#menu' } },
  ]), quietParams, { tabId: 5 });

  assert.equal(result.success, true);
  assert.deepEqual(calls.map((c) => c.params.action), ['wait_for_element']);
});

test('sub-actions outside the plan whitelist are rejected before execution', async () => {
  for (const action of ['type', 'hover', 'scroll']) {
    calls.length = 0;
    const result = await executeDebugRemotePlan('wf', planWith([
      { action: 'cdp_input', params: { action, selector: '#target' } },
    ]), quietParams, { tabId: 5 });
    assert.equal(result.success, false, `${action} 不应被 plan 层放行`);
  }
});

test('non input actions run directly', async () => {
  calls.length = 0;
  const result = await executeDebugRemotePlan('wf', planWith([
    { action: 'page', params: { action: 'view' } },
    { action: 'screenshot', params: {} },
  ]), quietParams, { tabId: 5 });

  assert.equal(result.success, true);
  assert.deepEqual(calls.map((c) => c.name), ['page', 'screenshot']);
});
