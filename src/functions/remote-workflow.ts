/**
 * 远端 Plan 执行引擎
 * 步骤级执行、模板变量、条件跳过、重试策略
 */

import type { FunctionDefinition, FunctionResult, ToolExecutionContext } from './types';
import { requestConfirmationFunction } from './request-confirmation';
import { tabLeaseManager } from '../background/tab-lease-manager';

type BuiltinResolver = (name: string) => FunctionDefinition | undefined;
type BuiltinNamesResolver = () => string[];
let resolverReady = false;
let resolveBuiltin: BuiltinResolver = () => undefined;
let resolveNames: BuiltinNamesResolver = () => [];

/** Registry wires this resolver after its static tool list is initialized. */
export const registerBuiltinFunctionResolver = (resolver: BuiltinResolver, names: BuiltinNamesResolver): void => {
  resolveBuiltin = resolver;
  resolveNames = names;
  resolverReady = true;
};

/** 旧工具名 → 新工具名映射（向后兼容已保存的用户工作流） */
const LEGACY_TOOL_NAME_MAP: Record<string, string> = {
  page_action: 'cdp_input',
  js_execute: 'cdp_frame',
  dom_manipulate: 'cdp_dom',
  cdp_css: 'cdp_dom',
  cdp_storage: 'cdp_dom',
  site_workflow: 'skill',
};

export const resolveRemotePlanAction = (name: string): { name: string; definition: FunctionDefinition } | undefined => {
  const direct = resolveBuiltin(name);
  if (direct) return { name, definition: direct };
  const mapped = LEGACY_TOOL_NAME_MAP[name];
  const definition = mapped ? resolveBuiltin(mapped) : undefined;
  return definition ? { name: mapped, definition } : undefined;
};

/** Return the built-in action names after the registry has wired its resolver. */
export const getSupportedRemotePlanActions = (): string[] => resolveNames();

/** 注册表在静态工具列表初始化后注入解析器；plan 动作白名单在解析结果之上再收窄一次。 */

export const isBuiltinResolverReady = (): boolean => resolverReady;

/**
 * 工作流 plan 动作白名单：只有录制器文档化且不绕过桥接策略的动作可执行。
 * 值为该动作允许的子动作集合；null 表示子动作不在 plan 层收窄（仍受桥接权限与租约约束）。
 * cdp_frame.evaluate 只以「只读 evaluate」形态放行：cdp-frame.ts 对 Runtime.evaluate 强制
 * throwOnSideEffect，写副作用会被 V8 拒绝；写操作仍必须走 page.click / page.type 的桥接策略路径，
 * 或 cdp_input 的显式写子动作（plan 层按 interact 触发审批与写租约）。
 */
const WORKFLOW_PLAN_ACTION_SUB_ACTIONS: Record<string, readonly string[] | null> = {
  // 工作流只允许打开/导航/查看，不允许借 plan 关闭或移动用户已有标签页
  tab_navigate: ['open', 'navigate', 'list', 'current', 'reload', 'go_back', 'go_forward'],
  page: ['view', 'snapshot', 'skeleton', 'assert', 'repair'],
  cdp_dom: [
    'query_selector', 'query_selector_all', 'get_outer_html', 'get_attributes', 'get_box_model',
    'get_document', 'get_text', 'get_html', 'get_computed_style_simple', 'wait_for',
    'css_get_computed_style', 'css_get_matched_rules', 'css_get_stylesheets', 'css_get_stylesheet',
  ],
  cdp_frame: ['evaluate'],
  cdp_input: ['wait_for_element', 'click', 'click_text', 'fill', 'key_press'],
  extract_data: null,
  screenshot: null,
};

/** 白名单内的 plan 动作名（已排除旧名别名解析后不在白名单的目标）。 */
export const getWorkflowPlanActionNames = (): string[] => Object.keys(WORKFLOW_PLAN_ACTION_SUB_ACTIONS);

