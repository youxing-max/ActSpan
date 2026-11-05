import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: ['src/functions/tab-utils.ts'], bundle: true, write: false, format: 'esm', platform: 'node',
});
const { withHiddenTab } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const event = () => {
  const listeners = new Set();
  return { listeners, addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn),
    emit: (...args) => { for (const fn of [...listeners]) fn(...args); } };
};
const fixture = (overrides = {}) => {
  const previous = globalThis.chrome;
  const calls = [], onEvent = event(), onDetach = event(), onRemoved = event();
  let exists = true;
  const chrome = globalThis.chrome = {
    runtime: { id: 'kcmnglipboiheaicckjcinkdmpgjcgog' },
    tabs: {
      create: async (options) => { calls.push(['create', options]); return { id: 71 }; },
      update: async (id, options) => { calls.push(['update', id, options]); await overrides.update?.(api); },
      remove: async (id) => { calls.push(['remove', id]); await overrides.remove?.(api); exists = false; onRemoved.emit(id); },
      get: async () => { if (!exists) throw new Error('No tab'); return { id: 71 }; }, onRemoved,
    },
    debugger: {
      onEvent, onDetach,
      attach: async (target) => { calls.push(['attach', target]); await overrides.attach?.(api); },
      detach: async (target) => { calls.push(['detach', target]); onDetach.emit(target); },
      sendCommand: async (target, method, params) => { calls.push([method, target, params]); return await overrides.command?.(method, api); },
    },
  };
  const api = { calls, chrome, onEvent, onDetach, onRemoved,
    paused: (url, sessionId, resourceType = 'Document') => onEvent.emit({ tabId: 71, ...(sessionId ? { sessionId } : {}) }, 'Fetch.requestPaused', { requestId: 'request-1', request: { url }, resourceType }),
    restore: () => { globalThis.chrome = previous; },
  };
  return api;
};

test('隐藏页先装守卫再导航，正常公开请求继续且先关页后释放调试器', async () => {
  const f = fixture({ update: ({ paused }) => paused('https://other.example/page') });
  try {
    assert.equal(await withHiddenTab('https://example.com/start', async (id, signal) => {
      assert.equal(id, 71); assert.equal(signal.aborted, false); return 'content';
    }), 'content');
    assert.deepEqual(f.calls[0], ['create', { url: 'about:blank', active: false }]);
    const names = f.calls.map(([name]) => name);
    assert.ok(names.indexOf('Fetch.enable') < names.indexOf('update'));
    assert.ok(names.includes('Fetch.continueRequest'));
    assert.ok(names.indexOf('remove') < names.indexOf('detach'));
    assert.equal(f.onEvent.listeners.size + f.onDetach.listeners.size, 0);
  } finally { f.restore(); }
});

test('私网重定向在请求阶段失败，不执行解析器', async () => {
  for (const url of ['http://127.0.0.1/private', 'http://[::1]/private', 'http://192.168.0.1/private']) {
    const f = fixture({ update: ({ paused }) => paused(url) });
    let ran = false;
    try {
      await assert.rejects(withHiddenTab('https://example.com/start', async () => { ran = true; }), /内网/);
      assert.equal(ran, false);
      assert.ok(f.calls.some(([name]) => name === 'Fetch.failRequest'));
      assert.ok(!f.calls.some(([name]) => name === 'Fetch.continueRequest'));
      assert.equal(f.onEvent.listeners.size + f.onDetach.listeners.size, 0);
    } finally { f.restore(); }
  }
});

test('允许自身扩展静态资源，其他扩展和非 HTTP 地址仍拒绝', async () => {
  const ownLogo = 'chrome-extension://kcmnglipboiheaicckjcinkdmpgjcgog/actspan-logo.svg';
  const allowed = fixture({ update: ({ paused }) => paused(ownLogo, undefined, 'Image') });
  try {
    assert.equal(await withHiddenTab('https://example.com', async () => 'content'), 'content');
    assert.ok(allowed.calls.some(([name]) => name === 'Fetch.continueRequest'));
    assert.ok(!allowed.calls.some(([name]) => name === 'Fetch.failRequest'));
  } finally { allowed.restore(); }
  for (const [url, resourceType, sessionId] of [
    ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/actspan-logo.svg', 'Image'],
    ['chrome-extension://kcmnglipboiheaicckjcinkdmpgjcgog.evil/actspan-logo.svg', 'Image'],
    ['file:///private.txt', 'Image'],
    ['http://127.0.0.1/private', 'Image'],
    [ownLogo, 'Document'],
    [ownLogo, 'Document', 'child'],
  ]) {
    const f = fixture({ update: ({ paused }) => paused(url, sessionId, resourceType) });
    try {
      await assert.rejects(withHiddenTab('https://example.com', async () => assert.fail('runner')), /拒绝/);
      assert.ok(f.calls.some(([name]) => name === 'Fetch.failRequest'));
      assert.ok(!f.calls.some(([name]) => name === 'Fetch.continueRequest'));
    } finally { f.restore(); }
  }
});

