/**
 * MCP Bridge：连接本地 MCP server（ws://127.0.0.1:<port>），
 * 执行 IDE agent 下发的浏览器原子操作，全程复用用户真实登录态。
 *
 * 配置存于 chrome.storage.local['actspan_mcp_bridge_settings']：
 *   { enabled: true, port: 30121, token?: '<manual token>' }
 * 旧配置仅迁移读取一次，随后只读取 Actspan key；服务端按扩展 ID 白名单配对。
 * 每个请求与已认证 WebSocket 及 client/request/task/session 绑定。
 * 仅 enabled: false 会关闭桥接。
 */
import { VERSION } from '../config';
import { ensureSkillRegistryReady, listManifestSources, registryService } from '../functions/skill-registry';
import { getBuiltinFunction } from '../functions/registry';
import { readWebhookConfig, selectCompletionWebhooks, sendWebhookEntries } from '../functions/webhook';
import { requestConfirmationFunction } from '../functions/request-confirmation';
import { getWorkflowPlanActionNames, isWorkflowPlanActionAllowed, isWorkflowPlanSubActionAllowed, resolveWorkflowPlanAction, resolveTemplateValue, readPathValue } from '../functions/remote-workflow';
import { redactAuditParams, redactPageContent, redactSensitive, isCredentialUrl } from '../functions/redact';
import { CHALLENGE_MESSAGE, createReadDriftTracker, detectChallenge, type ChallengeEvidence } from '../functions/risk-detect';
import { getSyncStatus } from '../options/pages/actspan-console-status';
import { getTaskExecutor, PolicyError, registerCapabilityHandler } from './policy-executor';
import { TabLeaseError, tabLeaseManager } from './tab-lease-manager';
import { isBlockedFetchUrl, isSafeNavigableUrl } from '../lib/ssrf-guard';
import { taskManager } from './task-manager';
import { handleMcpInteraction, isPageResultEnvelope } from './mcp-interaction';
import { sendToTabWithRetry } from '../functions/tab-message';
import { handleMcpNetwork } from './mcp-network';
import { recordSuccessfulActDraft, adoptActDraft } from './act-drafts';
import { registerDataCapabilityHandlers } from './mcp-data';
import { updateStatus } from './status-bridge';
import { MAIN_FRAME_ID, frameSnapshotId, listTabFrames, qualifyRef, routeFrameRef } from './frame-routing';
import { realClickAt, realPressKey, realTypeInto } from '../functions/cdp-input';
import { CDPSessionManager } from '../lib/cdp-session';
import type { PermissionLevel, TabLease, TaskContext } from './task-types';

const readDriftTracker = createReadDriftTracker();
let protocolWarning: string | null = null;
let authenticatedBridge = false;
const inFlightBridgeRequests = new Map<string, AbortController>();

interface BridgeRequestContext {
    clientId: string;
    requestId: string;
    taskId: string;
    sessionId: string;
    tabId?: number;
    host?: string;
    onlineSessions?: Array<{ clientId: string; sessionId: string; label?: string }>;
}

interface BridgeRequestFrame {
    id: string;
    method: string;
    params?: Record<string, unknown>;
    context: BridgeRequestContext;
}

const runtimeRequestType = 'actspan_mcp_request';
// 取消帧没有 method/params，不能走 BridgeRequestFrame 校验，只能按 id 匹配在途请求。
const runtimeCancelType = 'actspan_mcp_cancel';
const runtimeResponseType = 'actspan_mcp_response';
const runtimeAuditType = 'actspan_mcp_audit';
// 与 offscreen 侧同名常量保持一致；两侧各自声明，避免把 transport 打进 service worker。
const SETTINGS_GET_MESSAGE = 'actspan_mcp_settings_get';
const SETTINGS_SET_AUTO_MESSAGE = 'actspan_mcp_settings_set_auto';
const SETTINGS_CHANGED_MESSAGE = 'actspan_mcp_settings_changed';

const validBridgeIdentity = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= 256;

const isBridgeRequestFrame = (value: unknown): value is BridgeRequestFrame => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const frame = value as Record<string, unknown>;
    if (!validBridgeIdentity(frame.id) || typeof frame.method !== 'string' || !frame.method) return false;
    const context = frame.context;
    if (!context || typeof context !== 'object' || Array.isArray(context)) return false;
    const tuple = context as Record<string, unknown>;
    if (frame.id !== tuple.requestId || ![tuple.clientId, tuple.requestId, tuple.taskId, tuple.sessionId].every(validBridgeIdentity)) return false;
    if (tuple.tabId !== undefined && (!Number.isInteger(tuple.tabId) || Number(tuple.tabId) <= 0)) return false;
    if (frame.params !== undefined && (!frame.params || typeof frame.params !== 'object' || Array.isArray(frame.params))) return false;
    return true;
};

const sendOffscreen = (message: Record<string, unknown>): void => {
    void chrome.runtime.sendMessage(message).catch(() => undefined);
};

const sendBridgeAudit = (frame: BridgeRequestFrame, success: boolean, params: Record<string, unknown>, error?: unknown): void => {
    const redacted = redactAuditParams(params);
    const auditParams = {
        ...(typeof redacted.tabId === 'number' ? { tabId: redacted.tabId } : {}),
        ...(typeof redacted.submit === 'boolean' ? { submit: redacted.submit } : {}),
        ...(typeof redacted.active === 'boolean' ? { active: redacted.active } : {}),
        ...(typeof redacted.allowSensitive === 'boolean' ? { allowSensitive: redacted.allowSensitive } : {}),
        ...(typeof redacted.real === 'boolean' ? { real: redacted.real } : {}),
        ...(redacted.format === 'html' || redacted.format === 'text' ? { format: redacted.format } : {}),
        ...(typeof params.expression === 'string' ? { expressionChars: params.expression.length } : {}),
        ...(typeof params.text === 'string' ? { textChars: params.text.length } : {}),
    };
    sendOffscreen({ type: runtimeAuditType, frame: {
        type: 'audit', id: frame.id, ...frame.context,
        entry: { tool: frame.method, host: frame.context.host || frame.context.clientId, time: Date.now(), params: auditParams,
            effect: { success, summary: success ? 'ok' : error instanceof PolicyError && /APPROVAL|POLICY/.test(error.code) ? 'denied' : 'error' } },
    } });
};

export const handleOffscreenRequest = async (frame: BridgeRequestFrame): Promise<void> => {
    const params = frame.params || {};
    let normalizedParams: Record<string, unknown>;
    try { normalizedParams = canonicalizePlanTabParams(params, frame.context.tabId); }
    catch (error) {
        sendOffscreen({ type: runtimeResponseType, frame: { id: frame.id, ...frame.context, ok: false, error: error instanceof Error ? error.message : String(error) } });
        return;
    }
    if (frame.context.tabId !== normalizedParams.tabId) {
        sendOffscreen({ type: runtimeResponseType, frame: { id: frame.id, ...frame.context, ok: false, error: '请求 tabId 与认证上下文不一致' } });
        return;
    }
    // 有效请求帧已通过认证，即证明该会话在线：清掉断线标记，
    // 否则重连后残留的 disconnected 记录会让其他会话抢占仍然存活的标签页。
    if (validBridgeIdentity(frame.context.clientId) && validBridgeIdentity(frame.context.sessionId)) {
        tabLeaseManager.setSessionConnected({ clientId: frame.context.clientId, sessionId: frame.context.sessionId }, true);
    }
    const controller = new AbortController();
    // 重复 id 会覆盖前一个 controller，令前一个请求永远无法取消，其 finally 还会删掉后一个条目。
    if (inFlightBridgeRequests.has(frame.id)) {
        sendOffscreen({ type: runtimeResponseType, frame: { id: frame.id, ...frame.context, ok: false, error: '重复的请求 id，已拒绝' } });
        return;
    }
    inFlightBridgeRequests.set(frame.id, controller);
    try {
        const result = await executeBridgeRequest(frame.method, normalizedParams, frame.context, controller.signal);
        sendBridgeAudit(frame, true, normalizedParams);
        sendOffscreen({ type: runtimeResponseType, frame: { id: frame.id, ...frame.context, ok: true, result } });
    } catch (error) {
        sendBridgeAudit(frame, false, normalizedParams, error);
        sendOffscreen({ type: runtimeResponseType, frame: { id: frame.id, ...frame.context, ok: false, error: error instanceof Error ? error.message : String(error) } });
    } finally {
        if (inFlightBridgeRequests.get(frame.id) === controller) inFlightBridgeRequests.delete(frame.id);
    }
};
const WORKFLOW_CAPABILITY: Record<string, string> = {
    page_read: 'page.read', page_click: 'page.click', page_type: 'page.type',
    page_eval: 'page.eval', screenshot: 'page.screenshot', agent_delegate: 'agent_delegate',
};
const WORKFLOW_PLAN_CAPABILITY_PREFIX = 'workflow.plan.';

type WorkflowPlanStep = {
    action: string;
    params?: Record<string, unknown>;
    saveAs?: string;
    when?: unknown;
    retry?: { maxAttempts?: number; delayMs?: number; backoffFactor?: number };
    onError?: 'stop' | 'abort' | 'retry' | 'fallback' | 'continue';
    optional?: boolean;
    keepAlive?: boolean;
    note?: string;
};

type WorkflowPlan = {
    steps: WorkflowPlanStep[];
    resultPath?: string;
    outputPath?: string;
    outputTemplate?: unknown;
    tabLifecycle?: { closeOpenedTabs?: unknown };
    closeOpenedTabs?: unknown;
};

type PlanCloseMode = 'never' | 'on_success' | 'on_failure' | 'always';

/** plan 动作白名单由 remote-workflow 统一维护；此处只做权限与租约收窄。 */

const planActionPermission = (action: string, input: Record<string, unknown>): PermissionLevel => {
    const definition = getBuiltinFunction(action);
    if (!definition) return 'dangerous';
    const actionName = typeof input.action === 'string' ? input.action : '';
    return definition.actionPermissions?.[actionName] || definition.permissionLevel || 'interact';
};

const canonicalizePlanTabParams = (input: Record<string, unknown>, fallbackTabId?: number): Record<string, unknown> => {
    const camelTabId = input.tabId;
    const snakeTabId = input.tab_id;
    if (typeof camelTabId === 'number' && typeof snakeTabId === 'number' && camelTabId !== snakeTabId) {
        throw new PolicyError('tabId 与 tab_id 不一致', 'E_TAB_OWNERSHIP');
    }
    const tabId = typeof snakeTabId === 'number' ? snakeTabId
        : typeof camelTabId === 'number' ? camelTabId : fallbackTabId;
    if (typeof tabId !== 'number') return input;
    return { ...input, tabId, tab_id: tabId };
};

const resolvePlanTabId = (input: Record<string, unknown>, fallbackTabId?: number): number | undefined => {
    const normalized = canonicalizePlanTabParams(input, fallbackTabId);
    return typeof normalized.tab_id === 'number' ? normalized.tab_id : undefined;
};


const normalizePlanCloseMode = (raw: unknown): PlanCloseMode => {
    if (raw === true) return 'on_success';
    if (raw === false || raw == null) return 'on_success';
    const value = String(raw).trim().toLowerCase();
    if (value === 'always') return 'always';
    if (value === 'on_failure') return 'on_failure';
    if (value === 'on_success') return 'on_success';
    if (value === 'never' || value === 'none' || value === 'keep') return 'never';
    return 'never';
};

const shouldClosePlanTabs = (mode: PlanCloseMode, outcome: 'success' | 'failure'): boolean =>
    mode === 'always' || (mode === 'on_success' && outcome === 'success') || (mode === 'on_failure' && outcome === 'failure');
