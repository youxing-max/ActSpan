import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

let listener;
let sampled = 0;
let stopped = 0;
let failConstructor = false;
let recorders = [];
const makeStream = () => {
  const track = { stop() { stopped++; }, requestFrame() { sampled++; } };
  return { getTracks: () => [track], getVideoTracks: () => [track] };
};
globalThis.chrome = { runtime: { onMessage: { addListener(fn) { listener = fn; } } } };
globalThis.document = { createElement() {
  return { getContext: () => ({ drawImage() {} }), captureStream: () => makeStream() };
} };
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => makeStream() } } });
globalThis.Image = class {
  naturalWidth = 640;
  naturalHeight = 360;
  set src(value) { setImmediate(() => value.endsWith('bad') ? this.onerror() : this.onload()); }
};
globalThis.MediaRecorder = class {
  static isTypeSupported() { return true; }
  state = 'inactive';
  constructor() { if (failConstructor) throw Error('encoder initialization failed'); recorders.push(this); }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    setImmediate(() => {
      this.ondataavailable?.({ data: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])]) });
      this.onstop?.();
    });
  }
};
const bundle = await build({ entryPoints: ['src/offscreen/screen-capture.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { initScreenCapture } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
initScreenCapture();
const send = (type, args = {}) => new Promise(resolve => listener({ type, ...args }, {}, resolve));

test('hidden canvas recording samples frames explicitly and waits for final encoded data', async () => {
  assert.equal((await send('screen_record_canvas_start')).success, true);
  await Promise.all([send('screen_record_frame', { data: 'frame1' }), send('screen_record_frame', { data: 'frame2' })]);
  assert.equal(sampled, 2);
  assert.equal(recorders.length, 1);
  assert.equal((await send('screen_record_finish')).success, true);
  const result = await send('screen_record_stop');
  assert.equal(result.success, true);
  assert.equal(result.dataUrl, 'data:video/webm;base64,GkXfow==');
  assert.equal(result.sizeBytes, 4);
  assert.equal(stopped, 1);
});

test('cancel waits for final events, discards output and permits a fresh recording', async () => {
  await send('screen_record_canvas_start');
  await send('screen_record_frame', { data: 'frame' });
  assert.equal((await send('screen_record_cancel')).success, true);
  assert.equal((await send('screen_record_stop')).success, false);
  assert.equal((await send('screen_record_canvas_start')).success, true);
  await send('screen_record_frame', { data: 'new-frame' });
  const result = await send('screen_record_stop');
  assert.equal(result.sizeBytes, 4, 'cancelled chunks cannot leak into the new recording');
});

test('tabCapture automatic stop retains final data for a later stop request', async () => {
  assert.equal((await send('screen_record_start', { streamId: 'test-stream', maxDurationMs: 1 })).success, true);
  await new Promise(resolve => setTimeout(resolve, 10));
  const result = await send('screen_record_stop');
  assert.equal(result.success, true);
  assert.equal(result.sizeBytes, 4);
});

test('failed MediaRecorder initialization releases captured tracks', async () => {
  const before = stopped;
  failConstructor = true;
  const result = await send('screen_record_start', { streamId: 'test-stream' });
  failConstructor = false;
  assert.equal(result.success, false);
  assert.equal(stopped, before + 1);
  await send('screen_record_cancel');
});

test('invalid frame decoding reports failure and cancellation clears it', async () => {
  await send('screen_record_canvas_start');
  assert.equal((await send('screen_record_frame', { data: 'bad' })).success, false);
  const result = await send('screen_record_stop');
  assert.equal(result.success, false);
  assert.match(result.error, /帧解码失败/);
  await send('screen_record_cancel');
});
