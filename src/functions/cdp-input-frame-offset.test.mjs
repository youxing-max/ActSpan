import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

// 验证 resolveFrameOffset：沿 DOM.getFrameOwner 链累加 iframe 偏移并减去主框架滚动。
// 假 CDPSessionManager 按 nodeId/frameId 返回预设的 quad 与父子关系。

const FAKE_CDP_SRC = `
const owners = () => globalThis.__fakeFrames;
export const CDPSessionManager = {
  isSupported: () => true,
  attach: async () => ({ success: true }),
  sendCommand: async (tabId, method, params) => {
    const f = owners();
    (f.commands ??= []).push({ method, params });
    if (method === 'DOM.getFrameOwner' && f.rejectNumericFrames && typeof params.frameId !== 'string') {
      return { success: false, error: 'Invalid parameters: frameId must be a string' };
    }
    if (method === 'DOM.getFrameOwner') return { success: true, result: { backendNodeId: f.ownerByFrame[params.frameId] } };
    if (method === 'DOM.getBoxModel') return { success: true, result: { model: { border: f.quadByNode[params.backendNodeId] } } };
    if (method === 'DOM.describeNode') return { success: true, result: { node: { frameId: f.parentFrameByNode[params.backendNodeId] } } };
    if (method === 'Page.getLayoutMetrics') return { success: true, result: { visualViewport: f.viewport } };
    return { success: true, result: {} };
  },
};
`;

const plugin = {
  name: 'fake-cdp',
  setup(b) {
    b.onResolve({ filter: /lib\/cdp-session$/ }, () => ({ path: 'fake-cdp', namespace: 'fake' }));
    b.onLoad({ filter: /^fake-cdp$/, namespace: 'fake' }, () => ({ contents: FAKE_CDP_SRC, loader: 'js' }));
  },
};

const out = await build({
  stdin: {
    contents: `export { resolveFrameOffset, realClickAt } from './src/functions/cdp-input.ts';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  plugins: [plugin],
});
const { resolveFrameOffset, realClickAt } = await import(
  `data:text/javascript;base64,${Buffer.from(out.outputFiles[0].contents).toString('base64')}`
);

test('主框架或无 frameId 时偏移为零，且不发起 CDP 调用', async () => {
  globalThis.__fakeFrames = { ownerByFrame: {}, quadByNode: {}, parentFrameByNode: {}, viewport: { pageX: 0, pageY: 0 } };
  assert.deepEqual(await resolveFrameOffset(1, 0), { x: 0, y: 0 });
  assert.deepEqual(await resolveFrameOffset(1, undefined), { x: 0, y: 0 });
});

test('单层 iframe：偏移 = iframe 文档坐标 − 主框架滚动', async () => {
  globalThis.__fakeFrames = {
    ownerByFrame: { 476: 901 },
    quadByNode: { 901: [100, 50, 740, 50, 740, 370, 100, 370] },
    parentFrameByNode: { 901: 0 },
    viewport: { pageX: 0, pageY: 80 },
  };
  assert.deepEqual(await resolveFrameOffset(1, 476), { x: 100, y: -30 });
});

test('嵌套 iframe：沿 owner 链累加各级偏移', async () => {
  globalThis.__fakeFrames = {
    ownerByFrame: { 5: 901, 1: 900 },
    quadByNode: { 901: [100, 50, 200, 50, 200, 90, 100, 90], 900: [20, 10, 300, 10, 300, 200, 20, 200] },
    parentFrameByNode: { 901: 1, 900: 0 },
    viewport: { pageX: 7, pageY: 3 },
  };
  assert.deepEqual(await resolveFrameOffset(1, 5), { x: 113, y: 57 });
});

test('frame owner 查询失败时拒绝使用零偏移或部分偏移', async () => {
  globalThis.__fakeFrames = {
    ownerByFrame: {},
    quadByNode: {},
    parentFrameByNode: {},
    viewport: { pageX: 0, pageY: 0 },
  };
  await assert.rejects(() => resolveFrameOffset(1, 999), /iframe/);
});

test('Chrome frame ids rejected by CDP never produce a click in the parent frame', async () => {
  globalThis.__fakeFrames = { rejectNumericFrames: true };
  const result = await realClickAt(1, 10, 20, undefined, 476);
  assert.equal(result.success, false);
  assert.match(result.error, /iframe/);
  assert.equal(globalThis.__fakeFrames.commands.some(({ method }) => method.startsWith('Input.')), false);
});
