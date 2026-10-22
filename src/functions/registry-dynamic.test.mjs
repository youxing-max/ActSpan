import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

globalThis.chrome = {
  storage: {
    local: {
      // registry 同时使用 Promise 与回调两种签名，测试桩必须都支持。
      get: (keys, callback) => {
        const result = {};
        if (typeof callback === 'function') { callback(result); return undefined; }
        return Promise.resolve(result);
      },
      set: (items, callback) => {
        if (typeof callback === 'function') { callback(); return undefined; }
        return Promise.resolve();
      },
    },
  },
};

const bundle = await build({
  stdin: {
    contents: `export { upsertDynamicTool, importDynamicToolsFromManifest, listDynamicTools, getRegisteredFunction } from './src/functions/registry.ts';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { upsertDynamicTool, importDynamicToolsFromManifest, listDynamicTools, getRegisteredFunction } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

const tool = (endpoint, name) => ({
  name,
  description: '测试动态工具',
  parameters: { type: 'object', properties: {} },
  endpoint,
});

test('dynamic tool endpoints cannot point at loopback or private networks', async () => {
  for (const [index, endpoint] of ['http://127.0.0.1:8080/hook', 'http://10.0.0.5/x', 'http://[::ffff:7f00:1]/x', 'http://169.254.169.254/latest/meta-data'].entries()) {
    const result = await upsertDynamicTool(tool(endpoint, `blocked_${index}`));
    assert.equal(result.success, false, endpoint);
    assert.match(result.message, /本地|内网/, endpoint);
  }
});

test('public https endpoints still register', async () => {
  const result = await upsertDynamicTool(tool('https://example.com/hook', 'public_hook'));
  assert.equal(result.success, true, result.message);
  const tools = await listDynamicTools();
  assert.ok(tools.some((entry) => entry.name === 'public_hook' && entry.endpoint === 'https://example.com/hook'));
});

test('manifest URLs pointing at link-local metadata are rejected before fetch', async () => {
  const result = await importDynamicToolsFromManifest('http://169.254.169.254/latest/meta-data', false);
  assert.equal(result.success, false);
  assert.match(result.message, /本地|内网/);
});

test('dynamic tool requests refuse redirects instead of following them to internal hosts', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 302,
    type: 'default',
    url: 'https://example.com/hook',
    headers: new Headers(),
  });
  try {
    const result = await getRegisteredFunction('public_hook').execute({});
    assert.equal(result.success, false);
    assert.match(result.error, /不允许重定向/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
