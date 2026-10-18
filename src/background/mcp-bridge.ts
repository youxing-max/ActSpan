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
import { readWebhookConfig, selectFeishuWebhooks, sendWebhookEntries } from '../functions/webhook';
import { requestConfirmationFunction } from '../functions/request-confirmation';
import { resolveTemplateValue } from '../functions/remote-workflow';
import { getSyncStatus } from '../options/pages/actspan-console-status';
import { getTaskExecutor, Policy, PolicyError, registerCapabilityHandler } from './policy-executor';
import { TabLeaseError, tabLeaseManager } from './tab-lease-manager';
import { taskManager } from './task-manager';
import type { TabLease, TaskContext } from './task-types';

const SETTINGS_KEY = 'actspan_mcp_bridge_settings';
const LEGACY_SETTINGS_KEY = 'mole_mcp_bridge';
const SETTINGS_MIGRATED_KEY = 'actspan_mcp_bridge_settings_migrated_v1';
const AUTO_KEY = 'actspan_mcp_bridge_auto';
const RECONNECT_ALARM = 'actspan-mcp-bridge-reconnect';
const DEFAULT_PORT = 30121;

interface BridgeSettings {
    enabled?: boolean;
    port?: number;
    token?: string;
}

let ws: WebSocket | null = null;
let backoff = 1000;
let connecting = false;
let authenticatedBridge = false;
/** 运行时从 MCP server 自动领取的 token，用于零配置首连 */
let autoToken: string | null = null;
let settingsMigration: Promise<void> | null = null;

async function getSettings(): Promise<BridgeSettings> {
    if (!settingsMigration) {
        settingsMigration = (async () => {
            const current = await chrome.storage.local.get([SETTINGS_KEY, SETTINGS_MIGRATED_KEY]);
            if (current[SETTINGS_MIGRATED_KEY]) return;
            const legacy = await chrome.storage.local.get(LEGACY_SETTINGS_KEY);
            const settings = current[SETTINGS_KEY] ?? legacy[LEGACY_SETTINGS_KEY] ?? {};
            await chrome.storage.local.set({ [SETTINGS_KEY]: settings, [SETTINGS_MIGRATED_KEY]: true });
        })().catch((error) => { settingsMigration = null; throw error; });
    }
    await settingsMigration;
    const res = await chrome.storage.local.get(SETTINGS_KEY);
    return (res[SETTINGS_KEY] || {}) as BridgeSettings;
}

