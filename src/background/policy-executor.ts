import { TabLeaseError, tabLeaseManager, TabLeaseManager } from './tab-lease-manager';
import { TaskManager, taskManager } from './task-manager';
import type { CapabilityHandler, PermissionLevel, PolicyDecision, TaskContext } from './task-types';

type CapabilityPolicy = PermissionLevel | ((input: Record<string, unknown>) => PermissionLevel);

const CAPABILITIES: Record<string, PermissionLevel> = {
  ping: 'read', 'tabs.list': 'read', 'tabs.select': 'read', 'registry.list': 'read', 'registry.detail': 'read', 'task.status': 'read', 'task.result': 'read',
  'page.read': 'read', 'page.snapshot': 'read', 'tab.open': 'interact', 'tab.navigate': 'interact', 'page.click': 'interact', 'page.type': 'interact',
  'task.submit': 'interact', 'workflow.run': 'interact', 'agent_delegate': 'interact', 'feishu.push': 'interact', 'task.cancel': 'interact', 'tab.close': 'sensitive',
  'page.screenshot': 'sensitive', 'page.eval': 'dangerous', 'task.*': 'interact',
};

export class PolicyError extends Error {
  readonly code: string;
  constructor(message: string, code = 'E_POLICY') { super(message); this.name = 'PolicyError'; this.code = code; }
}

export class Policy {
  private readonly capabilityPolicies = new Map<string, CapabilityPolicy>();

  registerCapabilityPolicy(capability: string, policy: CapabilityPolicy): void {
    this.capabilityPolicies.set(capability, policy);
  }

  unregisterCapabilityPolicy(capability: string): void {
    this.capabilityPolicies.delete(capability);
  }

  check(capability: string, context: TaskContext, input: Record<string, unknown> = {}): PolicyDecision {
    if (!context.clientId || !context.requestId || !context.taskId || !context.sessionId) throw new PolicyError('缺少请求绑定上下文', 'E_CONTEXT');
    const configured = this.capabilityPolicies.get(capability);
    const level = configured
      ? (typeof configured === 'function' ? configured(input) : configured)
      : CAPABILITIES[capability] || CAPABILITIES[capability.split('.')[0] + '.*'] || 'dangerous';
    // 自由化模式：requiresApproval 恒为 false。permission level 保留供审计/日志分级，
    // 但不再触发任何确认门。敏感/危险能力直接执行，调用方（MCP 客户端）自负其责。
    return { level, requiresApproval: false };
  }
}

export class PolicyExecutor {
  private readonly handlers = new Map<string, CapabilityHandler>();
  private readonly controllers = new Map<string, Set<AbortController>>();
  private readonly tasks: TaskManager;
  private readonly leases: TabLeaseManager;
  private readonly policy: Policy;
  constructor(
    tasks: TaskManager = taskManager,
    leases: TabLeaseManager = tabLeaseManager,
    policy = new Policy(),
  ) {
    // erasableSyntaxOnly 禁用参数属性：赋值必须显式写出。
    this.tasks = tasks;
    this.leases = leases;
    this.policy = policy;
    this.handlers.set('task.submit', async (input, context) => {
      const task = this.tasks.get(context.taskId) || this.tasks.create({ taskId: context.taskId, sessionId: context.sessionId, owner: context.owner, clientId: context.clientId, registryRevision: typeof input.registryRevision === 'number' ? input.registryRevision : 0, mode: input.mode === 'continue' || input.mode === 'replace' ? input.mode : 'independent' });
      void this.tasks.submit(task.taskId, input, context).catch(() => undefined);
      return { taskId: task.taskId, sessionId: task.sessionId, state: task.state };
    });
    this.handlers.set('task.status', async (_input, context) => this.tasks.get(context.taskId));
    this.handlers.set('task.result', async (_input, context) => {
      const task = this.tasks.get(context.taskId);
      return task ? { taskId: task.taskId, state: task.state, result: task.result, error: task.error } : undefined;
    });
    this.handlers.set('task.cancel', async (_input, context) => ({ taskId: context.taskId, cancelled: await this.cancel(context.taskId) }));
  }

  registerCapabilityHandler(capability: string, handler: CapabilityHandler, policy?: CapabilityPolicy): () => void {
    this.handlers.set(capability, handler);
    if (policy) this.policy.registerCapabilityPolicy(capability, policy);
    return () => {
      if (this.handlers.get(capability) !== handler) return;
      this.handlers.delete(capability);
      if (policy) this.policy.unregisterCapabilityPolicy(capability);
    };
  }
  // 自由化模式：无审批凭证机制。approve() 保留为空操作以兼容 mcp-bridge 的既有调用。
  approve(_requestId: string, _clientId: string, _taskId: string, _tabId?: number, _capability?: string): void { /* no-op */ }

  check(context: TaskContext, capability: string, input: Record<string, unknown> = {}): PolicyDecision {
    const tabId = typeof input.tabId === 'number' ? input.tabId
      : typeof input.tab_id === 'number' ? input.tab_id : context.tabId;
    return this.policy.check(capability, tabId === context.tabId ? context : { ...context, tabId }, input);
  }

