import assert from 'node:assert/strict';
import { build } from 'esbuild';
import test from 'node:test';

let onMessage;
globalThis.chrome = {
  runtime: {
    onMessage: { addListener(listener) { onMessage = listener; } },
    onConnect: { addListener() {} },
    sendMessage() {},
    getURL: () => '',
  },
  storage: {
    local: {
      get(key, callback) {
        if (callback) callback({});
        return Promise.resolve({});
      },
      set(items, callback) {
        if (callback) callback();
        return Promise.resolve(items);
      },
    },
    onChanged: { addListener() {} },
  },
  alarms: { onAlarm: { addListener() {} }, create() {}, getAll: async () => [] },
};

const bundle = await build({
  stdin: { contents: `
    import './src/background/workflow-handlers.ts';
    export { default as Channel } from './src/lib/channel.ts';
    export { ensureSkillRegistryReady, registryService } from './src/functions/skill-registry.ts';
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { Channel, ensureSkillRegistryReady, registryService } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`
);
await ensureSkillRegistryReady();
await registryService.upsertSkill({
  name: 'site-skill',
  label: '站点技能',
  description: '站点工作流',
  scope: 'domain',
  url_patterns: ['*://shop.example/*'],
  guide: '',
  workflows: [{
    name: 'search-products',
    label: '搜索商品',
    description: '按关键词搜索商品',
    triggers: ['找商品'],
    parameters: { type: 'object', properties: {} },
    plan: { steps: [{ action: 'page', params: { action: 'read' } }] },
  }],
  enabled: true,
  source: 'user',
  version: 1,
  createdAt: 1,
  updatedAt: 1,
});
Channel.listen();

test('current URL workflow matching forwards trigger metadata without changing dedupe fields', async () => {
  assert.ok(onMessage);
  const response = await new Promise((resolve) => {
    onMessage({ type: '__site_workflows_match', data: { url: 'https://shop.example/products' } }, {}, resolve);
  });
  assert.deepEqual(response.workflows, [{
    name: 'search-products',
    label: '搜索商品',
    description: '按关键词搜索商品',
    triggers: ['找商品'],
    skillLabel: '站点技能',
    hasRequiredParams: false,
  }]);
});