/** 解析 plan 动作：只有白名单内的内置动作（含旧名别名）才返回定义。 */
export const resolveWorkflowPlanAction = (name: string): { name: string; definition: FunctionDefinition } | undefined => {
  const resolved = resolveRemotePlanAction(name);
  return resolved && Object.hasOwn(WORKFLOW_PLAN_ACTION_SUB_ACTIONS, resolved.name) ? resolved : undefined;
};

export const isWorkflowPlanActionAllowed = (name: string): boolean => Boolean(resolveWorkflowPlanAction(name));

/** 子动作收窄：白名单动作若声明了允许集合，则只放行集合内的子动作。 */
export const isWorkflowPlanSubActionAllowed = (name: string, subAction: string): boolean => {
  const resolved = resolveWorkflowPlanAction(name);
  if (!resolved) return false;
  const allowed = WORKFLOW_PLAN_ACTION_SUB_ACTIONS[resolved.name];
  return allowed === null || allowed.includes(subAction);
};

/** 校验单个 step 的 action 与已解析子动作（模板未解析时留给运行时再校验）。 */
const validatePlanStepAction = (action: string, params: Record<string, unknown>): string | null => {
  if (!resolveWorkflowPlanAction(action)) {
    return `action "${action}" 不在工作流动作白名单内`;
  }
  const rawSubAction = typeof params.action === 'string' ? params.action.trim().toLowerCase() : '';
  if (!rawSubAction || rawSubAction.includes('{{')) return null;
  if (!isWorkflowPlanSubActionAllowed(action, rawSubAction)) {
    return `${action}.${rawSubAction} 不是工作流允许的子动作`;
  }
  return null;
};

/** 保存与执行共用的 plan 动作校验：与执行边界同一份白名单。 */
export const isSupportedRemotePlanAction = (name: string): boolean => isWorkflowPlanActionAllowed(name);

/** 会改变页面状态的 cdp_input 子动作：工作流执行前必须用户批准。 */
const WORKFLOW_GATED_INPUT_ACTIONS: Record<string, true> = {
  click: true,
  double_click: true,
  type: true,
  fill: true,
  clear: true,
  select: true,
  key_press: true,
  click_text: true,
};

/** 需要审批时返回中文确认文案；只读/无副作用的子动作返回 null。 */
const buildWorkflowStepApprovalMessage = (
  workflow: string,
  index: number,
  step: RemotePlanStep,
  params: Record<string, unknown>,
): string | null => {
  if (resolveWorkflowPlanAction(step.action)?.name !== 'cdp_input') return null;
  const subAction = String(params.action || '').trim().toLowerCase();
  if (WORKFLOW_GATED_INPUT_ACTIONS[subAction] !== true) return null;
  const selector = String(params.selector || '').trim();
  const target = selector
    ? `选择器 ${selector}`
    : (params.element_id ? `元素 ${String(params.element_id)}` : '页面元素');
  const note = String(step.note || '').trim();
  return `工作流「${workflow}」第 ${index + 1} 步将执行页面操作 ${subAction}（${target}）`
    + `${note ? `：${note}` : ''}，是否批准？`;
};

type PlanStepErrorPolicy = 'abort' | 'continue';

interface PlanRetryPolicy {
  maxAttempts: number;
  delayMs: number;
  backoffFactor: number;
}

interface RemotePlanStep {
  action: string;
  params?: Record<string, unknown>;
  saveAs?: string;
  note?: string;
  keepAlive?: boolean;
  when?: unknown;
  retry?: PlanRetryPolicy;
  onError?: PlanStepErrorPolicy;
}

type PlanTabCloseMode = 'never' | 'on_success' | 'on_failure' | 'always';

interface RemotePlanTabLifecycle {
  closeOpenedTabs: PlanTabCloseMode;
}

