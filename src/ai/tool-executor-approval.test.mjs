import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

// 审批语义（2026-10-23 起）：只有 dangerous 级操作弹审批；sensitive/interact/read 直接执行。
// 支付/删除由 cdp-input 内部 requireSensitiveTargetApproval 独立确认，不在本文件范围。
// 用假 registry / 假 request_confirmation / 假 CDP 会话；cdp_input 本体保持真实实现，
// tab_navigate 用元数据与真实定义一致的假定义（permissionLevel/actionPermissions 照抄 tab-navigate.ts:79-87），
// 避免把 background 模块（tab-lease-manager/task-manager）打进 bundle。

const FAKE_REGISTRY_SRC = `
import { cdpInputFunction } from './src/functions/cdp-input.ts';
const fakeTabNavigate = {
  name: 'tab_navigate',
  description: 'fake tab_navigate（元数据照抄真实定义）',
  permissionLevel: 'interact',
  actionPermissions: { open: 'sensitive', navigate: 'dangerous', close: 'dangerous', list: 'sensitive' },
  approvalMessageTemplate: {
    open: 'AI 正在请求打开标签页 {url}',
    navigate: 'AI 正在请求把标签页导航到 {url}',
    close: 'AI 正在请求关闭标签页',
  },
  execute: async (params) => {
    globalThis.__tabNavExecuted.push(params);
    return { success: true, data: { executed: true } };
  },
};
export const getBuiltinFunction = (name) =>
  (name === 'cdp_input' ? cdpInputFunction : name === 'tab_navigate' ? fakeTabNavigate : undefined);
export const getRegisteredFunction = getBuiltinFunction;
export const mcpClient = {
  isParallel: () => false,
  callTool: async (name, params, context) => {
    const fn = getBuiltinFunction(name);
    if (!fn) return { content: [{ text: JSON.stringify({ success: false, error: 'unknown tool' }) }] };
    const result = await fn.execute(params, context);
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

/** 跑一次工具调用，返回审批提示、CDP 事件、tab_navigate 执行记录与工具输出 */
const callTool = async (name, params, decision = { approved: false }, taskTabId = 5) => {
  resetSensitiveAccessTrust();
  globalThis.__approvalPrompts = [];
  globalThis.__cdpEvents = [];
  globalThis.__tabNavExecuted = [];
  globalThis.__approvalDecision = decision;
  const results = await executeToolCalls(
    [{ type: 'function_call', id: 'call-1', call_id: 'call-1', name, arguments: JSON.stringify(params) }],
    taskTabId,
    undefined,
    () => {},
    undefined,
    { sessionId: 'test-session' },
  );
  return {
    prompts: globalThis.__approvalPrompts,
    cdp: globalThis.__cdpEvents,
    executed: globalThis.__tabNavExecuted,
    output: JSON.parse(results[0].output),
  };
};

for (const action of ['click', 'type', 'fill', 'clear', 'select', 'key_press', 'click_text', 'double_click']) {
  test(`${action} 属 sensitive：不再弹审批`, async () => {
    const { prompts } = await callTool(
      'cdp_input',
      { action, tab_id: 5, x: 10, y: 20, text: 'hi', selector: '#a', value: 'v', key: 'Enter' },
      { approved: true },
    );
    assert.deepEqual(prompts, [], `${action} 不应再请求确认`);
  });
}

test('click 直接执行真实 CDP 鼠标序列', async () => {
  const { prompts, cdp, output } = await callTool('cdp_input', { action: 'click', tab_id: 5, x: 10, y: 20 }, { approved: true });
  assert.deepEqual(prompts, []);
  assert.equal(output.success, true);
  assert.deepEqual(cdp.map((e) => e.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
});

test('hover 无需审批', async () => {
  const { prompts, cdp, output } = await callTool('cdp_input', { action: 'hover', tab_id: 5, x: 10, y: 20 });
  assert.deepEqual(prompts, []);
  assert.equal(output.success, true);
  assert.ok(cdp.length > 0, 'hover 应直接发送 CDP 事件');
});

test('跨标签页的 read/interact 操作不再弹审批（每步必弹问题的回归断言）', async () => {
  const { prompts, output } = await callTool('cdp_input', { action: 'click', tab_id: 9, x: 10, y: 20 }, { approved: true });
  assert.deepEqual(prompts, [], '跨标签页不再被提升为需确认');
  assert.ok(output && typeof output === 'object', '调用应走到执行阶段而非被审批拦截');
});

test('tab_navigate close 属 dangerous：仍弹审批，拒绝后不执行', async () => {
  const { prompts, executed, output } = await callTool('tab_navigate', { action: 'close', tab_id: 5 });
  assert.equal(prompts.length, 1, 'dangerous 必须请求确认');
  assert.match(prompts[0], /AI 正在请求/);
  assert.equal(output.success, false);
  assert.deepEqual(executed, [], '被拒绝后不得执行');
});

test('tab_navigate navigate 属 dangerous：仍弹审批', async () => {
  const { prompts, executed, output } = await callTool('tab_navigate', { action: 'navigate', tab_id: 5, url: 'https://example.com' });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /AI 正在请求/);
  assert.equal(output.success, false);
  assert.deepEqual(executed, []);
});

test('tab_navigate dangerous 操作经批准后执行', async () => {
  const { prompts, executed, output } = await callTool(
    'tab_navigate',
    { action: 'close', tab_id: 5 },
    { approved: true },
  );
  assert.equal(prompts.length, 1);
  assert.equal(output.success, true);
  assert.equal(executed.length, 1, '批准后应真正执行');
});

test('tab_navigate open/list 属 sensitive：不再弹审批', async () => {
  for (const action of ['open', 'list']) {
    const { prompts, output } = await callTool(
      'tab_navigate',
      { action, tab_id: 5, url: 'https://example.com' },
      { approved: true },
    );
    assert.deepEqual(prompts, [], `${action} 不应再请求确认`);
    assert.equal(output.success, true, `${action} 应直接执行`);
  }
});