const shouldRunPlanStep = (value: unknown): boolean => {
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        return normalized !== '' && !['false', '0', 'null', 'undefined'].includes(normalized);
    }
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
    return Boolean(value);
};


/** Keep recorder plans canonical; only validate actions at the execution boundary. */
export function getWorkflowPlanForExecution(workflow: { plan?: unknown }): WorkflowPlan {
    const plan = workflow.plan;
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('工作流没有可执行的 plan');
    const rawPlan = plan as Record<string, unknown>;
    const rawSteps = rawPlan.steps;
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) throw new Error('工作流没有可执行的 plan');
    if (rawSteps.length > 60) throw new Error('工作流 plan 步骤数超过上限 60');
    const steps = rawSteps.map((rawStep, index) => {
        if (!rawStep || typeof rawStep !== 'object' || Array.isArray(rawStep)) throw new Error(`不支持的工作流步骤: step_${index}`);
        const step = rawStep as Record<string, unknown>;
        const requestedAction = String(step.action || '').trim();
        const resolvedAction = requestedAction ? resolveWorkflowPlanAction(requestedAction) : undefined;
        if (!resolvedAction) {
            throw new Error(`不支持的工作流步骤: ${requestedAction || `step_${index}`}`);
        }
        const requestedSubAction = step.params && typeof step.params === 'object' && !Array.isArray(step.params)
            ? (step.params as Record<string, unknown>).action : undefined;
        if (typeof requestedSubAction === 'string' && !requestedSubAction.includes('{{')
            && !isWorkflowPlanSubActionAllowed(resolvedAction.name, requestedSubAction.trim().toLowerCase())) {
            throw new Error(`不支持的工作流步骤: ${requestedAction}.${requestedSubAction}`);
        }
        const retry = step.retry && typeof step.retry === 'object' && !Array.isArray(step.retry)
            ? { ...(step.retry as Record<string, unknown>) } : undefined;
        if (retry) {
            const maxAttempts = retry.maxAttempts ?? retry.max_attempts ?? retry.attempts;
            retry.maxAttempts = Number.isFinite(Number(maxAttempts))
                ? Math.max(1, Math.min(2, Math.floor(Number(maxAttempts)))) : 1;
            retry.delayMs = 250;
            delete retry.max_attempts;
            delete retry.attempts;
            delete retry.delay_ms;
            delete retry.backoffFactor;
            delete retry.backoff_factor;
        }
        const normalizedStep: Record<string, unknown> = { ...step, action: resolvedAction.name };
        if (retry) normalizedStep.retry = retry;
        const onError = step.onError ?? step.on_error;
        if (onError !== undefined) {
            const normalizedError = String(onError).trim().toLowerCase();
            normalizedStep.onError = normalizedError === 'retry' || normalizedError === 'fallback' || normalizedError === 'continue'
                ? normalizedError : 'stop';
        }
        if (step.optional === true) normalizedStep.optional = true;
        delete normalizedStep.on_error;
        return normalizedStep;
    });
    const resultPath = typeof rawPlan.resultPath === 'string' ? rawPlan.resultPath
        : typeof rawPlan.outputPath === 'string' ? rawPlan.outputPath : undefined;
    const normalizedPlan: Record<string, unknown> = { ...rawPlan, steps };
    if (resultPath !== undefined) normalizedPlan.resultPath = resultPath;
    return normalizedPlan as WorkflowPlan;
}


let workflowPlanHandlersRegistered = false;
export const registerWorkflowPlanHandlers = () => {
    if (workflowPlanHandlersRegistered) return;
    workflowPlanHandlersRegistered = true;
    for (const action of getWorkflowPlanActionNames()) {
        registerCapabilityHandler(`${WORKFLOW_PLAN_CAPABILITY_PREFIX}${action}`, async (input, context) => {
            const resolved = resolveWorkflowPlanAction(action);
            if (!resolved) throw new PolicyError(`工作流计划不可执行 ${action}`, 'E_POLICY_DENIED');
            const normalizedInput = canonicalizePlanTabParams(input, context.tabId);
            const targetTabId = resolvePlanTabId(normalizedInput);
            const tabAction = String(normalizedInput.action || '').toLowerCase();
            if (!isWorkflowPlanSubActionAllowed(resolved.name, tabAction)) {
                throw new PolicyError(`不支持的工作流步骤: ${action}.${tabAction}`, 'E_POLICY_DENIED');
            }
            if (action === 'tab_navigate' && tabAction === 'list') {
                throw new PolicyError('工作流计划不可使用 tab_navigate.list，请使用受任务租约过滤的 tabs.list', 'E_TAB_OWNERSHIP');
            }
            const implicitOpen = action === 'tab_navigate' && tabAction === 'open';
            const tabNavigateRead = action === 'tab_navigate' && tabAction === 'current';
            // 白名单内的 plan 动作都作用于标签页，只有 tab_navigate.current 是免租约的只读查询。
            const requiresTabLease = !tabNavigateRead;
            const permission = planActionPermission(action, normalizedInput);
            if (requiresTabLease && typeof targetTabId === 'number') {
                tabLeaseManager.authorize(context, targetTabId, permission !== 'read');
            } else if (requiresTabLease && permission !== 'read' && !implicitOpen) {
                throw new PolicyError(`工作流步骤 ${action} 必须指定已租约的 tab_id`, 'E_TAB_OWNERSHIP');
            }
            // 计划里的 page.view/snapshot/skeleton、cdp_dom 白名单子动作与只读 cdp_frame.evaluate
            // 都只读页面内容，与桥接读动作共用同一道验证页闸门，避免换条路径就把验证页当普通内容读走。
            const readPagePlanAction = action === 'cdp_dom' || action === 'cdp_frame'
                || (action === 'page' && ['view', 'snapshot', 'skeleton'].includes(tabAction));
            if (readPagePlanAction && typeof targetTabId === 'number') await assertNoChallenge(context, targetTabId);
            const result = await resolved.definition.execute(normalizedInput, { ...context, tabId: targetTabId });
            if (!result.success) throw new Error(result.error || `工作流步骤执行失败: ${action}`);
            return result.data;
        }, (input) => planActionPermission(action, input));
    }
};
const assertSignalActive = (signal?: AbortSignal): void => {
    if (signal?.aborted) throw new Error('Bridge 请求已取消');
};

/** 动作定位描述符：selector、ref+snapshotId、find 三选一。find 只在页面内解析，绝不转成 CSS。 */
type ActionFind = { role?: string; name?: string; nth?: number };
type ActionTarget = { selector?: string; ref?: string; snapshotId?: string; find?: ActionFind };
const PAGE_CONTENT_OPEN = '<page-content untrusted>';
const PAGE_CONTENT_CLOSE = '</page-content>';

/** D9：页面原文一律包进不可信围栏；内容里的收尾定界符一律转义，永远只包一层，攻击者无法提前闭合围栏。 */
export function wrapUntrustedPageContent(content: string): string {
    return `${PAGE_CONTENT_OPEN}\n${content.split(PAGE_CONTENT_CLOSE).join('<\\/page-content>')}\n${PAGE_CONTENT_CLOSE}`;
}

/** 凭据页出口的形状判定：redactPageContent 用 {content, warning} 表示整页掩码。 */
const isMaskedPage = (value: unknown): value is { content: unknown; warning: string } =>
    value !== null && typeof value === 'object' && 'content' in value && 'warning' in value;


const approvedPaymentActions = new WeakMap<Record<string, unknown>, string>();

/** 校验并归一化三选一定位参数，拒绝含糊或互相冲突的定位方式。 */
export function buildActionTarget(params: Record<string, unknown>): ActionTarget {
    const selector = typeof params.selector === 'string' && params.selector.trim() ? params.selector : undefined;
    const ref = typeof params.ref === 'string' && params.ref.trim() ? params.ref : undefined;
    const snapshotId = typeof params.snapshotId === 'string' && params.snapshotId.trim() ? params.snapshotId : undefined;
    const rawFind = params.find;
    const find = rawFind && typeof rawFind === 'object' && !Array.isArray(rawFind) ? rawFind as ActionFind : undefined;
    const provided = [selector && 'selector', ref && 'ref', find && 'find'].filter(Boolean);
    if (provided.length === 0) throw new Error('必须提供 selector、ref+snapshotId 或 find 之一来定位元素');
    if (provided.length > 1) throw new Error(`selector、ref、find 只能三选一，当前同时提供了：${provided.join('、')}`);
    if (ref && !snapshotId) throw new Error('ref 必须与 snapshotId 一起提供，以便校验句柄是否过期');
    if (snapshotId && !ref) throw new Error('snapshotId 只能与 ref 一起提供');
    if (find) {
        if (!find.role && !find.name) throw new Error('find 需要至少提供 role 或 name');
        if (find.nth !== undefined && (!Number.isSafeInteger(Number(find.nth)) || Number(find.nth) < 0)) {
            throw new Error('find.nth 必须是非负整数（0-based）');
        }
    }
    return { ...(selector ? { selector } : {}), ...(ref ? { ref, snapshotId } : {}), ...(find ? { find } : {}) };
}

/**
 * G5：把快照返回的 ref 路由到确切框架。
 * 子框架 ref 形如 `<baseRef>@f<frameId>`；后缀非法时明确报错，绝不回退到父框架执行。
 */
function routeActionTarget(target: ActionTarget): { target: ActionTarget; frameId?: number } {
    if (!target.ref) return { target };
    const route = routeFrameRef(target.ref, target.snapshotId);
    if (!route) {
        throw new PolicyError(`ref 后缀非法：${target.ref}；请原样回传快照返回的 ref`, 'E_REF_FRAME');
    }
    return { target: { ...target, ref: route.baseRef, snapshotId: route.snapshotId }, frameId: route.frameId };
}

/** pageAction 内部的可观察状态快照；与 content script 的 ElementObservableState 同源。 */
interface PageObservableState {
    visible: boolean;
    text: string;
    value?: string;
    ariaExpanded?: string;
    disabled: boolean;
    className: string;
}

/** A2：升级通道观测到的目标状态；center 由内容脚本按视口坐标给出。 */
interface ObservedTarget { state: PageObservableState; center?: { x: number; y: number }; kind?: string; tag?: string; find?: Record<string, unknown> }

/** 效果证据的观测字段；与内容脚本 buildEffectEvidence 同源。 */
const OBSERVABLE_FIELDS = ['visible', 'text', 'value', 'ariaExpanded', 'disabled', 'className'] as const;

