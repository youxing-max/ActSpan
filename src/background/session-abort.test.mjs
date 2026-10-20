import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `export { abortTaskResources } from './src/background/session-abort.ts';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { abortTaskResources } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

test('closes run resources after the runner abort hook finishes', async () => {
  const events = [];
  let resolveDone;
  const task = {
    runId: 'run-1',
    controller: new AbortController(),
    done: new Promise((resolve) => { resolveDone = resolve; }),
    markDone: () => events.push('mark-done'),
    runner: {
      abort: async () => {
        events.push('detach');
      },
    },
  };
  const runningSession = { id: 'session-1' };
  resolveDone();

  await abortTaskResources({
    task,
    runningSession,
    reason: 'interrupted',
    message: '用户中断',
    failureCode: 'E_CANCELLED',
    closeByRun: async () => events.push('close-resources'),
    timeoutMs: 5000,
  });

  assert.deepEqual(events, ['mark-done', 'detach', 'close-resources']);
});