interface RemoteWorkflowPlan {
  version?: number;
  workflow?: string;
  steps: RemotePlanStep[];
  resultPath?: string;
  outputTemplate?: unknown;
  tabLifecycle?: RemotePlanTabLifecycle;
}

interface StepExecutionTraceItem {
  index: number;
  action: string;
  success: boolean;
  skipped?: boolean;
  attempts?: number;
  maxAttempts?: number;
  nonFatal?: boolean;
  note?: string;
  saveAs?: string;
  keepAlive?: boolean;
  params: Record<string, unknown>;
  result?: unknown;
  error?: string;
}

const delayWithAbort = async (ms: number, signal?: AbortSignal): Promise<void> => {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('aborted'));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
};

interface FloatBallTakeoverStatePayload {
  active: boolean;
  label?: string;
  source?: string;
  workflow?: string;
  expiresInMs?: number;
  updatedAt?: number;
}

const sendFloatBallTakeoverStateToTab = async (tabId: number, payload: FloatBallTakeoverStatePayload): Promise<void> => {
  if (!Number.isFinite(tabId) || tabId <= 0) return;
  await new Promise<void>((resolve) => {
    try {
      chrome.tabs.sendMessage(
        tabId,
        {
          type: '__actspan_takeover_state',
          data: {
            ...payload,
            updatedAt: payload.updatedAt || Date.now(),
          },
        },
        () => {
          // 忽略 content script 尚未就绪等场景
          void chrome.runtime.lastError;
          resolve();
        },
      );
    } catch {
      resolve();
    }
  });
};

export const readPathValue = (source: unknown, path: string): unknown => {
  if (!path) return undefined;
  const tokens = path
    .split('.')
    .map((item) => item.trim())
    .filter(Boolean);
  let cursor: any = source;
  for (const token of tokens) {
    if (cursor == null) return undefined;
    if (Array.isArray(cursor) && /^\d+$/.test(token)) {
      cursor = cursor[Number(token)];
      continue;
    }
    if (typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[token];
  }
  return cursor;
};

export const resolveTemplateValue = (value: unknown, vars: Record<string, unknown>): unknown => {
  if (typeof value === 'string') {
    const exactMatch = value.match(/^{{\s*([^{}]+)\s*}}$/);
    if (exactMatch) {
      const fromPath = readPathValue(vars, exactMatch[1]);
      return fromPath === undefined ? value : fromPath;
    }
    return value.replace(/{{\s*([^{}]+)\s*}}/g, (_raw, token) => {
      const fromPath = readPathValue(vars, String(token || '').trim());
      if (fromPath === undefined || fromPath === null) return '';
      if (typeof fromPath === 'string' || typeof fromPath === 'number' || typeof fromPath === 'boolean') {
        return String(fromPath);
      }
      return JSON.stringify(fromPath);
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplateValue(item, vars));
  }
  if (value && typeof value === 'object') {
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      next[key] = resolveTemplateValue(item, vars);
    }
    return next;
  }
  return value;
};

const normalizePlanCloseMode = (raw: unknown): PlanTabCloseMode => {
  if (raw === true) return 'on_success';
  if (raw === false || raw == null) return 'on_success';
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'always') return 'always';
  if (value === 'on_failure') return 'on_failure';
  if (value === 'on_success') return 'on_success';
  if (value === 'never' || value === 'none' || value === 'keep') return 'never';
  return 'never';
};

const normalizeRetryPolicy = (raw: unknown): PlanRetryPolicy | undefined => {
  if (!raw || typeof raw !== 'object') return undefined;
  const source = raw as Record<string, unknown>;
  const maxAttemptsRaw = Number(source.maxAttempts ?? source.max_attempts ?? source.attempts);
  const delayMsRaw = Number(source.delayMs ?? source.delay_ms);
  const backoffRaw = Number(source.backoffFactor ?? source.backoff_factor);
  const maxAttempts = Number.isFinite(maxAttemptsRaw)
    ? Math.min(8, Math.max(1, Math.floor(maxAttemptsRaw)))
    : 1;
  const delayMs = Number.isFinite(delayMsRaw)
    ? Math.min(15_000, Math.max(0, Math.floor(delayMsRaw)))
    : 0;
  const backoffFactor = Number.isFinite(backoffRaw)
    ? Math.min(4, Math.max(1, backoffRaw))
    : 1;
  if (maxAttempts <= 1 && delayMs <= 0 && backoffFactor <= 1) return undefined;
  return {
    maxAttempts,
    delayMs,
    backoffFactor,
  };
};