test('跨进程 iframe 先继承守卫再继续运行，子会话命令不发往主会话', async () => {
  const f = fixture({ update: async ({ onEvent, paused }) => {
    onEvent.emit({ tabId: 71 }, 'Target.attachedToTarget', { sessionId: 'child', targetInfo: { type: 'iframe' }, waitingForDebugger: true });
    await tick();
    paused('http://127.0.0.1/subresource', 'child');
  } });
  try {
    await assert.rejects(withHiddenTab('https://example.com/start', async () => 'should not run'), /内网/);
    const child = f.calls.filter(([, target]) => target?.sessionId === 'child');
    const names = child.map(([name]) => name);
    assert.ok(names.includes('Fetch.enable'));
    assert.ok(names.indexOf('Fetch.enable') < names.indexOf('Runtime.runIfWaitingForDebugger'));
    assert.ok(names.includes('Fetch.failRequest'));
  } finally { f.restore(); }
});

test('取消或调试器断开会结束尚未完成的解析并关闭页面', async () => {
  for (const kind of ['abort', 'detach', 'blocked']) {
    const controller = new AbortController(), f = fixture();
    let guarded;
    try {
      const pending = withHiddenTab('https://example.com/start', async (_id, signal) => {
        guarded = signal;
        return new Promise(() => {});
      }, controller.signal);
      await tick();
      if (kind === 'abort') controller.abort();
      if (kind === 'detach') f.onDetach.emit({ tabId: 71 });
      if (kind === 'blocked') f.paused('http://localhost/');
      await assert.rejects(pending, kind === 'abort' ? /aborted/ : kind === 'detach' ? /断开/ : /内网/);
      assert.equal(guarded.aborted, true);
      assert.ok(f.calls.some(([name]) => name === 'remove'));
      assert.equal(f.onEvent.listeners.size + f.onDetach.listeners.size, 0);
    } finally { f.restore(); }
  }
});

test('解析器因守卫取消而先拒绝时保留具体拒绝原因', async () => {
  for (const kind of ['blocked', 'detach']) {
    const f = fixture();
    try {
      const pending = withHiddenTab('https://example.com', (_id, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }));
      await tick();
      if (kind === 'blocked') f.paused('http://127.0.0.1/private');
      else f.onDetach.emit({ tabId: 71 });
      await assert.rejects(pending, kind === 'blocked' ? /内网/ : /守卫已断开/);
      assert.ok(f.calls.some(([name]) => name === 'remove'));
    } finally { f.restore(); }
  }
});

test('安装期间失败或取消都不继续导航且关闭空白页', async () => {
  for (const stage of ['attach', 'Fetch.enable', 'update']) {
    const f = fixture({
      attach: () => { if (stage === 'attach') throw new Error('fixture failed'); },
      command: (method) => { if (method === stage) throw new Error('fixture failed'); },
      update: () => { if (stage === 'update') throw new Error('fixture failed'); },
    });
    try {
      await assert.rejects(withHiddenTab('https://example.com', async () => assert.fail('runner')), /fixture failed/);
      if (stage !== 'update') assert.ok(!f.calls.some(([name]) => name === 'update'));
      assert.ok(f.calls.some(([name]) => name === 'remove'));
      assert.equal(f.onEvent.listeners.size + f.onDetach.listeners.size, 0);
    } finally { f.restore(); }
  }
  const controller = new AbortController(), f = fixture({ attach: () => controller.abort() });
  try {
    await assert.rejects(withHiddenTab('https://example.com', async () => assert.fail('runner'), controller.signal), /aborted/);
    assert.ok(!f.calls.some(([name]) => name === 'update'));
  } finally { f.restore(); }
});

