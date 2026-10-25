import type { BrowserTask, PersistedTaskState, TaskContext, TaskOwner } from './task-types';
import { INTERRUPTED_TASK_ERROR } from './task-types';
import { TabLeaseManager, tabLeaseManager } from './tab-lease-manager';

export type TaskRunner = (task: BrowserTask, input: Record<string, unknown>, context: TaskContext) => Promise<unknown>;
export type TerminalTaskListener = (task: BrowserTask) => void;

export const TASK_STATE_STORAGE_KEY = 'actspan_task_state';
/** 仅保留最近 N 个终态任务，防止结果（整页内容等）无限堆积 */
const MAX_RETAINED_TERMINAL_TASKS = 50;
const TERMINAL_TASK_STATES = new Set(['succeeded', 'failed', 'cancelled']);
const MAX_PERSISTED_RESULT_CHARS = 16_000;
const MAX_PERSISTED_ERROR_CHARS = 2_000;
const MAX_PERSISTED_OWNED_TABS = 50;

/** 把超大 JSON 字段替换为带大小/预览的占位符，保留“被截断”这一事实 */
const truncateJsonField = (value: unknown, limit: number): unknown => {
  let serialized = '';
  try {
    serialized = JSON.stringify(value) ?? '';
  } catch {
    return { truncated: true, reason: 'unserializable' };
  }
  if (serialized.length <= limit) return value;
  return { truncated: true, size: serialized.length, preview: serialized.slice(0, 1_000) };
};

/** 持久化前裁剪任务字段，避免单条任务撑爆 storage 配额 */
const sanitizeTaskForPersist = (task: BrowserTask): BrowserTask => {
  let sanitized: BrowserTask = task;
  if (task.error && task.error.message.length > MAX_PERSISTED_ERROR_CHARS) {
    sanitized = { ...sanitized, error: { ...task.error, message: `${task.error.message.slice(0, MAX_PERSISTED_ERROR_CHARS)}…[已截断]` } };
  }
  if (task.ownedTabIds.length > MAX_PERSISTED_OWNED_TABS) {
    sanitized = { ...sanitized, ownedTabIds: task.ownedTabIds.slice(-MAX_PERSISTED_OWNED_TABS) };
  }
  if (!TERMINAL_TASK_STATES.has(task.state) || task.result === undefined) return sanitized;
  const result = truncateJsonField(task.result, MAX_PERSISTED_RESULT_CHARS);
  return result === task.result ? sanitized : { ...sanitized, result };
};

export class TaskManager {
  private readonly tasks = new Map<string, BrowserTask>();
  private persistQueue: Promise<void> = Promise.resolve();
  private runner: TaskRunner | null = null;
  private readonly controllers = new Map<string, AbortController>();
  private readonly pruning = new Set<string>();
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

  /** 删除超出保留上限的最旧终态任务；运行中/等待中的任务永不删除 */
  private pruneTerminalTasks(): void {
    const terminal = [...this.tasks.values()].filter((task) => TERMINAL_TASK_STATES.has(task.state));
    if (terminal.length <= MAX_RETAINED_TERMINAL_TASKS) return;
    terminal.sort((left, right) => right.updatedAt - left.updatedAt);
    for (const stale of terminal.slice(MAX_RETAINED_TERMINAL_TASKS)) {
      if (this.controllers.has(stale.taskId) || this.pruning.has(stale.taskId)) continue;
      this.pruning.add(stale.taskId);
      // 先关标签页再删任务：closeOwnedTabs 需要读 tasks/leases，
      // 且它内部的 update(taskId) 要求任务记录仍然存在。
      void this.closeOwnedTabs(stale.taskId)
        .catch(() => { /* 关闭失败不阻塞淘汰 */ })
        .finally(() => {
          this.leases.release(stale.taskId);
          this.tasks.delete(stale.taskId);
          this.pruning.delete(stale.taskId);
          void this.persist();
        });
    }
  }
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
    if (previousState !== task.state && TERMINAL_TASK_STATES.has(task.state)) {
      this.pruneTerminalTasks();
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
    this.pruneTerminalTasks();
    const state: PersistedTaskState = structuredClone({
      version: 1,
      tasks: this.list().map(sanitizeTaskForPersist),
      leases: this.leases.snapshot(),
      ownTabs: this.leases.snapshotOwnTabs(),
      updatedAt: Date.now(),
    });
    this.persistQueue = this.persistQueue
      .then(() => chrome.storage.local.set({ [TASK_STATE_STORAGE_KEY]: state }))
      .catch((err) => {
        // 配额/序列化失败必须留下日志，否则任务状态会静默丢失
        console.error('[Actspan] 持久化任务状态失败:', err);
      });
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
        // loop:* 是聊天轮的内部任务，会话层会单独恢复/报错；
        // 这里再写成 E_TASK_RUNTIME_INTERRUPTED 会让历史任务列表出现大量误报。
        const isSessionLoopTask = task.taskId.startsWith('loop:');
        task.state = isSessionLoopTask ? 'cancelled' : 'failed';
        task.error = isSessionLoopTask
          ? { code: 'E_CANCELLED', message: '任务已结束' }
          : { ...INTERRUPTED_TASK_ERROR };
        task.updatedAt = now;
        interruptedTaskIds.push(task.taskId);
      }
      this.tasks.set(task.taskId, task);
    }
    // 恢复时同样执行保留上限，避免历史数据把内存和配额继续撑大
    this.pruneTerminalTasks();
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
