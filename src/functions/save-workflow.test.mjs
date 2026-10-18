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
  plan: { steps: [{ action: 'page', params: { action: 'read' } }] },
};

const save = (overrides = {}) => saveWorkflowFunction.execute({
  workflow_json: JSON.stringify({ ...workflow, ...overrides }),
});

await registryService.listAll();

test('saves a workflow with complete metadata and preserves triggers', async () => {
  const result = await save();
  assert.equal(result.success, true, result.error);
  const saved = (await registryService.listAll()).skills
    .flatMap(skill => skill.workflows)
    .find(item => item.name === workflow.name);
  assert.deepEqual(saved?.triggers, workflow.triggers);
  assert.equal(saved?.label, workflow.label);
  assert.equal(saved?.description, workflow.description);
});

test('rejects a workflow with a blank label without writing the registry', async () => {
  const beforeWrites = writes.length;
  const beforeRevision = (await registryService.listAll()).revision;
  const result = await save({ label: '   ' });
  assert.equal(result.success, false);
  assert.match(result.error || '', /label/i);
  assert.equal(writes.length, beforeWrites);
  assert.equal((await registryService.listAll()).revision, beforeRevision);
});

test('rejects a workflow with a blank description without writing the registry', async () => {
  const beforeWrites = writes.length;
  const beforeRevision = (await registryService.listAll()).revision;
  const result = await save({ description: '\t' });
  assert.equal(result.success, false);
  assert.match(result.error || '', /description/i);
  assert.equal(writes.length, beforeWrites);
  assert.equal((await registryService.listAll()).revision, beforeRevision);
});

test('rejects an empty plan without writing the registry', async () => {
  const beforeWrites = writes.length;
  const beforeRevision = (await registryService.listAll()).revision;
  const result = await save({ plan: { steps: [] } });
  assert.equal(result.success, false);
  assert.match(result.error || '', /plan\.steps|steps/i);
  assert.equal(writes.length, beforeWrites);
  assert.equal((await registryService.listAll()).revision, beforeRevision);
});

test('rejects triggers that are not a string array without writing the registry', async () => {
  const beforeWrites = writes.length;
  const beforeRevision = (await registryService.listAll()).revision;
  const result = await save({ triggers: ['search', 42] });
  assert.equal(result.success, false);
  assert.match(result.error || '', /triggers/i);
  assert.equal(writes.length, beforeWrites);
  assert.equal((await registryService.listAll()).revision, beforeRevision);
});

test('rejects a workflow with an invalid name without writing the registry', async () => {
  const beforeWrites = writes.length;
  const result = await save({ name: 'Search_products' });
  assert.equal(result.success, false);
  assert.match(result.error || '', /name/i);
  assert.equal(writes.length, beforeWrites);
});

test('rejects a workflow with a non-Chinese label without writing the registry', async () => {
  const beforeWrites = writes.length;
  const result = await save({ label: 'Search products' });
  assert.equal(result.success, false);
  assert.match(result.error || '', /label/i);
  assert.equal(writes.length, beforeWrites);
});

test('rejects a workflow with a non-Chinese description without writing the registry', async () => {
  const beforeWrites = writes.length;
  const result = await save({ description: 'Search the product catalog' });
  assert.equal(result.success, false);
  assert.match(result.error || '', /description/i);
  assert.equal(writes.length, beforeWrites);
});
test('rejects placeholder label and description without writing the registry', async () => {
  const beforeWrites = writes.length;
  for (const field of ['label', 'description']) {
    const result = await save({ [field]: '待补充' });
    assert.equal(result.success, false);
    assert.match(result.error || '', new RegExp(field, 'i'));
  }
  assert.equal(writes.length, beforeWrites);
});

test('rejects a workflow with missing triggers without writing the registry', async () => {
  const beforeWrites = writes.length;
  const result = await save({ triggers: undefined });
  assert.equal(result.success, false);
  assert.match(result.error || '', /triggers/i);
  assert.equal(writes.length, beforeWrites);
});

test('rejects a workflow with too few or too many triggers without writing the registry', async () => {
  const beforeWrites = writes.length;
  for (const triggers of [['搜索商品'], ['搜索商品', '查找商品', '浏览商品', '筛选商品', '购买商品', '比较商品']]) {
    const result = await save({ triggers });
    assert.equal(result.success, false);
    assert.match(result.error || '', /triggers/i);
  }
  assert.equal(writes.length, beforeWrites);
});

test('rejects a workflow with a blank trigger without writing the registry', async () => {
  const beforeWrites = writes.length;
  const result = await save({ triggers: ['搜索商品', '  '] });
  assert.equal(result.success, false);
  assert.match(result.error || '', /triggers/i);
  assert.equal(writes.length, beforeWrites);
});
test('rejects placeholder workflow names without writing the registry', async () => {
  const beforeWrites = writes.length;
  const result = await save({ name: 'workflow' });
  assert.equal(result.success, false);
  assert.match(result.error || '', /name/i);
  assert.equal(writes.length, beforeWrites);
});

test('rejects non-Chinese trigger phrases without writing the registry', async () => {
  const beforeWrites = writes.length;
  const result = await save({ triggers: ['search products', 'find products'] });
  assert.equal(result.success, false);
  assert.match(result.error || '', /triggers/i);
  assert.equal(writes.length, beforeWrites);
});
