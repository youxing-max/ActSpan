import assert from 'node:assert/strict';
import { build } from 'esbuild';
import test from 'node:test';

const bundle = await build({
  stdin: { contents: `
    export { buildSkillContext, skillFunction } from './src/functions/skill.ts';
    export { registryService } from './src/functions/skill-registry.ts';
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
});

globalThis.chrome = {
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
  runtime: { getURL: () => '' },
  alarms: { onAlarm: { addListener() {} }, create() {} },
};

const { buildSkillContext, skillFunction, registryService } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`,
);

await buildSkillContext('https://unmatched.example/');
await registryService.upsertSkill({
  name: 'shopping-skill',
  label: '购物助手',
  description: '在商城中搜索商品',
  scope: 'domain',
  url_patterns: ['*://shop.example/*'],
  guide: '',
  workflows: [
    {
      name: 'search-products',
      label: '搜索商品',
      description: '按关键词搜索商品',
      triggers: ['找商品', '搜索商品'],
      parameters: { type: 'object', properties: { query: { type: 'string', description: '关键词', default: '茶' } } },
      plan: { steps: [{ action: 'page', params: { action: 'read' } }] },
    },
    {
      name: 'legacy-checkout',
      label: '旧版结算',
      description: '检查旧版结算页',
      parameters: { type: 'object', properties: {} },
      plan: { steps: [{ action: 'page', params: { action: 'read' } }] },
    },
  ],
  enabled: true,
  source: 'user',
  version: 1,
  createdAt: 1,
  updatedAt: 1,
});

test('list returns lightweight workflow metadata without plans and supports calls without name', async () => {
  const result = await skillFunction.execute({ action: 'list' });
  assert.equal(result.success, true, result.error);
  const workflows = result.data.skills.find((skill) => skill.name === 'shopping-skill').workflows;
  assert.deepEqual(workflows[0], {
    name: 'search-products',
    label: '搜索商品',
    description: '按关键词搜索商品',
    triggers: ['找商品', '搜索商品'],
    parameters: { type: 'object', properties: { query: { type: 'string', description: '关键词', default: '茶' } } },
  });
  assert.equal(Object.hasOwn(workflows[0], 'plan'), false);
  assert.equal(Object.hasOwn(workflows[1], 'triggers'), false);
  assert.equal(Object.hasOwn(workflows[1], 'plan'), false);
});

test('detail repeats workflow metadata and run resolves the internal workflow name', async () => {
  const detail = await skillFunction.execute({ action: 'detail', name: 'shopping-skill' });
  assert.equal(detail.success, true, detail.error);
  const workflow = detail.data.workflows.find((item) => item.name === 'search-products');
  assert.deepEqual(workflow.triggers, ['找商品', '搜索商品']);
  assert.deepEqual(workflow.parameters, { type: 'object', properties: { query: { type: 'string', description: '关键词', default: '茶' } } });
  assert.match(detail.data.hint, /Skill name/);
  assert.match(detail.data.hint, /workflow name/);

  const run = await skillFunction.execute({
    action: 'run',
    name: 'search-products',
    params: { query: '咖啡' },
  });
  assert.equal(/Workflow not found/.test(run.error || ''), false);
});

test('unmatched URLs still receive a dynamic schema whose list action does not require name', async () => {
  const context = await buildSkillContext('https://elsewhere.example/');
  assert.ok(context.schema);
  assert.deepEqual(context.schema.parameters.required, undefined);
  assert.deepEqual(context.schema.parameters.properties.action.enum, ['run', 'detail', 'list']);
});