/** 真实事件重放的结果：升级前后各一次观测 + CDP 派发是否成功。 */
interface RealOutcome {
    success: boolean;
    error?: string;
    changed: boolean;
    changedFields: string[];
    before: ObservedTarget | null;
    after: ObservedTarget | null;
}
// Serialized by chrome.scripting.executeScript; keep this function self-contained.
// `text` 参数在 'read' 动作下承载 maxChars（字符串形式），其余动作是输入文本。
async function pageAction(action: 'inspect' | 'click' | 'type' | 'observe' | 'read' | 'focus' | 'scroll_into_view', descriptor: ActionTarget, text: string, submit: boolean, approvedSignature?: string) {
    // 注入函数必须自包含：executeScript 把页面侧 throw 吞成 {result:null} 且不带 error 字段，
    // 桥侧无法分辨「返回 null」与「抛错」，所以动作体自己把结果装进信封，由调用方还原。
    const body = async (): Promise<Record<string, unknown>> => {
        const normalize = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();
        const roleOf = (el: Element): string => {
            const explicit = normalize(el.getAttribute('role')).toLowerCase().split(' ')[0];
            if (explicit) return explicit;
            const tag = el.tagName.toLowerCase();
            if (tag === 'input') {
                const type = (el.getAttribute('type') || 'text').toLowerCase();
                if (type === 'checkbox') return 'checkbox';
                if (type === 'radio') return 'radio';
                if (type === 'file') return 'file';
                if (type === 'search') return 'searchbox';
                if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button';
                if (['range', 'number'].includes(type)) return 'spinbutton';
                return 'textbox';
            }
            if (tag === 'textarea') return 'textbox';
            if (tag === 'select') return (el as HTMLSelectElement).multiple ? 'listbox' : 'combobox';
            if (tag === 'a' || tag === 'area') return el.hasAttribute('href') ? 'link' : '';
            if (tag === 'button' || tag === 'summary') return 'button';
            return '';
        };
        // 唯一可访问名实现：定位匹配与回传描述符必须同源，否则 ref→find 重放永远匹配不上。
        // 刻意不含 placeholder 与可编辑元素文本：页面可以回填用户输入，那会把隐私写进草稿。
        const accessibleNameOf = (el: Element): string => {
            const aria = normalize(el.getAttribute('aria-label'));
            if (aria) return aria;
            const labelledBy = el.getAttribute('aria-labelledby');
            if (labelledBy) {
                const referenced = labelledBy.split(/\s+/)
                    .map((id) => document.getElementById(id))
                    .filter((node): node is HTMLElement => Boolean(node))
                    .map((node) => normalize(node.innerText || node.textContent)).join(' ');
                if (normalize(referenced)) return normalize(referenced);
            }
            const labels = (el as HTMLInputElement).labels;
            if (labels && labels.length > 0) {
                const fromLabels = normalize(Array.from(labels).map((node) => node.innerText || node.textContent).join(' '));
                if (fromLabels) return fromLabels;
            }
            for (const attribute of ['alt', 'title']) {
                const candidate = normalize(el.getAttribute(attribute));
                if (candidate) return candidate;
            }
            const tag = el.tagName.toLowerCase();
            if (tag === 'input' && ['submit', 'button', 'reset', 'image'].includes((el.getAttribute('type') || '').toLowerCase())) {
                const value = normalize(el.getAttribute('value'));
                if (value) return value;
            }
            const name = normalize(el.getAttribute('name'));
            if (name) return name;
            const editable = tag === 'input' || tag === 'textarea' || tag === 'select'
                || (el as HTMLElement).isContentEditable === true;
            return editable ? '' : normalize((el as HTMLElement).innerText || el.textContent);
        };
        // 与 content script 的 promoteSvgActionTarget 同源：SVG 内部节点（path/rect…）自身没有动作语义，
        // 点击落点、disabled 判定与真实事件坐标都必须落在承载动作的祖先控件上，否则 selector 与 ref 两条路径看到的目标不同。
        const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
        const ACTION_BEARING = 'button,a,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[onclick]';
        const promoteSvg = (el: Element | null): Element | null => {
            if (!el) return el;
            if (el.namespaceURI !== SVG_NAMESPACE && el.tagName.toLowerCase() !== 'svg') return el;
            const ancestor = typeof el.closest === 'function' ? el.closest(ACTION_BEARING) : null;
            return ancestor || el;
        };
        // Resolution happens here, at action time, against the live DOM.
        const resolveRaw = (): Element | null => {
            if (descriptor.find) {
                const wantedRole = normalize(descriptor.find.role).toLowerCase();
                const wantedName = normalize(descriptor.find.name).toLowerCase();
                const exact: Element[] = [];
                const loose: Element[] = [];
                for (const el of Array.from(document.querySelectorAll('*'))) {
                    if (wantedRole && roleOf(el) !== wantedRole) continue;
                    if (wantedName) {
                        const candidate = normalize(accessibleNameOf(el)).toLowerCase();
                        if (!candidate) continue;
                        if (candidate === wantedName) { exact.push(el); loose.push(el); continue; }
                        if (!candidate.includes(wantedName)) continue;
                    }
                    loose.push(el);
                }
                const pool = exact.length > 0 ? exact : loose;
                if (pool.length === 0) {
                    const roles = new Set<string>();
                    const sameRole: string[] = [];
                    for (const el of Array.from(document.querySelectorAll('*'))) {
                        const role = roleOf(el);
                        if (role) roles.add(role);
                        if (wantedRole && role === wantedRole) {
                            const label = accessibleNameOf(el);
                            if (label) sameRole.push(label);
                        }
                    }
                    throw new Error(`find 未命中任何元素（role=${wantedRole || '*'}、name=${wantedName || '*'}）；页面可用 role：${Array.from(roles).sort().join('、') || '无'}${sameRole.length > 0 ? `；同 role 的名称：${sameRole.slice(0, 8).join('、')}` : ''}`);
                }
                const nth = descriptor.find.nth;
                if (nth !== undefined) {
                    if (!Number.isSafeInteger(nth) || nth < 0) throw new Error('find.nth 必须是非负整数（0-based）');
                    if (nth >= pool.length) throw new Error(`find.nth=${nth} 超出匹配数量 ${pool.length}；nth 为 0-based`);
                    return pool[nth] ?? null;
                }
                if (pool.length > 1) throw new Error(`find 命中 ${pool.length} 个元素，未指定 nth，拒绝猜测；候选：${pool.slice(0, 8).map((el) => `${roleOf(el)}:${accessibleNameOf(el)}`).join('、')}；请用 nth（0-based）选择或改用 selector`);
                return pool[0] ?? null;
            }
            return descriptor.selector ? document.querySelector(descriptor.selector) : null;
        };
        // 提升只在解析出口做一次：selector 与 find 两条分支都走同一套目标，inspect/observe/click/type/read 看到同一个元素。
        const resolve = (): Element | null => promoteSvg(resolveRaw());
        // 只回传稳定描述符；拿不到稳定名称时省略 find，让 act 草稿放弃该步骤而不是记录用户输入。
        const observed = (el: Element) => {
            const role = roleOf(el);
            const name = accessibleNameOf(el);
            if (!name || name.length > 120) return undefined;
            const peers = Array.from(document.querySelectorAll('*'))
                .filter((node) => roleOf(node) === role && accessibleNameOf(node) === name);
            const index = peers.indexOf(el);
            return { role: role || undefined, name, ...(peers.length > 1 && index >= 0 ? { nth: index } : {}) };
        };
        // 与 content script 的 buildEffectEvidence 同源：动作前后各观测一次真实目标，只有字段真的变了才算 changed。
        const clip = (raw: unknown, max: number) => {
            const text = normalize(raw);
            return text.length > max ? `${text.slice(0, max)}...` : text;
        };
        const textOf = (el: Element) => clip((el as HTMLElement).innerText || el.textContent || '', 220);
        const observable = (el: Element): PageObservableState => {
            const htmlEl = el as HTMLElement;
            const style = typeof window !== 'undefined' && typeof window.getComputedStyle === 'function' ? window.getComputedStyle(htmlEl) : undefined;
            const rect = typeof htmlEl.getBoundingClientRect === 'function' ? htmlEl.getBoundingClientRect() : undefined;
            // 密码框只暴露「有没有内容」：value 参与比对但永不回传明文，否则填写成功会被判成 unchanged 而触发无谓的真实事件重放。
            // 非输入元素（body 等）读取 value 会触发 native getter 抛 Illegal invocation，必须包 try。
            let raw: string | undefined;
            try {
                raw = 'value' in el ? String((el as HTMLInputElement).value || '') : undefined;
            } catch {
                raw = undefined;
            }
            const value = raw !== undefined && (el.getAttribute('type') || '').toLowerCase() === 'password' ? (raw ? '[set]' : '') : raw;
            return {
                visible: !(style && (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)) && (!rect || (rect.width > 0 && rect.height > 0)),
                text: textOf(el),
                value,
                ariaExpanded: el.getAttribute?.('aria-expanded') || undefined,
                disabled: htmlEl.hasAttribute?.('disabled') === true || el.getAttribute?.('aria-disabled') === 'true' || (htmlEl as HTMLButtonElement).disabled === true,
                className: typeof htmlEl.className === 'string' ? htmlEl.className : '',
            };
        };
        const centerOf = (el: Element): { x: number; y: number } | undefined => {
            const rect = typeof (el as HTMLElement).getBoundingClientRect === 'function' ? (el as HTMLElement).getBoundingClientRect() : undefined;
            if (!rect || !Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0 || rect.height <= 0) return undefined;
            return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
        };
        const effectOf = (name: 'click' | 'fill', el: Element, before: PageObservableState, documentChanged = false) => {
            const after = observable(el);
            const changedFields: string[] = (['visible', 'text', 'value', 'ariaExpanded', 'disabled', 'className'] as const)
                .filter((field) => before[field] !== after[field]);
            if (documentChanged) changedFields.push('document');
            const invalid = typeof el.matches === 'function' && el.matches(':invalid');
            const formInvalid = !invalid && typeof el.closest === 'function' ? el.closest('form')?.querySelector(':invalid') : null;
            const validationError = invalid || formInvalid ? '页面表单校验未通过' : undefined;
            const status = validationError ? 'validation_error' : changedFields.length > 0 ? 'changed' : name === 'click' ? 'requested' : 'unchanged';
            return {
                action: name,
                status,
                changed: changedFields.length > 0,
                target: { tag: el.tagName.toLowerCase(), role: el.getAttribute?.('role') || undefined,
                    text: clip(textOf(el), 120) || undefined },
                changed_fields: changedFields,
                observed: { visible: after.visible, text: after.text || undefined, value: after.value,
                    nearby_text: typeof el.parentElement?.textContent === 'string' ? clip(el.parentElement.textContent, 160) : undefined,
                    validation_error: validationError },
                diagnostic: validationError
                    ? `${name} 已执行，但目标附近报告表单校验错误；请修正字段后重试`
                    : changedFields.length > 0
                        ? `${name} 已执行，目标 ${el.tagName.toLowerCase()} 发生可观察变化：${changedFields.join(', ')}`
                        : `${name} 已请求目标 ${el.tagName.toLowerCase()}；目标附近未观察到同步 DOM 变化，不能据此判定页面无响应`,
            };
        };
        const target = resolve() as HTMLElement | null;
        if (!target) throw new Error(`元素未找到: ${descriptor.selector || JSON.stringify(descriptor.find)}`);
        // 动作前捕获稳定描述符：点击可能卸载目标、输入会改写 value，事后取会污染草稿。
        const stableFind = observed(target);
        // 定向读取：解析在真实 DOM 上完成，返回命中元素自己的正文/HTML，而不是整页文本。
        if (action === 'read') {
            const limit = Math.max(1, Number(text) || 20000);
            return { text: ((target as HTMLElement).innerText || target.textContent || '').slice(0, limit),
                html: target.outerHTML.slice(0, limit), tag: target.tagName, find: stableFind };
        }
        if (action === 'click' || action === 'scroll_into_view') target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        if (action === 'scroll_into_view') return { center: centerOf(target) };
        const form = (target as HTMLInputElement).form;
        // 与 content script 的 classifySensitiveTarget 同源：提交语义检查表单提交按钮（type+submit 会 requestSubmit），
        // 普通点击检查目标自身或它最近的按钮祖先（click 只点目标本身）。
        const button = submit
            ? (form?.querySelector('button[type="submit"], input[type="submit"], button:not([type])') as HTMLElement | null) || target
            : (target.closest?.('button, a, [role="button"], input[type="submit"]') as HTMLElement | null) || target;
        const label = (button.innerText || button.getAttribute?.('aria-label') || button.getAttribute?.('value') || button.textContent || '').trim().slice(0, 120);
        const surrounding = (form?.innerText || button.parentElement?.innerText || '').slice(0, 500);
        const amount = (surrounding.match(/(?:[$€£¥]\s*\d[\d,.]*|\d[\d,.]*\s*(?:元|円|美元|欧元|USD|CNY|EUR|GBP))/i) || [])[0] || '';
        const kind = /(?:支付|付款|购买|结算|下单|充值|订阅|捐赠|pay\b|checkout\b|purchase\b|place order\b|subscribe\b|donate\b)/i.test(label)
            ? 'payment' : /(?:删除|清空|移除|delete\b|remove\b|erase\b)/i.test(label) ? 'deletion'
                : amount && /(?:确认|确定|继续|提交|完成|confirm\b|continue\b|proceed\b|submit\b|complete\b)/i.test(label) ? 'payment' : 'ordinary';
        const signature = JSON.stringify([kind, label, amount]);
        if (action === 'inspect') return { kind, amount, label, signature, find: stableFind, center: centerOf(target), tag: target.tagName.toLowerCase() };
        if (action === 'observe') return { state: observable(target), center: centerOf(target), kind, tag: target.tagName.toLowerCase(), find: stableFind };
        // 聚焦是升级路径的前置动作：落在下面的填写分支里会用空串把已有值写空，必须单独短路。
        if (action === 'focus') {
            target.focus();
            return { focused: true, tag: target.tagName.toLowerCase(), kind, find: stableFind, center: centerOf(target) };
        }
        // 自由化模式：支付/敏感目标签名检查已移除。
        void approvedSignature;
        if (action === 'click') {
            const before = observable(target);
            // A click can update a sibling without changing the button itself; do not replay it.
            const root = document.documentElement || document.body;
            const observer = typeof MutationObserver === 'function' && root ? new MutationObserver(() => undefined) : null;
            observer?.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
            let documentChanged = false;
            try {
                target.click();
                documentChanged = (observer?.takeRecords().length ?? 0) > 0;
            } finally {
                observer?.disconnect();
            }
            const effect = effectOf('click', target, before, documentChanged);
            return { clicked: descriptor.selector || 'find', tag: target.tagName.toLowerCase(), kind, center: centerOf(target), find: stableFind, effect, changed: effect.changed };
        }
        const before = observable(target);
        const input = target as HTMLInputElement | HTMLTextAreaElement;
        // 非输入元素直接报可操作错误，而不是让 native value setter 抛 "Illegal invocation"。
        // 用结构判断而非 instanceof：跨 realm（executeScript 注入）与测试 mock 都不是真实 HTMLInputElement 实例。
        const tag = target.tagName.toLowerCase();
        const inputType = ((target as HTMLInputElement).type || (tag === 'input' ? 'text' : '')).toLowerCase();
        const fillableTags = tag === 'textarea' || (tag === 'input' && !/^(?:button|submit|reset|image|checkbox|radio|file|hidden|range|color)$/i.test(inputType));
        const isTextInput = fillableTags || (target as HTMLElement).isContentEditable === true;
        if (!isTextInput) {
            throw new Error(`目标元素不可输入文本（tag=${tag}${inputType ? `, type=${inputType}` : ''}）；请改用 page.click 或换一个 input/textarea 目标`);
        }
        input.focus();
        // 优先用原生 setter（React 等受控组件需要）；对非常规目标 setter 可能非法调用，包 try 兜底直接赋值。
        const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        try {
            if (setter) setter.call(input, text); else input.value = text;
        } catch {
            input.value = text;
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        if (submit) {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            if (input.form && typeof input.form.requestSubmit === 'function') input.form.requestSubmit();
        }
        const effect = effectOf('fill', target, before);
        return { typed: true, ...(descriptor.selector ? { selector: descriptor.selector } : {}), find: stableFind, kind, center: centerOf(target), effect, changed: effect.changed };
    };
    try {
        return { __actspan_page_result: true, ok: true, value: await body() };
    } catch (error) {
        return { __actspan_page_result: true, ok: false, error: String((error as Error)?.message ?? error) };
    }
}

/** 导航前拒绝本机/内网与凭据页；about:blank 仍允许。 */
function assertSafeNavigableTarget(value: unknown): string {
    const raw = String(value ?? '').trim();
    if (!isSafeNavigableUrl(raw)) throw new Error('仅允许 http/https 页面（或 about:blank）');
    if (/^https?:/i.test(raw)) {
        if (isBlockedFetchUrl(raw)) throw new Error('不允许打开本机或内网地址');
        if (isCredentialUrl(raw)) throw new Error('不允许打开凭据页面');
    }
    return raw;
}
/**
 * ref 动作的唯一通道：句柄解析与动作执行发生在同一次 content-script 调用里，
 * 页面无法用公开属性把 ref 重定向到别的元素。
 */
async function runRefAction<T = Record<string, unknown>>(
    context: TaskContext, tabId: number, action: 'inspect' | 'read' | 'click' | 'type' | 'observe' | 'focus' | 'scroll_into_view', target: ActionTarget,
    payload: Record<string, unknown> = {}, frameId?: number): Promise<T> {
    const result = await sendToTabWithRetry<{ success: boolean; error?: string; data?: T }>(
        tabId, '__page_grounding_action',
        { action, element_id: target.ref, snapshot_id: target.snapshotId, ...payload },
        { signal: context.signal, deadlineMs: 5000, timeoutMessage: 'ref 动作执行超时', frameId });
    if (!result?.success) {
        throw new Error(result?.error || 'ref 句柄已失效，请重新调用 page(action="snapshot") 或改用 find');
    }
    return result.data as T;
}

export async function executeBridgeRequest(method: string, params: Record<string, unknown>, context: {
    clientId: string; requestId: string; taskId: string; sessionId: string; tabId?: number;
    workflowStep?: boolean; finalize?: boolean;
}, signal?: AbortSignal): Promise<unknown> {
    assertSignalActive(signal);
    const runContext: TaskContext = { ...context, owner: 'ide-agent', creator: 'mcp', signal };
    const executor = getTaskExecutor();
    const normalizedParams = canonicalizePlanTabParams(params, context.tabId);
    assertSignalActive(signal);
    // 自由化模式：所有能力自动放行，无确认、无审批凭证、无支付签名。
    try {
        const result = await executor.execute(runContext, method, normalizedParams);
        const reminder = method !== 'tabs.list' && (method.startsWith('page.') || method.startsWith('tab.'))
            ? tabLeaseManager.getReminder({ clientId: context.clientId, sessionId: context.sessionId,
                tabId: typeof params.tabId === 'number' || typeof params.tab_id === 'number' ? resolvePlanTabId(normalizedParams) : undefined }) : undefined;
        return reminder ? result && typeof result === 'object' && !Array.isArray(result)
            ? { ...result, reminder } : { result, reminder } : result;
    }
    finally { approvedPaymentActions.delete(normalizedParams); }
}

// ============ 指令执行 ============

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    if (signal?.aborted) {
        reject(new Error('Bridge 请求已取消'));
        return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(new Error('Bridge 请求已取消'));
    };
    timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
});

