import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: { contents: `
    export { registerActiveSessionTask } from './src/background/session-state.ts';
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { registerActiveSessionTask } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

const task = (sessionId) => ({ sessionId, runId: `${sessionId}-run` });

test('registering one session task preserves another session task', () => {
  const runtime = { tasks: new Map() };
  registerActiveSessionTask(runtime, task('session-a'));
  registerActiveSessionTask(runtime, task('session-b'));
  assert.deepEqual([...runtime.tasks.keys()], ['session-a', 'session-b']);
});