const resolveConditionBoolean = (raw: unknown): boolean => {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    if (!normalized) return false;
    if (normalized === 'false' || normalized === '0' || normalized === 'null' || normalized === 'undefined') return false;
    return true;
  }
  if (raw == null) return false;
  if (Array.isArray(raw)) return raw.length > 0;
  if (typeof raw === 'object') return Object.keys(raw as Record<string, unknown>).length > 0;
  return Boolean(raw);
};

/** plan 校验错误信息 */
interface PlanValidationError {
  stepIndex: number;
  action: string;
  message: string;
}

/**
 * 校验远端 plan，返回具体的 step 级别错误列表
 * 用于在 normalizeRemotePlan 返回 null 时提供详细诊断信息
 */
const validateRemotePlan = (raw: unknown): PlanValidationError[] => {
  const errors: PlanValidationError[] = [];
  if (!raw || typeof raw !== 'object') {
    errors.push({ stepIndex: -1, action: '', message: 'plan 不是有效对象' });
    return errors;
  }
  const source = raw as Record<string, unknown>;
  const rawSteps = source.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    errors.push({ stepIndex: -1, action: '', message: 'plan.steps 不存在或为空数组' });
    return errors;
  }
  if (rawSteps.length > 60) {
    errors.push({ stepIndex: -1, action: '', message: `plan.steps 长度 ${rawSteps.length} 超过上限 60` });
    return errors;
  }
  for (let i = 0; i < rawSteps.length; i++) {
    const step = rawSteps[i];
    if (!step || typeof step !== 'object') {
      errors.push({ stepIndex: i, action: '', message: `步骤 ${i + 1} 不是有效对象` });
      continue;
    }
    const action = String((step as Record<string, unknown>).action || '').trim();
    if (!action) {
      errors.push({ stepIndex: i, action: '', message: `步骤 ${i + 1} 缺少 action 字段` });
    } else if (!resolveWorkflowPlanAction(action)) {
      errors.push({ stepIndex: i, action, message: `步骤 ${i + 1} 的 action "${action}" 不在工作流动作白名单内` });
    } else {
      const rawParams = (step as Record<string, unknown>).params;
      const params = rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
        ? rawParams as Record<string, unknown>
        : {};
      const subActionError = validatePlanStepAction(action, params);
      if (subActionError) errors.push({ stepIndex: i, action, message: `步骤 ${i + 1}: ${subActionError}` });
    }
  }
  return errors;
};

