import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `export * from './src/background/workflow-recorder.ts';
      export { useRecorder } from './src/content/float-ball/hooks/useRecorder.ts';
      export { default as Channel } from './src/lib/channel';`,
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'recorder-fixture', setup(build) {
    const mocks = {
      react: `export const useCallback=f=>f; export const useRef=v=>({current:v});
        export const useEffect=f=>{const cleanup=f(); if(cleanup) globalThis.fixture.cleanups.push(cleanup)};`,
      useActspan: `export const useActspan=()=>({state:globalThis.fixture.state,dispatch:({type,payload})=>{
        if(type==='SET_RECORDING') Object.assign(globalThis.fixture.state,payload);
      }});`,
      channel: `const handlers=new Map(); export default {
        on(t,f){handlers.set(t,f)},off(t){handlers.delete(t)},
        send(t,d,cb){globalThis.fixture.sent.push({type:t,data:d});return handlers.get(t)?.(d,{tab:{id:7}},cb)},
        sendToTab(id,t,d,cb){globalThis.fixture.toTab.push({id,type:t,data:d});
          if(t==='__recorder_end'&&globalThis.fixture.holdEnd){globalThis.fixture.end=()=>handlers.get(t)?.(d,{},cb);return}
          if(t==='__recorder_end'&&globalThis.fixture.failEnd){cb?.();return}
          return handlers.get(t)?.(d,{},cb)},broadcast(){}
      };`,
      'recorder-overlay': `export const showRecorderOverlay=(_stop,cancel)=>{globalThis.fixture.cancel=cancel};
        export const updateRecorderStepCount=()=>{}; export const hideRecorderOverlay=()=>{};`,
      'llm-client': 'export const chatComplete=()=>{throw Error("AI must not run")};',
      'session-manager': 'export const buildSessionSyncPayload=()=>{},createSession=()=>{},createSessionPushEvent=()=>{},flushFeishuCompletionNotifications=()=>{},persistRuntimeSessions=()=>{};',
      'artifact-store': 'export const ArtifactStore={saveScreenshot:()=>{throw Error("unexpected screenshot")}};',
      'workflow-recorder-save': 'export const saveAuditedWorkflow=()=>{};',
    };
    build.onResolve({ filter: /.*/ }, args => {
      const key = args.path.split('/').at(-1).replace(/\.ts$/, '');
      if (Object.hasOwn(mocks, key)) return { path: key, namespace: 'fixture' };
    });
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js' }));
  }}],
});

let run = 0;
async function fixture() {
  const listeners = new Map();
  const f = globalThis.fixture = { state: { isRecording: false }, sent: [], toTab: [], cleanups: [], stored: {} };
  globalThis.window = { location: { href: 'https://test.invalid/form' }, setTimeout, clearTimeout };
  globalThis.document = {
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
  };
  globalThis.CSS = { escape: value => value };
  globalThis.chrome = {
    storage: { session: {
      async get() { return {}; }, async set(data) { f.stored = structuredClone(data); }, async remove() { f.stored = {}; },
    } },
    webNavigation: { onCreatedNavigationTarget: { addListener() {}, removeListener() {} }, onCompleted: { addListener() {}, removeListener() {} } },
    tabs: { async get() { return { active: false }; } },
  };
  const module = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}#${run++}`);
  await new Promise(setImmediate);
  const hook = module.useRecorder();
  await new Promise(setImmediate);
  hook.startRecording();
  const field = (id, value = '', type = 'text') => ({
    id, value, type, tagName: 'INPUT', closest: () => null, getAttribute: () => null,
  });
  const emit = (type, target) => listeners.get(type)?.({ target });
  const cleanup = () => { f.cleanups.forEach(fn => fn()); module.recorderCancel(); };
  return { ...module, f, field, emit, cleanup };
}

await test('立即停止返回防抖中的最后输入，重复停止不重复追加', async () => {
  const x = await fixture();
  try {
    x.emit('input', x.field('text', '最后一段😀'));
    const [a, b] = await Promise.all([x.recorderStop(), x.recorderStop()]);
    assert.equal(a.success, true);
    assert.deepEqual(a.steps.map(s => [s.action, s.value]), [['type', '最后一段😀']]);
    assert.deepEqual(b.steps, a.steps);
    assert.equal((await x.recorderStop()).steps.length, 1);
    assert.equal(x.f.stored.actspan_recorder_state.active, false);
    assert.equal(x.f.toTab.filter(m => m.type === '__recorder_end' && m.data.flush).length, 1);
  } finally { x.cleanup(); }
});

await test('清空输入后换字段、快速点击保持真实步骤次序', async () => {
  const x = await fixture();
  try {
    x.emit('input', x.field('first', ''));
    x.emit('input', x.field('second', '内容'));
    x.emit('click', { ...x.field('button'), tagName: 'BUTTON', textContent: '继续' });
    const result = await x.recorderStop();
    assert.deepEqual(result.steps.map(s => [s.action, s.selector, s.value]), [
      ['type', '#first', ''], ['type', '#second', '内容'], ['click', '#button', undefined],
    ]);
  } finally { x.cleanup(); }
});

await test('停止握手交回的密码在页面内脱敏', async () => {
  const x = await fixture();
  try {
    x.emit('input', x.field('password', 'secret-do-not-persist', 'password'));
    const result = await x.recorderStop();
    assert.equal(result.steps.length, 1);
    assert.equal(JSON.stringify(result).includes('secret-do-not-persist'), false);
    assert.equal(JSON.stringify(x.f.stored).includes('secret-do-not-persist'), false);
  } finally { x.cleanup(); }
});

await test('取消丢弃待输入，停止响应晚到不能复活录制', async () => {
  const x = await fixture();
  try {
    x.emit('input', x.field('text', 'discard'));
    x.f.holdEnd = true;
    const stopped = x.recorderStop();
    const respond = x.f.end;
    x.recorderCancel();
    respond();
    assert.equal((await stopped).success, false);
    assert.equal(await x.recorderGetState(), null);
    assert.equal(x.f.sent.some(m => m.type === '__recorder_step'), false);
  } finally { x.cleanup(); }
});

await test('接收端失联明确失败且保留已有步骤，重试后可停止', async () => {
  const x = await fixture();
  try {
    x.emit('input', x.field('text', '保留'));
    x.f.failEnd = true;
    assert.equal((await x.recorderStop()).success, false);
    assert.equal((await x.recorderGetState()).active, true);
    x.f.failEnd = false;
    assert.equal((await x.recorderStop()).steps[0].value, '保留');
  } finally { x.cleanup(); }
});