test('安装命令未返回时取消或断开仍立即关页，晚到的 attach 不遗留调试器', async () => {
  for (const stage of ['attach', 'Fetch.enable', 'Target.setAutoAttach', 'update']) {
    for (const interruption of ['abort', 'detach']) {
      const controller = new AbortController();
      let release, entered;
      const blocked = new Promise((resolve) => { release = resolve; });
      const started = new Promise((resolve) => { entered = resolve; });
      const pause = async () => { entered(); await blocked; };
      const f = fixture({
        attach: () => { if (stage === 'attach') return pause(); },
        command: (method) => { if (method === stage) return pause(); },
        update: () => { if (stage === 'update') return pause(); },
      });
      let settled = false;
      const pending = withHiddenTab('https://example.com', async () => assert.fail('runner'), controller.signal)
        .then(() => { settled = true; return null; }, (error) => { settled = true; return error; });
      try {
        await started;
        if (interruption === 'abort') controller.abort();
        else f.onDetach.emit({ tabId: 71 });
        await tick();
        assert.equal(settled, true, `${stage}/${interruption} must not await the pending Chrome command`);
        assert.match((await pending).message, interruption === 'abort' ? /aborted/ : /断开/);
        assert.ok(f.calls.some(([name]) => name === 'remove'));
        if (stage === 'attach') assert.ok(!f.calls.some(([name]) => name === 'detach'));
        release();
        await tick();
        const names = f.calls.map(([name]) => name);
        assert.ok(names.indexOf('remove') < names.indexOf('detach'));
        assert.equal(names.filter((name) => name === 'detach').length, 1);
        if (stage !== 'update') assert.ok(!names.includes('update'));
        assert.equal(f.onEvent.listeners.size + f.onDetach.listeners.size, 0);
      } finally {
        release();
        await pending;
        f.restore();
      }
    }
  }
});

test('晚到 attach 在关页未完成或失败时不提前释放，实际关页后只释放一次', async () => {
  for (const closeFails of [false, true]) {
    const controller = new AbortController();
    let releaseAttach, releaseClose;
    const attachWait = new Promise((resolve) => { releaseAttach = resolve; });
    const closeWait = new Promise((resolve) => { releaseClose = resolve; });
    const f = fixture({ attach: () => attachWait, remove: async () => {
      if (closeFails) throw new Error('close failed');
      await closeWait;
    } });
    const pending = withHiddenTab('https://example.com', async () => assert.fail('runner'), controller.signal)
      .then(() => null, (error) => error);
    try {
      await tick();
      controller.abort();
      await tick();
      assert.ok(f.calls.some(([name]) => name === 'remove'));
      releaseAttach();
      await tick();
      assert.ok(!f.calls.some(([name]) => name === 'detach'));
      if (closeFails) {
        assert.match((await pending).message, /aborted/);
        f.onRemoved.emit(71);
      } else {
        releaseClose();
        assert.match((await pending).message, /aborted/);
      }
      await tick();
      assert.equal(f.calls.filter(([name]) => name === 'detach').length, 1);
      assert.equal(f.onEvent.listeners.size + f.onDetach.listeners.size + f.onRemoved.listeners.size, 0);
    } finally {
      releaseAttach(); releaseClose();
      await pending;
      f.restore();
    }
  }
});

test('关页失败保留拒绝请求的守卫，页面实际关闭才清理监听', async () => {
  const f = fixture({ remove: () => { throw new Error('close failed'); } });
  try {
    await assert.rejects(withHiddenTab('https://example.com', async () => 'content'), /close failed/);
    assert.ok(!f.calls.some(([name]) => name === 'detach'));
    f.paused('https://example.com/next');
    await tick();
    assert.equal(f.calls.at(-1)[0], 'Fetch.failRequest');
    f.onRemoved.emit(71);
    assert.equal(f.onEvent.listeners.size + f.onDetach.listeners.size + f.onRemoved.listeners.size, 0);
  } finally { f.restore(); }
});

test('关页失败不覆盖解析器或守卫原始错误，保留拦截直到页面关闭', async () => {
  for (const kind of ['runner', 'guard']) {
    const f = fixture({ remove: () => { throw new Error('close failed'); } });
    try {
      const pending = withHiddenTab('https://example.com', async () => {
        if (kind === 'runner') throw new Error('runner failed');
        f.paused('http://127.0.0.1/private');
        return new Promise(() => {});
      });
      await assert.rejects(pending, kind === 'runner' ? /runner failed/ : /内网/);
      assert.ok(!f.calls.some(([name]) => name === 'detach'));
      f.paused('https://example.com/next');
      assert.equal(f.calls.at(-1)[0], 'Fetch.failRequest');
      f.onRemoved.emit(71);
      await tick();
      assert.equal(f.calls.filter(([name]) => name === 'detach').length, 1);
      assert.equal(f.onEvent.listeners.size + f.onDetach.listeners.size + f.onRemoved.listeners.size, 0);
    } finally { f.restore(); }
  }
});

test('已取消和初始内网 URL 不创建页面', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  try {
    await assert.rejects(withHiddenTab('https://example.com', async () => {}, controller.signal), /aborted/);
    await assert.rejects(withHiddenTab('http://127.0.0.1', async () => {}), /内网/);
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});
