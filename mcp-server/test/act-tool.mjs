import assert from 'node:assert/strict';
import test from 'node:test';
import registerActTool from '../act-tool.js';

const schemaParams = { taskId: {}, sessionId: {} };

function setup(callBridge) {
    const handlers = new Map();
    const registrations = [];
    registerActTool({
        registerTool: (name, definition, fn) => { registrations.push({ name, definition }); handlers.set(name, fn); },
        callBridge,
        run: (fn) => async (args) => fn(args),
        tabIdParam: {},
        taskParams: schemaParams,
    });
    return { handler: handlers.get('actspan_act'), adopt: handlers.get('actspan_adopt'), registrations };
}

test('registers actspan_act and batches safe actions before one final snapshot', async () => {
    const calls = [];
    const { handler, registrations } = setup(async (method, params) => {
        calls.push({ method, params });
        if (method === 'page.click') return { changed: true, clicked: params.selector };
        if (method === 'act.draft') return { success: true, draftId: 'd1', created: true, successCount: 1 };
        return { url: 'https://example.test', content: 'done' };
    });
    assert.equal(registrations[0].name, 'actspan_act');
    assert.match(registrations[0].definition.description, /^Your DEFAULT way to act/);
    // P1：描述必须把「合并一次调用省一整轮模型往返」说出来。
    assert.match(registrations[0].definition.description, /saves a full model turn/);
    const result = await handler({ tabId: 7, steps: [{ action: 'click', selector: '#go' }] });
    assert.equal(result.success, true);
    assert.equal(result.snapshot.url, 'https://example.test');
    assert.deepEqual(calls.map(({ method }) => method), ['page.click', 'act.draft', 'page.read']);
});

test('blocks sensitive action before bridge dispatch unless explicitly allowed', async () => {
    const calls = [];
    const { handler } = setup(async (method) => { calls.push(method); return { changed: true }; });
    const result = await handler({ tabId: 3, steps: [{ action: 'click', selector: 'button.pay-now' }] });
    assert.equal(result.success, false);
    assert.match(result.error, /^SENSITIVE_BLOCKED: /);
    assert.deepEqual(calls, []);
});

// 目标可能藏在 find/value 里：只看顶层 selector 会整类漏判，闸门必须按整个步骤判定。
test('blocks sensitive targets addressed by find or value, and from select', async () => {
    for (const step of [
        { action: 'click', find: { role: 'button', name: '删除账户' } },
        { action: 'click', find: { role: 'button', name: 'Delete account' } },
        { action: 'type', selector: '#card', text: '4111', submit: true },
        { action: 'select', selector: '#plan', value: '结算方式' },
    ]) {
        const calls = [];
        const { handler } = setup(async (method) => { calls.push(method); return { changed: true }; });
        const result = await handler({ tabId: 3, steps: [step] });
        assert.equal(result.success, false, `${JSON.stringify(step)} must be blocked`);
        assert.match(result.error, /^SENSITIVE_BLOCKED: /);
        assert.deepEqual(calls, [], `${JSON.stringify(step)} must not reach the bridge`);
    }
});

test('an ordinary target is still batched without an allowSensitive flag', async () => {
    const calls = [];
    const { handler } = setup(async (method, params) => {
        calls.push({ method, params });
        return method === 'page.read' ? { url: 'https://example.test', content: 'ok' } : { changed: true };
    });
    const result = await handler({ tabId: 3, steps: [{ action: 'click', selector: '#next' }] });
    assert.equal(result.success, true);
    assert.deepEqual(calls[0], { method: 'page.click', params: { tabId: 3, selector: '#next' } });
});

test('stops with NO_EFFECT and does not persist a draft', async () => {
    const calls = [];
    const { handler } = setup(async (method) => { calls.push(method); return method === 'page.click' ? { changed: false } : { success: true }; });
    const result = await handler({ steps: [{ action: 'click', selector: '#noop' }] });
    assert.equal(result.success, false);
    assert.match(result.error, /^NO_EFFECT: /);
    assert.deepEqual(calls, ['page.click']);
});

