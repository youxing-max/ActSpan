import type { BrowserTask, SessionTabRecord, TabLease, TaskContext } from './task-types';

const L2_IDLE_MS = 5000;

interface DebuggerLease {
  taskId: string;
  detach: () => Promise<void>;
  timer: ReturnType<typeof setTimeout>;
}

export class TabLeaseError extends Error {
  readonly code: string;
  constructor(message: string, code = 'E_TAB_LEASE') {
    super(message);
    this.name = 'TabLeaseError';
    this.code = code;
  }
}
const waitForPromise = (promise: Promise<void>, signal?: AbortSignal): Promise<void> => {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new TabLeaseError('任务已取消，未执行后续副作用', 'E_TASK_CANCELLED'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new TabLeaseError('任务已取消，未执行后续副作用', 'E_TASK_CANCELLED'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, (error) => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
};


/** Task/session/client keyed ownership and per-tab serialization. */
export class TabLeaseManager {
  private readonly leases = new Map<number, TabLease>();
  private readonly queues = new Map<number, Promise<void>>();
  private readonly debuggerOwners = new Map<number, string>();
  private readonly debuggerLeases = new Map<number, DebuggerLease>();
  private readonly ownTabs = new Map<number, SessionTabRecord>();
  private readonly disconnected = new Set<string>();
  private readonly reminders = new Map<string, number>();
  private onChange: () => void = () => undefined;

  setChangeHandler(handler: () => void): void { this.onChange = handler; }
  private sessionKey(context: { clientId: string; sessionId: string }): string {
    return JSON.stringify([context.clientId, context.sessionId]);
  }

  setSessionConnected(context: { clientId: string; sessionId: string }, connected: boolean): void {
    const key = this.sessionKey(context);
    if (connected) this.disconnected.delete(key);
    else this.disconnected.add(key);
  }

  private conflict(context: { clientId: string; sessionId: string }, tabId: number): SessionTabRecord | undefined {
    const record = this.ownTabs.get(tabId);
    if (!record || this.sessionKey(record) === this.sessionKey(context) || this.disconnected.has(this.sessionKey(record))) return;
    const lease = this.leases.get(tabId);
    return lease && !lease.releasedAt && lease.expiresAt > Date.now() ? record : undefined;
  }

  private ownershipError(tabId: number): TabLeaseError {
    return new TabLeaseError(`标签页 ${tabId} 不属于当前任务/客户端，仍被其他会话占用。请先调用 tabs.list 找回自己的标签页，或新建标签页；待原主人断开后再显式接管。`, 'E_TAB_OWNERSHIP');
  }

  registerTab(task: BrowserTask, tabId: number, options: { label?: string; defaultSlot?: boolean } = {}): SessionTabRecord {
    const context = { taskId: task.taskId, sessionId: task.sessionId, clientId: task.clientId || task.owner, owner: task.owner, requestId: 'register' };
    this.authorize(context, tabId, false);
    const previous = this.ownTabs.get(tabId);
    const sameSession = previous && this.sessionKey(previous) === this.sessionKey(context);
    const defaultSlot = options.defaultSlot ?? (sameSession ? previous.defaultSlot : ![...this.ownTabs.values()].some((record) => this.sessionKey(record) === this.sessionKey(context) && record.defaultSlot));
    if (defaultSlot) for (const record of this.ownTabs.values()) if (this.sessionKey(record) === this.sessionKey(context)) record.defaultSlot = false;
    const record: SessionTabRecord = {
      taskId: task.taskId, sessionId: task.sessionId, clientId: context.clientId, tabId,
      label: options.label ?? (sameSession ? previous.label : undefined), defaultSlot,
      createdAt: sameSession ? previous.createdAt : Date.now(), updatedAt: Date.now(),
    };
    this.ownTabs.set(tabId, record);
    task.activeTabId = [...this.ownTabs.values()].find((item) => item.taskId === task.taskId && this.sessionKey(item) === this.sessionKey(context) && item.defaultSlot)?.tabId ?? tabId;
    this.onChange();
    return { ...record };
  }

  authorizeWrite(context: TaskContext, tabId: number): TabLease {
    if (context.signal?.aborted) throw new TabLeaseError('任务已取消，未执行后续副作用', 'E_TASK_CANCELLED');
    if (this.conflict(context, tabId)) throw this.ownershipError(tabId);
    return this.authorize(context, tabId, true);
  }

  selectTab(context: Pick<TaskContext, 'taskId' | 'sessionId' | 'clientId'>, tabId: number): { tabId: number; warning?: string } {
    if (this.conflict(context, tabId)) return { tabId, warning: this.ownershipError(tabId).message };
    const record = this.ownTabs.get(tabId);
    if (record && this.sessionKey(record) === this.sessionKey(context)) {
      for (const item of this.ownTabs.values()) if (this.sessionKey(item) === this.sessionKey(context)) item.defaultSlot = item.tabId === tabId;
      this.onChange();
    }
    return { tabId };
  }

  listTabs(context: { sessionId: string; clientId: string }): Array<{ tabId: number; sessionId: string; clientId: string; taskId: string; label?: string; marker: '*' | '+' | '×' }> {
    return [...this.ownTabs.values()].map((record) => ({
      tabId: record.tabId, sessionId: record.sessionId, clientId: record.clientId, taskId: record.taskId, label: record.label,
      marker: this.sessionKey(record) === this.sessionKey(context) ? record.defaultSlot ? '*' : '+' : '×',
    }));
  }

  getReminder(context: { sessionId: string; clientId: string; tabId?: number }, now = Date.now()): string | undefined {
    if (context.tabId !== undefined) return;
    const key = this.sessionKey(context);
    if ([...this.ownTabs.values()].filter((record) => this.sessionKey(record) === key).length < 2) return;
    const previous = this.reminders.get(key);
    if (previous !== undefined && now - previous < 10 * 60_000) return;
    this.reminders.set(key, now);
    return '本会话有多个工作标签页，请使用显式 tabId，避免缺省槽切错工作线。';
  }

  attachNewTab(task: BrowserTask, parentTabId: number, tabId: number, label?: string): { parentTabId: number; tabId: number } {
    const context = { taskId: task.taskId, sessionId: task.sessionId, clientId: task.clientId || task.owner, owner: task.owner, requestId: 'new-tab' };
    this.authorizeWrite(context, parentTabId);
    if (tabId === parentTabId || this.leases.has(tabId) || this.ownTabs.has(tabId)) throw new TabLeaseError('只有实际新标签页才能附加到创建者', 'E_TAB_NOT_NEW');
    this.acquire(task, tabId, context.clientId);
    this.registerTab(task, tabId, { label, defaultSlot: true });
    return { parentTabId, tabId };
  }

  snapshotOwnTabs(): SessionTabRecord[] { return [...this.ownTabs.values()].map((record) => ({ ...record })); }

  restoreOwnTabs(records: SessionTabRecord[]): void {
    this.ownTabs.clear();
    for (const record of records) this.ownTabs.set(record.tabId, { ...record });
  }

  acquire(task: BrowserTask, tabId: number, clientId = task.clientId || task.owner, ttlMs = 10 * 60_000): TabLease {
    if (task.clientId && task.clientId !== clientId) throw this.ownershipError(tabId);
    const now = Date.now();
    const current = this.leases.get(tabId);
    if (this.conflict({ sessionId: task.sessionId, clientId }, tabId)) throw this.ownershipError(tabId);
    if (current && !current.releasedAt && current.expiresAt > now &&
      (current.taskId !== task.taskId || current.sessionId !== task.sessionId || current.clientId !== clientId) &&
      !this.disconnected.has(this.sessionKey(current))) {
      throw this.ownershipError(tabId);
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
    task.clientId = clientId;
    if (!task.ownedTabIds.includes(tabId)) task.ownedTabIds.push(tabId);
    task.activeTabId = tabId;
    this.registerTab(task, tabId);
    return lease;
  }

  authorize(context: TaskContext, tabId: number, write = true): TabLease {
    const lease = this.leases.get(tabId);
    if (!lease || lease.releasedAt || lease.expiresAt <= Date.now()) {
      throw new TabLeaseError(`任务未拥有标签页 ${tabId}。请调用 tabs.list 选择自己的标签页，或先新建标签页取得租约。`, 'E_TAB_OWNERSHIP');
    }
    if (lease.taskId !== context.taskId || lease.sessionId !== context.sessionId || lease.clientId !== context.clientId) {
      throw this.ownershipError(tabId);
    }
    if (write && context.owner === 'user' && lease.creator !== 'user') {
      throw new TabLeaseError('用户任务不能写入其他创建者的标签页', 'E_TAB_OWNERSHIP');
    }
    this.disconnected.delete(this.sessionKey(context));
    return lease;
  }

  release(taskId: string, tabId?: number, clientId?: string): number {
    let released = 0;
    for (const [id, lease] of this.leases) {
      if (lease.taskId !== taskId || (tabId !== undefined && tabId !== id) || (clientId && clientId !== lease.clientId)) continue;
      if (!lease.releasedAt) { lease.releasedAt = Date.now(); released++; }
      const record = this.ownTabs.get(id);
      if (record?.taskId === taskId && record.clientId === lease.clientId && record.sessionId === lease.sessionId) this.ownTabs.delete(id);
      if (this.debuggerOwners.get(id) === taskId) this.debuggerOwners.delete(id);
      const debuggerLease = this.debuggerLeases.get(id);
      if (debuggerLease?.taskId === taskId) {
        clearTimeout(debuggerLease.timer);
        this.debuggerLeases.delete(id);
        void debuggerLease.detach().catch(() => undefined);
      }
    }
    this.onChange();
    return released;
  }

  get(tabId: number): TabLease | undefined { return this.leases.get(tabId); }
  list(taskId?: string): TabLease[] {
    return [...this.leases.values()].filter((l) => !taskId || l.taskId === taskId);
  }

  async serialize<T>(tabId: number, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new TabLeaseError('任务已取消，未执行后续副作用', 'E_TASK_CANCELLED');
    const previous = this.queues.get(tabId) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.queues.set(tabId, queued);
    let entered = false;
    try {
      await waitForPromise(previous, signal);
      if (signal?.aborted) throw new TabLeaseError('任务已取消，未执行后续副作用', 'E_TASK_CANCELLED');
      entered = true;
      return await run();
    } finally {
      if (entered) release();
      else void previous.then(release, release);
      void queued.then(() => {
        if (this.queues.get(tabId) === queued) this.queues.delete(tabId);
      }, () => {
        if (this.queues.get(tabId) === queued) this.queues.delete(tabId);
      });
    }
  }

  private armDebuggerIdle(tabId: number, taskId: string, detach: () => Promise<void>): void {
    const previous = this.debuggerLeases.get(tabId);
    clearTimeout(previous?.timer);
    const timer = setTimeout(() => {
      const lease = this.debuggerLeases.get(tabId);
      if (!lease || lease.taskId !== taskId) return;
      this.debuggerLeases.delete(tabId);
      if (this.debuggerOwners.get(tabId) === taskId) this.debuggerOwners.delete(tabId);
      void detach().catch(() => undefined);
    }, L2_IDLE_MS);
    this.debuggerLeases.set(tabId, { taskId, detach, timer });
  }

  async withDebugger<T>(context: TaskContext, tabId: number, attach: () => Promise<void>, detach: () => Promise<void>, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.authorizeWrite(context, tabId);
    if (signal?.aborted) throw new TabLeaseError('任务已取消，未执行后续副作用', 'E_TASK_CANCELLED');
    const owner = this.debuggerOwners.get(tabId);
    if (owner && owner !== context.taskId) throw new TabLeaseError(`调试器已被任务 ${owner} 占用`, 'E_DEBUGGER_OWNERSHIP');
    const lease = this.debuggerLeases.get(tabId);
    const attached = owner === context.taskId && lease?.taskId === context.taskId;
    if (!attached) {
      await attach();
      this.debuggerOwners.set(tabId, context.taskId);
    }
    try {
      if (signal?.aborted) throw new TabLeaseError('任务已取消，未执行后续副作用', 'E_TASK_CANCELLED');
      this.authorizeWrite(context, tabId);
      const result = await run();
      this.armDebuggerIdle(tabId, context.taskId, detach);
      return result;
    } catch (error) {
      if (!attached && this.debuggerOwners.get(tabId) === context.taskId) {
        this.debuggerLeases.delete(tabId);
        this.debuggerOwners.delete(tabId);
        await detach().catch(() => undefined);
      }
      throw error;
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
