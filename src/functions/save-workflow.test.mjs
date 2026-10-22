import assert from 'node:assert/strict';
import { build } from 'esbuild';
import test from 'node:test';

const values = {};
const writes = [];
globalThis.chrome = {
  storage: {
    local: {
      get(keys, callback) {
        const names = keys == null ? Object.keys(values) : Array.isArray(keys) ? keys : [keys];
        const result = Object.fromEntries(names.filter(key => key in values).map(key => [key, values[key]]));
        callback?.(result);
        return Promise.resolve(result);
      },
      set(items, callback) {
        writes.push(items);
        Object.assign(values, items);
        callback?.();
        return Promise.resolve();
      },
    },
    onChanged: { addListener() {} },
  },
  runtime: { sendMessage() {} },
};

const bundle = await build({
  stdin: {
    contents: `
      export { saveWorkflowFunction } from './src/functions/save-workflow.ts';
      export { registryService } from './src/functions/skill-registry.ts';
      export { getBuiltinFunction } from './src/functions/registry.ts';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { saveWorkflowFunction, registryService } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`
);

const workflow = {
  name: 'search_products',
  label: '搜索商品',
  description: '帮助用户快速搜索商品',
  triggers: ['搜索商品', '查找商品'],
  parameters: { type: 'object', properties: {} },
  plan: { steps: [{ action: 'page', params: { action: 'view' } }] },
};

const save = (overrides = {}) => saveWorkflowFunction.execute({
  workflow_json: JSON.stringify({ ...workflow, ...overrides }),
});

// F4: a defective script is saved anyway; the defect is named, not silently dropped.
const saveWithWarnings = async (overrides) => {
  const beforeWrites = writes.length;
  const beforeRevision = (await registryService.listAll()).revision;
  const result = await save(overrides);
  assert.equal(result.success, true, result.error);
  assert.equal(result.data.healthy, false);
  assert.ok(result.data.warnings.length > 0, 'a defective save must name at least one defect');
  assert.ok(writes.length > beforeWrites, 'a defective save must still reach the registry');
  assert.ok((await registryService.listAll()).revision > beforeRevision);
  return result;
};

await registryService.listAll();

test('a well-formed script saves with zero warnings', async () => {
  const result = await save();
  assert.equal(result.success, true, result.error);
  assert.deepEqual(result.data.warnings, []);
  assert.equal(result.data.healthy, true);
  const saved = (await registryService.listAll()).skills
    .flatMap(skill => skill.workflows)
    .find(item => item.name === workflow.name);
  assert.deepEqual(saved?.triggers, workflow.triggers);
  assert.equal(saved?.label, workflow.label);
  assert.equal(saved?.description, workflow.description);
});

test('unparseable JSON is refused and names the parser position', async () => {
  const beforeWrites = writes.length;
  const result = await saveWorkflowFunction.execute({ workflow_json: '{"name": "search_products",}' });
  assert.equal(result.success, false);
  assert.match(result.error || '', /not valid JSON/);
  assert.match(result.error || '', /position/i);
  assert.equal(writes.length, beforeWrites);
});

test('a plan with no steps is refused because nothing is runnable', async () => {
  const beforeWrites = writes.length;
  for (const plan of [{ steps: [] }, {}, undefined]) {
    const result = await save({ plan });
    assert.equal(result.success, false);
    assert.match(result.error || '', /plan\.steps/);
  }
  assert.equal(writes.length, beforeWrites);
});

test('a missing or non-object workflow is refused', async () => {
  for (const workflow_json of ['null', '[]', '"text"']) {
    const result = await saveWorkflowFunction.execute({ workflow_json });
    assert.equal(result.success, false);
    assert.match(result.error || '', /workflow object/);
  }
});

test('a blank label is saved with the workflow name as its label', async () => {
  const result = await saveWithWarnings({ label: '   ' });
  assert.match(result.data.warnings.join(' | '), /label/);
  const saved = (await registryService.listAll()).skills
    .flatMap(skill => skill.workflows)
    .find(item => item.name === workflow.name);
  assert.equal(saved?.label, workflow.name);
});

test('a non-Chinese label is saved with a named warning', async () => {
  const result = await saveWithWarnings({ label: 'Search products' });
  assert.match(result.data.warnings.join(' | '), /label/);
});

test('a blank description is saved with a named warning', async () => {
  const result = await saveWithWarnings({ description: '\t' });
  assert.match(result.data.warnings.join(' | '), /description/);
});

test('a non-Chinese description is saved with a named warning', async () => {
  const result = await saveWithWarnings({ description: 'Search the product catalog' });
  assert.match(result.data.warnings.join(' | '), /description/);
});

test('placeholder label and description are named as placeholders', async () => {
  for (const field of ['label', 'description']) {
    const result = await saveWithWarnings({ [field]: '待补充' });
    assert.match(result.data.warnings.join(' | '), new RegExp(field, 'i'));
  }
});

test('an invalid name is saved under a generated snake_case name', async () => {
  const result = await saveWithWarnings({ name: 'Search_products' });
  assert.match(result.data.warnings.join(' | '), /name/);
  assert.match(result.data.name, /^user-workflow_[a-z0-9]+$/);
});

test('placeholder workflow names are replaced and named', async () => {
  const result = await saveWithWarnings({ name: 'workflow' });
  assert.match(result.data.warnings.join(' | '), /name/);
  assert.match(result.data.name, /^user-workflow_[a-z0-9]+$/);
});

test('missing triggers are saved as an empty trigger list and named', async () => {
  const result = await saveWithWarnings({ triggers: undefined });
  assert.match(result.data.warnings.join(' | '), /triggers/);
  const saved = (await registryService.listAll()).skills
    .flatMap(skill => skill.workflows)
    .find(item => item.name === workflow.name);
  assert.equal(saved?.triggers, undefined);
});

test('a non-array trigger list is saved as empty and named', async () => {
  const result = await saveWithWarnings({ triggers: '搜索商品' });
  assert.match(result.data.warnings.join(' | '), /triggers is not an array/);
});

test('too few or too many triggers are saved and named', async () => {
  const few = await saveWithWarnings({ triggers: ['搜索商品'] });
  assert.match(few.data.warnings.join(' | '), /triggers should hold 2-5 Chinese strings; saved 1/);
  const many = await saveWithWarnings({ triggers: ['搜索商品', '查找商品', '浏览商品', '筛选商品', '购买商品', '比较商品'] });
  assert.match(many.data.warnings.join(' | '), /triggers: kept the first 5 of 6/);
});

// 这些文字会进 skill 工具描述（即系统提示）：不设上限，被注入的页面就能把任意长的指令
// 永久写进去，所以超长必须截断并点名。
test('oversized label, description and triggers are truncated and named', async () => {
  const result = await saveWithWarnings({
    label: `搜索商品${'甲'.repeat(80)}`,
    description: `帮助用户快速搜索商品${'乙'.repeat(400)}`,
    triggers: ['搜索商品', '查找商品', '浏览商品', '筛选商品', '购买商品', '比较商品', '收藏商品'],
  });
  const warnings = result.data.warnings.join(' | ');
  assert.match(warnings, /label exceeded 60 characters; truncated/);
  assert.match(warnings, /description exceeded 300 characters; truncated/);
  assert.match(warnings, /triggers: kept the first 5 of 7/);
  const saved = (await registryService.listAll()).skills
    .flatMap(skill => skill.workflows)
    .find(item => item.name === workflow.name);
  assert.equal(saved?.label.length, 60);
  assert.equal(saved?.description.length, 300);
  assert.equal(saved?.triggers.length, 5);
});

test('blank and non-Chinese trigger entries are dropped and counted', async () => {
  const blank = await saveWithWarnings({ triggers: ['搜索商品', '  '] });
  assert.match(blank.data.warnings.join(' | '), /dropped 1 blank or non-Chinese entry/);
  const foreign = await saveWithWarnings({ triggers: ['search products', 'find products'] });
  assert.match(foreign.data.warnings.join(' | '), /dropped 2 blank or non-Chinese entries/);
});

test('mixed-type trigger entries are dropped and counted', async () => {
  const result = await saveWithWarnings({ triggers: ['搜索商品', '查找商品', 42] });
  assert.match(result.data.warnings.join(' | '), /dropped 1 blank or non-Chinese entry/);
});

test('an unknown plan action is saved as-is and named with its step number', async () => {
  const result = await saveWithWarnings({
    plan: { steps: [{ action: 'page', params: { action: 'read' } }, { action: 'delete_everything' }] },
  });
  assert.match(result.data.warnings.join(' | '), /step 2 action "delete_everything"/);
  assert.match(result.data.warnings.join(' | '), /saved as-is/);
});

test('a legal action with an illegal sub-action is named as failing at run time', async () => {
  const result = await saveWithWarnings({
    plan: {
      steps: [
        { action: 'page', params: { action: 'read' } },
        { action: 'cdp_dom', params: { action: 'query' } },
      ],
    },
  });
  const joined = result.data.warnings.join(' | ');
  assert.match(joined, /step 1 page\.read/);
  assert.match(joined, /step 2 cdp_dom\.query/);
  assert.match(joined, /will fail when the workflow runs/);
});

test('a step without an action is named as empty', async () => {
  const result = await saveWithWarnings({ plan: { steps: [{ params: { action: 'read' } }] } });
  assert.match(result.data.warnings.join(' | '), /step 1 action null/);
});

test('every defect in one script is named, not just the first', async () => {
  const result = await saveWithWarnings({
    name: 'Bad Name',
    label: '待补充',
    description: '',
    triggers: ['搜索商品'],
    plan: { steps: [{ action: 'page', params: { action: 'read' } }, { action: 'nope' }] },
  });
  const joined = result.data.warnings.join(' | ');
  assert.match(joined, /name/);
  assert.match(joined, /label/);
  assert.match(joined, /description/);
  assert.match(joined, /2-5/);
  assert.match(joined, /step 2 action "nope"/);
});

test('url_patterns are coerced to trimmed strings', async () => {
  const result = await save({ url_patterns: ['  https://shop.example/*  ', '', 42] });
  assert.equal(result.success, true, result.error);
  const saved = (await registryService.listAll()).skills.find(skill => skill.name === result.data.name);
  assert.deepEqual(saved?.url_patterns, ['https://shop.example/*', '42']);
});
