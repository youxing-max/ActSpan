import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const storage = {};
const listeners = new Set();
const commands = [];
const messages = [];
let attached = false;
let attachError = '';
let capturePermission = false;
let offscreenFailure = '';
const video = 'data:video/webm;base64,GkXfow==';
globalThis.chrome = {
  storage: { session: {
    async get(key) { return { [key]: storage[key] }; },
    async set(data) { Object.assign(storage, structuredClone(data)); },
  } },
  runtime: {
    lastError: undefined,
    getPlatformInfo(callback) { callback({}); },
    sendMessage(message, callback) {
      messages.push(message);
      callback(offscreenFailure && message.type !== 'screen_record_ping'
        ? { success: false, error: offscreenFailure }
        : { success: true, dataUrl: video, sizeBytes: 4, active: false, ready: true });
    },
  },
  tabs: { async update() {}, async get(id) { return { id, windowId: 1 }; } },
  windows: { async update() {} },
  offscreen: { async hasDocument() { return true; }, async createDocument() {} },
  tabCapture: { getMediaStreamId(_args, callback) {
    chrome.runtime.lastError = capturePermission ? undefined : { message: 'activeTab permission required' };
    callback(capturePermission ? 'test-stream' : '');
    chrome.runtime.lastError = undefined;
  } },
  debugger: {
    async attach() { if (attachError) throw Error(attachError); attached = true; },
    async detach() { attached = false; },
    async sendCommand(_target, method) { commands.push(method); return {}; },
    onEvent: { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); } },
  },
};
const bundle = await build({
  stdin: { contents: `export {screenRecordFunction} from './src/functions/screen-record.ts';
    export {getServiceWorkerKeepAliveState} from './src/background/service-worker-keepalive.ts';`, loader: 'ts', resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'recording-cdp', setup(b) {
    b.onResolve({ filter: /\/cdp-session$/ }, () => ({ path: 'cdp', namespace: 'recording-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'recording-stub' }, () => ({ contents: `export const CDPSessionManager={
      async attach(id){try{await chrome.debugger.attach({tabId:id});return {success:true}}catch(e){return {success:false,error:e.message}}},
      async detach(id){await chrome.debugger.detach({tabId:id});return {success:true}},
      async sendCommand(id,method,params){try{if(!globalThis.recordingTestAttached()){await chrome.debugger.attach({tabId:id})}return {success:true,result:await chrome.debugger.sendCommand({tabId:id},method,params)}}catch(e){return {success:false,error:e.message}}}};` }));
  } }],
});
const { screenRecordFunction: tool, getServiceWorkerKeepAliveState } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
globalThis.recordingTestAttached = () => attached;
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(setImmediate); };
const reset = async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  attachError = ''; capturePermission = false; offscreenFailure = '';
  storage.actspan_screen_record_state = { active: false };
  attached = false; commands.length = 0; messages.length = 0;
  t.after(async () => { offscreenFailure = ''; await tool.execute({ action: 'cancel' }); });
};

test('cancel stops screencast, detaches and releases recording keepalive', async t => {
  await reset(t);
  assert.equal((await tool.execute({ action: 'start', tab_id: 17 })).success, true);
  assert.equal(attached, true);
  assert.equal((await tool.execute({ action: 'cancel' })).success, true);
  assert.equal(attached, false);
  assert.ok(commands.includes('Page.stopScreencast'));
  assert.equal(listeners.size, 0);
  assert.equal(getServiceWorkerKeepAliveState().refCount, 0);
});

test('duration limit stops capture but keeps the finished video available for stop', async t => {
  await reset(t);
  assert.equal((await tool.execute({ action: 'start', tab_id: 18, max_duration_seconds: 1 })).success, true);
  for (const listener of listeners) listener({ tabId: 18 }, 'Page.screencastFrame', { data: 'aW1hZ2U=', sessionId: 1 });
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(attached, false);
  assert.equal((await tool.execute({ action: 'state' })).data.active, false);
  assert.equal((await tool.execute({ action: 'start', tab_id: 19 })).success, false, 'uncollected output must not be overwritten');
  const result = await tool.execute({ action: 'stop', save_mode: 'inline' });
  assert.equal(result.success, true);
  assert.equal(result.data.format, 'webm');
  assert.equal(result.data.data_url, video);
  assert.ok(messages.some(m => m.type === 'screen_record_frame'), 'encode during capture rather than buffering frames for a hidden rAF loop');
  assert.equal(getServiceWorkerKeepAliveState().refCount, 0);
});

test('failed debugger start leaves no frame listener or active recording', async t => {
  await reset(t); attachError = 'another debugger is attached';
  const result = await tool.execute({ action: 'start', tab_id: 20 });
  assert.equal(result.success, false);
  assert.equal(listeners.size, 0);
  assert.equal(storage.actspan_screen_record_state.active, false);
  assert.equal(getServiceWorkerKeepAliveState().refCount, 0);
});

test('encoding failure returns an error instead of a mislabeled HTML video', async t => {
  await reset(t);
  assert.equal((await tool.execute({ action: 'start', tab_id: 21 })).success, true);
  for (const listener of listeners) listener({ tabId: 21 }, 'Page.screencastFrame', { data: 'aW1hZ2U=', sessionId: 1 });
  await flush(); offscreenFailure = 'encoder unavailable';
  const result = await tool.execute({ action: 'stop', save_mode: 'inline' });
  assert.equal(result.success, false);
  assert.match(result.error, /encoder unavailable/);
  assert.equal(attached, false);
});

test('tabCapture start failure cleans resources without claiming a recording started', async t => {
  await reset(t); capturePermission = true; offscreenFailure = 'media start failed';
  const result = await tool.execute({ action: 'start', tab_id: 22 });
  assert.equal(result.success, false);
  assert.equal(storage.actspan_screen_record_state.active, false);
  assert.equal(getServiceWorkerKeepAliveState().refCount, 0);
});
