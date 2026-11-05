import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

// 保留真实存储、调度器和分发代码；仅隔离 AI 执行及浏览器副作用。
const bundle = await build({
  stdin: {
    contents: `export { restoreRuntimeTimers } from './src/background/timer-dispatch.ts';
      export { TimerScheduler } from './src/lib/timer-scheduler.ts';
      export { timerFunction } from './src/functions/timer.ts';`,
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'timer-execution-stubs', setup(builder) {
    const modules = {
      '../lib/channel': 'export default { sendToTab() {} };',
      './bg-tasks-manager': 'export const broadcastBgTasksChanged = async () => {};',
      './channel-handlers': 'export const showNotification = () => {};',
      './session-manager': `
        export const activeCoalescedTasks = new Set();
        export const hasRunningTasks = () => globalThis.__timerTest.busy;
        export const getRunningTasks = () => [];
        export const RuntimeResourceManager = { unregisterFromAllSessions() {} };
        export const restoreRuntimeSessions = async () => {};
        export const dispatchSessionOp = async (_key, run) => run();
        export const createSession = action => ({ id: action, status: 'done' });
        export const runSessionNow = async (_session, action) => {
          globalThis.__timerTest.runs.push({ action, at: Date.now() });
          await globalThis.__timerTest.runGate;
        };`,
    };
    builder.onResolve({ filter: /.*/ }, args => {
      if (args.importer.replaceAll('\\', '/').endsWith('/timer-dispatch.ts') && args.path in modules) {
        return { path: args.path, namespace: 'timer-stub' };
      }
    });
    builder.onLoad({ filter: /.*/, namespace: 'timer-stub' }, ({ path }) => ({ contents: modules[path] }));
  }}],
});

async function setup(t, overrides = {}) {
  const state = globalThis.__timerTest = { now: 100_000, busy: false, runs: [] };
  const task = {
    id: 'cycle', type: 'interval', action: '本地计数', tabId: 0, createdAt: 90_000,
    scheduleMode: 'runtime', intervalMs: 1000, nextRunAt: 100_250,
    currentCount: 0, maxCount: 10, ...overrides,
  };
  const storage = { actspan_timers: [task], actspan_migrated_actspan_timers: true };
  const alarms = new Map();
  const handles = new Map();
  const listeners = [];
  let nextHandle = 0;
  const schedule = (callback, delay, repeat) => {
    const id = ++nextHandle;
    handles.set(id, { callback, at: state.now + delay, repeat: repeat ? delay : 0 });
    return id;
  };
  t.mock.method(Date, 'now', () => state.now);
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => schedule(callback, delay, false));
  t.mock.method(globalThis, 'setInterval', (callback, delay) => schedule(callback, delay, true));
  t.mock.method(globalThis, 'clearTimeout', id => handles.delete(id));
  t.mock.method(globalThis, 'clearInterval', id => handles.delete(id));
  globalThis.chrome = {
    storage: { local: {
      get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys])
        .filter(key => key in storage).map(key => [key, structuredClone(storage[key])])),
      set: async items => Object.assign(storage, structuredClone(items)),
    } },
    alarms: {
      onAlarm: { addListener: listener => listeners.push(listener) },
      create: async (name, info) => alarms.set(name, { name, ...info }),
      clear: async name => alarms.delete(name),
      getAll: callback => callback([...alarms.values()]),
      get: (name, callback) => callback(alarms.get(name)),
    },
    tabs: { get: async () => { throw new Error('no tab'); } },
  };
  const mod = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}#${t.name}`);
  t.after(() => { delete globalThis.__timerTest; delete globalThis.chrome; });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const advance = async milliseconds => {
    const end = state.now + milliseconds;
    for (;;) {
      const next = [...handles.entries()].filter(([, item]) => item.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, item] = next;
      state.now = item.at;
      if (item.repeat) item.at += item.repeat;
      else handles.delete(id);
      item.callback();
      await settle();
    }
    state.now = end;
    await settle();
  };
  const fireAlarm = async () => {
    const alarm = alarms.get('actspan_timer_cycle');
    if (alarm?.periodInMinutes) alarm.when += alarm.periodInMinutes * 60_000;
    else alarms.delete('actspan_timer_cycle');
    for (const listener of listeners) listener({ name: 'actspan_timer_cycle' });
    await settle();
  };
  return { ...mod, state, storage, alarms, handles, advance, fireAlarm, settle };
}

test('恢复 runtime interval 时按记录的剩余时间触发，过期时保持原相位且不补跑欠账', async t => {
  const h = await setup(t);
  await h.restoreRuntimeTimers();
  await h.advance(249);
  assert.equal(h.state.runs.length, 0);
  await h.advance(1);
  assert.equal(h.state.runs.length, 1, '应在剩余 250ms 后执行，不能重新等待完整周期');
  await h.advance(1000);
  assert.deepEqual(h.state.runs.map(run => run.at), [100_250, 101_250]);
  h.TimerScheduler.clear('cycle');
  h.state.now = 104_600;
  await h.restoreRuntimeTimers();
  assert.equal(h.storage.actspan_timers[0].nextRunAt, 105_250);
  await h.advance(649);
  assert.equal(h.state.runs.length, 2);
  await h.advance(1);
  assert.equal(h.state.runs.length, 3, '恢复后只执行当前一轮');
});

