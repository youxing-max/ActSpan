import assert from 'node:assert/strict';
import test from 'node:test';
import registerActTool from '../act-tool.js';
import { createToolResult } from '../tool-result.js';

const schemaParams = { taskId: {}, sessionId: {} };
// index.js 用的真实信封，不是直通：行为断言必须跑真实包装语义，否则 run() 的降级永远测不出来。
const real = createToolResult({ safeError: (error) => String(error?.message || error || 'unknown error') });
const passThrough = (fn) => async (args) => fn(args);

function setup(callBridge, runners = {}) {
    const handlers = new Map();
    const registrations = [];
    registerActTool({
        registerTool: (name, definition, fn) => { registrations.push({ name, definition }); handlers.set(name, fn); },
        callBridge,
        run: runners.run || passThrough,
        runStructured: runners.runStructured || passThrough,
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

// free mode（docs/spec/actspan-free-mode-spec.md）移除了 SENSITIVE_BLOCKED 门：
// 敏感目标不再在桥接前被拦截，动作照常下发，只保留权限分级用于审计。
test('free mode dispatches previously sensitive targets without blocking', async () => {
    const calls = [];
    const { handler } = setup(async (method) => { calls.push(method); return { changed: true }; });
    const result = await handler({ tabId: 3, steps: [{ action: 'click', selector: 'button.pay-now' }] });
    assert.equal(result.success, true);
    assert.equal(calls[0], 'page.click');
    assert.doesNotMatch(String(result.error || ''), /SENSITIVE_BLOCKED/);
});

// 目标可能藏在 find/value 里：free mode 下这些形态同样不再被拦截，必须照常到达桥接。
test('free mode dispatches targets addressed by find or value, and from select', async () => {
    for (const step of [
        { action: 'click', find: { role: 'button', name: '删除账户' } },
        { action: 'click', find: { role: 'button', name: 'Delete account' } },
        { action: 'type', selector: '#card', text: '4111', submit: true },
        { action: 'select', selector: '#plan', value: '结算方式' },
    ]) {
        const calls = [];
        const { handler } = setup(async (method) => { calls.push(method); return { changed: true }; });
        const result = await handler({ tabId: 3, steps: [step] });
        assert.equal(result.success, true, `${JSON.stringify(step)} must dispatch`);
        assert.doesNotMatch(String(result.error || ''), /SENSITIVE_BLOCKED/, JSON.stringify(step));
        assert.ok(calls.length > 0, `${JSON.stringify(step)} must reach the bridge`);
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

// 回归：run() 会把 success:false 升级成 isError，客户端只剩一条文案，trace/reads 全丢。
// 这里跑 index.js 用的真实信封，直通 run 掩盖不了这层降级。
// 失败刺激改用 NO_EFFECT（点击未产生变化）——free mode 下 SENSITIVE_BLOCKED 已不存在，
// 但「步骤级失败仍然是 content」这条信封契约必须继续钉住。
test('a step-level act failure stays content, not isError, and keeps trace and reads', async () => {
    const { handler } = setup(async (method) => (method === 'page.read' ? { matched: true } : { changed: false }),
        { runStructured: real.runStructured });
    const envelope = await handler({ tabId: 3, steps: [
        { action: 'read', selector: '#price' },
        { action: 'click', selector: '#next' },
    ] });
    assert.notEqual(envelope.isError, true);
    const payload = JSON.parse(envelope.content[0].text);
    assert.equal(payload.success, false);
    assert.match(payload.error, /^NO_EFFECT: /);
    assert.deepEqual(payload.trace.map(({ path, action, ok }) => ({ path, action, ok })), [
        { path: 'steps[0]', action: 'read', ok: true },
        { path: 'steps[1]', action: 'click', ok: false },
    ]);
    assert.equal(payload.trace[1].error.code, 'NO_EFFECT');
    assert.deepEqual(payload.reads, [{ matched: true }]);
});

// 同一个包装下抛出的异常仍然是 MCP error：不提升结构化失败，不等于吞掉真异常。
test('a thrown failure is still an MCP error under the same wrapper', async () => {
    const envelope = await real.runStructured(async () => { throw new Error('bridge exploded'); })({});
    assert.equal(envelope.isError, true);
    assert.equal(envelope.content[0].text, 'Actspan error: bridge exploded');
});

// 另一侧同样要钉住：提升型 run() 还在给其余工具用，别把它一起改成不提升。
test('run() still promotes a structured failure to isError', async () => {
    const { handler } = setup(async () => ({ changed: false }), { runStructured: real.run });
    const envelope = await handler({ steps: [{ action: 'click', selector: '#next' }] });
    assert.equal(envelope.isError, true);
    assert.match(envelope.content[0].text, /^Actspan error: NO_EFFECT: /);
});
