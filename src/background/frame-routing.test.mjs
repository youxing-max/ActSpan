import assert from 'node:assert/strict';
import test from 'node:test';
import { routeFrameRef, frameSnapshotId, qualifyRef, parseQualifiedRef, MAIN_FRAME_ID } from './frame-routing.ts';

test('主框架 ref 不带后缀，snapshotId 沿用 tab 级', () => {
  const route = routeFrameRef('ec-abc-1', 'snap-1');
  assert.deepEqual(route, { baseRef: 'ec-abc-1', frameId: MAIN_FRAME_ID, snapshotId: 'snap-1' });
});

test('子框架 ref 剥后缀并推导框架级 snapshotId', () => {
  const route = routeFrameRef('ec-abc-1@f467', 'snap-1');
  assert.deepEqual(route, { baseRef: 'ec-abc-1', frameId: 467, snapshotId: 'snap-1@f467' });
});

test('二次路由幂等：已剥后缀的 ref + 框架级 snapshotId 仍路由到原框架', () => {
  // 模拟 page.click 复审路径：target 已被 routeActionTarget 路由过一次，
  // ref 无后缀、snapshotId 带 @f467——再次路由不得降级到主框架。
  const first = routeFrameRef('ec-abc-1@f467', 'snap-1');
  const second = routeFrameRef(first.baseRef, first.snapshotId);
  assert.equal(second.frameId, 467, '二次路由必须保持原框架');
  assert.equal(second.snapshotId, 'snap-1@f467');
});

test('非法后缀一律拒绝，不回退父框架', () => {
  assert.equal(routeFrameRef('ec-abc-1@xyz', 'snap-1'), null);
  assert.equal(routeFrameRef('a@f2@f3', 'snap-1'), null, '嵌套后缀同样非法');
});

test('qualifyRef/frameSnapshotId/parseQualifiedRef 互逆', () => {
  assert.equal(qualifyRef('ec-abc-1', 467), 'ec-abc-1@f467');
  assert.equal(frameSnapshotId('snap-1', 467), 'snap-1@f467');
  assert.equal(frameSnapshotId('snap-1', MAIN_FRAME_ID), 'snap-1');
  assert.deepEqual(parseQualifiedRef('ec-abc-1@f467'), { baseRef: 'ec-abc-1', frameId: 467 });
  assert.deepEqual(parseQualifiedRef('ec-abc-1'), { baseRef: 'ec-abc-1', frameId: MAIN_FRAME_ID });
});
