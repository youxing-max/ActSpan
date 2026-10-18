import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

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
    contents: `export { saveWorkflowFunction } from './src/functions/save-workflow.ts';
export { skillFunction } from './src/functions/skill.ts';
export { registryService } from './src/functions/skill-registry.ts';
export { getBuiltinFunction } from './src/functions/registry.ts';
export { getSyncStatus } from './src/options/pages/actspan-console-status.ts';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { saveWorkflowFunction, skillFunction, registryService, getSyncStatus } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

const workflow = {
  name: 'search_products', label: 'Search products', description: 'Search catalog',
  triggers: ['find products', 'search catalog'],
  url_patterns: ['*://example.com/*'],
  parameters: { type: 'object', properties: {} },
  plan: { steps: [{ action: 'page', params: {} }] },
};

test('AI save is visible at the same revision to Console and Skill API without old-key writes', async () => {
  const saved = await saveWorkflowFunction.execute({ workflow_json: JSON.stringify(workflow) });
  assert.equal(saved.success, true, saved.error);
  const snapshot = await registryService.listAll();
  const savedSkill = snapshot.skills.find(skill => skill.workflows.some(item => item.name === workflow.name));
  assert.ok(savedSkill);
  assert.equal(savedSkill.source, 'user');
  assert.deepEqual(savedSkill.url_patterns, workflow.url_patterns);
  assert.deepEqual(savedSkill.workflows.find(item => item.name === workflow.name).triggers, workflow.triggers);
  assert.equal(values.actspan_skills.revision, snapshot.revision);
  assert.equal(writes.some(items => 'mole_site_workflows_v1' in items), false);
  const list = await skillFunction.execute({ action: 'list' });
  assert.equal(list.data.revision, snapshot.revision);
  const listedSkill = list.data.skills.find(skill => skill.name === savedSkill.name);
  assert.ok(listedSkill);
  const listedWorkflow = listedSkill.workflows.find(item => item.name === workflow.name);
  assert.deepEqual(listedWorkflow, {
    name: workflow.name,
    label: workflow.label,
    description: workflow.description,
    triggers: workflow.triggers,
    parameters: workflow.parameters,
  });
  assert.equal('plan' in listedWorkflow, false);
  const detail = await skillFunction.execute({ action: 'detail', name: savedSkill.name });
  assert.equal(detail.data.revision, snapshot.revision);
  assert.equal(detail.data.workflows[0].name, workflow.name);
  assert.equal(detail.data.workflows[0].label, workflow.label);
  assert.equal(detail.data.workflows[0].description, workflow.description);
  assert.deepEqual(detail.data.workflows[0].triggers, workflow.triggers);
});

test('Console edits and deletions change the next Skill API query without reloading', async () => {
  const before = await registryService.listAll();
  const skill = before.skills.find(item => item.workflows.some(wf => wf.name === workflow.name));
  const changed = await registryService.upsertSkill({ ...skill, label: 'Renamed catalog', updatedAt: Date.now() });
  const listed = await skillFunction.execute({ action: 'list' });
  assert.equal(listed.data.revision, changed.revision);
  assert.equal(listed.data.skills.find(item => item.name === skill.name).label, 'Renamed catalog');
  const removed = await registryService.remove(skill.name, skill.scope);
  const after = await skillFunction.execute({ action: 'list' });
  assert.equal(after.data.revision, removed.revision);
  assert.equal(after.data.skills.some(item => item.name === skill.name), false);
  const run = await skillFunction.execute({ action: 'run', name: workflow.name });
  assert.equal(run.success, false);
  assert.match(run.error, /Workflow not found/);
});

test('persisted manifest sync progress shows syncing only while recent and active', () => {
  const now = 1_000_000;
  const persisted = JSON.parse(JSON.stringify([{ url: 'https://example.com/skills.json', enabled: true, syncStartedAt: now - 1000, lastSyncError: 'previous failure' }]));
  assert.equal(getSyncStatus(persisted, now), 'syncing');
  assert.equal(getSyncStatus(persisted, now + 11 * 60 * 1000), 'error');
  persisted[0].lastSyncError = undefined;
  persisted[0].lastSyncAt = now - 60 * 60 * 1000;
  assert.equal(getSyncStatus(persisted, now + 11 * 60 * 1000), 'stale');
  persisted[0].enabled = false;
  assert.equal(getSyncStatus(persisted, now), 'ready');
});
