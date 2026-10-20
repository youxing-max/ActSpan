import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundled = await build({
  stdin: {
    contents: `
      export { loadToolsFunction } from './src/functions/load-tools.ts';
      export { cdpNetworkFunction } from './src/functions/cdp-network.ts';
      export { downloadFileFunction } from './src/functions/download-file.ts';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { loadToolsFunction, cdpNetworkFunction, downloadFileFunction } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString('base64')}`);

test('load_tools reports resident tools without promising a new load', async () => {
  assert.match(loadToolsFunction.description, /already available/i);
  assert.match(loadToolsFunction.description, /does not load new tools/i);

  const result = await loadToolsFunction.execute({ category: 'browser_utils' });
  assert.equal(result.success, true);
  assert.equal(result.data.already_available, true);
  assert.deepEqual(result.data.loaded, ['clipboard_ops', 'notification', 'webhook', 'bookmark_ops', 'history_search', 'download_file']);
  assert.match(result.data.message, /already available/i);
  assert.doesNotMatch(result.data.message, /已加载/);
});

test('network and download descriptions encode their data and file strategy', () => {
  assert.match(cdpNetworkFunction.description, /START HERE when you need DATA/i);
  assert.match(cdpNetworkFunction.description, /list actual requests before choosing an endpoint/i);
  assert.match(cdpNetworkFunction.description, /Never guess an endpoint name from memory/i);
  assert.match(cdpNetworkFunction.description, /response size/i);
  assert.match(cdpNetworkFunction.description, /page-driven network fallback/i);

  assert.match(downloadFileFunction.description, /LAST RESORT/i);
  assert.match(downloadFileFunction.description, /fetch_url/i);
  assert.match(downloadFileFunction.description, /data_pipeline/i);
  assert.match(downloadFileFunction.description, /saveAs:false/i);
  assert.match(downloadFileFunction.description, /system save dialog/i);
});

test('strategy tools remain valid function registrations', () => {
  for (const tool of [loadToolsFunction, cdpNetworkFunction, downloadFileFunction]) {
    assert.equal(typeof tool.name, 'string');
    assert.ok(tool.description.length > 0);
    assert.equal(tool.parameters.type, 'object');
    assert.equal(typeof tool.execute, 'function');
    assert.equal(typeof tool.supportsParallel, 'boolean');
  }
});
