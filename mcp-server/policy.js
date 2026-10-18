// This boundary is deliberately independent of tool registration: aliases cannot bypass it.
const CAPABILITIES = Object.freeze({
    ping: 'read',
    'tabs.list': 'read',
    'tab.close': 'sensitive',
    'tab.navigate': 'interact',
    'page.read': 'read',
    'page.click': 'interact',
    'page.type': 'interact',
    'page.eval': 'dangerous',
    'page.screenshot': 'sensitive',
    'registry.list': 'read',
    'registry.detail': 'read',
    'workflow.run': 'interact',
    'feishu.push': 'interact',
    'task.submit': 'interact',
    'task.status': 'read',
    'task.result': 'read',
    'task.cancel': 'interact',
});

export class Policy {
    static check(capability, context) {
        const permission = CAPABILITIES[capability];
        if (!permission) throw new Error(`Unsupported bridge capability: ${capability}`);
        for (const key of ['clientId', 'requestId', 'taskId', 'sessionId']) {
            if (typeof context?.[key] !== 'string' || !context[key] || context[key].length > 256) {
                throw new Error(`Missing authenticated ${key}`);
            }
        }
        if (context.tabId !== undefined && (!Number.isSafeInteger(context.tabId) || context.tabId < 0)) {
            throw new Error('Invalid tabId');
        }
        // An MCP caller cannot approve itself: the extension executor must obtain and
        // bind user approval to this exact client/request/task/tab before side effects.
        return { permission, requiresApproval: permission === 'sensitive' || permission === 'dangerous' ||
            (permission === 'interact' && context.tabId !== undefined) };
    }
}
