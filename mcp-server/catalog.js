import { randomUUID } from 'node:crypto';

export const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:30121';
export const TASK_STATES = new Set([
    'queued',
    'running',
    'waiting_user',
    'succeeded',
    'failed',
    'cancelled',
]);

export const TOOL_NAMES = Object.freeze([
    'actspan_status',
    'actspan_feishu_push',
    'actspan_tabs_list',
    'actspan_tab_open',
    'actspan_tab_close',
    'actspan_tab_navigate',
    'actspan_page_read',
    'actspan_page_click',
    'actspan_page_type',
    'actspan_page_eval',
    'actspan_screenshot',
    'actspan_skills_list',
    'actspan_skill_detail',
    'actspan_workflow_run',
    'actspan_agent_submit',
    'actspan_agent_status',
    'actspan_agent_result',
    'actspan_agent_cancel',
]);

const extensionIdPattern = /^[a-p]{32}$/;

export function validateConfig(env = process.env) {
    const errors = [];
    const apiUrl = String(env.ACTSPAN_API_URL || '').trim();
    const apiKey = String(env.ACTSPAN_API_KEY || '').trim();
    const bridgeUrl = String(env.ACTSPAN_BRIDGE_URL || DEFAULT_BRIDGE_URL).trim();

    if (!apiUrl) errors.push('ACTSPAN_API_URL is required and must be an HTTPS URL');
    else {
        try {
            const parsed = new URL(apiUrl);
            if (parsed.protocol !== 'https:') errors.push('ACTSPAN_API_URL must use https://');
        } catch {
            errors.push('ACTSPAN_API_URL must be a valid HTTPS URL, for example https://api.example.com');
        }
    }
    if (!apiKey) errors.push('ACTSPAN_API_KEY is required; set it in the MCP client env (never on the command line)');

    let parsedBridge;
    try {
        parsedBridge = new URL(bridgeUrl);
        if (!['ws:', 'wss:'].includes(parsedBridge.protocol)) {
            errors.push('ACTSPAN_BRIDGE_URL must use ws:// or wss://');
        }
        if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsedBridge.hostname)) {
            errors.push('ACTSPAN_BRIDGE_URL must point to the local extension Bridge');
        }
    } catch {
        errors.push('ACTSPAN_BRIDGE_URL must be a valid local ws:// URL');
    }

    const extensionIds = String(env.ACTSPAN_EXTENSION_IDS || '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)
        .map(value => value.startsWith('chrome-extension://') ? value : `chrome-extension://${value}`);
    if (!extensionIds.length) errors.push('ACTSPAN_EXTENSION_IDS is required; list the exact Chrome extension ID(s) allowed to pair');
    const invalidIds = extensionIds.filter(value => !extensionIdPattern.test(value.slice('chrome-extension://'.length)));
    if (invalidIds.length) errors.push('ACTSPAN_EXTENSION_IDS must be comma-separated 32-character Chrome extension IDs (a-p only)');

    return {
        valid: errors.length === 0,
        errors,
        config: {
            apiUrl,
            apiKey,
            bridgeUrl,
            bridgePort: parsedBridge?.port ? Number(parsedBridge.port) : 30121,
            pairOrigins: invalidIds.length ? [] : extensionIds,
        },
    };
}

export function createRequestContext({ clientId, taskId, sessionId } = {}) {
    return {
        clientId: clientId || randomUUID(),
        requestId: randomUUID(),
        taskId: taskId || randomUUID(),
        sessionId: sessionId || randomUUID(),
    };
}

export function normalizeCatalogList(result) {
    const snapshot = result?.snapshot && typeof result.snapshot === 'object' ? result.snapshot : result || {};
    const revision = Number.isFinite(Number(snapshot.revision)) ? Number(snapshot.revision) : 0;
    const updatedAt = Number.isFinite(Number(snapshot.updatedAt)) ? Number(snapshot.updatedAt) : Date.now();
    return {
        revision,
        skills: Array.isArray(snapshot.skills) ? snapshot.skills : [],
        syncStatus: typeof snapshot.syncStatus === 'string' ? snapshot.syncStatus : 'ready',
        generatedAt: Number.isFinite(Number(snapshot.generatedAt)) ? Number(snapshot.generatedAt) : updatedAt,
    };
}

export function normalizeTaskHandle(result, fallback = {}) {
    const source = result && typeof result === 'object' ? result : {};
    const taskId = String(source.taskId || fallback.taskId || '').trim();
    const sessionId = String(source.sessionId || fallback.sessionId || '').trim();
    if (!taskId || !sessionId) throw new Error('Bridge did not return a taskId and sessionId');
    const state = TASK_STATES.has(source.state) ? source.state : 'queued';
    const revision = Number(source.registryRevision ?? fallback.registryRevision ?? 0);
    return {
        taskId,
        sessionId,
        registryRevision: Number.isFinite(revision) ? revision : 0,
        state,
    };
}

export class RegistryCatalog {
    constructor(hub, { timeoutMs = 10000 } = {}) {
        this.hub = hub;
        this.timeoutMs = timeoutMs;
    }

    async list(context = {}) {
        // Query the extension each time so a newly saved registry revision is visible immediately.
        return normalizeCatalogList(await this.hub.call('registry.list', {}, this.timeoutMs, context));
    }

    async detail(name, context = {}) {
        const normalizedName = String(name || '').trim();
        if (!normalizedName) throw new Error('skill name is required');
        return await this.hub.call('registry.detail', { name: normalizedName }, this.timeoutMs, context);
    }
}
