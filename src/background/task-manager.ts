import type { BrowserTask, PersistedTaskState, TaskContext, TaskOwner } from './task-types';
import { INTERRUPTED_TASK_ERROR } from './task-types';
import { TabLeaseManager, tabLeaseManager } from './tab-lease-manager';

export type TaskRunner = (task: BrowserTask, input: Record<string, unknown>, context: TaskContext) => Promise<unknown>;
export type TerminalTaskListener = (task: BrowserTask) => void;

export const TASK_STATE_STORAGE_KEY = 'actspan_task_state';

export class TaskManager {
  private readonly tasks = new Map<string, BrowserTask>();
  private persistQueue: Promise<void> = Promise.resolve();
  private runner: TaskRunner | null = null;
  private readonly controllers = new Map<string, AbortController>();
  private readonly terminalListeners = new Set<TerminalTaskListener>();
  private readonly leases: TabLeaseManager;
  constructor(leases: TabLeaseManager = tabLeaseManager) {
    // erasableSyntaxOnly 禁用参数属性：赋值必须显式写出。
    this.leases = leases;
    leases.setChangeHandler(() => { void this.persist(); });
  }

  create(input: { taskId?: string; sessionId: string; owner: TaskOwner; clientId?: string; parentTaskId?: string; registryRevision?: number; ownedTabIds?: number[]; mode?: 'independent' | 'continue' | 'replace' }): BrowserTask {
    if (input.mode === 'continue' || input.mode === 'replace') this.cancelSession(input.sessionId, undefined, input.clientId);
    const now = Date.now();
    const task: BrowserTask = {
      taskId: input.taskId || `task_${now}_${Math.random().toString(36).slice(2, 8)}`,
      sessionId: input.sessionId,
      owner: input.owner,
      clientId: input.clientId,
      parentTaskId: input.parentTaskId,
      state: 'queued',
      ownedTabIds: [...(input.ownedTabIds || [])],
      registryRevision: input.registryRevision || 0,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.taskId, task);
    void this.persist();
    return task;
  }

  get(taskId: string): BrowserTask | undefined { return this.tasks.get(taskId); }
  list(sessionId?: string): BrowserTask[] { return [...this.tasks.values()].filter((t) => !sessionId || t.sessionId === sessionId); }
  has(taskId: string): boolean { return this.tasks.has(taskId); }
  onTerminal(listener: TerminalTaskListener): () => void {
    this.terminalListeners.add(listener);
    return () => this.terminalListeners.delete(listener);
  }

