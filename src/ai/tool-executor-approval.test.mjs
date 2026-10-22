import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

// 验证模型工具调用路径上的 cdp_input 审批：sensitive 动作必须先确认，拒绝后不得产生任何 CDP 事件。
// 用假 registry / 假 request_confirmation / 假 CDP 会话，cdp_input 本体保持真实实现。

const FAKE_REGISTRY_SRC = `
import { cdpInputFunction } from './src/functions/cdp-input.ts';
export const getBuiltinFunction = (name) => (name === 'cdp_input' ? cdpInputFunction : undefined);
export const getRegisteredFunction = getBuiltinFunction;
export const mcpClient = {
  isParallel: () => false,
  callTool: async (name, params, context) => {
    const result = await cdpInputFunction.execute(params, context);
    return { content: [{ text: JSON.stringify(result) }] };
  },
};
`;

const FAKE_CONFIRM_SRC = `
export const requestConfirmationFunction = {
  execute: async ({ message }) => {
    globalThis.__approvalPrompts.push(message);
    return { success: true, data: globalThis.__approvalDecision };
  },
};
`;

const FAKE_CDP_SRC = `
export const CDPSessionManager = {
  isSupported: () => true,
  attach: async () => ({ success: true }),
  sendCommand: async (tabId, method, params) => {
    globalThis.__cdpEvents.push({ tabId, method, params });
    return { success: true, result: {} };
  },
};
`;

const plugin = {
  name: 'approval-fakes',
  setup(b) {
    b.onResolve({ filter: /functions\/registry$/ }, () => ({ path: 'fake-registry', namespace: 'fake' }));
    b.onResolve({ filter: /functions\/request-confirmation$/ }, () => ({ path: 'fake-confirm', namespace: 'fake' }));
    b.onResolve({ filter: /lib\/cdp-session$/ }, () => ({ path: 'fake-cdp', namespace: 'fake' }));
    b.onLoad({ filter: /^fake-registry$/, namespace: 'fake' },
      () => ({ contents: FAKE_REGISTRY_SRC, loader: 'js', resolveDir: process.cwd() }));
    b.onLoad({ filter: /^fake-confirm$/, namespace: 'fake' }, () => ({ contents: FAKE_CONFIRM_SRC, loader: 'js' }));
    b.onLoad({ filter: /^fake-cdp$/, namespace: 'fake' }, () => ({ contents: FAKE_CDP_SRC, loader: 'js' }));
  },
};

const out = await build({
  stdin: {
    contents: `export { executeToolCalls, resetSensitiveAccessTrust } from './src/ai/tool-executor.ts';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  plugins: [plugin],
});
const { executeToolCalls, resetSensitiveAccessTrust } = await import(
  `data:text/javascript;base64,${Buffer.from(out.outputFiles[0].contents).toString('base64')}`
);

/** 跑一次 cdp_input 工具调用，返回审批提示、CDP 事件与工具输出 */
const callTool = async (params, decision = { approved: false }) => {
  resetSensitiveAccessTrust();
  globalThis.__approvalPrompts = [];
  globalThis.__cdpEvents = [];
  globalThis.__approvalDecision = decision;
  const results = await executeToolCalls(
    [{ type: 'function_call', id: 'call-1', call_id: 'call-1', name: 'cdp_input', arguments: JSON.stringify({ tab_id: 5, ...params }) }],
    5,
    undefined,
    () => {},
    undefined,
    { sessionId: 'test-session' },
  );
  return {
    prompts: globalThis.__approvalPrompts,
    cdp: globalThis.__cdpEvents,
    output: JSON.parse(results[0].output),
  };
};

for (const action of ['click', 'type', 'fill', 'clear', 'select', 'key_press', 'click_text', 'double_click']) {
  test(`${action} is refused without any page effect when the user denies`, async () => {
    const { prompts, cdp, output } = await callTool({ action, x: 10, y: 20, text: 'hi', value: 'v', key: 'Enter' });
    assert.equal(prompts.length, 1, `${action} 必须先请求确认`);
    assert.match(prompts[0], /cdp_input/);
    assert.equal(cdp.length, 0, `${action} 被拒绝后不得发送任何 CDP 事件`);
    assert.equal(output.success, false);
  });
}

test('click runs the real CDP mouse sequence once approved', async () => {
  const { prompts, cdp, output } = await callTool({ action: 'click', x: 10, y: 20 }, { approved: true });
  assert.equal(prompts.length, 1);
  assert.equal(output.success, true);
  assert.deepEqual(cdp.map((e) => e.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
});

test('hover runs without asking for approval', async () => {
  const { prompts, cdp, output } = await callTool({ action: 'hover', x: 10, y: 20 });
  assert.deepEqual(prompts, []);
  assert.equal(output.success, true);
  assert.ok(cdp.length > 0, 'hover 应直接发送 CDP 事件');
});

test('"do not ask again this session" still covers later sensitive actions', async () => {
  resetSensitiveAccessTrust();
  const first = await callTool({ action: 'click', x: 10, y: 20 }, { approved: true, trustAll: true });
  assert.equal(first.prompts.length, 1);
  globalThis.__approvalPrompts = [];
  const second = await executeToolCalls(
    [{ type: 'function_call', id: 'call-2', call_id: 'call-2', name: 'cdp_input', arguments: JSON.stringify({ action: 'fill', tab_id: 5, selector: '#a', value: 'x' }) }],
    5,
    undefined,
    () => {},
    undefined,
    { sessionId: 'test-session' },
  );
  assert.deepEqual(globalThis.__approvalPrompts, [], '同一 session 信任后不再询问');
  assert.ok(second.length === 1);
});

test('trust is scoped per session and does not leak across sessions', async () => {
  resetSensitiveAccessTrust();
  await callTool({ action: 'click', x: 10, y: 20 }, { approved: true, trustAll: true });
  globalThis.__approvalPrompts = [];
  await executeToolCalls(
    [{ type: 'function_call', id: 'call-3', call_id: 'call-3', name: 'cdp_input', arguments: JSON.stringify({ action: 'fill', tab_id: 5, selector: '#a', value: 'x' }) }],
    5,
    undefined,
    () => {},
    undefined,
    { sessionId: 'other-session' },
  );
  assert.equal(globalThis.__approvalPrompts.length, 1, '另一个 session 必须重新确认');
});

test('cross-tab targets always confirm even after trust was granted', async () => {
  resetSensitiveAccessTrust();
  await callTool({ action: 'click', x: 10, y: 20 }, { approved: true, trustAll: true });
  globalThis.__approvalPrompts = [];
  await executeToolCalls(
    [{ type: 'function_call', id: 'call-4', call_id: 'call-4', name: 'cdp_input', arguments: JSON.stringify({ action: 'fill', tab_id: 9, selector: '#a', value: 'x' }) }],
    5,
    undefined,
    () => {},
    undefined,
    { sessionId: 'test-session' },
  );
  assert.equal(globalThis.__approvalPrompts.length, 1, '跨标签页访问不受 trustAll 影响');
});

test('trust without any scope is never recorded', async () => {
  resetSensitiveAccessTrust();
  await callTool({ action: 'click', x: 10, y: 20 }, { approved: true, trustAll: true });
  globalThis.__approvalPrompts = [];
  await executeToolCalls(
    [{ type: 'function_call', id: 'call-5', call_id: 'call-5', name: 'cdp_input', arguments: JSON.stringify({ action: 'fill', tab_id: 5, selector: '#a', value: 'x' }) }],
    5,
    undefined,
    () => {},
  );
  assert.equal(globalThis.__approvalPrompts.length, 1, '没有 session/task 作用域时必须重新确认');
});
