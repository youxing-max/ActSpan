// This boundary is deliberately independent of tool registration: aliases cannot bypass it.
const CAPABILITIES = Object.freeze({
    ping: 'read',
    'tabs.list': 'read',
    'tabs.select': 'read',
    'tab.open': 'interact',
    'tab.close': 'sensitive',
    'tab.navigate': 'interact',
    'page.read': 'read',
    'page.snapshot': 'read',
    'page.click': 'interact',
    'page.type': 'interact',
    'page.eval': 'dangerous',
    'page.screenshot': 'sensitive',
    'page.select': 'interact',
    'page.upload': 'interact',
    'page.key': 'interact',
    'page.wait': 'read',
    'page.scroll': 'interact',
    'network.list': 'read',
    'network.detail': 'read',
    'network.query': 'read',
    'data.fetch': 'read',
    'data.fetch_chunk': 'read',
    'data.fetch_release': 'read',
    'data.paginate': 'read',
    'data.paginate_page': 'read',
    'data.download': 'interact',
    'act.draft': 'read',
    'act.adopt': 'sensitive',
    'page.status_update': 'read',
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
        // 与扩展侧 policy-executor 同一条判据：tabId 是调用方可选参数，不能当作「要不要确认」
        // 的依据，否则省略它就能让 page.* 的写动作和 tab.navigate 免确认。tab.open 不在此列。
        const tabScoped = capability.startsWith('page.') || capability === 'tab.navigate';
        return { permission, requiresApproval: permission === 'sensitive' || permission === 'dangerous' ||
            (permission === 'interact' && (tabScoped || context.tabId !== undefined)) };
    }
}
