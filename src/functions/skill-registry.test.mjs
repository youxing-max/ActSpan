import assert from 'node:assert/strict';
import { build } from 'esbuild';
import test from 'node:test';

const bundle = await build({
  stdin: { contents: `
    export { addManifestSource, removeManifestSource, syncAllSkillManifests, ensureSkillRegistryReady, registryService } from './src/functions/skill-registry.ts';
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { addManifestSource, removeManifestSource, syncAllSkillManifests, ensureSkillRegistryReady, registryService } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
test('manifest sync is visible and cannot resurrect a removed source', async () => {
  const values = {};
  let finish;
  let fetchStarted;
  const fetched = new Promise(resolve => { fetchStarted = resolve; });
  globalThis.fetch = () => new Promise(resolve => { finish = resolve; fetchStarted(); });
  globalThis.chrome = {
    storage: {
      local: {
        get(key, callback) {
          const result = key == null ? structuredClone(values) : { [key]: structuredClone(values[key]) };
          if (callback) { callback(result); return; }
          return Promise.resolve(result);
        },
        set(items, callback) {
          Object.assign(values, structuredClone(items));
          if (callback) callback();
          return Promise.resolve();
        },
      },
      onChanged: { addListener() {} },
    },
    runtime: { getURL: () => '', sendMessage: async () => {} },
    alarms: { onAlarm: { addListener() {} }, create() {} },
  };

  await ensureSkillRegistryReady();
  const adding = addManifestSource('https://example.com/skills.json');
  let timer;
  await Promise.race([fetched, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(JSON.stringify(values))), 1000);
  })]);
  clearTimeout(timer);
  assert.equal(values.actspan_skill_sources.sources[0].syncStartedAt > 0, true);

  finish({ ok: false, status: 503 });
  const result = await adding;
  assert.equal(result.success, false);
  assert.equal(values.actspan_skill_sources.sources[0].syncStartedAt, undefined);
  assert.equal(values.actspan_skill_sources.sources[0].lastSyncError, 'HTTP 503');

  let resolveSecond;
  let notifySecond;
  const secondFetched = new Promise(resolve => { notifySecond = resolve; });
  globalThis.fetch = () => new Promise(resolve => { resolveSecond = resolve; notifySecond(); });
  const resync = syncAllSkillManifests();
  await secondFetched;
  await removeManifestSource('https://example.com/skills.json');
  resolveSecond({ ok: true, json: async () => ({ skills: [{
    name: 'remote-test', label: 'Remote test', description: 'From deleted source',
    url_patterns: ['*://example.com/*'], guide: '', workflows: [], version: 1,
  }] }) });
  await resync;
  assert.deepEqual(values.actspan_skill_sources.sources, []);
  assert.equal((await registryService.listAll()).skills.some(skill => skill.source === 'remote'), false);
});
