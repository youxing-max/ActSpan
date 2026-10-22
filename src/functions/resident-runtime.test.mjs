import assert from 'node:assert/strict';
import { build } from 'esbuild';
import test from 'node:test';

const bundle = await build({
  stdin: {
    contents: `export { residentRuntimeFunction } from './src/functions/resident-runtime.ts';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { residentRuntimeFunction } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

test('resident start rejects a missing workflow before creating a job', async () => {
  const values = {};
  const alarms = [];
  globalThis.chrome = {
    storage: {
      local: {
        get(key, callback) {
          const result = key == null ? structuredClone(values) : { [key]: structuredClone(values[key]) };
          callback?.(result);
          return Promise.resolve(result);
        },
        set(items, callback) {
          Object.assign(values, structuredClone(items));
          callback?.();
          return Promise.resolve();
        },
      },
    },
    runtime: { getURL: () => '' },
    alarms: {
      onAlarm: { addListener() {} },
      create(name) { alarms.push(name); },
      clear() {},
      getAll(callback) { callback([]); },
    },
  };

  const result = await residentRuntimeFunction.execute({
    action: 'start',
    site_workflow: 'missing-workflow',
    tab_id: 1,
  });

  assert.equal(result.success, false);
  assert.match(result.error, /missing-workflow/);
  assert.equal(values.actspan_resident_runtime_jobs_v1, undefined);
  assert.equal(alarms.some(name => name.startsWith('actspan_resident_job_')), false);
});
