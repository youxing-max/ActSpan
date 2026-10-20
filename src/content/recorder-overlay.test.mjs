import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `export { updateRecorderStepCount } from './src/content/recorder-overlay.ts';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { updateRecorderStepCount } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`
);

const stepElement = { textContent: '' };
globalThis.document = {
  querySelector: () => stepElement,
};

test('displays recorder steps above the former ten-step limit', () => {
  updateRecorderStepCount(11);

  assert.equal(stepElement.textContent, '11 步');
});