test('周期 alarm 忙碌跳过一轮后仍可执行下一轮，且不消耗次数', async t => {
  const h = await setup(t, { scheduleMode: 'alarm', intervalMs: 60_000, nextRunAt: 100_000 });
  await h.restoreRuntimeTimers();
  await h.fireAlarm();
  assert.equal(h.state.runs.length, 1);
  h.state.now += 60_000;
  h.state.busy = true;
  await h.fireAlarm();
  assert.equal(h.storage.actspan_timers[0].currentCount, 1);
  assert.ok(h.alarms.has('actspan_timer_cycle'), '忙碌跳过不能永久丢失周期调度');
  h.state.busy = false;
  h.state.now += 60_000;
  await h.fireAlarm();
  assert.equal(h.state.runs.length, 2);
});

test('runtime 和 alarm 先后到达时同一轮只执行一次', async t => {
  const h = await setup(t, { nextRunAt: 101_000 });
  await h.restoreRuntimeTimers();
  await h.advance(1000);
  assert.equal(h.state.runs.length, 1);
  await h.fireAlarm();
  assert.equal(h.state.runs.length, 1, '晚到的旧 alarm 不能多执行一轮');
  assert.equal(h.storage.actspan_timers[0].currentCount, 1);
});

test('runtime 丢失后由 alarm 唤醒，重建运行时循环并在最大次数处清理', async t => {
  const h = await setup(t, { nextRunAt: 100_000, maxCount: 2 });
  await h.fireAlarm();
  assert.equal(h.state.runs.length, 1);
  assert.equal(h.TimerScheduler.isScheduled('cycle'), true, 'alarm 必须重建内存调度');
  await h.advance(1000);
  assert.equal(h.state.runs.length, 2);
  assert.equal(h.storage.actspan_timers.length, 0);
  assert.equal(h.TimerScheduler.isScheduled('cycle'), false);
  assert.equal(h.alarms.size, 0);
  await h.advance(10_000);
  assert.equal(h.state.runs.length, 2);
});

test('上一轮仍在执行时周期 alarm 保留后续调度，不并发启动任务', async t => {
  const h = await setup(t, { scheduleMode: 'alarm', intervalMs: 60_000, nextRunAt: 100_000 });
  let release;
  h.state.runGate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  await h.restoreRuntimeTimers();
  await h.fireAlarm();
  h.state.now += 60_000;
  await h.fireAlarm();
  assert.equal(h.state.runs.length, 1);
  assert.ok(h.alarms.has('actspan_timer_cycle'), '仍执行上一轮时也不能丢失后续 alarm');
  release();
  await h.settle();
  h.state.now += 60_000;
  await h.fireAlarm();
  assert.equal(h.state.runs.length, 2);
});

test('runtime 周期任务创建和更新时立即设置备份 alarm，取消后两通道均停止', async t => {
  const h = await setup(t);
  h.storage.actspan_timers = [];
  const result = await h.timerFunction.execute({
    action: 'set_interval', interval_ms: 1000, task_action: '本地计数',
  }, {});
  assert.equal(result.success, true);
  const id = result.data.timer_id;
  assert.equal(h.alarms.get(`actspan_timer_${id}`)?.when, 101_000, '首轮之前就需要持久兜底');
  await h.advance(250);
  const updated = await h.timerFunction.execute({ action: 'update', timer_id: id, interval_ms: 2000 }, {});
  assert.equal(updated.success, true);
  assert.equal(h.alarms.get(`actspan_timer_${id}`)?.when, 102_250);
  await h.advance(1999);
  assert.equal(h.state.runs.length, 0);
  await h.advance(1);
  assert.equal(h.state.runs.length, 1);
  const cleared = await h.timerFunction.execute({ action: 'clear', timer_id: id }, {});
  assert.equal(cleared.success, true);
  assert.equal(h.TimerScheduler.isScheduled(id), false);
  assert.equal(h.alarms.size, 0);
  assert.equal(h.handles.size, 0);
  await h.advance(5000);
  assert.equal(h.state.runs.length, 1);
});

test('更新周期时即使 alarm API 耗时，存储的执行时间也与 alarm 一致', async t => {
  const h = await setup(t, { scheduleMode: 'alarm', intervalMs: 60_000 });
  const createAlarm = chrome.alarms.create;
  t.mock.method(chrome.alarms, 'create', async (...args) => {
    await createAlarm(...args);
    h.state.now += 5;
  });
  const updated = await h.timerFunction.execute({ action: 'update', timer_id: 'cycle', interval_ms: 120_000 }, {});
  assert.equal(updated.success, true);
  const alarm = h.alarms.get('actspan_timer_cycle');
  assert.equal(h.storage.actspan_timers[0].nextRunAt, alarm.when);
  h.state.now = alarm.when;
  await h.fireAlarm();
  assert.equal(h.state.runs.length, 1, '不能把按时到达的 alarm 判定为尚未到期');
});
