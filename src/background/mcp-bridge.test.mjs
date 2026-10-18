import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: { contents: `
    export { filterTabsForContext } from './src/background/mcp-bridge.ts';
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { filterTabsForContext } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

test('tabs.list only exposes tabs leased by the current task and client', () => {
  const tabs = [
    { id: 1, url: 'https://private.example/one', title: 'One', active: true },
    { id: 2, url: 'https://private.example/two', title: 'Two', active: false },
  ];
  const leases = [
    { taskId: 'task-a', sessionId: 'session-a', clientId: 'client-a', tabId: 1, expiresAt: Date.now() + 10000 },
    { taskId: 'task-b', sessionId: 'session-b', clientId: 'client-b', tabId: 2, expiresAt: Date.now() + 10000 },
  ];
  assert.deepEqual(filterTabsForContext(tabs, {
    taskId: 'task-a', sessionId: 'session-a', clientId: 'client-a',
  }, leases), [{ id: 1, url: 'https://private.example/one', title: 'One', active: true }]);
});
