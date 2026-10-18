import { TabLeaseError, tabLeaseManager, TabLeaseManager } from './tab-lease-manager';
import { TaskManager, taskManager } from './task-manager';
import type { CapabilityHandler, PermissionLevel, PolicyDecision, TaskContext } from './task-types';

const CAPABILITIES: Record<string, PermissionLevel> = {
  ping: 'read', 'tabs.list': 'read', 'registry.list': 'read', 'registry.detail': 'read', 'task.status': 'read', 'task.result': 'read',
  'page.read': 'read', 'tab.open': 'interact', 'tab.navigate': 'interact', 'page.click': 'interact', 'page.type': 'interact',
  'task.submit': 'interact', 'workflow.run': 'interact', 'agent_delegate': 'interact', 'feishu.push': 'interact', 'task.cancel': 'interact', 'tab.close': 'sensitive',
  'page.screenshot': 'sensitive', 'page.eval': 'dangerous', 'task.*': 'interact',
};

export class PolicyError extends Error {
  constructor(message: string, public readonly code = 'E_POLICY') { super(message); this.name = 'PolicyError'; }
}

export class Policy {
  check(capability: string, context: TaskContext): PolicyDecision {
    if (!context.clientId || !context.requestId || !context.taskId || !context.sessionId) throw new PolicyError('缺少请求绑定上下文', 'E_CONTEXT');
    const level = CAPABILITIES[capability] || CAPABILITIES[capability.split('.')[0] + '.*'] || 'dangerous';
    const requiresApproval = level === 'dangerous' || level === 'sensitive' || (level === 'interact' && context.tabId !== undefined);
    return { level, requiresApproval };
  }
}

export class PolicyExecutor {
  private readonly handlers = new Map<string, CapabilityHandler>();
  private readonly controllers = new Map<string, Set<AbortController>>();
  private readonly approvals = new Set<string>();
  constructor(
    private readonly tasks: TaskManager = taskManager,
    private readonly leases: TabLeaseManager = tabLeaseManager,
    private readonly policy = new Policy(),
  ) {
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

  registerCapabilityHandler(capability: string, handler: CapabilityHandler): () => void {
    this.handlers.set(capability, handler);
    return () => { if (this.handlers.get(capability) === handler) this.handlers.delete(capability); };
  }
  approve(requestId: string, clientId: string, taskId: string, tabId?: number): void {
    this.approvals.add(this.approvalKey(requestId, clientId, taskId, tabId));
  }

  private approvalKey(requestId: string, clientId: string, taskId: string, tabId?: number): string {
    return `${requestId}:${clientId}:${taskId}:${tabId ?? ''}`;
  }

  async execute(context: TaskContext, capability: string, input: Record<string, unknown> = {}): Promise<unknown> {
    const tabId = typeof input.tabId === 'number' ? input.tabId : context.tabId;
    const decision = this.policy.check(capability, tabId === context.tabId ? context : { ...context, tabId });
    const approvalKey = this.approvalKey(context.requestId, context.clientId, context.taskId, tabId);
    if (decision.requiresApproval && !this.approvals.delete(approvalKey)) throw new PolicyError('该能力需要绑定请求的明确确认', 'E_APPROVAL_REQUIRED');
    let task = this.tasks.get(context.taskId);
    const taskCreation = capability === 'task.submit' || capability === 'workflow.run' || capability === 'tab.open' || capability === 'page.read' || capability === 'feishu.push';
    const readOnly = decision.level === 'read';
    const noTaskRead = capability === 'ping' || capability === 'tabs.list' || capability === 'registry.list' || capability === 'registry.detail';
    if (!task && (capability === 'tab.open' || capability === 'page.read')) {
      task = this.tasks.create({ taskId: context.taskId, sessionId: context.sessionId, owner: context.owner, clientId: context.clientId });
    }
    if (!task && !taskCreation && (!readOnly || !noTaskRead)) throw new PolicyError('未知任务不能执行浏览器能力', 'E_TASK_OWNERSHIP');
    if (task && task.sessionId !== context.sessionId) throw new PolicyError('任务不属于当前 session', 'E_TASK_OWNERSHIP');
    if (task && task.clientId && task.clientId !== context.clientId) throw new PolicyError('任务不属于当前 client', 'E_TASK_OWNERSHIP');
    if (task) this.tasks.assertNotCancelled(context.taskId);
    if (tabId !== undefined && task) {
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
    const invoke = async () => {
      if (task && capability !== 'task.cancel' && capability !== 'task.status' && capability !== 'task.result') { this.tasks.assertNotCancelled(context.taskId); this.tasks.markRunning(context.taskId); }
      const result = await handler(input, runContext);
      if (task && capability === 'tab.open' && result && typeof result === 'object' && 'tabId' in result && typeof result.tabId === 'number') {
        this.leases.acquire(task, result.tabId, context.clientId);
      }
      if (task && capability === 'tab.close' && tabId !== undefined) {
        this.leases.release(context.taskId, tabId, context.clientId);
        this.tasks.releaseOwnedTab(context.taskId, tabId);
      }
      if (task && capability !== 'task.cancel' && capability !== 'task.submit' && capability !== 'task.status' && capability !== 'task.result' && context.workflowStep !== true && context.finalize !== false) { this.tasks.assertNotCancelled(context.taskId); this.tasks.markSucceeded(context.taskId, result); }
      return result;
    };
    try { return tabId !== undefined ? await this.leases.serialize(tabId, invoke) : await invoke(); }
    catch (err) {
      if (task && this.tasks.isCancelled(context.taskId)) throw new PolicyError('任务已取消，未执行后续副作用', 'E_TASK_CANCELLED');
      if (task) this.tasks.markFailed(context.taskId, normalizeError(err));
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
  return { code: 'E_TASK_EXECUTION', message: err instanceof Error ? err.message : String(err) };
}

export const policyExecutor = new PolicyExecutor();
export const getTaskExecutor = () => policyExecutor;
export const registerCapabilityHandler = (capability: string, handler: CapabilityHandler) => policyExecutor.registerCapabilityHandler(capability, handler);
export const getTaskManager = () => taskManager;