  async execute(context: TaskContext, capability: string, input: Record<string, unknown> = {}): Promise<unknown> {
    const tabId = typeof input.tabId === 'number' ? input.tabId
      : typeof input.tab_id === 'number' ? input.tab_id : context.tabId;
    const decision = this.check(context, capability, input);
    let task = this.tasks.get(context.taskId);
    // 取消后的唯一观测入口是 task.status / task.result / task.cancel：它们不产生页副作用，
    // 必须能读到终态，也必须能重复调用。
    const cancellationExempt = capability === 'task.cancel' || capability === 'task.status' || capability === 'task.result';
    // 单动作能力在没有任务时自建任务；只有这种「本次调用自建」的任务才由执行器收尾。
    const selfTaskCapability = capability === 'tab.open' || capability === 'page.read'
      || capability === 'data.fetch' || capability === 'data.paginate' || capability === 'data.download';
    const taskCreation = capability === 'task.submit' || capability === 'workflow.run' || capability === 'feishu.push' || selfTaskCapability;
    const readOnly = decision.level === 'read';
    const noTaskRead = capability === 'ping' || capability === 'tabs.list' || capability === 'registry.list' || capability === 'registry.detail';
    const taskCreatedHere = !task && selfTaskCapability;
    if (taskCreatedHere) {
      task = this.tasks.create({ taskId: context.taskId, sessionId: context.sessionId, owner: context.owner, clientId: context.clientId });
    }
    if (!task && !taskCreation && (!readOnly || !noTaskRead)) {
      if (capability === 'page.status_update') {
        throw new PolicyError('状态播报需要先有属于本任务的标签页：请先调用 tab_open 取得租约，再播报进度', 'E_TASK_OWNERSHIP');
      }
      throw new PolicyError('未知任务不能执行浏览器能力', 'E_TASK_OWNERSHIP');
    }
    if (task && task.sessionId !== context.sessionId) throw new PolicyError('任务不属于当前 session', 'E_TASK_OWNERSHIP');
    if (task && task.clientId && task.clientId !== context.clientId) throw new PolicyError('任务不属于当前 client', 'E_TASK_OWNERSHIP');
    if (task && !cancellationExempt) this.tasks.assertNotCancelled(context.taskId);
    // tabs.select only updates our session's default slot; foreign IDs return a warning without touching the tab.
    if (tabId !== undefined && task && capability !== 'tabs.select') {
      this.leases.authorize(context, tabId, !readOnly);
    }
    const handler = this.handlers.get(capability) || this.handlers.get(capability.split('.')[0] + '.*');
    if (!handler) throw new PolicyError(`未注册能力: ${capability}`, 'E_CAPABILITY');
    const controller = new AbortController();
    const external = context.signal;
    const abort = () => controller.abort(external?.reason);
    external?.addEventListener('abort', abort, { once: true });
    let set = this.controllers.get(context.taskId);
    if (!set) { set = new Set(); this.controllers.set(context.taskId, set); }
    set.add(controller);
    const runContext = { ...context, signal: controller.signal };
    const assertActive = () => {
      if (controller.signal.aborted || (task && this.tasks.isCancelled(context.taskId))) {
        throw new PolicyError('任务已取消，未执行后续副作用', 'E_TASK_CANCELLED');
      }
    };
    const invoke = async () => {
      if (task && !cancellationExempt) {
        assertActive();
        this.tasks.markRunning(context.taskId);
      }
      if (!cancellationExempt) assertActive();
      const result = await handler(input, runContext);
      if (!cancellationExempt) assertActive();
      if (task && capability === 'tab.open' && result && typeof result === 'object' && 'tabId' in result && typeof result.tabId === 'number') {
        this.leases.acquire(task, result.tabId, context.clientId);
      }
      if (task && capability === 'tab.close' && tabId !== undefined) {
        this.leases.release(context.taskId, tabId, context.clientId);
        this.tasks.releaseOwnedTab(context.taskId, tabId);
      }
      // 只有本次调用自建的单动作任务由执行器收尾；已有任务的 state 归 runner / workflow 执行器。
      if (task && taskCreatedHere && context.workflowStep !== true && context.finalize !== false) {
        this.tasks.assertNotCancelled(context.taskId);
        this.tasks.markSucceeded(context.taskId, result);
      }
      return result;
    };
    try { return tabId !== undefined && capability !== 'tabs.select' ? await this.leases.serialize(tabId, invoke, controller.signal) : await invoke(); }
    catch (err) {
      if (task && this.tasks.isCancelled(context.taskId)) throw new PolicyError('任务已取消，未执行后续副作用', 'E_TASK_CANCELLED');
      if (task && context.workflowStep !== true) this.tasks.markFailed(context.taskId, normalizeError(err));
      throw err;
    } finally {
      external?.removeEventListener('abort', abort);
      set.delete(controller);
      if (!set.size) this.controllers.delete(context.taskId);
    }
  }

  async cancel(taskId: string): Promise<boolean> {
    const changed = this.tasks.cancel(taskId);
    if (!changed) return false;
    for (const controller of this.controllers.get(taskId) || []) controller.abort('cancelled');
    return true;
  }

  async recover(): Promise<void> { await this.tasks.restore(); }
}

function normalizeError(err: unknown): { code: string; message: string } {
  if (err instanceof TabLeaseError || err instanceof PolicyError) return { code: err.code, message: err.message };
  if (err && typeof err === 'object' && 'code' in err) {
    const code = err.code;
    if (typeof code === 'string' && (code === 'NEEDS_L2' || code === 'L2_BUSY')) {
      const message = 'message' in err && typeof err.message === 'string' ? err.message : code;
      return { code, message };
    }
  }
  return { code: 'E_TASK_EXECUTION', message: err instanceof Error ? err.message : String(err) };
}

export const policyExecutor = new PolicyExecutor();
export const getTaskExecutor = () => policyExecutor;
export const registerCapabilityHandler = (capability: string, handler: CapabilityHandler, policy?: CapabilityPolicy) =>
  policyExecutor.registerCapabilityHandler(capability, handler, policy);
export const getTaskManager = () => taskManager;
