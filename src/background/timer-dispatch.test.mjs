/**
 * restoreRuntimeTimers 必须在扩展重载后补回 alarm 模式任务：
 * 过期的任务立即补触发一次，未到期的按原 nextRunAt 重建 alarm。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const now = Date.now();
const storage = {
  actspan_timers: [
    {
      id: 't_expired',
      type: 'timeout',
      action: '过期的延时任务',
      tabId: 0,
      createdAt: now - 120_000,
      nextRunAt: now - 60_000,
      scheduleMode: 'alarm',
      precision: 'minute',
      currentCount: 0,
    },
    {
      id: 't_future',
      type: 'schedule',
      action: '未来的定时任务',
      tabId: 0,
      createdAt: now - 120_000,
      nextRunAt: now + 60_000,
      scheduleMode: 'alarm',
      precision: 'minute',
      currentCount: 0,
      scheduleRule: 'daily:09:00',
    },
    {
      id: 't_runtime',
      type: 'timeout',
      action: '毫秒级延时任务',
      tabId: 0,
      createdAt: now - 60_000,
      nextRunAt: now - 1_000,
      scheduleMode: 'runtime',
      precision: 'millisecond',
      currentCount: 0,
    },
  ],
};

const createdAlarms = [];
const alarmListeners = [];
const notificationMessages = [];
globalThis.chrome = {
  storage: {
    local: {
      get(keys, callback) {
        const names = Array.isArray(keys) ? keys : [keys];
        const result = Object.fromEntries(
          names.filter((key) => key in storage).map((key) => [key, storage[key]]),
        );
        if (callback) { callback(result); return; }
        return Promise.resolve(result);
      },
      set(items, callback) {
        Object.assign(storage, items);
        if (callback) { callback(); return; }
        return Promise.resolve();
      },
    },
    onChanged: { addListener() {} },
  },
  alarms: {
    onAlarm: { addListener: (listener) => { alarmListeners.push(listener); } },
    create(name, info) { createdAlarms.push({ name, ...info }); return Promise.resolve(); },
    clear() { return Promise.resolve(true); },
    getAll(callback) { callback([]); },
    get(_name, callback) { callback(undefined); },
  },
  tabs: {
    sendMessage() {},
    get: () => Promise.reject(new Error('no tab')),
    onRemoved: { addListener() {} },
  },
  notifications: { create: (...args) => { const opts = typeof args[0] === 'object' ? args[0] : args[1]; notificationMessages.push(opts?.title); return Promise.resolve('notification-id'); } },
  runtime: { id: 'actspan-test', getURL: () => 'chrome-extension://actspan-test/', lastError: undefined },
};

const bundle = await build({
  stdin: {
    contents: `
      export { restoreRuntimeTimers } from './src/background/timer-dispatch.ts';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { restoreRuntimeTimers } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`
);

test('restore 时为过期的 alarm 任务立即补触发一次，并重建未来任务的 alarm', async () => {
  await restoreRuntimeTimers();

  const expired = createdAlarms.find((alarm) => alarm.name === 'actspan_timer_t_expired');
  assert.ok(expired, '过期的 alarm 任务必须重建 alarm 以补触发');
  assert.ok(expired.when <= Date.now() + 100, '过期任务应立即触发而不是再等一分钟');

  // 触发恢复出来的 alarm：过期任务必须执行一次并清理
  assert.ok(alarmListeners.length >= 1);
  for (const listener of alarmListeners) listener({ name: 'actspan_timer_t_expired' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    storage.actspan_timers.some((task) => task.id === 't_expired'),
    false,
    '过期任务应在恢复后被触发一次并清理',
  );

  const future = createdAlarms.find((alarm) => alarm.name === 'actspan_timer_t_future');
  assert.ok(future, '未到期的 alarm 任务必须重建 alarm');
  assert.equal(future.when, now + 60_000);

  // runtime 模式任务仍走内存定时器（过期的 timeout 立即触发并被清理）
  const runtimeAlarm = createdAlarms.find((alarm) => alarm.name === 'actspan_timer_t_runtime');
  assert.equal(runtimeAlarm, undefined, 'runtime 模式任务不应创建 alarm');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(
    storage.actspan_timers.some((task) => task.id === 't_runtime'),
    false,
    'runtime timeout 应被内存定时器触发并清理',
  );

  // 本用例中 chrome.tabs.get 永远 reject（原标签页已关闭）：
  // 任务仍必须执行（会话已创建并运行完成，见上方清理断言），
  // 且完成后发送的是「已完成」通知而不是旧的「无法推送结果」。
  assert.deepEqual(notificationMessages, ['定时任务已完成', '定时任务已完成']);
});
