import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `export { cdpFrameFunction } from './src/functions/cdp-frame.ts';
      export { CDPSessionManager } from './src/lib/cdp-session.ts';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { cdpFrameFunction, CDPSessionManager } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const tree = (id, parentId) => ({ frameTree: { frame: { id, parentId, url: `https://${id}.test/` } } });

test('frame list merges cross-process trees and preserves their parent identity', async (t) => {
  const result = { success: true, result: { frameTrees: [tree('main'), tree('child', 'main'), tree('nested', 'child'), tree('child', 'main')] } };
  t.mock.method(CDPSessionManager, 'getFrameTrees', async () => result);
  const listed = await cdpFrameFunction.execute({ action: 'list', tab_id: 81 });
  assert.equal(listed.success, true);
  assert.equal(listed.data.total, 3);
  assert.deepEqual(listed.data.frames.map(f => [f.frame_id, f.parent_frame_id, f.is_main]), [
    ['main', '', true], ['child', 'main', false], ['nested', 'child', false],
  ]);
});

test('snapshot discovers a cold child session and evaluates only in that session', async (t) => {
  let discovered = false;
  const calls = [];
  t.mock.method(CDPSessionManager, 'getFrameTrees', async () => {
    discovered = true;
    return { success: true, result: { frameTrees: [tree('main'), tree('child', 'main')] } };
  });
  t.mock.method(CDPSessionManager, 'getFrameExecutionContext', () => discovered ? { contextId: 1, sessionId: 'child-session' } : null);
  t.mock.method(CDPSessionManager, 'sendCommand', async (...args) => {
    calls.push(args);
    return { success: true, result: { result: { value: '子框架编号 CHILD-729', type: 'string' } } };
  });
  const snapshot = await cdpFrameFunction.execute({ action: 'snapshot', frame_id: 'child', tab_id: 81 });
  assert.equal(snapshot.success, true);
  assert.equal(snapshot.data.text, '子框架编号 CHILD-729');
  assert.equal(calls.length, 1);
  const [tabId, method, params, sessionId] = calls[0];
  assert.equal(tabId, 81);
  assert.equal(method, 'Runtime.evaluate');
  assert.equal(params.contextId, 1);
  assert.equal(params.throwOnSideEffect, true);
  assert.equal(sessionId, 'child-session');
});

test('a removed frame fails without evaluating the main frame', async (t) => {
  t.mock.method(CDPSessionManager, 'getFrameExecutionContext', () => null);
  t.mock.method(CDPSessionManager, 'getFrameTrees', async () => ({ success: true, result: { frameTrees: [tree('main')] } }));
  const commands = t.mock.method(CDPSessionManager, 'sendCommand', async () => { throw new Error('must not evaluate'); });
  const result = await cdpFrameFunction.execute({ action: 'snapshot', frame_id: 'removed', tab_id: 81 });
  assert.equal(result.success, false);
  assert.match(result.error, /未找到 frame_id: removed/);
  assert.equal(commands.mock.callCount(), 0);
});

test('child evaluations keep sensitive-data and side-effect rejections', async (t) => {
  t.mock.method(CDPSessionManager, 'getFrameExecutionContext', () => ({ contextId: 1, sessionId: 'child-session' }));
  const command = t.mock.method(CDPSessionManager, 'sendCommand', async () => ({
    success: true, result: { exceptionDetails: { text: 'EvalError: Possible side-effect in debug-evaluate' } },
  }));
  const sensitive = await cdpFrameFunction.execute({ action: 'evaluate', frame_id: 'child', expression: 'document.cookie', tab_id: 81 });
  assert.equal(sensitive.success, false);
  assert.equal(command.mock.callCount(), 0);
  const mutation = await cdpFrameFunction.execute({ action: 'evaluate', frame_id: 'child', expression: 'document.body.remove()', tab_id: 81 });
  assert.equal(mutation.success, false);
  assert.match(mutation.error, /只读表达式/);
  assert.equal(command.mock.calls[0].arguments[2].throwOnSideEffect, true);
});