test('exposes draft adoption through the MCP adapter', async () => {
    const calls = [];
    const { adopt, registrations } = setup(async (method, params) => {
        calls.push({ method, params });
        return { success: true, draftId: params.draftId, created: true };
    });
    assert.ok(registrations.some(({ name }) => name === 'actspan_adopt'));
    const result = await adopt({ draftId: 'draft-7', tabId: 7, taskId: 'task-1' });
    assert.deepEqual(result, { success: true, draftId: 'draft-7', created: true });
    assert.deepEqual(calls, [{ method: 'act.adopt', params: { draftId: 'draft-7', tabId: 7, taskId: 'task-1' } }]);
});

test('dispatches select, scroll, wait and assert through real bridge methods', async () => {
    const calls = [];
    const { handler } = setup(async (method, params) => {
        calls.push({ method, params });
        if (method === 'page.read') return { content: 'ready', url: 'https://example.test' };
        if (method === 'page.wait') return { found: true };
        return { changed: true };
    });
    const result = await handler({ steps: [
        { action: 'select', selector: '#choice', value: 'yes' },
        { action: 'scroll', deltaY: 120 },
        { action: 'wait', for: 'text', text: 'ready' },
        { action: 'assert', cond: { textContains: 'ready' } },
    ] });
    assert.equal(result.success, true);
    assert.deepEqual(calls.map(({ method }) => method), ['page.select', 'page.scroll', 'page.wait', 'page.read', 'act.draft', 'page.read']);
});

test('read observation carries contains back as a boolean probe, never as page text', async () => {
    const calls = [];
    const { handler } = setup(async (method, params) => {
        calls.push({ method, params });
        if (method === 'page.read') return { matched: true };
        return { changed: true };
    });
    const result = await handler({ steps: [
        { action: 'read', selector: '#price', contains: '¥199' },
        { action: 'click', selector: '#next' },
    ] });
    assert.equal(result.success, true);
    // contains 被翻译成 textContains 探针，原始 contains 不会漏给页面侧。
    assert.deepEqual(calls[0], { method: 'page.read', params: { selector: '#price', attr: 'textContains', expect: '¥199' } });
    assert.equal(result.observations.length, 1);
    assert.equal(result.observations[0].matched, true);
    assert.deepEqual(calls.map(({ method }) => method), ['page.read', 'page.click', 'act.draft', 'page.read']);
});

test('read observation passes attr through untouched', async () => {
    const calls = [];
    const { handler } = setup(async (method, params) => {
        calls.push({ method, params });
        if (method === 'page.read') return { matched: true };
        return { success: true, draftId: 'd1', created: true };
    });
    await handler({ steps: [{ action: 'read', selector: '#box', attr: 'checked' }] });
    assert.deepEqual(calls[0], { method: 'page.read', params: { selector: '#box', attr: 'checked' } });
});

test('rejects an over-budget script before any bridge call and keeps the diagnostic code', async () => {
    const calls = [];
    const { handler } = setup(async (method) => { calls.push(method); return { changed: true }; });
    const steps = Array.from({ length: 19 }, (_, index) => ({ action: 'click', selector: `#${index}` }));
    steps.push({ repeat: { max: 3, steps: [{ action: 'click', selector: '#more' }] } });
    const result = await handler({ steps });
    assert.equal(result.success, false);
    assert.match(result.error, /^BUDGET_EXCEEDED: /);
    assert.match(result.error, /Expanded steps exceed 20/);
    assert.deepEqual(calls, []);
});

test('accepts a script whose listed steps fit the expanded budget', async () => {
    const calls = [];
    const { handler } = setup(async (method, params) => {
        calls.push({ method, params });
        if (method === 'page.read') return { url: 'https://example.test', content: 'done' };
        return { changed: true };
    });
    const steps = Array.from({ length: 19 }, (_, index) => ({ action: 'click', selector: `#${index}` }));
    steps.push({ repeat: { max: 1, steps: [{ action: 'click', selector: '#more' }] } });
    const result = await handler({ steps });
    assert.equal(result.success, true);
    assert.equal(calls.filter(({ method }) => method === 'page.click').length, 20);
});
