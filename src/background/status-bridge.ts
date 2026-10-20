import Channel from '../lib/channel';
import { tabLeaseManager } from './tab-lease-manager';
import { taskManager } from './task-manager';

export const STATUS_MAX_LENGTH = 80;

const textLength = (text: string): number => Array.from(text).length;

export function validateStatusText(value: unknown): string {
    if (typeof value !== 'string') throw new Error('status text must be a string');
    const text = value.trim();
    if (!text) throw new Error('status text must not be empty');
    if (textLength(text) > STATUS_MAX_LENGTH) throw new Error(`status text must be <= ${STATUS_MAX_LENGTH} characters`);
    return text;
}

type StatusContext = {
    clientId: string;
    requestId: string;
    taskId: string;
    sessionId: string;
    tabId?: number;
    owner: 'ide-agent' | 'extension-agent' | 'user';
    signal?: AbortSignal;
};

const sameSession = (record: { sessionId: string; clientId: string }, context: StatusContext): boolean =>
    record.sessionId === context.sessionId && record.clientId === context.clientId;

/** Resolve only a tab leased to this exact task/session/client; never changes focus. */
export function resolveStatusTabId(context: StatusContext, requestedTabId?: number): number {
    const task = taskManager.get(context.taskId);
    const tabId = requestedTabId ?? context.tabId ?? task?.activeTabId;
    if (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId < 0) {
        throw new Error('status update requires a task-owned tab');
    }
    const lease = tabLeaseManager.get(tabId);
    if (!lease || lease.releasedAt || !sameSession(lease, context) || lease.expiresAt <= Date.now() || (task && lease.taskId !== context.taskId)) {
        throw new Error('status update target is not owned by the current session');
    }
    if (task) tabLeaseManager.authorize(context, tabId, false);
    return tabId;
}

export function sendStatusEvent(tabId: number, payload: { text: string; language?: string; active: boolean }): void {
    Channel.sendToTab(tabId, '__status_update', payload);
}

export async function updateStatus(input: Record<string, unknown>, context: StatusContext): Promise<{ acknowledged: true; tabId: number }> {
    if (context.signal?.aborted) throw new Error('status update cancelled');
    const text = validateStatusText(input.text);
    const tabId = resolveStatusTabId(context, typeof input.tabId === 'number' ? input.tabId : undefined);
    const language = typeof input.language === 'string' && input.language.trim() ? input.language : undefined;
    sendStatusEvent(tabId, { text, ...(language ? { language } : {}), active: true });
    return { acknowledged: true, tabId };
}

/** Clear every visible status owned by a task without touching any other session. */
export function clearStatusForTask(taskId: string): boolean {
    const task = taskManager.get(taskId);
    if (!task) return false;
    const context = {
        clientId: task.clientId || task.owner,
        requestId: `status-clear:${taskId}`,
        taskId: task.taskId,
        sessionId: task.sessionId,
        owner: task.owner,
    } as StatusContext;
    let cleared = false;
    for (const lease of tabLeaseManager.list(taskId)) {
        if (lease.releasedAt || lease.expiresAt <= Date.now() || !sameSession(lease, context)) continue;
        try {
            const tabId = resolveStatusTabId(context, lease.tabId);
            sendStatusEvent(tabId, { text: '', active: false });
            cleared = true;
        } catch { /* stale tabs are already idle or gone */ }
    }
    return cleared;
}

taskManager.onTerminal((task) => {
    clearStatusForTask(task.taskId);
});
