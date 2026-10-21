import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: { contents: `
    export { downloadFileFunction } from './src/functions/download-file.ts';
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { downloadFileFunction } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

const downloadCalls = [];

globalThis.chrome = {
  downloads: {
    download: async (options) => {
      downloadCalls.push(options);
      return 1;
    },
  },
  storage: { local: { get: (_key, callback) => callback?.({}), set: (_items, callback) => callback?.() } },
};

test('downloads require user approval', () => {
  assert.equal(downloadFileFunction.permissionLevel, 'sensitive');
});

test('rejects loopback, credential and executable targets', () => {
  assert.match(downloadFileFunction.validate?.({ url: 'http://127.0.0.1/a.txt' }) || '', /内网|本机/);
  assert.match(downloadFileFunction.validate?.({ url: 'https://example.com/reset-password' }) || '', /凭据/);
  assert.match(downloadFileFunction.validate?.({ content: 'x', filename: 'payload.command' }) || '', /可执行/);
});

test('rejects executable names inferred from URL or reserved names', async () => {
  const fromUrl = await downloadFileFunction.execute({ url: 'https://example.com/payload.command' });
  assert.equal(fromUrl.success, false);
  assert.match(fromUrl.error, /可执行/);

  const reserved = downloadFileFunction.validate?.({ content: 'x', filename: 'CON.txt' });
  assert.match(reserved || '', /保留名/);
});

test('strips directory components from filename', async () => {
  downloadCalls.length = 0;
  const result = await downloadFileFunction.execute({
    content: 'hello',
    filename: '../../evil.txt',
  });
  assert.equal(result.success, true);
  assert.equal(downloadCalls[0].filename, 'evil.txt');
});