/** 过期/已释放的租约允许同一会话重新接管，避免长时间任务只能重新 tab.open。 */
function authorizeOrReclaim(context: TaskContext, tabId: number, mutate: boolean): void {
    const lease = tabLeaseManager.get(tabId);
    if (!lease) {
        if (mutate) tabLeaseManager.authorize(context, tabId, true);
        return;
    }
    if (lease.releasedAt || lease.expiresAt <= Date.now()) {
        const sameOwner = lease.taskId === context.taskId
            && lease.sessionId === context.sessionId
            && lease.clientId === context.clientId;
        // 只读请求不能抢走其他任务过期/释放的标签页；仅写操作或原所有者可接管。
        if (!mutate && !sameOwner) {
            tabLeaseManager.authorize(context, tabId, false);
            return;
        }
        tabLeaseManager.reclaim(context, tabId);
        return;
    }
    tabLeaseManager.authorize(context, tabId, mutate);
}

async function resolveTab(context: TaskContext, tabId: number | undefined, mode: 'read' | 'mutate'): Promise<chrome.tabs.Tab> {
    assertSignalActive(context.signal);
    if (typeof tabId === 'number') {
        authorizeOrReclaim(context, tabId, mode === 'mutate');
        const tab = await chrome.tabs.get(tabId);
        assertSignalActive(context.signal);
        return tab;
    }
    if (mode === 'read') {
        const found = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        assertSignalActive(context.signal);
        if (!found[0]?.id) throw new Error('找不到目标标签页');
        if (tabLeaseManager.get(found[0].id)) authorizeOrReclaim(context, found[0].id, false);
        return found[0];
    }
    const task = taskManager.get(context.taskId);
    if (task?.activeTabId !== undefined) {
        authorizeOrReclaim(context, task.activeTabId, true);
        const tab = await chrome.tabs.get(task.activeTabId);
        assertSignalActive(context.signal);
        return tab;
    }
    throw new Error('写操作必须指定当前任务拥有的 tabId，或先打开新的标签页');
}
async function waitComplete(tabId: number, timeoutMs = 20000, signal?: AbortSignal): Promise<chrome.tabs.Tab> {
    assertSignalActive(signal);
    const deadline = Date.now() + timeoutMs;
    let tab = await chrome.tabs.get(tabId);
    assertSignalActive(signal);
    while (tab.status !== 'complete' && Date.now() < deadline) {
        await sleep(300, signal);
        tab = await chrome.tabs.get(tabId);
        assertSignalActive(signal);
    }
    return tab;
}

/** executeScript 的 func 必须自包含（无闭包引用），序列化后在页面里重建 */
async function execInTab<T>(
    tabId: number,
    func: (...args: never[]) => T,
    args: unknown[] = [],
    world: 'ISOLATED' | 'MAIN' = 'ISOLATED',
    signal?: AbortSignal,
): Promise<T> {
    assertSignalActive(signal);
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        world,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        func: func as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        args: args as any,
    });
    assertSignalActive(signal);
    const r = results?.[0] as { result?: unknown; error?: unknown } | undefined;
    if (r?.error) throw r.error instanceof Error ? r.error : new Error(String(r.error));
    const raw: unknown = r?.result;
    // 页面侧 throw 到不了这里（Chrome 把它吞成 result:null），所以带信封的注入函数自己报错。
    if (isPageResultEnvelope(raw)) {
        if (raw.ok !== true) throw new Error(raw.error || '页面操作失败');
        return raw.value as T;
    }
    return raw as T;
}

/** 读页面内容前的统一闸门：命中人机验证页即交给用户确认并终止，绝不把验证页当普通内容返回。 */
const assertNoChallenge = async (context: TaskContext, tabId: number): Promise<void> => {
    const evidence = await execInTab<ChallengeEvidence>(tabId, (() => ({
        frames: Array.from(document.querySelectorAll('iframe')).map((frame) => (frame as HTMLIFrameElement).src),
        overlays: Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).map((node) => (node as HTMLElement).innerText || ''),
    })) as never, [], 'ISOLATED', context.signal);
    if (detectChallenge(evidence).detected) {
        await requestConfirmationFunction.execute({ message: CHALLENGE_MESSAGE }, { signal: context.signal });
        throw new PolicyError(CHALLENGE_MESSAGE, 'E_CHALLENGE');
    }
};

async function withDebugger<T>(context: TaskContext, tabId: number, fn: () => Promise<T>): Promise<T> {
    assertSignalActive(context.signal);
    // 一个标签页只允许一个调试器。attach/detach 必须统一走 CDPSessionManager，
    // 否则 page.click 的真实事件升级（cdp-input）与 page.screenshot / page.eval
    // 会各自 attach 同一个标签页，后到的一方必然撞 "Another debugger is already attached"。
    return tabLeaseManager.withDebugger(context, tabId,
        async () => {
            const attached = await CDPSessionManager.attach(tabId);
            if (!attached.success) throw new Error(attached.error || '调试器 attach 失败');
        },
        async () => { await CDPSessionManager.detach(tabId); }, fn, context.signal);
}

