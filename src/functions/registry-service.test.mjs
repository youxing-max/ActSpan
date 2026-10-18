import assert from 'node:assert/strict';
import { build } from 'esbuild';
import test from 'node:test';

const bundle = await build({
  stdin: { contents: `export { RegistryService } from './src/functions/registry-service.ts';`,
    resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { RegistryService } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

const workflow = {
  name: 'search',
  label: 'Search',
  description: 'Search the page',
  parameters: { type: 'object', properties: {} },
  plan: { steps: [{ id: 'read', capability: 'page_read', input: {} }] },
};

const skill = (overrides = {}) => ({
  name: 'catalog',
  label: 'Catalog',
  description: 'Catalog skill',
  scope: 'domain',
  url_patterns: ['*://example.com/*'],
  guide: '',
  workflows: [workflow],
  enabled: true,
  source: 'builtin',
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const storage = (initial = {}) => {
  const values = { ...initial };
  const writes = [];
  return {
    values,
    writes,
    async get(key) {
      if (key == null) return { ...values };
      const keys = Array.isArray(key) ? key : [key];
      return Object.fromEntries(keys.filter(k => k in values).map(k => [k, values[k]]));
    },
    async set(items) {
      writes.push(items);
      Object.assign(values, items);
    },
  };
};

test('stores canonical shape and increments revision for user writes', async () => {
  const area = storage();
  const service = new RegistryService({ storage: area, now: () => 100 });
  await service.initialize();

  assert.deepEqual(await service.listAll(), { revision: 0, skills: [], updatedAt: 100 });
  const result = await service.upsertSkill(skill({ source: 'user', updatedAt: 100 }));
  assert.deepEqual(result, { success: true, revision: 1 });
  const stored = area.values.actspan_skills;
  assert.equal(stored.schemaVersion, 1);
  assert.equal(stored.revision, 1);
  assert.equal(stored.updatedAt, 100);
  assert.equal(stored.skills.length, 1);
  assert.equal(stored.skills[0].name, 'catalog');
  assert.equal(stored.skills[0].source, 'user');
});
test('normalizes unsupported structured workflow error policies to stop', async () => {
  const area = storage();
  const service = new RegistryService({ storage: area, now: () => 100 });
  await service.initialize();
  await service.upsertSkill(skill({
    source: 'user',
    workflows: [{ ...workflow, plan: { steps: [{ id: 'read', capability: 'page_read', input: {}, onError: 'continue' }] } }],
  }));
  const stored = (await service.get('catalog', 'domain')).workflows[0].steps[0];
  assert.equal(stored.onError, 'stop');
});

test('resolves source precedence without collapsing global and domain scopes', async () => {
  const area = storage({
    actspan_skills: {
      schemaVersion: 1,
      revision: 4,
      updatedAt: 4,
      skills: [
        skill({ source: 'builtin', scope: 'global', updatedAt: 1 }),
        skill({ source: 'builtin', scope: 'domain', updatedAt: 1 }),
        skill({ source: 'remote', scope: 'domain', version: 2, updatedAt: 2 }),
        skill({ source: 'user', scope: 'domain', version: 3, updatedAt: 3 }),
      ],
    },
  });
  const service = new RegistryService({ storage: area, now: () => 10 });
  await service.initialize();

  const snapshot = await service.listAll();
  assert.equal(snapshot.revision, 4);
  assert.equal(snapshot.skills.filter(item => item.name === 'catalog').length, 2);
  assert.equal((await service.get('catalog', 'domain'))?.source, 'user');
  assert.equal((await service.get('catalog', 'global'))?.source, 'builtin');
});

test('migrates old user workflows once without writing the old key', async () => {
  const area = storage({
    mole_site_workflows_v1: {
      version: 1,
      workflows: [{ ...workflow, source: 'user', url_patterns: ['*://example.com/*'] }],
    },
  });
  const service = new RegistryService({ storage: area, now: () => 200 });
  await service.initialize();

  const migrated = await service.get('user-search', 'domain');
  assert.equal(migrated?.source, 'user');
  assert.ok(area.values.actspan_skills);
  assert.equal(area.writes.some(write => 'mole_site_workflows_v1' in write), false);

  const writes = area.writes.length;
  await service.reload();
  assert.equal(area.writes.length, writes);
});

test('imports existing domain skills from mole_skills without overwriting canonical edits', async () => {
  const area = storage({
    mole_skills: { version: 2, skills: [
      skill({ name: 'saved', source: 'user', scope: 'domain' }),
      skill({ name: 'remote', source: 'remote', scope: 'domain', manifestUrl: 'https://example.com/skills.json' }),
    ] },
    actspan_skills: { schemaVersion: 1, revision: 2, updatedAt: 2, skills: [
      skill({ name: 'saved', source: 'user', scope: 'domain', label: 'Latest edit' }),
    ] },
  });
  const service = new RegistryService({ storage: area, now: () => 200 });
  await service.initialize();

  assert.equal((await service.get('saved', 'domain'))?.label, 'Latest edit');
  assert.equal((await service.get('remote', 'domain'))?.manifestUrl, 'https://example.com/skills.json');
  assert.equal(area.writes.some(write => 'mole_skills' in write), false);
  assert.equal(area.values.actspan_skills.skills.length, 2);
});

test('failed storage write leaves the last persisted snapshot visible', async () => {
  const area = storage();
  const service = new RegistryService({ storage: {
    get: area.get,
    async set(items) {
      if (items.actspan_skills) throw new Error('storage full');
      await area.set(items);
    },
  }, now: () => 300 });
  await service.initialize();

  await assert.rejects(service.upsertSkill(skill({ name: 'unsaved', source: 'user' })), /storage full/);
  assert.deepEqual(await service.listAll(), { revision: 0, skills: [], updatedAt: 300 });
});

test('serializes concurrent writes without dropping skills or repeating revisions', async () => {
  const area = storage();
  const service = new RegistryService({ storage: area, now: () => 300 });
  await service.initialize();

  const results = await Promise.all([
    service.upsertSkill(skill({ name: 'first', source: 'user' })),
    service.upsertSkill(skill({ name: 'second', source: 'user' })),
  ]);

  assert.deepEqual(results.map(result => result.revision), [1, 2]);
  assert.deepEqual((await service.listAll()).skills.map(item => item.name), ['first', 'second']);
  assert.deepEqual(area.values.actspan_skills.skills.map(item => item.name), ['first', 'second']);
});

test('retries initialization after a transient storage read failure', async () => {
  const area = storage();
  let fail = true;
  const service = new RegistryService({ storage: {
    async get(key) {
      if (fail) { fail = false; throw new Error('storage unavailable'); }
      return area.get(key);
    },
    set: area.set,
  }, now: () => 300 });

  await assert.rejects(service.initialize(), /storage unavailable/);
  await service.initialize();
  assert.equal((await service.listAll()).revision, 0);
});

test('persists removal when a remote source only deletes its last skill', async () => {
  const area = storage();
  const service = new RegistryService({ storage: area, now: () => 300 });
  await service.initialize();
  await service.replaceSourceSkills('remote', 'https://manifest.example/skills.json', [skill({ source: 'remote' })]);
  const before = await service.listAll();
  await service.replaceSourceSkills('remote', 'https://manifest.example/skills.json', []);

  const after = await service.listAll();
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.skills.length, 0);
  assert.equal(area.writes.at(-1)?.actspan_skills !== undefined, true);
});

test('broadcasts registry_changed with changed skill names and revision', async () => {
  const area = storage();
  const service = new RegistryService({ storage: area, now: () => 400 });
  await service.initialize();
  const events = [];
  service.subscribe(event => events.push(event));

  await service.upsertSkill(skill({ source: 'user', updatedAt: 400 }));

  assert.deepEqual(events, [{
    type: 'registry_changed',
    revision: 1,
    changedSkills: ['catalog'],
    reason: 'user_save',
    timestamp: 400,
  }]);
});
