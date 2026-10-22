import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `
      export { executeDebugRemotePlan, registerBuiltinFunctionResolver } from './src/functions/remote-workflow.ts';
      export { requestConfirmationFunction } from './src/functions/request-confirmation.ts';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { executeDebugRemotePlan, registerBuiltinFunctionResolver, requestConfirmationFunction } =
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

const withConfirmation = async (response, fn) => {
  const prompts = [];
  const prior = requestConfirmationFunction.execute;
  requestConfirmationFunction.execute = async (params, context) => {
    prompts.push({ params, context });
    return response;
  };
  calls.length = 0;
  try {
    const result = await fn();
    return { result, prompts };
  } finally {
    requestConfirmationFunction.execute = prior;
  }
};

const planWith = (steps) => ({ version: 1, closeOpenedTabs: 'never', steps });

test('rejected approval blocks the step with no side effect', async () => {
  const { result, prompts } = await withConfirmation({ success: true, data: { approved: false } }, () =>
    executeDebugRemotePlan('wf', planWith([
      { action: 'cdp_input', params: { action: 'click', selector: '#buy' }, note: '下单' },
    ]), quietParams, { tabId: 5 }));

  assert.equal(result.success, false);
  assert.match(result.error, /用户未批准工作流步骤/);
  assert.equal(calls.length, 0);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].params.message, /click/);
  assert.match(prompts[0].params.message, /#buy/);
  assert.match(prompts[0].params.message, /下单/);
  assert.equal(prompts[0].context.tabId, 5);
});

test('failed confirmation response also blocks the step', async () => {
  const { result } = await withConfirmation({ success: false, error: 'E_TIMEOUT' }, () =>
    executeDebugRemotePlan('wf', planWith([
      { action: 'cdp_input', params: { action: 'fill', selector: '#email', value: 'a@b.test' } },
    ]), quietParams, { tabId: 5 }));

  assert.equal(result.success, false);
  assert.match(result.error, /用户未批准工作流步骤/);
  assert.equal(calls.length, 0);
});

test('rejection is not retried even when the step declares retries', async () => {
  const { result, prompts } = await withConfirmation({ success: true, data: { approved: false } }, () =>
    executeDebugRemotePlan('wf', planWith([
      { action: 'cdp_input', params: { action: 'click', selector: '#buy' }, retry: { maxAttempts: 3 } },
    ]), quietParams, { tabId: 5 }));

  assert.equal(result.success, false);
  assert.equal(prompts.length, 1);
  assert.equal(calls.length, 0);
});

test('approved step executes normally', async () => {
  const { result, prompts } = await withConfirmation({ success: true, data: { approved: true } }, () =>
    executeDebugRemotePlan('wf', planWith([
      { action: 'cdp_input', params: { action: 'fill', selector: '#q', value: 'hello' } },
    ]), quietParams, { tabId: 5 }));

  assert.equal(result.success, true);
  assert.equal(prompts.length, 1);
  assert.deepEqual(calls, [{ name: 'cdp_input', params: { action: 'fill', selector: '#q', value: 'hello', tab_id: 5 } }]);
});

test('wait_for_element needs no approval', async () => {
  const { result, prompts } = await withConfirmation({ success: true, data: { approved: false } }, () =>
    executeDebugRemotePlan('wf', planWith([
      { action: 'cdp_input', params: { action: 'wait_for_element', selector: '#menu' } },
    ]), quietParams, { tabId: 5 }));

  assert.equal(result.success, true);
  assert.equal(prompts.length, 0);
  assert.deepEqual(calls.map((c) => c.params.action), ['wait_for_element']);
});

test('sub-actions outside the plan whitelist are rejected before execution', async () => {
  for (const action of ['type', 'hover', 'scroll']) {
    const { result } = await withConfirmation({ success: true, data: { approved: true } }, () =>
      executeDebugRemotePlan('wf', planWith([
        { action: 'cdp_input', params: { action, selector: '#target' } },
      ]), quietParams, { tabId: 5 }));
    assert.equal(result.success, false, `${action} 不应被 plan 层放行`);
  }
});

test('non input actions are never gated', async () => {
  const { result, prompts } = await withConfirmation({ success: true, data: { approved: false } }, () =>
    executeDebugRemotePlan('wf', planWith([
      { action: 'page', params: { action: 'view' } },
      { action: 'screenshot', params: {} },
    ]), quietParams, { tabId: 5 }));

  assert.equal(result.success, true);
  assert.equal(prompts.length, 0);
  assert.deepEqual(calls.map((c) => c.name), ['page', 'screenshot']);
});
