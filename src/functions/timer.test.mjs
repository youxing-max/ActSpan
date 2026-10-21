import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: { contents: `export { timerFunction } from './src/functions/timer.ts'; export { TimerStore } from './src/lib/timer-store.ts';`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { timerFunction, TimerStore } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

const storage = {};
const alarms = new Set();
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.filter((key) => key in storage).map((key) => [key, storage[key]]));
      },
      set: async (items) => Object.assign(storage, items),
    },
  },
  alarms: {
    create: async (name) => { alarms.add(name); },
    clear: async (name) => { alarms.delete(name); return true; },
  },
};

test('timer mutations require approval', () => {
  const permissions = timerFunction.actionPermissions || {};
  for (const action of ['set_timeout', 'set_interval', 'set_schedule', 'update', 'clear']) {
    assert.equal(permissions[action], 'sensitive', `${action} 应为 sensitive`);
  }
  assert.equal(permissions.list, undefined);
});

test('resident AI without task identity cannot list or mutate timers', async () => {
  storage.actspan_timers = [
    { id: 'legacy-1', type: 'timeout', action: '旧任务', tabId: 0, createdAt: Date.now(), currentCount: 0 },
  ];
  storage.actspan_migrated_actspan_timers = true;

  const visible = await timerFunction.execute({ action: 'list' }, { owner: 'extension-agent' });
  assert.equal(visible.data.timers.length, 0);

  const denied = await timerFunction.execute({ action: 'clear', timer_id: 'legacy-1' }, { taskId: 'task-a' });
  assert.equal(denied.success, false);

  const byUser = await timerFunction.execute({ action: 'clear', timer_id: 'legacy-1' }, {});
  assert.equal(byUser.success, true);
});

test('concurrent TimerStore mutations do not lose or resurrect tasks', async () => {
  storage.actspan_timers = [];
  storage.actspan_migrated_actspan_timers = true;
  const task = (id) => ({
    id, type: 'timeout', action: `任务 ${id}`, tabId: 1, createdAt: Date.now(), currentCount: 0,
  });

  await Promise.all(Array.from({ length: 8 }, (_, index) => TimerStore.save(task(`t-${index}`))));
  assert.equal((await TimerStore.getAll()).length, 8);

  await TimerStore.save(task('t-0'));
  assert.equal((await TimerStore.getAll()).length, 8, '重复 save 不应产生重复任务');

  await Promise.all([TimerStore.remove('t-0'), TimerStore.save(task('t-0'))]);
  const remaining = await TimerStore.getAll();
  assert.equal(remaining.length, 8, '并发 remove/save 后总额不应丢失');
  assert.equal(remaining.filter(item => item.id === 't-0').length, 1);
});

test('timers are visible and mutable only by their owning task', async () => {
  const created = await timerFunction.execute(
    { action: 'set_timeout', delay_minutes: 60, task_action: '提醒我喝水', name: '喝水' },
    { taskId: 'task-a', sessionId: 'session-a' },
  );
  assert.equal(created.success, true);
  const timerId = created.data.timer_id;
  assert.ok(timerId);

  const otherList = await timerFunction.execute({ action: 'list' }, { taskId: 'task-b', sessionId: 'session-b' });
  assert.equal(otherList.data.timers.length, 0);

  const otherClear = await timerFunction.execute({ action: 'clear', timer_id: timerId }, { taskId: 'task-b' });
  assert.equal(otherClear.success, false);
  assert.match(otherClear.error, /无权/);

  const ownerClear = await timerFunction.execute({ action: 'clear', timer_id: timerId }, { taskId: 'task-a' });
  assert.equal(ownerClear.success, true);
});
