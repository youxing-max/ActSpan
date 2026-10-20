import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `
      export {
        isRecorderOwnerTab,
        isRecorderStateForTab,
        shouldTransferRecorderToTab,
      } from './src/background/recorder-state.ts';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const {
  isRecorderOwnerTab,
  isRecorderStateForTab,
  shouldTransferRecorderToTab,
} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

const activeState = { active: true, tabId: 7 };

test('recognizes only the recorder state owner tab', () => {
  assert.equal(isRecorderOwnerTab(activeState, 7), true);
  assert.equal(isRecorderOwnerTab(activeState, 8), false);
  assert.equal(isRecorderOwnerTab(null, 7), false);
  assert.equal(isRecorderOwnerTab(activeState, undefined), false);
});

test('returns state for the exact tab even after recording stops', () => {
  assert.equal(isRecorderStateForTab({ active: false, tabId: 7 }, 7), true);
  assert.equal(isRecorderStateForTab({ active: false, tabId: 7 }, 8), false);
});

test('rejects unknown or malformed recorder state without throwing', () => {
  assert.equal(isRecorderStateForTab(undefined, 7), false);
  assert.equal(isRecorderStateForTab('recorder', 7), false);
  assert.equal(isRecorderStateForTab({ tabId: '7' }, 7), false);
  assert.equal(shouldTransferRecorderToTab(42, 7, 8), false);
  assert.equal(shouldTransferRecorderToTab({ tabId: 7, active: 'true' }, 7, 8), false);
});

test('transfers only an active recording from its source tab to a new tab', () => {
  assert.equal(shouldTransferRecorderToTab(activeState, 7, 8), true);
  assert.equal(shouldTransferRecorderToTab(activeState, 8, 9), false);
  assert.equal(shouldTransferRecorderToTab(activeState, 7, 7), false);
  assert.equal(shouldTransferRecorderToTab({ active: false, tabId: 7 }, 7, 8), false);
  assert.equal(shouldTransferRecorderToTab(null, 7, 8), false);
});
