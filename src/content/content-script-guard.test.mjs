import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `export { claimContentScript } from './src/content/content-script-guard.ts';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { claimContentScript } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`
);

test('only the first content script instance claims the isolated world', () => {
  const scope = {};

  assert.equal(claimContentScript(scope), true);
  assert.equal(claimContentScript(scope), false);
  assert.equal(claimContentScript({}), true);
});
