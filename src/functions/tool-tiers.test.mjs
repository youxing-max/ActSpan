import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: { contents: `
    export { buildToolCatalog, getToolsByCategory } from './src/functions/tool-tiers.ts';
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { buildToolCatalog, getToolsByCategory } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

test('resident catalog exposes browser capabilities by information layer without a loading prerequisite', () => {
  const catalog = buildToolCatalog();

  assert.match(catalog, /DOM actions/i);
  assert.match(catalog, /Network data/i);
  assert.match(catalog, /Pixel fallback/i);
  assert.match(catalog, /Sessions and meta/i);
  assert.match(catalog, /cdp_network/);
  assert.match(catalog, /webhook.*Feishu.*Lark.*Bark.*Slack.*Discord.*WeCom/i);
  assert.match(catalog, /agent.*spawn_subtask/s);
  assert.doesNotMatch(catalog, /not in the default toolset|load_tools\(category=/i);
});

test('resident catalog includes internal status and experience controls', () => {
  const catalog = buildToolCatalog(['status', 'adopt', 'site_experience']);
  assert.match(catalog, /status.*adopt.*site_experience/);
});

test('semantic categories coexist with legacy load_tools category names', () => {
  assert.ok(getToolsByCategory('dom_actions').includes('cdp_input'));
  assert.ok(getToolsByCategory('network_data').includes('cdp_network'));
  assert.ok(getToolsByCategory('pixel_fallback').includes('screenshot'));
  assert.ok(getToolsByCategory('sessions_meta').includes('webhook'));
  assert.ok(getToolsByCategory('browser_utils').includes('webhook'));
});
