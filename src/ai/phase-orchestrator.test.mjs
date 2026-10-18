import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `
      export { getBrowserState } from './src/ai/phase-orchestrator.ts';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { getBrowserState } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`,
);

test('browser state follows the task tab instead of the focused tab', async () => {
  const tabs = [
    { id: 11, url: 'https://user.example/', title: 'User tab', active: true },
    { id: 42, url: 'https://task.example/result', title: 'Task result', active: false },
  ];
  globalThis.chrome = {
    tabs: {
      query: async (query) => query.lastFocusedWindow ? [tabs[0]] : tabs,
    },
  };

  const state = await getBrowserState(42);

  assert.equal(state.activeTabId, 42);
  assert.equal(state.currentUrl, 'https://task.example/result');
});
