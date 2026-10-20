import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `export { cdpInputFunction } from './src/functions/cdp-input.ts';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { cdpInputFunction } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

test('rejects ambiguous element_id and selector locators', () => {
  assert.match(
    cdpInputFunction.validate({ action: 'fill', element_id: 'ec-1', selector: '#email', value: 'a@b.test' }) || '',
    /同时|either|ambiguous|mutually/i,
  );
});

test('reports NEEDS_L2 when the debugger API is unavailable', async () => {
  const result = await cdpInputFunction.execute({ action: 'key_press', key: 'Enter', tab_id: 7 });
  assert.equal(result.success, false);
  assert.match(result.error || '', /NEEDS_L2/);
  assert.equal(result.diagnostic?.action, 'key_press');
});
