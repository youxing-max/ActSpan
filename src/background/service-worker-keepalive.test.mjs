/**
 * Service Worker 保活测试
 * 覆盖：运行期间按引用计数启动心跳、全部释放后停止
 */

import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { build } from 'esbuild';

let pingCount = 0;
globalThis.chrome = {
  runtime: {
    getPlatformInfo(callback) {
      pingCount += 1;
      callback?.({ os: 'mac' });
    },
    lastError: undefined,
  },
};

const bundle = await build({
  stdin: {
    contents: `
      export {
        acquireServiceWorkerKeepAlive,
        getServiceWorkerKeepAliveState,
      } from './src/background/service-worker-keepalive.ts';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const {
  acquireServiceWorkerKeepAlive,
  getServiceWorkerKeepAliveState,
} = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`
);

test('多个并发任务共享心跳，全部释放后停止', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const before = pingCount;
    const releaseFirst = acquireServiceWorkerKeepAlive();
    const releaseSecond = acquireServiceWorkerKeepAlive();

    assert.deepEqual(getServiceWorkerKeepAliveState(), { refCount: 2, active: true });
    assert.equal(pingCount, before + 1);

    mock.timers.tick(20_000);
    assert.equal(pingCount, before + 2);

    releaseFirst();
    assert.deepEqual(getServiceWorkerKeepAliveState(), { refCount: 1, active: true });
    mock.timers.tick(20_000);
    assert.equal(pingCount, before + 3);

    releaseSecond();
    assert.deepEqual(getServiceWorkerKeepAliveState(), { refCount: 0, active: false });
    mock.timers.tick(20_000);
    assert.equal(pingCount, before + 3);

    // 重复释放不应把引用计数减成负数
    releaseSecond();
    assert.equal(getServiceWorkerKeepAliveState().refCount, 0);
  } finally {
    mock.timers.reset();
  }
});