export function filterTabsForContext(
    tabs: chrome.tabs.Tab[],
    context: Pick<TaskContext, 'taskId' | 'sessionId' | 'clientId'>,
    leases: TabLease[] = tabLeaseManager.list(),
): Array<{ id?: number; url?: string; title?: string; active?: boolean }> {
    const ownedTabIds = new Set(leases
        .filter((lease) => lease.taskId === context.taskId && lease.sessionId === context.sessionId &&
            lease.clientId === context.clientId && !lease.releasedAt && lease.expiresAt > Date.now())
        .map((lease) => lease.tabId));
    return tabs
        .filter((tab) => typeof tab.id === 'number' && ownedTabIds.has(tab.id))
        .map((tab) => ({ id: tab.id, url: tab.url, title: tab.title, active: tab.active }));
}

export async function dispatch(method: string, params: Record<string, unknown>, context: TaskContext): Promise<unknown> {
    assertSignalActive(context.signal);
    switch (method) {
        case 'ping':
            return { pong: true, version: VERSION, uptime: 'extension', ...(protocolWarning ? { warning: protocolWarning } : {}) };

        case 'tabs.list': {
            const tabs = await chrome.tabs.query({});
            assertSignalActive(context.signal);
            const visible = new Map(tabs.filter((tab) => typeof tab.id === 'number').map((tab) => [tab.id, tab]));
            return tabLeaseManager.listTabs(context).filter((entry) => visible.has(entry.tabId)).map((entry) => {
                const tab = visible.get(entry.tabId)!;
                return entry.marker === '×' ? { id: entry.tabId, marker: entry.marker }
                    : { id: entry.tabId, marker: entry.marker, label: entry.label,
                        url: redactSensitive({ url: tab.url || '' }).url, title: tab.title, active: tab.active };
            });
        }

        case 'tabs.select': {
            const tabId = params.tabId;
            if (!Number.isSafeInteger(tabId)) throw new PolicyError('必须提供有效 tabId', 'E_TAB_OWNERSHIP');
            const lease = tabLeaseManager.get(tabId as number);
            if (lease && lease.sessionId === context.sessionId && lease.clientId === context.clientId && lease.taskId !== context.taskId) {
                return { tabId, warning: `标签页 ${tabId} 属于本会话的另一任务，请使用该任务的 taskId，当前任务的默认标签页不变。` };
            }
            const selected = tabLeaseManager.selectTab(context, tabId as number);
            if (!selected.warning && lease?.taskId === context.taskId && lease.sessionId === context.sessionId && lease.clientId === context.clientId) {
                taskManager.update(context.taskId, { activeTabId: tabId as number });
            }
            return selected;
        }

        case 'tab.open': {
            const task = taskManager.get(context.taskId);
            if (!task) throw new Error('任务记录不存在');
            assertSignalActive(context.signal);
            const targetUrl = assertSafeNavigableTarget(params.url);
            const tab = await chrome.tabs.create({
                url: targetUrl,
                active: params.active === true,
            });
            const tabId = tab.id;
            if (typeof tabId !== 'number') throw new Error('新标签页缺少 tabId');
            try {
                assertSignalActive(context.signal);
                tabLeaseManager.acquire(task, tabId, context.clientId);
                const label = typeof params.label === 'string' ? params.label.trim().slice(0, 80) : '';
                tabLeaseManager.registerTab(task, tabId, { ...(label ? { label } : {}), defaultSlot: true });
                await taskManager.persist();
                const done = await waitComplete(tabId, 20000, context.signal);
                // 302 等最终地址同样不得落在本机/内网/凭据页。
                assertSafeNavigableTarget(done.url);
                readDriftTracker.setBaseline(context.sessionId, done.url);
                return { tabId: done.id, url: done.url, title: done.title, label: label || undefined,
                    taskId: context.taskId, sessionId: context.sessionId };
            } catch (error) {
                try { await chrome.tabs.remove(tabId); } catch { /* 标签页可能已被用户关闭 */ }
                tabLeaseManager.release(context.taskId, tabId, context.clientId);
                taskManager.releaseOwnedTab(context.taskId, tabId);
                throw error;
            }
        }

        case 'tab.navigate': {
            const tab = await resolveTab(context, params.tabId as number | undefined, 'mutate');
            assertSignalActive(context.signal);
            const targetUrl = assertSafeNavigableTarget(params.url);
            tabLeaseManager.authorizeWrite(context, tab.id!);
            const previousUrl = tab.url;
            await chrome.tabs.update(tab.id!, { url: targetUrl });
            const done = await waitComplete(tab.id!, 20000, context.signal);
            try {
                assertSafeNavigableTarget(done.url);
            } catch (error) {
                // 回滚可避免继续在已租用标签页上读取内网页面；请求本身已发生，属残余盲 SSRF。
                if (previousUrl && isSafeNavigableUrl(previousUrl) && !isBlockedFetchUrl(previousUrl)) {
                    try { await chrome.tabs.update(tab.id!, { url: previousUrl }); } catch { /* 标签页可能已关闭 */ }
                }
                throw error;
            }
            readDriftTracker.setBaseline(context.sessionId, done.url);
            return { tabId: done.id, url: done.url, title: done.title };
        }

        case 'tab.close':
            await resolveTab(context, Number(params.tabId), 'mutate');
            assertSignalActive(context.signal);
            tabLeaseManager.authorizeWrite(context, Number(params.tabId));
            await chrome.tabs.remove(Number(params.tabId));
            return { closed: true };

        case 'page.eval': {
            // No arbitrary main-world JS is approved for mutation: V8's throwOnSideEffect must accept the expression.
            // This is a V8 side-effect check, not a JavaScript sandbox or a promise of confinement for every page API.
            const tab = await resolveTab(context, params.tabId as number | undefined, 'mutate');
            const opened = await taskManager.withNewTabs(context, tab.id!, () => withDebugger(context, tab.id!, async () => {
                tabLeaseManager.authorizeWrite(context, tab.id!);
                assertSignalActive(context.signal);
                const r = await chrome.debugger.sendCommand({ tabId: tab.id! }, 'Runtime.evaluate', {
                    expression: String(params.expression),
                    returnByValue: true,
                    awaitPromise: true,
                    userGesture: false,
                    throwOnSideEffect: true,
                }) as {
                    result?: { value?: unknown };
                    exceptionDetails?: { exception?: { description?: string }; text?: string };
                };
                if (r?.exceptionDetails) {
                    const detail = r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'JS 执行异常';
                    // V8 的 throwOnSideEffect 对 DOM 取值也保守拒绝（getter 可能有副作用）。
                    // 这条错误必须自带下一步，否则 agent 会换着表达式反复试错。
                    if (/side.?effect|副作用/i.test(detail)) {
                        throw new Error(`${detail}：该表达式无法被证明无副作用。读取页面状态请改用 page_read 的 attr: "value" | "text" | "checked" | "textContains"（可配 selector / find），或用 page_snapshot 取元素清单。`);
                    }
                    throw new Error(detail);
                }
                return r?.result?.value;
            }));
            return opened.tabId ? { result: opened.result, parentTabId: opened.parentTabId,
                tabId: opened.tabId, newTabIds: opened.newTabIds } : opened.result;
        }

        case 'page.read': {
            const target = params.selector || params.ref || params.find ? buildActionTarget(params) : undefined;
            const tab = await resolveTab(context, params.tabId as number | undefined, 'read');
            const maxChars = Number(params.maxChars) || 20000;
            const currentUrl = tab.url || '';
            if (!readDriftTracker.hasBaseline(context.sessionId)) readDriftTracker.setBaseline(context.sessionId, currentUrl);
            await assertNoChallenge(context, tab.id!);
            // 条件探针：把 DOM 状态折算成布尔证据，原始 value 与页面文本绝不回传。
            if (params.attr !== undefined) {
                const attr = String(params.attr);
                if (!['exists', 'checked', 'value', 'text', 'textContains'].includes(attr)) {
                    throw new Error(`不支持的读取属性: ${attr}`);
                }
                const routed = target ? routeActionTarget(target) : undefined;
                const probe = await sendToTabWithRetry<{ success: boolean; error?: string; data?: Record<string, unknown> }>(
                    tab.id!, '__page_grounding_action',
                    { action: 'read', attr, ...(params.expect === undefined ? {} : { expect: String(params.expect) }),
                        ...(routed?.target.ref ? { element_id: routed.target.ref, snapshot_id: routed.target.snapshotId } : {}),
                        ...(routed?.target.selector ? { selector: routed.target.selector } : {}),
                        ...(routed?.target.find ? { find: routed.target.find } : {}) },
                    // 未定向的消息会投递到全部框架，子框架可能抢先回传错误的状态。
                    { signal: context.signal, deadlineMs: 5000, timeoutMessage: '页面状态探针超时', frameId: routed?.frameId ?? MAIN_FRAME_ID });
                if (!probe?.success) throw new Error(probe?.error || '页面状态探针失败');
                return { url: redactSensitive({ url: currentUrl }).url, ...(probe.data || {}) };
            }
            let content: unknown;
            let hit: { tag?: string; find?: unknown } | undefined;
            if (target) {
                const routed = routeActionTarget(target);
                const read = routed.target.ref
                    ? await runRefAction<{ text: string; html: string; tag: string; find?: unknown }>(
                        context, tab.id!, 'read', routed.target, { max_chars: maxChars }, routed.frameId)
                    : await execInTab(tab.id!, pageAction as never,
                        ['read', routed.target, String(maxChars), false], 'ISOLATED', context.signal) as { text: string; html: string; tag: string; find?: unknown };
                content = params.format === 'html' ? read.html : read.text;
                hit = { tag: read.tag, find: read.find };
            } else {
                content = params.format === 'html'
                    ? await execInTab(tab.id!, ((n: number) => document.documentElement.outerHTML.slice(0, n)) as never, [maxChars], 'ISOLATED', context.signal)
                    : await execInTab(tab.id!, ((n: number) => (document.body?.innerText || '').slice(0, n)) as never, [maxChars], 'ISOLATED', context.signal);
            }
            const driftWarning = readDriftTracker.check(context.sessionId, currentUrl);
            const redacted = redactPageContent(content, currentUrl);
            const credentialPage = isMaskedPage(redacted);
            // 非凭据 URL 也可能被成组规则掩码（脱敏组、手机号、token 键）；内容真被改动就要告诉调用方，
            // 否则 agent 会把掩码后的文本当成页面原文转述。
            const maskedContent = !credentialPage && typeof content === 'string' && typeof redacted === 'string' && redacted !== content;
            const pageContent = credentialPage ? String(redacted.content) : wrapUntrustedPageContent(String(redacted));
            const credentialWarning = credentialPage
                ? redacted.warning
                : (maskedContent ? '页面包含疑似凭据或敏感内容，已掩码' : '');
            // 掩码文案是扩展自己生成的，不是页面原文，不进不可信围栏；只有真实页面内容才降权。
            return { title: credentialPage ? '[凭据页面已掩码]' : redactSensitive(tab.title),
                url: redactSensitive({ url: currentUrl }).url,
                content: pageContent,
                ...(hit ? { target: hit } : {}),
                ...(credentialWarning || driftWarning ? { warning: [credentialWarning,
                    driftWarning ? '读取标签页发生漂移，请确认当前页面' : ''].filter(Boolean).join('；') } : {}) };
        }

        case 'page.snapshot': {
            const tab = await resolveTab(context, params.tabId as number | undefined, 'read');
            await assertNoChallenge(context, tab.id!);
            const tabSnapshotId = `snap-${crypto.randomUUID()}`;
            const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 60);
            const frameParams = {
                ...(typeof params.query === 'string' && params.query.trim() ? { query: params.query } : {}),
                ...(typeof params.scope_selector === 'string' && params.scope_selector.trim() ? { scope_selector: params.scope_selector } : {}),
                include_non_interactive: params.include_non_interactive === true,
                include_hidden: params.include_hidden === true,
                only_viewport: params.only_viewport === true,
                limit,
            };
            // 默认只读主框架；跨源 iframe 文本需要显式 include_frames 并触发敏感审批。
            const allFrames = await listTabFrames(tab.id!);
            const frames = params.include_frames === true ? allFrames : allFrames.filter((frame) => frame.frameId === MAIN_FRAME_ID);
            const collected = await Promise.all(frames.map(async (frame) => {
                try {
                    const result = await sendToTabWithRetry<{ success: boolean; error?: string; data?: { elements?: unknown[] } }>(
                        tab.id!, '__page_grounding_snapshot',
                        { ...frameParams, snapshot_id: frameSnapshotId(tabSnapshotId, frame.frameId) },
                        { signal: context.signal, deadlineMs: 8000, timeoutMessage: `frame ${frame.frameId} 快照超时`, frameId: frame.frameId });
                    if (!result?.success) {
                        return { frame, elements: [] as unknown[], error: result?.error || '快照失败' };
                    }
                    return { frame, elements: Array.isArray(result.data?.elements) ? result.data.elements : [], error: undefined };
                } catch (error) {
                    return { frame, elements: [] as unknown[], error: error instanceof Error ? error.message : String(error) };
                }
            }));
            // 协议不变：agent 只看到一个 tab 级 snapshotId，子框架元素靠 ref 后缀区分归属。
            const ranked = collected.flatMap((entry) => entry.elements.map((element, index) => {
                const descriptor = element && typeof element === 'object' ? element as Record<string, unknown> : {};
                const baseRef = typeof descriptor.element_id === 'string' ? descriptor.element_id : '';
                return {
                    descriptor: {
                        ...descriptor,
                        ...(baseRef ? { element_id: qualifyRef(baseRef, entry.frame.frameId) } : {}),
                        snapshot_id: tabSnapshotId,
                        ...(entry.frame.frameId === MAIN_FRAME_ID ? {} : { frame_id: entry.frame.frameId, frame_url: entry.frame.url }),
                    },
                    frameId: entry.frame.frameId,
                    score: Number(descriptor.score) || 0,
                    index,
                };
            })).sort((left, right) => right.score - left.score || left.frameId - right.frameId || left.index - right.index);
            // 元素描述符里的 value 是输入框明文，text 也可能夹带手机号/凭据；出口必须统一脱敏，
            // 定位字段（element_id/snapshot_id/rect/selector）由 redactSensitive 保留。
            const merged = ranked.slice(0, limit).map((entry) => redactSensitive(entry.descriptor));
            return {
                snapshot_id: tabSnapshotId,
                url: redactSensitive({ url: tab.url || '' }).url,
                title: redactSensitive(tab.title),
                matched_query: frameParams.query,
                scope_selector: frameParams.scope_selector,
                frames: collected.map((entry) => ({ frame_id: entry.frame.frameId, url: redactSensitive({ url: entry.frame.url }).url,
                    element_count: entry.elements.length, ...(entry.error ? { error: entry.error } : {}) })),
                total_candidates: ranked.length,
                elements: merged,
                message: `已生成页面语义快照（${merged.length} 个候选元素，覆盖 ${collected.length} 个框架）`,
            };
        }

        case 'page.click':
        case 'page.type': {
            const routed = routeActionTarget(buildActionTarget(params));
            const target = routed.target;
            const tab = await resolveTab(context, params.tabId as number | undefined, 'mutate');
            tabLeaseManager.authorizeWrite(context, tab.id!);
            const approvedSignature = approvedPaymentActions.get(params);
            approvedPaymentActions.delete(params);
            const action = method === 'page.click' ? 'click' as const : 'type' as const;
            const submit = method === 'page.type' && params.submit === true;
            const realRequested = params.real === true;
            const text = String(params.text ?? '');
            const synthetic = () => target.ref
                ? runRefAction<Record<string, unknown>>(context, tab.id!, action, target,
                    { ...(action === 'type' ? { text, submit } : {}),
                      ...(approvedSignature ? { approved_signature: approvedSignature } : {}) }, routed.frameId)
                // 数组里出现 undefined 会让 executeScript 直接报 "Value is unserializable"，
                // 于是每一次普通点击都失败。缺省时干脆不占位，页面侧拿到的是同样的 undefined。
                : execInTab(tab.id!, pageAction as never,
                    [action, target, text, submit, ...(approvedSignature ? [approvedSignature] : [])],
                    'ISOLATED', context.signal) as Promise<Record<string, unknown>>;
            const observe = async (): Promise<ObservedTarget | null> => {
                try {
                    const observed = target.ref
                        ? await runRefAction<ObservedTarget>(context, tab.id!, 'observe', target, { submit }, routed.frameId)
                        : await execInTab(tab.id!, pageAction as never, ['observe', target, '', submit], 'ISOLATED', context.signal) as ObservedTarget;
                    return observed && typeof observed === 'object' && observed.state ? observed : null;
                } catch { return null; }
            };
            // A1：真实事件通道复用 cdp-input 的 CDP 事件序列；坐标由内容脚本解析，桥只负责派发。
            const replayReal = async (): Promise<RealOutcome> => {
                if (action === 'click') {
                    try {
                        if (target.ref) await runRefAction(context, tab.id!, 'scroll_into_view', target, {}, routed.frameId);
                        else await execInTab(tab.id!, pageAction as never, ['scroll_into_view', target, '', false], 'ISOLATED', context.signal);
                    } catch {
                        return { success: false, error: '无法将目标滚动到视口', changed: false, changedFields: [], before: null, after: null };
                    }
                }
                const before = await observe();
                if (!before) return { success: false, error: '无法观测目标状态', changed: false, changedFields: [], before: null, after: null };
                let real: { success: boolean; error?: string };
                if (action === 'click') {
                    if (!before.center) return { success: false, error: '目标没有可用的视口坐标', changed: false, changedFields: [], before, after: null };
                    real = await realClickAt(tab.id!, before.center.x, before.center.y, context.signal, routed.frameId);
                } else {
                    let focused = true;
                    try {
                        if (target.ref) await runRefAction(context, tab.id!, 'focus', target, {}, routed.frameId);
                        else await execInTab(tab.id!, pageAction as never, ['focus', target, '', submit], 'ISOLATED', context.signal);
                    } catch { focused = false; }
                    if (!focused) return { success: false, error: '无法聚焦目标元素', changed: false, changedFields: [], before, after: null };
                    real = await realTypeInto(tab.id!, text, context.signal);
                    if (real.success && submit) real = await realPressKey(tab.id!, 'Enter');
                }
                const after = await observe();
                const changedFields = after ? OBSERVABLE_FIELDS.filter((field) => before.state[field] !== after.state[field]) : [];
                return { success: real.success, ...(real.error ? { error: real.error } : {}), changed: changedFields.length > 0, changedFields, before, after };
            };
            // 回执必须说清「哪个通道跑的、为什么、观测到什么」：升级后 changed 以真实事件为准，不做定长等待。
            const receipt = (base: Record<string, unknown>, outcome: RealOutcome, reason: 'explicit_real' | 'no_effect'): Record<string, unknown> => ({
                ...base, escalated: true, changed: outcome.changed,
                escalation: { channel: 'cdp_real_events', reason, success: outcome.success, ...(outcome.error ? { error: outcome.error } : {}) },
                effect: { ...((base.effect as Record<string, unknown>) || {}),
                    status: !outcome.success ? 'unchanged' : outcome.changed ? 'changed' : action === 'click' ? 'requested' : 'unchanged',
                    changed: outcome.changed, changed_fields: outcome.changedFields,
                    observed: outcome.after ? { visible: outcome.after.state.visible, text: outcome.after.state.text || undefined, value: outcome.after.state.value } : undefined,
                    diagnostic: !outcome.success
                        ? `真实事件（CDP）重放失败：${outcome.error || '未知原因'}`
                        : outcome.changed
                            ? `已用真实事件（CDP）重放，目标发生可观察变化：${outcome.changedFields.join(', ')}`
                            : '已用真实事件（CDP）重放；目标附近仍未观察到同步 DOM 变化，不能据此判定页面无响应' },
            });
            const run = async (): Promise<Record<string, unknown>> => {
                // C1③：合成点击可能只发请求、不改页面。监听已开时用请求增量把这种点击挡在自动重放之外。
                const netBefore = CDPSessionManager.isNetworkListening(tab.id!) ? CDPSessionManager.getNetworkSummary(tab.id!).total : null;
                if (realRequested) {
                    const outcome = await replayReal();
                    if (outcome.success) return receipt({ ...(action === 'click' ? { clicked: target.selector || 'find' } : { typed: true }),
                        tag: outcome.before?.tag, kind: outcome.before?.kind, ...(outcome.before?.find ? { find: outcome.before.find } : {}) }, outcome, 'explicit_real');
                    // A1：真实事件不可用（NEEDS_L2 / L2_BUSY / 无坐标）时，合成事件降级为兜底。
                    const fallback = await synthetic();
                    return { ...fallback, escalated: false,
                        escalation: { channel: 'cdp_real_events', reason: 'explicit_real', success: false, fallback: 'synthetic',
                            ...(outcome.error ? { error: outcome.error } : {}) } };
                }
                const syntheticResult = await synthetic();
                if (syntheticResult.changed === true) return syntheticResult;
                const kind = String(syntheticResult.kind || '');
                const tag = String(syntheticResult.tag || '').toLowerCase();
                const netAfter = netBefore === null ? null : CDPSessionManager.getNetworkSummary(tab.id!).total;
                // 网络请求已发出：点击生效了，不要重试。
                if (netBefore !== null && netAfter !== null && netAfter > netBefore) {
                    return { ...syntheticResult, effect: { ...((syntheticResult.effect as Record<string, unknown>) || {}),
                        diagnostic: '合成事件已派发一次点击，期间出现新的网络请求：点击已生效。不要重试；仅当确认页面忽略非可信事件（isTrusted）时才传 real:true（会再点一次）。' } };
                }
                // A2 例外 + A3 硬边界：提交动作、支付/删除类目标与原生 select 不自动升级（避免重复执行）。
                if (submit || kind === 'payment' || kind === 'deletion' || tag === 'select') return syntheticResult;
                // 点击：合成事件已执行 target.click()，onclick 已触发但可能只改了 sibling（观察不到）。
                // 无条件重放真实事件会对有副作用的点击造成双重触发，故不再自动升级。
                if (action === 'click') return { ...syntheticResult, effect: { ...((syntheticResult.effect as Record<string, unknown>) || {}),
                    diagnostic: '合成事件已派发一次点击，未观察到目标自身变化（可能只改了兄弟节点）。不要重试；仅当确认页面忽略非可信事件（isTrusted）时才传 real:true（会再点一次）。' } };
                // 输入：合成事件可能被受控组件拦截，仍需真实键盘事件兜底。
                return receipt(syntheticResult, await replayReal(), 'no_effect');
            };
            if (method === 'page.type' && params.submit !== true) return run();
            const opened = await taskManager.withNewTabs(context, tab.id!, run);
            return { ...(opened.result as Record<string, unknown>), parentTabId: opened.parentTabId,
                ...(opened.tabId === undefined ? {} : { tabId: opened.tabId, newTabIds: opened.newTabIds }) };
        }

        case 'page.screenshot': {
            // 可视区 PNG 截图（free mode 实现）。
            // 必须走 CDPSessionManager.sendCommand：它管理 inFlightCommands 并 touchSession，
            // 否则空闲 5s 的 idle detach 会在 attach 后立即 detach，撞上 captureScreenshot（Detached while handling command）。
            const tab = await resolveTab(context, params.tabId as number | undefined, 'read');
            return withDebugger(context, tab.id!, async () => {
                assertSignalActive(context.signal);
                // 必须走 CDPSessionManager.sendCommand：它管理 inFlightCommands 并 touchSession，
                // 否则空闲 5s 的 idle detach 会在 attach 后立即 detach，撞上 captureScreenshot（Detached while handling command）。
                const res = await CDPSessionManager.sendCommand(tab.id!, 'Page.captureScreenshot', { format: 'png' });
                if (!res.success) throw new Error(res.error || '截图命令失败');
                const shot = res.result as { data?: string };
                if (!shot?.data) throw new Error('截图返回为空');
                return { mimeType: 'image/png', data: shot.data };
            });
        }
        case 'page.select':
        case 'page.upload':
        case 'page.key':
        case 'page.wait':
        case 'page.scroll': {
            const tab = await resolveTab(context, params.tabId as number | undefined, method === 'page.wait' ? 'read' : 'mutate');
            if (method !== 'page.wait') tabLeaseManager.authorizeWrite(context, tab.id!);
            return handleMcpInteraction(method, params, context, tab.id!);
        }

        case 'network.list':
        case 'network.detail':
        case 'network.query': {
            const tab = await resolveTab(context, params.tabId as number | undefined, params.reload === true ? 'mutate' : 'read');
            if (params.reload === true) tabLeaseManager.authorizeWrite(context, tab.id!);
            return handleMcpNetwork(method, params, context, tab.id!);
        }

        case 'act.draft': {
            const tab = await resolveTab(context, params.tabId as number | undefined, 'read');
            return recordSuccessfulActDraft({ ...params, tabId: tab.id });
        }

        case 'act.adopt': {
            const tab = await resolveTab(context, params.tabId as number | undefined, 'mutate');
            tabLeaseManager.authorizeWrite(context, tab.id!);
            return adoptActDraft({ draftId: params.draftId, tabId: tab.id });
        }

        default:
            throw new Error(`未知指令: ${method}`);
    }
}