function send(socket: WebSocket, msg: Record<string, unknown>) {
    if (socket === ws && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

function scheduleReconnect() {
    setTimeout(() => void connect(), backoff);
    backoff = Math.min(backoff * 2, 30000);
}

async function connect() {
    if (connecting || ws) return;
    const s = await getSettings();
    if (s.enabled === false) return;
    const port = s.port || DEFAULT_PORT;
    const token = s.token || autoToken;
    connecting = true;
    let socket: WebSocket;
    try {
        socket = new WebSocket(`ws://127.0.0.1:${port}`);
        ws = socket;
    } catch {
        connecting = false;
        scheduleReconnect();
        return;
    }
    const inFlight = new Set<AbortController>();
    let authenticated = false;
    socket.onopen = () => {
        if (ws !== socket) return;
        connecting = false;
        backoff = 1000;
        socket.send(JSON.stringify(token ? { type: 'hello', token } : { type: 'pair' }));
    };
    socket.onmessage = async (ev) => {
        if (ws !== socket) return;
        let msg: { type?: string; id?: string; method?: string; token?: string; params?: Record<string, unknown>;
            context?: { clientId?: string; requestId?: string; taskId?: string; sessionId?: string; tabId?: number } };
        try { msg = JSON.parse(String(ev.data)); } catch { return; }
        if (msg.type === 'pair_ok' && typeof msg.token === 'string' && !authenticated) {
            autoToken = msg.token;
            void chrome.storage.local.set({ [AUTO_KEY]: { port, token: msg.token, pairedAt: Date.now() } });
            socket.send(JSON.stringify({ type: 'hello', token: msg.token }));
            return;
        }
        if (msg.type === 'hello_ok') {
            authenticated = true;
            authenticatedBridge = true;
            return;
        }
        if (!authenticated || !msg.id || !msg.method || !msg.context ||
            msg.id !== msg.context.requestId ||
            ![msg.context.clientId, msg.context.requestId, msg.context.taskId, msg.context.sessionId]
                .every((value) => typeof value === 'string' && value.length > 0 && value.length <= 256) ||
            msg.context.tabId !== (msg.params || {}).tabId) return;
        const context = msg.context as { clientId: string; requestId: string; taskId: string; sessionId: string; tabId?: number };
        const controller = new AbortController();
        inFlight.add(controller);
        try {
            const result = await executeBridgeRequest(msg.method, msg.params || {}, context, controller.signal);
            send(socket, { id: msg.id, ...context, ok: true, result });
        } catch (err) {
            send(socket, { id: msg.id, ...context, ok: false, error: err instanceof Error ? err.message : String(err) });
        } finally {
            inFlight.delete(controller);
        }
    };
    socket.onclose = (ev) => {
        if (ws !== socket) return;
        ws = null;
        connecting = false;
        for (const controller of inFlight) controller.abort('bridge disconnected');
        authenticatedBridge = false;
        if (ev.code === 4001 && token && !s.token) autoToken = null;
        void getSettings().then((settings) => { if (settings.enabled !== false) scheduleReconnect(); });
    };
    socket.onerror = () => {
        try { socket.close(); } catch { /* already closing */ }
    };
}
const WORKFLOW_CAPABILITY: Record<string, string> = {
    page_read: 'page.read', page_click: 'page.click', page_type: 'page.type',
    page_eval: 'page.eval', screenshot: 'page.screenshot', agent_delegate: 'agent_delegate',
};
async function executeBridgeRequest(method: string, params: Record<string, unknown>, context: {
    clientId: string; requestId: string; taskId: string; sessionId: string; tabId?: number;
    workflowStep?: boolean; finalize?: boolean;
}, signal?: AbortSignal): Promise<unknown> {
    const executor = getTaskExecutor();
    const runContext: TaskContext = { ...context, owner: 'ide-agent', creator: 'mcp', signal };
    const tabId = typeof params.tabId === 'number' ? params.tabId : context.tabId;
    const decision = new Policy().check(method, { ...runContext, tabId });
    if (decision.requiresApproval) {
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort('approval timed out'), 25_000);
        const onAbort = () => timeout.abort(signal?.reason);
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            const result = await requestConfirmationFunction.execute({
                message: `Actspan 请求 ${decision.level} 权限：${method}。客户端 ${context.clientId}，请求 ${context.requestId}，任务 ${context.taskId}，标签页 ${tabId ?? '未指定'}。`,
            }, { signal: timeout.signal });
            if (!result.success || result.data?.approved !== true) throw new Error('用户未批准此请求');
            executor.approve(context.requestId, context.clientId, context.taskId, tabId);
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        }
    }
    if (signal?.aborted) throw new Error('Bridge 请求已取消');
    return executor.execute(runContext, method, params);
}

// ============ 指令执行 ============

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function resolveTab(context: TaskContext, tabId: number | undefined, mode: 'read' | 'mutate'): Promise<chrome.tabs.Tab> {
    if (typeof tabId === 'number') {
        const lease = tabLeaseManager.get(tabId);
        if (lease || mode === 'mutate') tabLeaseManager.authorize(context, tabId, mode === 'mutate');
        return chrome.tabs.get(tabId);
    }
    if (mode === 'read') {
        const found = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!found[0]?.id) throw new Error('找不到目标标签页');
        if (tabLeaseManager.get(found[0].id)) tabLeaseManager.authorize(context, found[0].id, false);
        return found[0];
    }
    const task = taskManager.get(context.taskId);
    if (task?.activeTabId !== undefined) {
        tabLeaseManager.authorize(context, task.activeTabId);
        return chrome.tabs.get(task.activeTabId);
    }
    throw new Error('写操作必须指定当前任务拥有的 tabId，或先打开新的标签页');
}
async function waitComplete(tabId: number, timeoutMs = 20000): Promise<chrome.tabs.Tab> {
    const deadline = Date.now() + timeoutMs;
    let tab = await chrome.tabs.get(tabId);
    while (tab.status !== 'complete' && Date.now() < deadline) {
        await sleep(300);
        tab = await chrome.tabs.get(tabId);
    }
    return tab;
}

/** executeScript 的 func 必须自包含（无闭包引用），序列化后在页面里重建 */
async function execInTab<T>(
    tabId: number,
    func: (...args: never[]) => T,
    args: unknown[] = [],
    world: 'ISOLATED' | 'MAIN' = 'ISOLATED',
): Promise<T> {
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        world,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        func: func as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        args: args as any,
    });
    const r = results?.[0] as { result?: T; error?: unknown } | undefined;
    if (r?.error) throw r.error instanceof Error ? r.error : new Error(String(r.error));
    return r?.result as T;
}

