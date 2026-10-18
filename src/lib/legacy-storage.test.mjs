import assert from 'node:assert/strict';
import test from 'node:test';
import { readMigratedStorage } from './legacy-storage.ts';

const storage = (initial = {}) => {
  const values = { ...initial };
  const writes = [];
  return {
    values,
    writes,
    async get(keys) {
      return Object.fromEntries((Array.isArray(keys) ? keys : [keys])
        .filter(key => key in values).map(key => [key, values[key]]));
    },
    async set(items) {
      writes.push(items);
      Object.assign(values, items);
    },
  };
};

test('copies a legacy value once and never resurrects it after deleting the new value', async () => {
  const area = storage({ mole_timers: [{ id: 'old' }] });
  assert.deepEqual(await readMigratedStorage(area, 'actspan_timers', 'mole_timers'), [{ id: 'old' }]);
  assert.deepEqual(area.values.actspan_timers, [{ id: 'old' }]);
  assert.equal(area.writes.length, 1);
  delete area.values.actspan_timers;
  assert.equal(await readMigratedStorage(area, 'actspan_timers', 'mole_timers'), undefined);
  assert.equal(area.writes.length, 1);
});

test('preserves existing Actspan data over legacy data', async () => {
  const area = storage({ mole_timers: ['old'], actspan_timers: ['new'] });
  assert.deepEqual(await readMigratedStorage(area, 'actspan_timers', 'mole_timers'), ['new']);
  assert.equal(area.writes.some(items => 'mole_timers' in items), false);
});
