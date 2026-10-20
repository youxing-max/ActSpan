import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const listeners = () => ({ addListener() {}, removeListener() {} });
const calls = [];
const debuggerApi = {
  onDetach: listeners(),
  onEvent: listeners(),
  async attach() { calls.push('attach'); },
  async detach() { calls.push('detach'); },
  async sendCommand() { return {}; },
};
globalThis.chrome = { debugger: debuggerApi };
const bundle = await build({
  stdin: {
    contents: `export { CDPSessionManager, L2_IDLE_MS } from './src/lib/cdp-session.ts';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { CDPSessionManager, L2_IDLE_MS } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

test('keeps one L2 attach across a command burst and detaches after idle', async () => {
  calls.length = 0;
  await CDPSessionManager.sendCommand(41, 'Input.dispatchMouseEvent', { type: 'mouseMoved' });
  await CDPSessionManager.sendCommand(41, 'Input.dispatchMouseEvent', { type: 'mouseMoved' });
  assert.equal(calls.filter((call) => call === 'attach').length, 1);
  await new Promise((resolve) => setTimeout(resolve, L2_IDLE_MS + 50));
  assert.equal(calls.filter((call) => call === 'detach').length, 1);
});

test('holds the L2 attach while network capture is active, releases it after stop', async () => {
  calls.length = 0;
  assert.deepEqual(await CDPSessionManager.startNetworkListening(43), { success: true });
  await new Promise((resolve) => setTimeout(resolve, L2_IDLE_MS + 250));
  assert.equal(calls.filter((call) => call === 'detach').length, 0);
  await CDPSessionManager.stopNetworkListening(43);
  await new Promise((resolve) => setTimeout(resolve, L2_IDLE_MS + 250));
  assert.equal(calls.filter((call) => call === 'detach').length, 1);
});

test('maps a DevTools collision to L2_BUSY', async () => {
  debuggerApi.attach = async () => { throw new Error('Another debugger is already attached'); };
  const result = await CDPSessionManager.attach(42);
  assert.equal(result.code, 'L2_BUSY');
  assert.match(result.error || '', /L2_BUSY/);
});