async function ensureMcpOffscreenDocument(): Promise<void> {
    if (!chrome.offscreen?.hasDocument || !chrome.offscreen?.createDocument) return;
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
        url: 'mcp.html',
        reasons: ['WORKERS'],
        justification: 'Keep the authenticated MCP WebSocket alive while the service worker is suspended.',
    });
}

const BRIDGE_SETTINGS_KEY = 'actspan_mcp_bridge_settings';
const BRIDGE_LEGACY_SETTINGS_KEY = 'mole_mcp_bridge';
const BRIDGE_SETTINGS_MIGRATED_KEY = 'actspan_mcp_bridge_settings_migrated_v1';
const BRIDGE_AUTO_KEY = 'actspan_mcp_bridge_auto';

/** 旧键只迁移一次；此后设置以 actspan_mcp_bridge_settings 为准。 */
const readBridgeSettings = async (): Promise<{ settings: Record<string, unknown>; auto: Record<string, unknown> }> => {
    const current = await chrome.storage.local.get([BRIDGE_SETTINGS_KEY, BRIDGE_SETTINGS_MIGRATED_KEY, BRIDGE_AUTO_KEY]);
    if (!current[BRIDGE_SETTINGS_MIGRATED_KEY]) {
        const legacy = await chrome.storage.local.get(BRIDGE_LEGACY_SETTINGS_KEY);
        const settings = current[BRIDGE_SETTINGS_KEY] ?? legacy[BRIDGE_LEGACY_SETTINGS_KEY] ?? {};
        await chrome.storage.local.set({ [BRIDGE_SETTINGS_KEY]: settings, [BRIDGE_SETTINGS_MIGRATED_KEY]: true });
        return { settings: settings as Record<string, unknown>, auto: (current[BRIDGE_AUTO_KEY] || {}) as Record<string, unknown> };
    }
    return {
        settings: (current[BRIDGE_SETTINGS_KEY] || {}) as Record<string, unknown>,
        auto: (current[BRIDGE_AUTO_KEY] || {}) as Record<string, unknown>,
    };
};