const normalizeRemotePlan = (raw: unknown): RemoteWorkflowPlan | null => {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const rawSteps = source.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) return null;
  if (rawSteps.length > 60) return null;

  const steps: RemotePlanStep[] = [];
  for (const item of rawSteps) {
    if (!item || typeof item !== 'object') return null;
    const sourceStep = item as Record<string, unknown>;
    const action = String(sourceStep.action || '').trim();
    if (!resolveWorkflowPlanAction(action)) return null;
    const params = sourceStep.params && typeof sourceStep.params === 'object' && !Array.isArray(sourceStep.params)
      ? sourceStep.params as Record<string, unknown>
      : {};
    if (validatePlanStepAction(action, params)) return null;
    const saveAs = String(sourceStep.saveAs || '').trim() || undefined;
    steps.push({
      action,
      params,
      saveAs,
      note: typeof sourceStep.note === 'string' ? sourceStep.note : undefined,
      keepAlive: sourceStep.keepAlive === true,
      when: sourceStep.when,
      retry: normalizeRetryPolicy(sourceStep.retry),
      onError: String(sourceStep.onError || sourceStep.on_error || '').trim().toLowerCase() === 'continue'
        ? 'continue'
        : 'abort',
    });
  }
  const tabLifecycleRaw = source.tabLifecycle && typeof source.tabLifecycle === 'object'
    ? source.tabLifecycle as Record<string, unknown>
    : null;
  return {
    version: Number(source.version) || 1,
    workflow: typeof source.workflow === 'string' ? source.workflow : undefined,
    steps,
    resultPath: typeof source.resultPath === 'string' ? source.resultPath : undefined,
    outputTemplate: source.outputTemplate,
    tabLifecycle: {
      closeOpenedTabs: normalizePlanCloseMode(
        tabLifecycleRaw?.closeOpenedTabs ?? source.closeOpenedTabs,
      ),
    },
  };
};

