import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `export { getRecorderRecovery } from './src/content/recorder-recovery.ts';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { getRecorderRecovery } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`
);

test('restores active recording step count and original start time after navigation', () => {
  assert.deepEqual(
    getRecorderRecovery({
      active: true,
      startedAt: 1234,
      steps: [{ seq: 1 }, { seq: 2 }],
    }, 9999),
    { stepCount: 2, startedAt: 1234 },
  );
});

test('does not restore an inactive or missing recording state', () => {
  assert.equal(getRecorderRecovery({ active: false, startedAt: 1234, steps: [] }, 9999), null);
  assert.equal(getRecorderRecovery(null, 9999), null);
});