  update(taskId: string, patch: Partial<BrowserTask>): BrowserTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`未知任务: ${taskId}`);
    const previousState = task.state;
    Object.assign(task, patch, { updatedAt: Date.now() });
    void this.persist();
    if (previousState !== task.state && (task.state === 'succeeded' || task.state === 'failed' || task.state === 'cancelled')) {
      for (const listener of this.terminalListeners) {
        try { listener(task); } catch { /* status cleanup cannot change task outcome */ }
      }
    }
    return task;
  }
  async withNewTabs<T>(context: TaskContext, parentTabId: number, run: () => Promise<T>): Promise<{ result: T; parentTabId: number; tabId?: number; newTabIds?: number[] }> {
    const task = this.tasks.get(context.taskId);
    if (!task) throw new Error(`未知任务: ${context.taskId}`);
    this.assertNotCancelled(task.taskId);
    this.leases.authorizeWrite(context, parentTabId);
    const existing = new Set((await chrome.tabs.query({})).map((tab) => tab.id));
    const created = new Set<number>();
    const onCreated = (tab: chrome.tabs.Tab) => {
      if (tab.openerTabId === parentTabId && typeof tab.id === 'number' && !existing.has(tab.id)) created.add(tab.id);
    };
    const onTarget = (details: chrome.webNavigation.WebNavigationSourceCallbackDetails) => {
      if (details.sourceTabId === parentTabId && !existing.has(details.tabId)) created.add(details.tabId);
    };
    chrome.tabs.onCreated?.addListener(onCreated);
    chrome.webNavigation?.onCreatedNavigationTarget?.addListener(onTarget);
    try {
      this.assertNotCancelled(task.taskId);
      this.leases.authorizeWrite(context, parentTabId);
      const result = await run();
      for (const tab of await chrome.tabs.query({})) onCreated(tab);
      this.assertNotCancelled(task.taskId);
      this.leases.authorizeWrite(context, parentTabId);
      const newTabIds: number[] = [];
      for (const tabId of created) {
        this.leases.attachNewTab(task, parentTabId, tabId);
        newTabIds.push(tabId);
      }
      await this.persist();
      return newTabIds.length ? { result, parentTabId, tabId: newTabIds.at(-1), newTabIds } : { result, parentTabId };
    } finally {
      chrome.tabs.onCreated?.removeListener(onCreated);
      chrome.webNavigation?.onCreatedNavigationTarget?.removeListener(onTarget);
    }
  }


  setRunner(runner: TaskRunner | null): void { this.runner = runner; }
  createAbortController(taskId: string): AbortController {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`未知任务: ${taskId}`);
    const existing = this.controllers.get(taskId);
    if (existing) return existing;
    const controller = new AbortController();
    this.controllers.set(taskId, controller);
    if (task.state === 'cancelled') controller.abort('cancelled');
    return controller;
  }

  releaseAbortController(taskId: string, controller: AbortController): void {
    if (this.controllers.get(taskId) === controller) this.controllers.delete(taskId);
  }


  async submit(taskId: string, input: Record<string, unknown>, context: TaskContext): Promise<unknown> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`未知任务: ${taskId}`);
    if (!this.runner) {
      this.markFailed(taskId, { code: 'E_TASK_RUNNER_UNAVAILABLE', message: '扩展 Agent Loop 尚未注册。' });
      throw new Error('扩展 Agent Loop 尚未注册');
    }
    this.assertNotCancelled(taskId);
    this.markRunning(taskId);
    const controller = this.createAbortController(taskId);
    const abortExternal = () => controller.abort(context.signal?.reason);
    context.signal?.addEventListener('abort', abortExternal, { once: true });
    const runnerContext = { ...context, signal: controller.signal };
    try {
      const result = await this.runner(task, input, runnerContext);
      this.assertNotCancelled(taskId);
      this.markSucceeded(taskId, result);
      return result;
    } catch (error) {
      if (this.isCancelled(taskId)) throw error;
      this.markFailed(taskId, { code: 'E_TASK_EXECUTION', message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      context.signal?.removeEventListener('abort', abortExternal);
      if (this.controllers.get(taskId) === controller) this.controllers.delete(taskId);
    }
  }
  markRunning(taskId: string): void { const task = this.tasks.get(taskId); if (task && task.state === 'queued') this.update(taskId, { state: 'running' }); }
  markSucceeded(taskId: string, result: unknown): void { const task = this.tasks.get(taskId); if (task && task.state !== 'cancelled') this.update(taskId, { state: 'succeeded', result }); }
  markFailed(taskId: string, error: { code: string; message: string }): void { const task = this.tasks.get(taskId); if (task && task.state !== 'cancelled') this.update(taskId, { state: 'failed', error }); }
  isCancelled(taskId: string): boolean { return this.tasks.get(taskId)?.state === 'cancelled'; }
  async closeOwnedTabs(taskId: string, excludedTabIds: ReadonlySet<number> = new Set<number>()): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || typeof chrome === 'undefined' || !chrome.tabs?.remove) return;
    const allTabIds = [...new Set([
      ...task.ownedTabIds,
      ...this.leases.list(taskId).map((lease) => lease.tabId),
    ])];
    const tabIds = allTabIds.filter((tabId) => !excludedTabIds.has(tabId));
    for (const tabId of tabIds) {
      const lease = this.leases.get(tabId);
      const ownsTab = lease && !lease.releasedAt && lease.expiresAt > Date.now() &&
        lease.taskId === task.taskId && lease.sessionId === task.sessionId &&
        lease.clientId === (task.clientId || task.owner);
      if (!ownsTab) continue;
      try { await chrome.tabs.remove(tabId); } catch { /* 标签页可能已被用户关闭 */ }
      const current = this.leases.get(tabId);
      if (current?.taskId === task.taskId && current.sessionId === task.sessionId && current.clientId === (task.clientId || task.owner)) {
        this.leases.release(taskId, tabId, task.clientId);
      }
    }
    const remainingOwnedTabIds = task.ownedTabIds.filter((tabId) => excludedTabIds.has(tabId));
    if (tabIds.length > 0) this.update(taskId, {
      ownedTabIds: remainingOwnedTabIds,
      activeTabId: task.activeTabId !== undefined && excludedTabIds.has(task.activeTabId)
        ? task.activeTabId : remainingOwnedTabIds.at(-1),
    });
  }

  releaseOwnedTab(taskId: string, tabId: number): void {
    const task = this.tasks.get(taskId);
    if (!task || !task.ownedTabIds.includes(tabId)) return;
    const ownedTabIds = task.ownedTabIds.filter((id) => id !== tabId);
    this.update(taskId, {
      ownedTabIds,
      activeTabId: task.activeTabId === tabId ? ownedTabIds.at(-1) : task.activeTabId,
    });
  }

  assertNotCancelled(taskId: string): void { if (this.isCancelled(taskId)) throw new Error('任务已取消，未执行后续副作用'); }

  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.state === 'succeeded' || task.state === 'failed' || task.state === 'cancelled') return false;
    this.update(taskId, { state: 'cancelled' });
    this.controllers.get(taskId)?.abort('cancelled');
    void this.closeOwnedTabs(taskId);
    for (const child of this.tasks.values()) if (child.parentTaskId === taskId) this.cancel(child.taskId);
    return true;
  }
  cancelSession(sessionId: string, exceptTaskId?: string, clientId?: string): number {
    let cancelled = 0;
    for (const task of this.list(sessionId)) {
      if (task.taskId !== exceptTaskId && task.clientId === clientId && this.cancel(task.taskId)) cancelled++;
    }
    return cancelled;
  }

  async persist(): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    const state: PersistedTaskState = structuredClone({ version: 1, tasks: this.list(), leases: this.leases.snapshot(), ownTabs: this.leases.snapshotOwnTabs(), updatedAt: Date.now() });
    this.persistQueue = this.persistQueue.then(() => chrome.storage.local.set({ [TASK_STATE_STORAGE_KEY]: state })).catch(() => undefined);
    await this.persistQueue;
  }

  async restore(): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    const result = await chrome.storage.local.get(TASK_STATE_STORAGE_KEY);
    const state = result[TASK_STATE_STORAGE_KEY] as PersistedTaskState | undefined;
    if (!state || !Array.isArray(state.tasks)) return;
    this.tasks.clear();
    const now = Date.now();
    const interruptedTaskIds: string[] = [];
    for (const task of state.tasks) {
      if (!task?.taskId || !task.sessionId) continue;
      if (task.state === 'queued' || task.state === 'running' || task.state === 'waiting_user') {
        task.state = 'failed';
        task.error = { ...INTERRUPTED_TASK_ERROR };
        task.updatedAt = now;
        interruptedTaskIds.push(task.taskId);
      }
      this.tasks.set(task.taskId, task);
    }
    this.leases.restore(Array.isArray(state.leases) ? state.leases : []);
    this.leases.restoreOwnTabs(Array.isArray(state.ownTabs) ? state.ownTabs : (state.leases || []).filter((lease) => !lease.releasedAt).map((lease) => ({
      taskId: lease.taskId, sessionId: lease.sessionId, clientId: lease.clientId, tabId: lease.tabId,
      defaultSlot: this.tasks.get(lease.taskId)?.activeTabId === lease.tabId, createdAt: lease.createdAt, updatedAt: now,
    })));
    for (const taskId of interruptedTaskIds) await this.closeOwnedTabs(taskId);
    await this.persist();
  }
}

export const taskManager = new TaskManager();
