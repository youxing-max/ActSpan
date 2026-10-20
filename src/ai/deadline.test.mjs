import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: { contents: `
    export { createDeadlineSignal, isTimeoutError, DeadlineTimeoutError } from './src/ai/deadline.ts';
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { createDeadlineSignal, isTimeoutError, DeadlineTimeoutError } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

test('deadline exposes an identifiable timeout error', async () => {
  const deadline = createDeadlineSignal(undefined, 5);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(deadline.signal.aborted, true);
  assert.equal(isTimeoutError(deadline.signal.reason), true);
  assert.ok(deadline.signal.reason instanceof DeadlineTimeoutError);
  deadline.cleanup();
});

test('deadline keeps a caller abort distinct from timeout', () => {
  const controller = new AbortController();
  const reason = new Error('caller stopped');
  const deadline = createDeadlineSignal(controller.signal, 1000);
  controller.abort(reason);
  assert.equal(deadline.signal.aborted, true);
  assert.equal(deadline.signal.reason, reason);
  assert.equal(deadline.didTimeout(), false);
  deadline.cleanup();
});
