import type { BrowserTask, TabLease, TaskContext, TaskOwner } from './task-types';

export class TabLeaseError extends Error {
  constructor(message: string, public readonly code = 'E_TAB_LEASE') {
    super(message);
    this.name = 'TabLeaseError';
  }
}


/** Task/session/client keyed ownership and per-tab serialization. */
export class TabLeaseManager {
  private readonly leases = new Map<number, TabLease>();
  private readonly queues = new Map<number, Promise<void>>();
  private readonly debuggerOwners = new Map<number, string>();

  acquire(task: BrowserTask, tabId: number, clientId = task.clientId || task.owner, ttlMs = 10 * 60_000): TabLease {
    const now = Date.now();
    const current = this.leases.get(tabId);
    if (current && !current.releasedAt && current.expiresAt > now && current.taskId !== task.taskId) {
      throw new TabLeaseError(`标签页 ${tabId} 已被其他任务占用`, 'E_TAB_OWNERSHIP');
    }
    const lease: TabLease = {
      taskId: task.taskId,
      sessionId: task.sessionId,
      clientId,
      tabId,
      creator: task.owner,
      createdAt: current?.createdAt || now,
      expiresAt: now + Math.max(1_000, ttlMs),
    };
    this.leases.set(tabId, lease);
    if (!task.ownedTabIds.includes(tabId)) task.ownedTabIds.push(tabId);
    task.activeTabId = tabId;
    return lease;
  }

  authorize(context: TaskContext, tabId: number, write = true): TabLease {
    const lease = this.leases.get(tabId);
    if (!lease || lease.releasedAt || lease.expiresAt <= Date.now()) {
      throw new TabLeaseError(`任务未拥有标签页 ${tabId}`, 'E_TAB_OWNERSHIP');
    }
    if (lease.taskId !== context.taskId || lease.sessionId !== context.sessionId || lease.clientId !== context.clientId) {
      throw new TabLeaseError(`标签页 ${tabId} 不属于当前任务/客户端`, 'E_TAB_OWNERSHIP');
    }
    if (write && context.owner === 'user' && lease.creator !== 'user') {
      throw new TabLeaseError('用户任务不能写入其他创建者的标签页', 'E_TAB_OWNERSHIP');
    }
    return lease;
  }

  release(taskId: string, tabId?: number, clientId?: string): number {
    let released = 0;
    for (const [id, lease] of this.leases) {
      if (lease.taskId !== taskId || (tabId !== undefined && tabId !== id) || (clientId && clientId !== lease.clientId)) continue;
      if (!lease.releasedAt) { lease.releasedAt = Date.now(); released++; }
      if (this.debuggerOwners.get(id) === taskId) this.debuggerOwners.delete(id);
    }
    return released;
  }

  get(tabId: number): TabLease | undefined { return this.leases.get(tabId); }
  list(taskId?: string): TabLease[] {
    return [...this.leases.values()].filter((l) => !taskId || l.taskId === taskId);
  }

  async serialize<T>(tabId: number, run: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(tabId) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.queues.set(tabId, queued);
    await previous;
    try { return await run(); } finally {
      release();
      if (this.queues.get(tabId) === queued) this.queues.delete(tabId);
    }
  }

  async withDebugger<T>(context: TaskContext, tabId: number, attach: () => Promise<void>, detach: () => Promise<void>, run: () => Promise<T>): Promise<T> {
    this.authorize(context, tabId, true);
    const owner = this.debuggerOwners.get(tabId);
    if (owner && owner !== context.taskId) throw new TabLeaseError(`调试器已被任务 ${owner} 占用`, 'E_DEBUGGER_OWNERSHIP');
    const attached = owner === context.taskId;
    if (!attached) { await attach(); this.debuggerOwners.set(tabId, context.taskId); }
    try { return await run(); }
    finally {
      if (!attached && this.debuggerOwners.get(tabId) === context.taskId) {
        this.debuggerOwners.delete(tabId);
        await detach().catch(() => undefined);
      }
    }
  }

  snapshot(): TabLease[] { return this.list(); }
  restore(leases: TabLease[]): void {
    this.leases.clear();
    for (const lease of leases || []) if (!lease.releasedAt && lease.expiresAt > Date.now()) this.leases.set(lease.tabId, lease);
  }
}

export const tabLeaseManager = new TabLeaseManager();
export const leaseManager = tabLeaseManager;