async function withDebugger<T>(context: TaskContext, tabId: number, fn: () => Promise<T>): Promise<T> {
    const target = { tabId };
    return tabLeaseManager.withDebugger(context, tabId,
        () => chrome.debugger.attach(target, '1.3'),
        () => chrome.debugger.detach(target), fn);
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

async function dispatch(method: string, params: Record<string, unknown>, context: TaskContext): Promise<unknown> {
    switch (method) {
        case 'ping':
            return { pong: true, version: VERSION, uptime: 'extension' };

        case 'tabs.list': {
            const tabs = await chrome.tabs.query({});
            return filterTabsForContext(tabs, context);
        }

        case 'tab.open': {
            const task = taskManager.get(context.taskId);
            if (!task) throw new Error('任务记录不存在');
            const tab = await chrome.tabs.create({
                url: String(params.url),
                active: params.active === true,
            });
            const tabId = tab.id;
            if (typeof tabId !== 'number') throw new Error('新标签页缺少 tabId');
            try {
                tabLeaseManager.acquire(task, tabId, context.clientId);
                await taskManager.persist();
                const done = await waitComplete(tabId);
                return { tabId: done.id, url: done.url, title: done.title, taskId: context.taskId, sessionId: context.sessionId };
            } catch (error) {
                try { await chrome.tabs.remove(tabId); } catch { /* 标签页可能已被用户关闭 */ }
                tabLeaseManager.release(context.taskId, tabId, context.clientId);
                taskManager.releaseOwnedTab(context.taskId, tabId);
                throw error;
            }
        }

        case 'tab.navigate': {
            const tab = await resolveTab(context, params.tabId as number | undefined, 'mutate');
            await chrome.tabs.update(tab.id!, { url: String(params.url) });
            const done = await waitComplete(tab.id!);
            return { tabId: done.id, url: done.url, title: done.title };
        }

        case 'tab.close':
            await resolveTab(context, Number(params.tabId), 'mutate');
            await chrome.tabs.remove(Number(params.tabId));
            return { closed: true };

        case 'page.eval': {
            // 走 CDP Runtime.evaluate：页面主上下文执行，避免 MV3 SW 的 CSP 禁 eval 问题
            const tab = await resolveTab(context, params.tabId as number | undefined, 'mutate');
            return withDebugger(context, tab.id!, async () => {
                const r = await chrome.debugger.sendCommand({ tabId: tab.id! }, 'Runtime.evaluate', {
                    expression: String(params.expression),
                    returnByValue: true,
                    awaitPromise: true,
                    userGesture: true,
                }) as {
                    result?: { value?: unknown };
                    exceptionDetails?: { exception?: { description?: string }; text?: string };
                };
                if (r?.exceptionDetails) {
                    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'JS 执行异常');
                }
                return r?.result?.value;
            });
        }

        case 'page.read': {
            const tab = await resolveTab(context, params.tabId as number | undefined, 'read');
            const maxChars = Number(params.maxChars) || 20000;
            const content = params.format === 'html'
                ? await execInTab(tab.id!, ((n: number) => document.documentElement.outerHTML.slice(0, n)) as never, [maxChars])
                : await execInTab(tab.id!, ((n: number) => (document.body?.innerText || '').slice(0, n)) as never, [maxChars]);
            return { title: tab.title, url: tab.url, content };
        }

        case 'page.click': {
            const tab = await resolveTab(context, params.tabId as number | undefined, 'mutate');
            return execInTab(tab.id!, ((sel: string) => {
                const el = document.querySelector(sel) as HTMLElement | null;
                if (!el) throw new Error(`元素未找到: ${sel}`);
                el.scrollIntoView({ block: 'center' });
                el.click();
                return { clicked: sel, tag: el.tagName };
            }) as never, [String(params.selector)]);
        }

        case 'page.type': {
            const tab = await resolveTab(context, params.tabId as number | undefined, 'mutate');
            return execInTab(tab.id!, ((sel: string, text: string, submit: boolean) => {
                const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
                if (!el) throw new Error(`元素未找到: ${sel}`);
                el.focus();
                // 走原生 setter，兼容 React 受控组件
                const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                if (setter) setter.call(el, text); else el.value = text;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                if (submit) {
                    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
                    if (el.form && typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
                }
                return { typed: true, selector: sel };
            }) as never, [String(params.selector), String(params.text), params.submit === true]);
        }

        case 'page.screenshot': {
            const tab = await resolveTab(context, params.tabId as number | undefined, 'read');
            return withDebugger(context, tab.id!, async () => {
                const shot = await chrome.debugger.sendCommand({ tabId: tab.id! }, 'Page.captureScreenshot', { format: 'png' }) as { data?: string };
                if (!shot?.data) throw new Error('截图返回为空');
                return { mimeType: 'image/png', data: shot.data };
            });
        }

        default:
            throw new Error(`未知指令: ${method}`);
    }
}

export function initMcpBridge() {
    for (const method of ['ping', 'tabs.list', 'tab.open', 'tab.navigate', 'tab.close',
        'page.eval', 'page.read', 'page.click', 'page.type', 'page.screenshot']) {
        registerCapabilityHandler(method, (input, context) => dispatch(method, input, context));
    }
    registerCapabilityHandler('feishu.push', async (input) => {
        if (typeof input.title !== 'string' || typeof input.message !== 'string') {
            throw new Error('飞书推送需要 title 和 message');
        }
        const webhookName = typeof input.webhookName === 'string' ? input.webhookName.trim() : undefined;
        const entries = selectFeishuWebhooks(await readWebhookConfig(), webhookName);
        if (entries.length === 0) {
            return {
                success: false,
                error: webhookName
                    ? `未找到已启用的飞书 Webhook: ${webhookName}`
                    : '没有已启用的飞书 Webhook，请在 Options > Webhook 页面添加并启用至少一个飞书 Webhook',
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
        sendResponse({ connected: authenticatedBridge && ws?.readyState === WebSocket.OPEN });
    });
    registerCapabilityHandler('workflow.run', async (input, context) => {
        await ensureSkillRegistryReady();
        const snapshot = await registryService.listAll();
        const matches = snapshot.skills.filter((skill) => skill.enabled)
            .flatMap((skill) => skill.workflows.map((workflow) => ({ skill, workflow })))
            .filter(({ workflow }) => workflow.name === input.name);
        if (matches.length !== 1) throw new Error(matches.length ? '工作流名称不唯一' : '工作流不存在');
        const { workflow } = matches[0];
        if (!workflow.steps?.length) throw new Error('工作流没有可执行的结构化步骤');
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
        for (const step of workflow.steps) {
            if (!WORKFLOW_CAPABILITY[step.capability]) throw new Error(`不支持的工作流步骤: ${step.capability}`);
        }
        if (taskManager.get(context.taskId)) throw new Error('任务 ID 已存在');
        const task = taskManager.create({ taskId: context.taskId, sessionId: context.sessionId,
            clientId: context.clientId, owner: context.owner, registryRevision: snapshot.revision });
        const steps = workflow.steps;
        const workflowController = taskManager.createAbortController(task.taskId);
        const abortWorkflow = () => workflowController.abort(context.signal?.reason);
        if (context.signal?.aborted) workflowController.abort(context.signal.reason);
        else context.signal?.addEventListener('abort', abortWorkflow, { once: true });
        void (async () => {
            const results: unknown[] = [];
            try {
                taskManager.update(task.taskId, { state: 'running' });
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
                                await sleep(250);
                                taskManager.assertNotCancelled(task.taskId);
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
                taskManager.assertNotCancelled(task.taskId);
                taskManager.update(task.taskId, { state: 'succeeded', result: { results, registryRevision: snapshot.revision } });
            } catch (error) {
                if (!taskManager.isCancelled(task.taskId)) taskManager.update(task.taskId, { state: 'failed',
                    error: { code: 'E_WORKFLOW', message: error instanceof Error ? error.message : String(error) } });
            } finally {
                context.signal?.removeEventListener('abort', abortWorkflow);
                taskManager.releaseAbortController(task.taskId, workflowController);
                await taskManager.closeOwnedTabs(task.taskId);
            }
        })();
        return { taskId: task.taskId, sessionId: task.sessionId, registryRevision: snapshot.revision, state: 'queued' };
    });
    chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 1 });
    chrome.alarms.onAlarm.addListener((a) => {
        if (a.name === RECONNECT_ALARM && !ws && !connecting) void connect();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes[SETTINGS_KEY]) {
            const old = ws;
            ws = null;
            connecting = false;
            authenticatedBridge = false;
            try { old?.close(); } catch { /* noop */ }
            void connect();
        }
    });
    void connect();
}
