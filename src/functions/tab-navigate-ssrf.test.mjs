import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

let finalUrl = 'https://public.example/landing';
let updateListener = null;
const created = [];
const removed = [];

globalThis.chrome = {
  tabs: {
    async create(properties) {
      created.push({ ...properties });
      const tab = { id: 801, url: properties.url, pendingUrl: properties.url, active: properties.active ?? false, status: 'loading' };
      queueMicrotask(() => updateListener?.(801, { status: 'complete' }));
      return tab;
    },
    async get(tabId, callback) {
      const tab = { id: tabId, url: finalUrl, pendingUrl: finalUrl, status: 'complete' };
      callback?.(tab);
      return tab;
    },
    async remove(tabId) { removed.push(tabId); },
    onUpdated: {
      addListener(listener) { updateListener = listener; },
      removeListener(listener) { if (updateListener === listener) updateListener = null; },
    },
  },
};

const bundle = await build({
  stdin: {
    contents: `export { tabNavigateFunction } from './src/functions/tab-navigate.ts';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { tabNavigateFunction } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

const reset = (url) => {
  finalUrl = url;
  created.length = 0;
  removed.length = 0;
};

test('open closes a tab whose final address redirects to loopback', async () => {
  reset('http://127.0.0.1:8123/admin');
  const result = await tabNavigateFunction.execute({ action: 'open', url: 'https://public.example/redirect', active: false });
  assert.equal(result.success, false);
  assert.match(result.error || '', /重定向|本机|内网/);
  assert.deepEqual(removed, [801]);
});

test('open refuses loopback and wildcard DNS targets before creating a tab', async () => {
  reset('https://public.example/landing');
  for (const url of ['http://127.0.0.1:8123/admin', 'http://127.0.0.1.nip.io:8123/', 'http://169.254.169.254/latest/meta-data']) {
    const result = await tabNavigateFunction.execute({ action: 'open', url, active: false });
    assert.equal(result.success, false);
  }
  assert.deepEqual(created, []);
});

test('open keeps a tab that stays on a public address', async () => {
  reset('https://public.example/landing');
  const result = await tabNavigateFunction.execute({ action: 'open', url: 'https://public.example/redirect', active: false });
  assert.equal(result.success, true);
  assert.equal(result.data?.tab_id, 801);
  assert.deepEqual(removed, []);
});