const registerOffscreenTransport = (): void => {
    chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
        if (!sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`)) return false;
        if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
        const frame = message as Record<string, unknown>;
        if (frame.type === runtimeRequestType && isBridgeRequestFrame(frame.frame)) {
            void handleOffscreenRequest(frame.frame);
            sendResponse({ accepted: true });
            return false;
        }
        // offscreen 文档只有 chrome.runtime，设置读写必须由 service worker 代做。
        if (frame.type === SETTINGS_GET_MESSAGE) {
            void readBridgeSettings().then(sendResponse, () => sendResponse({ settings: {}, auto: {} }));
            return true;
        }
        if (frame.type === SETTINGS_SET_AUTO_MESSAGE && frame.value && typeof frame.value === 'object') {
            void chrome.storage.local.set({ [BRIDGE_AUTO_KEY]: frame.value })
                .then(() => sendResponse({ accepted: true }), () => sendResponse({ accepted: false }));
            return true;
        }
        if (frame.type === 'actspan_mcp_transport_event') {
            const status = typeof frame.status === 'string' ? frame.status : '';
            if (status === 'disconnected') {
                for (const controller of inFlightBridgeRequests.values()) controller.abort('bridge disconnected');
                inFlightBridgeRequests.clear();
                authenticatedBridge = false;
            } else {
                authenticatedBridge = status === 'connected' || (status === 'version_warning' && authenticatedBridge);
            }
            if (status === 'incompatible_protocol' || status === 'incompatible_peer') {
                protocolWarning = `MCP ${status}`;
                authenticatedBridge = false;
            } else if (status === 'version_warning') {
                protocolWarning = `MCP version ${String(frame.appVersion || '')} differs from extension ${VERSION}`;
            }
            sendResponse({ accepted: true });
            return false;
        }
        if (frame.type === 'actspan_mcp_socket_event' && authenticatedBridge && frame.frame && typeof frame.frame === 'object') {
            const event = frame.frame as Record<string, unknown>;
            // 取消帧被 offscreen 包了一层 socket_event：桥发来的 { type: 'actspan_mcp_cancel', id }
            // 在这里的嵌套帧上，必须在事件分支里按 id 中止在途请求，否则客户端超时后写操作仍会落地。
            if (event.type === runtimeCancelType && typeof event.id === 'string') {
                inFlightBridgeRequests.get(event.id)?.abort('cancelled by client');
                sendResponse({ accepted: true });
                return false;
            }
            if (event.type === 'session_disconnected' && typeof event.clientId === 'string' && typeof event.sessionId === 'string' &&
                validBridgeIdentity(event.clientId) && validBridgeIdentity(event.sessionId)) {
                tabLeaseManager.setSessionConnected({ clientId: event.clientId, sessionId: event.sessionId }, false);
            }
            sendResponse({ accepted: true });
            return false;
        }
        if (frame.type === 'actspan_mcp_transport_status') {
            sendResponse({ connected: authenticatedBridge });
            return false;
        }
        return false;
    });
    // 设置变化必须由这里转达：offscreen 文档订阅不到 chrome.storage.onChanged。
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local' || !changes[BRIDGE_SETTINGS_KEY]) return;
        void chrome.runtime.sendMessage({ type: SETTINGS_CHANGED_MESSAGE }).catch(() => undefined);
    });
    void ensureMcpOffscreenDocument().catch((error) => {
        protocolWarning = `MCP offscreen unavailable: ${error instanceof Error ? error.message : String(error)}`;
        authenticatedBridge = false;
    });
};

export function initMcpBridge() {
    registerOffscreenTransport();
    registerWorkflowPlanHandlers();
    for (const method of ['ping', 'tabs.list', 'tabs.select', 'tab.open', 'tab.navigate', 'tab.close',
        'page.eval', 'page.read', 'page.snapshot', 'page.click', 'page.type', 'page.screenshot']) {
        registerCapabilityHandler(method, (input, context) => dispatch(method, input, context));
    }
    registerDataCapabilityHandlers(registerCapabilityHandler);
    // page.snapshot 默认只读主框架；显式请求跨源子框架时提升为敏感审批。
    registerCapabilityHandler('page.snapshot', (input, context) => dispatch('page.snapshot', input, context),
        (input: Record<string, unknown>): PermissionLevel => input.include_frames === true ? 'sensitive' : 'read');
    for (const method of ['page.select', 'page.upload', 'page.key', 'page.wait', 'page.scroll',
        'network.list', 'network.detail', 'network.query', 'act.draft', 'act.adopt']) {
        const policy = method.startsWith('network.') ? (input: Record<string, unknown>): PermissionLevel => input.reload === true ? 'interact' : 'read'
            : method === 'page.wait' || method === 'act.draft' ? 'read' : method === 'act.adopt' ? 'sensitive' : 'interact';
        registerCapabilityHandler(method, (input, context) => dispatch(method, input, context), policy);
    }
    registerCapabilityHandler('page.status_update', updateStatus, 'read');
    registerCapabilityHandler('feishu.push', async (input) => {
        if (typeof input.title !== 'string' || typeof input.message !== 'string') {
            throw new Error('推送需要 title 和 message');
        }
        const webhookName = typeof input.webhookName === 'string' ? input.webhookName.trim() : undefined;
        const entries = selectCompletionWebhooks(await readWebhookConfig(), webhookName);
        if (entries.length === 0) {
            return {
                success: false,
                error: webhookName
                    ? `未找到已启用的飞书或钉钉 Webhook: ${webhookName}`
                    : '没有已启用的飞书或钉钉 Webhook，请在 Options > Webhook 页面添加并启用至少一个飞书或钉钉 Webhook',
            };
        }
        return sendWebhookEntries(entries, { title: input.title, message: input.message });
    });
    registerCapabilityHandler('registry.list', async () => {
        await ensureSkillRegistryReady();
        const snapshot = await registryService.listAll();
        return { revision: snapshot.revision, skills: snapshot.skills,
            syncStatus: getSyncStatus(await listManifestSources()), generatedAt: Date.now() };
    });
    registerCapabilityHandler('registry.detail', async (input) => {
        await ensureSkillRegistryReady();
        if (typeof input.name !== 'string' || !input.name) throw new Error('必须提供 Skill 名称');
        const scope = input.scope === 'domain' || input.scope === 'global' ? input.scope : undefined;
        const skill = await registryService.get(input.name, scope);
        if (!skill) throw new Error(`Skill 不存在: ${input.name}`);
        return { skill, revision: (await registryService.listAll()).revision };
    });
    registerCapabilityHandler('agent_delegate', async (input, context) => {
        const query = typeof input.query === 'string' ? input.query : typeof input.goal === 'string' ? input.goal : '';
        if (!query.trim()) throw new Error('委派步骤缺少 query/goal');
        const parent = taskManager.get(context.taskId);
        if (!parent) throw new Error('委派步骤缺少父任务');
        taskManager.assertNotCancelled(parent.taskId);
        const child = taskManager.create({ parentTaskId: parent.taskId, sessionId: parent.sessionId,
            clientId: context.clientId, owner: 'extension-agent', registryRevision: parent.registryRevision });
        return taskManager.submit(child.taskId, { ...input, query }, {
            ...context, requestId: crypto.randomUUID(), taskId: child.taskId, owner: 'extension-agent',
        });
    });
    chrome.runtime.onMessage.addListener((message: { type?: string }, _sender, sendResponse) => {
        if (message?.type !== 'actspan_bridge_status') return;
        sendResponse({ connected: authenticatedBridge });
    });
    registerCapabilityHandler('workflow.run', async (input, context) => {
        await ensureSkillRegistryReady();
        const snapshot = await registryService.listAll();
        const matches = snapshot.skills.filter((skill) => skill.enabled)
            .flatMap((skill) => skill.workflows.map((workflow) => ({ skill, workflow })))
            .filter(({ workflow }) => workflow.name === input.name);
        if (matches.length !== 1) throw new Error(matches.length ? '工作流名称不唯一' : '工作流不存在');
        const { workflow } = matches[0];
        const plan = workflow.steps?.length ? undefined : getWorkflowPlanForExecution(workflow);
        if (plan) {
            for (const step of plan.steps) {
                if (!step || typeof step.action !== 'string' || !isWorkflowPlanActionAllowed(step.action)) {
                    throw new Error(`不支持的工作流步骤: ${String(step?.action || '')}`);
                }
            }
        }
        const supplied = input.input ?? {};
        if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) throw new Error('工作流输入必须是对象');
        const values: Record<string, unknown> = { ...supplied as Record<string, unknown> };
        const properties = workflow.parameters?.properties as Record<string, { type?: string; default?: unknown }> | undefined;
        for (const [key, schema] of Object.entries(properties || {})) {
            if (values[key] === undefined && schema?.default !== undefined) values[key] = schema.default;
            const value = values[key];
            if (value === undefined) continue;
            const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
            if (schema?.type && type !== schema.type && !(schema.type === 'integer' && typeof value === 'number' &&
                Number.isInteger(value))) throw new Error(`工作流参数 ${key} 类型不匹配`);
        }
        for (const key of workflow.parameters?.required || []) {
            if (values[key] === undefined) throw new Error(`缺少工作流参数: ${key}`);
        }
        for (const step of workflow.steps || []) {
            if (!WORKFLOW_CAPABILITY[step.capability]) throw new Error(`不支持的工作流步骤: ${step.capability}`);
        }
        if (taskManager.get(context.taskId)) throw new Error('任务 ID 已存在');
        const mode = input.mode === 'continue' || input.mode === 'replace' ? input.mode : 'independent';
        const task = taskManager.create({ taskId: context.taskId, sessionId: context.sessionId,
            clientId: context.clientId, owner: context.owner, registryRevision: snapshot.revision, mode });
        const steps = workflow.steps || [];
        const workflowController = taskManager.createAbortController(task.taskId);
        const abortWorkflow = () => workflowController.abort(context.signal?.reason);
        if (context.signal?.aborted) workflowController.abort(context.signal.reason);
        else context.signal?.addEventListener('abort', abortWorkflow, { once: true });
        void (async () => {
            const results: unknown[] = [];
            let workflowOutcome: 'success' | 'failure' = 'failure';
            const keepAliveTabIds = new Set<number>();
            let planOutput: unknown;
            const planVars: Record<string, unknown> = {
                ...values,
                input: values,
                context: { tabId: values.tabId ?? values.tab_id ?? null },
                steps: {},
                last: null,
            };
            try {
                taskManager.update(task.taskId, { state: 'running' });
                if (plan) {
                    let runtimeTabId = typeof values.tabId === 'number' ? values.tabId
                        : typeof values.tab_id === 'number' ? values.tab_id : undefined;
                    for (let index = 0; index < plan.steps.length; index++) {
                        taskManager.assertNotCancelled(task.taskId);
                        const step = plan.steps[index];
                        const resolvedWhen = resolveTemplateValue(step.when === undefined ? true : step.when, planVars);
                        if (!shouldRunPlanStep(resolvedWhen)) continue;
                        const rawParams = resolveTemplateValue(step.params || {}, planVars);
                        if (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams)) {
                            throw new Error(`工作流步骤 ${index} 输入必须是对象`);
                        }
                        const params = canonicalizePlanTabParams({ ...(rawParams as Record<string, unknown>) }, runtimeTabId);
                        const action = step.action;
                        if (action === 'tab_navigate' && String(params.action || '').toLowerCase() === 'navigate') {
                            params.action = 'open';
                            if (params.active === undefined) params.active = false;
                        }
                        const stepTabId = resolvePlanTabId(params);
                        const maxAttempts = step.retry?.maxAttempts === 2 || step.onError === 'retry' ? 2 : 1;
                        const retryDelayMs = 250;
                        let stepResult: unknown;
                        let stepError: unknown;
                        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                            try {
                                stepResult = await executeBridgeRequest(`${WORKFLOW_PLAN_CAPABILITY_PREFIX}${action}`, params,
                                    { ...context, requestId: crypto.randomUUID(), workflowStep: true, finalize: false, tabId: stepTabId },
                                    workflowController.signal);
                                stepError = undefined;
                            } catch (error) {
                                stepError = error;
                                if (workflowController.signal.aborted) throw new Error('Bridge 请求已取消');
                                if (error instanceof PolicyError || error instanceof TabLeaseError || taskManager.isCancelled(task.taskId)) {
                                    throw error instanceof Error ? error : new Error(String(error));
                                }
                                if (attempt >= maxAttempts) break;
                                await sleep(retryDelayMs, workflowController.signal);
                                taskManager.assertNotCancelled(task.taskId);
                            }
                        }
                        if (stepError !== undefined) {
                            const message = stepError instanceof Error ? stepError.message : String(stepError);
                            if (step.onError === 'continue' || step.onError === 'fallback' || step.optional === true) {
                                const warning = { success: false, error: message };
                                results.push({ stepId: index, skipped: true, error: message });
                                planVars.last = warning;
                                planVars[`step_${index}`] = warning;
                                planVars.last_error = `step_${index} failed but continued: ${message}`;
                                if (step.saveAs) {
                                    (planVars.steps as Record<string, unknown>)[step.saveAs] = warning;
                                    planVars[step.saveAs] = warning;
                                }
                                continue;
                            }
                            throw stepError;
                        }
                        results.push(stepResult);
                        planVars.last = stepResult ?? null;
                        planVars[`step_${index}`] = stepResult ?? null;
                        if (step.saveAs) {
                            (planVars.steps as Record<string, unknown>)[step.saveAs] = stepResult ?? null;
                            planVars[step.saveAs] = stepResult ?? null;
                        }
                        const returnedTabId = stepResult && typeof stepResult === 'object'
                            ? Number((stepResult as Record<string, unknown>).tab_id) : NaN;
                        if (Number.isFinite(returnedTabId) && returnedTabId > 0) {
                            runtimeTabId = returnedTabId;
                            (planVars.context as Record<string, unknown>).tabId = returnedTabId;
                            const tabAction = String(params.action || '').toLowerCase();
                            const createsTab = action === 'tab_navigate'
                                && (tabAction === 'open' || tabAction === 'duplicate')
                                && (stepResult as Record<string, unknown> | null)?.reused !== true;
                            if (createsTab) {
                                const createdTask = taskManager.get(task.taskId);
                                const rollbackCreatedTab = async () => {
                                    tabLeaseManager.release(task.taskId, returnedTabId, context.clientId);
                                    taskManager.releaseOwnedTab(task.taskId, returnedTabId);
                                    try { await chrome.tabs.remove(returnedTabId); } catch { /* tab may already be closed */ }
                                };
                                if (!createdTask || taskManager.isCancelled(task.taskId)) {
                                    await rollbackCreatedTab();
                                    throw new Error('Bridge 请求已取消');
                                }
                                tabLeaseManager.acquire(createdTask, returnedTabId, context.clientId);
                                if (taskManager.isCancelled(task.taskId)) {
                                    await rollbackCreatedTab();
                                    throw new Error('Bridge 请求已取消');
                                }
                                await taskManager.persist();
                                if (taskManager.isCancelled(task.taskId)) {
                                    await rollbackCreatedTab();
                                    throw new Error('Bridge 请求已取消');
                                }
                                if (step.keepAlive === true) keepAliveTabIds.add(returnedTabId);
                            }
                        }
                    }
                } else {
                for (const step of steps) {
                    taskManager.assertNotCancelled(task.taskId);
                    const vars = { ...values, input: values, context: { tabId: values.tabId ?? null } };
                    for (const match of JSON.stringify(step.input).matchAll(/{{\s*([^{}]+)\s*}}/g)) {
                        const token = match[1].trim();
                        if (resolveTemplateValue(`{{${token}}}`, vars) === `{{${token}}}`) {
                            throw new Error(`未提供工作流模板变量: ${token}`);
                        }
                    }
                    const stepInput = resolveTemplateValue(step.input, vars);
                    if (!stepInput || typeof stepInput !== 'object' || Array.isArray(stepInput)) {
                        throw new Error(`工作流步骤 ${step.id} 输入必须是对象`);
                    }
                    const params = stepInput as Record<string, unknown>;
                    const stepContext = { ...context, requestId: crypto.randomUUID(), workflowStep: true, finalize: false,
                        tabId: typeof params.tabId === 'number' ? params.tabId : undefined };
                    let attempt = 0;
                    while (attempt < 2) {
                        try {
                            results.push(await executeBridgeRequest(WORKFLOW_CAPABILITY[step.capability], params,
                                stepContext, workflowController.signal));
                            break;
                        } catch (error) {
                            if (error instanceof PolicyError || error instanceof TabLeaseError ||
                                taskManager.isCancelled(task.taskId)) throw error;
                            if (step.onError === 'retry' && attempt === 0) {
                                attempt += 1;
                                await sleep(250, workflowController.signal);
                                continue;
                            }
                            if (step.onError === 'fallback' || step.optional) {
                                taskManager.update(task.taskId, { state: 'running', error: undefined });
                                results.push({ stepId: step.id, skipped: true,
                                    error: error instanceof Error ? error.message : String(error) });
                                break;
                            }
                            throw error;
                        }
                    }
                }
                }
                if (plan) {
                    planOutput = plan.outputTemplate !== undefined
                        ? resolveTemplateValue(plan.outputTemplate, planVars!)
                        : plan.resultPath ? readPathValue(planVars!, plan.resultPath) : planVars!.last;
                }
                taskManager.assertNotCancelled(task.taskId);
                workflowOutcome = 'success';
                taskManager.update(task.taskId, { state: 'succeeded', result: {
                    results,
                    ...(plan ? { output: planOutput === undefined ? null : planOutput, resultPath: plan.resultPath } : {}),
                    registryRevision: snapshot.revision,
                } });
            } catch (error) {
                if (!taskManager.isCancelled(task.taskId)) taskManager.update(task.taskId, { state: 'failed',
                    error: { code: 'E_WORKFLOW', message: error instanceof Error ? error.message : String(error) } });
            } finally {
                context.signal?.removeEventListener('abort', abortWorkflow);
                taskManager.releaseAbortController(task.taskId, workflowController);
                const closeMode = plan
                    ? normalizePlanCloseMode(plan.tabLifecycle?.closeOpenedTabs ?? plan.closeOpenedTabs)
                    : 'always';
                if (shouldClosePlanTabs(closeMode, workflowOutcome)) await taskManager.closeOwnedTabs(task.taskId, keepAliveTabIds);
            }
        })();
        return { taskId: task.taskId, sessionId: task.sessionId, registryRevision: snapshot.revision, state: 'queued' };
    });
    chrome.tabs.onRemoved?.addListener((tabId) => {
        // 标签页关闭后该 tab 的租约必须失效，避免 id 复用后继承。
        tabLeaseManager.releaseTab(tabId);
        if (authenticatedBridge) sendOffscreen({ type: 'actspan_mcp_event', frame: { type: 'event', event: { type: 'tab_closed', tabId } } });
    });
}
