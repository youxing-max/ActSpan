import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `export { MAIN_FRAME_ID, parseQualifiedRef, frameSnapshotId, qualifyRef, routeFrameRef, listTabFrames } from './src/background/frame-routing.ts';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { MAIN_FRAME_ID, parseQualifiedRef, frameSnapshotId, qualifyRef, routeFrameRef, listTabFrames } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

test('an unqualified ref belongs to the main frame', () => {
  assert.deepEqual(parseQualifiedRef('ec-abc-1'), { baseRef: 'ec-abc-1', frameId: MAIN_FRAME_ID });
  assert.equal(qualifyRef('ec-abc-1', MAIN_FRAME_ID), 'ec-abc-1');
  assert.equal(frameSnapshotId('snap-1', MAIN_FRAME_ID), 'snap-1');
});

test('a frame-qualified ref carries its owning frame', () => {
  assert.deepEqual(parseQualifiedRef('ec-abc-1@f7'), { baseRef: 'ec-abc-1', frameId: 7 });
  assert.equal(qualifyRef('ec-abc-1', 7), 'ec-abc-1@f7');
  assert.equal(frameSnapshotId('snap-1', 7), 'snap-1@f7');
});

test('a forged or damaged suffix is rejected instead of falling back to the parent frame', () => {
  for (const forged of ['ec-abc-1@f', 'ec-abc-1@f-1', 'ec-abc-1@f1.5', 'ec-abc-1@frame', 'ec-abc-1@f1@f2', '@f2', 'ec-abc-1@']) {
    assert.equal(parseQualifiedRef(forged), null, `${forged} must not resolve to a frame`);
    assert.equal(routeFrameRef(forged, 'snap-1'), null, `${forged} must not be routed`);
  }
});

test('routing rewrites the ref and snapshot id for the target frame', () => {
  assert.deepEqual(routeFrameRef('ec-abc-1@f7', 'snap-1'), { baseRef: 'ec-abc-1', frameId: 7, snapshotId: 'snap-1@f7' });
  assert.deepEqual(routeFrameRef('ec-abc-1', 'snap-1'), { baseRef: 'ec-abc-1', frameId: MAIN_FRAME_ID, snapshotId: 'snap-1' });
  // 重复回传子框架 snapshotId 时按 tab 级 id 归一，避免叠加出 snap-1@f7@f7。
  assert.deepEqual(routeFrameRef('ec-abc-1@f7', 'snap-1@f7'), { baseRef: 'ec-abc-1', frameId: 7, snapshotId: 'snap-1@f7' });
});

test('frames are enumerated deterministically, main frame first', async () => {
  globalThis.chrome = { webNavigation: { getAllFrames: async () => [
    { frameId: 5, parentFrameId: 0, url: 'https://cross.example/inner.html' },
    { frameId: 0, parentFrameId: -1, url: 'https://host.example/page.html' },
    { frameId: 2, parentFrameId: 0, url: 'https://host.example/nested.html' },
  ] } };
  assert.deepEqual((await listTabFrames(1)).map((frame) => frame.frameId), [0, 2, 5]);
});

test('frame enumeration degrades to the main frame when the API is unavailable', async () => {
  globalThis.chrome = { webNavigation: { getAllFrames: async () => { throw new Error('no permission'); } } };
  assert.deepEqual((await listTabFrames(1)).map((frame) => frame.frameId), [MAIN_FRAME_ID]);
});
