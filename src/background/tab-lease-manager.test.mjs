import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: { contents: `
    export { TabLeaseManager, TabLeaseError } from './src/background/tab-lease-manager.ts';
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { TabLeaseManager } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

const LEASE_TTL_MS = 10 * 60_000;

const makeTask = (overrides = {}) => ({
  taskId: 't1', sessionId: 's1', owner: 'ide-agent', clientId: 'c1',
  state: 'running', ownedTabIds: [], registryRevision: 0,
  createdAt: Date.now(), updatedAt: Date.now(), ...overrides,
});

const context = (task, tabId) => ({
  clientId: task.clientId, requestId: `r-${Math.random()}`,
  taskId: task.taskId, sessionId: task.sessionId, owner: task.owner, tabId,
});

test('acquire keeps the 10 minute default lease window', () => {
  const leases = new TabLeaseManager();
  const task = makeTask();
  const before = Date.now();
  const lease = leases.acquire(task, 31, 'c1');
  assert.ok(lease.expiresAt >= before + LEASE_TTL_MS - 5);
  assert.ok(lease.expiresAt <= Date.now() + LEASE_TTL_MS);
});

test('authorize renews the lease while the task is actively using the tab', () => {
  const leases = new TabLeaseManager();
  const task = makeTask();
  const lease = leases.acquire(task, 32, 'c1');
  // Simulate ~9 minutes of activity: still valid, but close to the original deadline.
  lease.expiresAt = Date.now() + 60_000;
  const nearExpiry = lease.expiresAt;
  const renewed = leases.authorize(context(task, 32), 32);
  assert.equal(renewed, lease);
  assert.ok(renewed.expiresAt > nearExpiry, 'active authorize must push the deadline out');
  assert.ok(renewed.expiresAt >= Date.now() + LEASE_TTL_MS - 5);
});

test('repeated active use outlives the original 10 minute deadline', () => {
  const leases = new TabLeaseManager();
  const task = makeTask();
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    const lease = leases.acquire(task, 33, 'c1');
    const originalDeadline = lease.expiresAt;
    assert.equal(originalDeadline, clock + LEASE_TTL_MS);
    // 9 minutes of authorized calls, then another 5 minutes — past the original deadline.
    for (let minute = 0; minute < 14; minute++) {
      clock += 60_000;
      leases.authorize(context(task, 33), 33);
    }
    assert.ok(clock > originalDeadline, 'simulated clock passed the original deadline');
    assert.ok(lease.expiresAt > clock, 'active lease stays valid past the original deadline');
    assert.equal(lease.expiresAt, clock + LEASE_TTL_MS);
  } finally {
    Date.now = realNow;
  }
});

test('an idle lease past its TTL is rejected once the clock crosses the deadline', () => {
  const leases = new TabLeaseManager();
  const task = makeTask();
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    leases.acquire(task, 35, 'c1');
    clock += LEASE_TTL_MS + 1;
    assert.throws(
      () => leases.authorize(context(task, 35), 35),
      (error) => error.code === 'E_TAB_OWNERSHIP',
    );
  } finally {
    Date.now = realNow;
  }
});

test('an idle lease past its TTL is still rejected and is not revived', () => {
  const leases = new TabLeaseManager();
  const task = makeTask();
  const lease = leases.acquire(task, 34, 'c1');
  lease.expiresAt = Date.now() - 1;
  const expiredAt = lease.expiresAt;
  assert.throws(
    () => leases.authorize(context(task, 34), 34),
    (error) => error.code === 'E_TAB_OWNERSHIP',
  );
  assert.equal(lease.expiresAt, expiredAt, 'a failed authorize must not extend the lease');
});

test('reclaim explicitly takes over an expired lease, releaseTab frees a closed tab', () => {
  const leases = new TabLeaseManager();
  const task = makeTask();
  const lease = leases.acquire(task, 36, 'c1');
  lease.expiresAt = Date.now() - 1;

  const reclaimed = leases.reclaim(context(task, 36), 36);
  assert.ok(reclaimed.expiresAt > Date.now(), 'reclaim must issue a fresh deadline');
  assert.doesNotThrow(() => leases.authorize(context(task, 36), 36));

  leases.releaseTab(36);
  assert.equal(leases.get(36), undefined);
  assert.throws(() => leases.authorize(context(task, 36), 36), /未拥有/);
});