/** 执行一个 plan（步骤级执行引擎） */
const runRemotePlan = async (
  workflow: string,
  plan: RemoteWorkflowPlan,
  inputParams: Record<string, unknown>,
  context?: ToolExecutionContext,
): Promise<FunctionResult> => {
  const isolatedDebug = context?.isolatedDebug === true;
  const closeMode = isolatedDebug ? 'always' : (plan.tabLifecycle?.closeOpenedTabs || 'on_success');
  const openedCleanupTabIds = new Set<number>();
  const openedKeepAliveTabIds = new Set<number>();
  const isolatedTabIds = context?.debugTabIds ?? new Set<number>();
  if (isolatedDebug && typeof context?.tabId === 'number') isolatedTabIds.add(context.tabId);
  const closedTabIds: number[] = [];
  const closeErrors: string[] = [];

  const shouldCloseByOutcome = (mode: PlanTabCloseMode, outcome: 'success' | 'failure'): boolean => {
    if (mode === 'always') return true;
    if (mode === 'on_success' && outcome === 'success') return true;
    if (mode === 'on_failure' && outcome === 'failure') return true;
    return false;
  };

  const closeTrackedTabs = async (outcome: 'success' | 'failure'): Promise<void> => {
    if (!shouldCloseByOutcome(closeMode, outcome)) return;
    const tabIds = Array.from(openedCleanupTabIds.values());
    for (const tabId of tabIds) {
      if (closedTabIds.includes(tabId)) continue;
      try {
        await chrome.tabs.remove(tabId);
        closedTabIds.push(tabId);
      } catch (err: any) {
        closeErrors.push(`tab ${tabId}: ${err?.message || 'close failed'}`);
      }
    }
  };

  const vars: Record<string, unknown> = {
    ...inputParams,
    input: inputParams,
    context: {
      tabId: context?.tabId ?? null,
    },
    steps: {},
    last: null,
  };
  const traces: StepExecutionTraceItem[] = [];
  const warnings: string[] = [];
  let runtimeTabId = context?.tabId;
  // 直接调用 plan 的入口（调试页/常驻任务）也要尊重已有租约：目标标签页被其他任务
  // 持有时不能借 plan 绕过 tool-executor 的租约校验。每一步都复查，覆盖 switch/open 后的目标变化。
  const leaseConflictError = (tabId?: number): string | null => {
    if (typeof tabId !== 'number' || tabId <= 0) return null;
    const lease = tabLeaseManager.get(tabId);
    const sameOwner = Boolean(context?.taskId && lease
      && lease.taskId === context.taskId
      && (!context.sessionId || lease.sessionId === context.sessionId));
    return lease && !sameOwner ? `标签页 ${tabId} 正被其他任务使用` : null;
  };
  const initialLeaseError = leaseConflictError(runtimeTabId);
  if (initialLeaseError) return { success: false, error: initialLeaseError };
  const shouldPushTakeoverState = inputParams.float_ball_execution_state !== false;
  const defaultExecutionLabel = 'Actspan AI 执行中';
  const takeoverLabel = String(inputParams.execution_state_label || inputParams.takeover_label || defaultExecutionLabel).trim()
    || defaultExecutionLabel;
  const takeoverTtlRaw = Number(inputParams.execution_state_ttl_ms ?? inputParams.takeover_ttl_ms);
  const takeoverTtlMs = Number.isFinite(takeoverTtlRaw)
    ? Math.max(15_000, Math.min(10 * 60_000, Math.floor(takeoverTtlRaw)))
    : 120_000;
  const takeoverSyncedTabIds = new Set<number>();

  const refreshTakeoverState = async () => {
    if (!shouldPushTakeoverState) return;
    if (!Number.isFinite(Number(runtimeTabId)) || Number(runtimeTabId) <= 0) return;
    const targetTabId = Number(runtimeTabId);
    takeoverSyncedTabIds.add(targetTabId);
    await sendFloatBallTakeoverStateToTab(Number(runtimeTabId), {
      active: true,
      label: takeoverLabel,
      source: 'plan_execution',
      workflow,
      expiresInMs: takeoverTtlMs,
    });
  };

  const clearTakeoverState = async () => {
    if (!shouldPushTakeoverState) return;
    for (const tabId of Array.from(takeoverSyncedTabIds.values())) {
      await sendFloatBallTakeoverStateToTab(tabId, {
        active: false,
        source: 'plan_execution',
        workflow,
      });
    }
  };

  try {
    await refreshTakeoverState();

    for (let index = 0; index < plan.steps.length; index++) {
      if (context?.signal?.aborted) {
        return { success: false, error: 'aborted by user' };
      }

      const step = plan.steps[index];
      const stepLeaseError = leaseConflictError(runtimeTabId);
      if (stepLeaseError) return { success: false, error: stepLeaseError };
      await refreshTakeoverState();
      const resolvedWhenValue = resolveTemplateValue(step.when === undefined ? true : step.when, vars);
      const shouldRun = resolveConditionBoolean(resolvedWhenValue);
      const resolvedRawParams = resolveTemplateValue(step.params || {}, vars);
      if (!resolvedRawParams || typeof resolvedRawParams !== 'object' || Array.isArray(resolvedRawParams)) {
        return {
          success: false,
          error: `invalid params for plan step ${index}`,
        };
      }
      const resolvedParams = resolvedRawParams as Record<string, unknown>;
      // 模板展开后再次校验子动作，防止 {{input.action}} 绕过静态白名单
      const runtimeSubActionError = validatePlanStepAction(step.action, resolvedParams);
      if (runtimeSubActionError) {
        return { success: false, error: `plan step ${index}: ${runtimeSubActionError}` };
      }
      if (!shouldRun) {
        traces.push({
          index,
          action: step.action,
          success: true,
          skipped: true,
          attempts: 0,
          maxAttempts: step.retry?.maxAttempts || 1,
          note: step.note,
          saveAs: step.saveAs,
          keepAlive: step.keepAlive === true,
          params: resolvedParams,
        });
        continue;
      }

      if (!resolverReady) {
        return { success: false, error: 'workflow runtime registry is not initialized' };
      }
      const runner = resolveWorkflowPlanAction(step.action)?.definition;
      if (!runner) {
        return { success: false, error: `unsupported plan action: ${step.action}` };
      }

      // 执行上下文已确定的标签页是唯一合法目标：计划内的 tab_id 不能把动作引到
      // 任务租约之外的页面（tab_navigate 的 open/switch 会在成功后更新 runtimeTabId）。
      if (typeof runtimeTabId === 'number') {
        resolvedParams.tab_id = runtimeTabId;
        delete resolvedParams.tabId;
      }

      const tabAction = step.action === 'tab_navigate'
        ? String(resolvedParams.action || '').trim().toLowerCase()
        : '';

      if (isolatedDebug && typeof runtimeTabId === 'number') {
        if (Object.prototype.hasOwnProperty.call(resolvedParams, 'tab_id')) {
          resolvedParams.tab_id = runtimeTabId;
        }
        if (step.action === 'screenshot') {
          return { success: false, error: '隔离调试模式禁止临时激活标签页，请使用 DOM/CDP 调试工具' };
        }
        if (step.action === 'tab_navigate') {
          if (tabAction === 'switch' || tabAction === 'duplicate') {
            return { success: false, error: '隔离调试模式禁止切换或复制标签页' };
          }
          resolvedParams.tab_id = runtimeTabId;
          if (tabAction === 'open') resolvedParams.active = false;
        }
      } else if (step.action === 'tab_navigate' && tabAction === 'navigate') {
        // 普通 workflow 不得跳转用户当前页面；后台新开标签页。
        resolvedParams.action = 'open';
        if (resolvedParams.active === undefined) resolvedParams.active = false;
      }

      const approvalMessage = buildWorkflowStepApprovalMessage(workflow, index, step, resolvedParams);
      if (approvalMessage) {
        const approval = await requestConfirmationFunction.execute(
          { message: approvalMessage },
          { signal: context?.signal, tabId: runtimeTabId },
        );
        if (!approval.success || approval.data?.approved !== true) {
          await closeTrackedTabs('failure');
          return {
            success: false,
            error: `用户未批准工作流步骤: ${approvalMessage}`,
            data: {
              workflow,
              mode: 'plan',
              step: index,
              traces,
              tabLifecycle: {
                closeOpenedTabs: closeMode,
                openedCleanupTabIds: Array.from(openedCleanupTabIds.values()),
                openedKeepAliveTabIds: Array.from(openedKeepAliveTabIds.values()),
                closedTabIds,
                closeErrors,
              },
            },
          };
        }
      }

      const maxAttempts = step.retry?.maxAttempts || 1;
      let retryDelayMs = step.retry?.delayMs || 0;
      let stepResult: FunctionResult = {
        success: false,
        error: 'step not executed',
      };
      let attempts = 0;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        attempts = attempt;
        stepResult = await runner.execute(resolvedParams, {
          tabId: runtimeTabId,
          signal: context?.signal,
          isolatedDebug,
          debugTabIds: context?.debugTabIds,
        });
        if (stepResult.success) break;
        if (attempt >= maxAttempts) break;
        const waitMs = Math.max(0, Math.floor(retryDelayMs));
        if (waitMs > 0) {
          try {
            await delayWithAbort(waitMs, context?.signal);
          } catch {
            return { success: false, error: 'aborted by user' };
          }
        }
        const backoff = step.retry?.backoffFactor || 1;
        retryDelayMs = retryDelayMs > 0 ? Math.floor(retryDelayMs * backoff) : retryDelayMs;
      }

      const allowContinueOnError = step.onError === 'continue';
      traces.push({
        index,
        action: step.action,
        success: stepResult.success,
        attempts,
        maxAttempts,
        nonFatal: !stepResult.success && allowContinueOnError,
        note: step.note,
        saveAs: step.saveAs,
        keepAlive: step.keepAlive === true,
        params: resolvedParams,
        result: stepResult.data,
        error: stepResult.error,
      });

      if (
        step.action === 'tab_navigate'
        && String(resolvedParams.action || '').trim().toLowerCase() === 'open'
        && stepResult.success
        && (stepResult.data as { reused?: boolean } | undefined)?.reused !== true
      ) {
        const openedTabId = Number((stepResult.data as any)?.tab_id);
        if (Number.isFinite(openedTabId) && openedTabId > 0) {
          isolatedTabIds.add(openedTabId);
          if (step.keepAlive === true && !isolatedDebug) {
            openedKeepAliveTabIds.add(openedTabId);
          } else {
            openedCleanupTabIds.add(openedTabId);
          }
        }
      }

      if (!stepResult.success && !allowContinueOnError) {
        await closeTrackedTabs('failure');
        return {
          success: false,
          error: stepResult.error || `plan step failed at index ${index}`,
          data: {
            workflow,
            mode: 'plan',
            step: index,
            traces,
            tabLifecycle: {
              closeOpenedTabs: closeMode,
              openedCleanupTabIds: Array.from(openedCleanupTabIds.values()),
              openedKeepAliveTabIds: Array.from(openedKeepAliveTabIds.values()),
              closedTabIds,
              closeErrors,
            },
          },
        };
      }

      if (!stepResult.success && allowContinueOnError) {
        const warningText = `step_${index} failed but continued: ${stepResult.error || 'unknown error'}`;
        warnings.push(warningText);
        vars.last = {
          success: false,
          error: stepResult.error || 'step failed',
        };
        vars[`step_${index}`] = vars.last;
        if (step.saveAs) {
          (vars.steps as Record<string, unknown>)[step.saveAs] = vars.last;
          vars[step.saveAs] = vars.last;
        }
        vars.last_error = warningText;
        continue;
      }

      const stepData = stepResult.data;
      vars.last = stepData ?? null;
      vars[`step_${index}`] = stepData ?? null;
      if (step.saveAs) {
        (vars.steps as Record<string, unknown>)[step.saveAs] = stepData ?? null;
        vars[step.saveAs] = stepData ?? null;
      }
      if (stepData && typeof stepData === 'object' && typeof (stepData as any).tab_id === 'number') {
        const nextTabId = (stepData as any).tab_id;
        if (!isolatedDebug || isolatedTabIds.has(nextTabId)) {
          runtimeTabId = nextTabId;
          (vars.context as Record<string, unknown>).tabId = runtimeTabId;
          await refreshTakeoverState();
        }
      }
    }

    await closeTrackedTabs('success');

    const output = plan.outputTemplate !== undefined
      ? resolveTemplateValue(plan.outputTemplate, vars)
      : (plan.resultPath ? readPathValue(vars, plan.resultPath) : vars.last);

    return {
      success: true,
      data: {
        workflow,
        mode: 'plan',
        output: output === undefined ? null : output,
        traces,
        resultPath: plan.resultPath || null,
        warnings,
        tabLifecycle: {
          closeOpenedTabs: closeMode,
          openedCleanupTabIds: Array.from(openedCleanupTabIds.values()),
          openedKeepAliveTabIds: Array.from(openedKeepAliveTabIds.values()),
          closedTabIds,
          closeErrors,
        },
      },
    };
  } finally {
    if (isolatedDebug) await closeTrackedTabs('failure');
    await clearTakeoverState();
  }
};

/**
 * 执行远端 plan（供调试和 site workflow 使用）
 * workflow: 工作流名称标识
 * planRaw: plan JSON
 * paramsRaw: 传入参数
 */
export const executeDebugRemotePlan = async (
  workflowRaw: unknown,
  planRaw: unknown,
  paramsRaw: unknown,
  context?: ToolExecutionContext,
): Promise<FunctionResult> => {
  const workflow = String(workflowRaw || 'unnamed').trim();
  const plan = normalizeRemotePlan(planRaw);
  if (!plan) {
    // 使用 validateRemotePlan 获取具体的 step 级别错误信息
    const validationErrors = validateRemotePlan(planRaw);
    const errorDetails = validationErrors.length > 0
      ? validationErrors.map((e) => e.message).join('；')
      : '未知原因';
    return {
      success: false,
      error: `plan JSON 非法：${errorDetails}`,
    };
  }
  const params = paramsRaw && typeof paramsRaw === 'object' && !Array.isArray(paramsRaw)
    ? paramsRaw as Record<string, unknown>
    : {};
  return runRemotePlan(workflow, plan, params, context);
};
