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
        // 自由化模式：不设置任何审批门。permission 仍保留供审计/日志分级，
        // 但 requiresApproval 恒为 false——任何已认证客户端可直接执行副作用。
        return { permission, requiresApproval: false };
    }
}
