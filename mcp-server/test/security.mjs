import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';

const dir = mkdtempSync(path.join(os.tmpdir(), 'actspan-bridge-security-'));
process.env.ACTSPAN_MCP_LOG = path.join(dir, 'bridge.log');
const { ExtensionHub, log } = await import('../bridge.js');
const { Policy } = await import('../policy.js');
const { extensionIdFromKey } = await import('../install.js');
const origin = `chrome-extension://${extensionIdFromKey()}`;
const otherOrigin = 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

async function open(url, from = origin) {
    const ws = new WebSocket(url, { headers: { Origin: from } });
    await once(ws, 'open');
    return ws;
}
async function frame(ws) {
    const [raw] = await once(ws, 'message');
    return JSON.parse(raw.toString());
}
async function authenticated(url, token) {
    const ws = await open(url);
    const reply = frame(ws);
    ws.send(JSON.stringify({ type: 'hello', token, role: 'extension' }));
    assert.equal((await reply).type, 'hello_ok');
    return ws;
}
async function hubTest(t) {
    const hub = new ExtensionHub('test-secret', { port: 0, pairOrigins: [origin] });
    await hub.start();
    t.after(() => { hub.client?.terminate(); hub.wss.close(); });
    return { hub, url: `ws://127.0.0.1:${hub.wss.address().port}` };
}

test('pairing requires the proof issued by the first pair', async (t) => {
    const { url } = await hubTest(t);

    const first = await open(url);
    const firstReply = frame(first);
    first.send(JSON.stringify({ type: 'pair' }));
    const ok = await firstReply;
    assert.equal(ok.type, 'pair_ok');
    assert.match(ok.pairingSecret, /^[a-f0-9]{64}$/);
    first.terminate();

    // 伪造 allowlisted Origin、但没有配对证明：不能拿到 token
    const forged = await open(url);
    const closed = once(forged, 'close');
    forged.send(JSON.stringify({ type: 'pair' }));
    assert.equal((await closed)[0], 4001);

    // 合法扩展带回首次签发的证明，可以重新配对
    const legit = await open(url);
    const legitReply = frame(legit);
    legit.send(JSON.stringify({ type: 'pair', pairingSecret: ok.pairingSecret }));
    const again = await legitReply;
    assert.equal(again.type, 'pair_ok');
    assert.equal(again.token, ok.token);
    legit.terminate();
});

test('unknown extension and web origins never receive pairing token, even with known token', async (t) => {
    const { url } = await hubTest(t);
    for (const from of [otherOrigin, 'https://evil.example']) {
        const ws = await open(url, from);
        const closed = once(ws, 'close');
        ws.send(JSON.stringify({ type: 'pair' }));
        assert.equal((await closed)[0], 4001);
        const known = await open(url, from);
        const denied = once(known, 'close');
        known.send(JSON.stringify({ type: 'hello', token: 'test-secret' }));
        assert.equal((await denied)[0], 4001);
    }
});

test('extension handshake rejects an explicitly agent/operator role but stays compatible without one', async (t) => {
    const { hub, url } = await hubTest(t);
    // D12：Origin 白名单只证明「来自某个已配对的扩展」；hello 自报 role 时必须自认 extension。
    // 有 Origin 却报 role:'agent'/'operator' 的扩展按冒充处理，连接直接断开。
    for (const role of ['agent', 'operator']) {
        const ws = await open(url);
        const closed = once(ws, 'close');
        ws.send(JSON.stringify({ type: 'hello', token: 'test-secret', role }));
        const outcome = await Promise.race([
            closed.then(([code]) => code),
            new Promise((resolve) => setTimeout(() => resolve('still open'), 300)),
        ]);
        assert.equal(outcome, 4001, `hello role=${role} must be rejected`);
        assert.equal(hub.isConnected(), false);
        assert.equal(hub.clientOrigin, null);
        assert.match(hub.lastError, /role/);
    }
    // 未声明 role 是老客户端的存量帧：Origin + token 已经成立，按 extension 兼容放行。
    const legacy = await open(url);
    const legacyReply = frame(legacy);
    legacy.send(JSON.stringify({ type: 'hello', token: 'test-secret' }));
    assert.equal((await legacyReply).type, 'hello_ok');
    legacy.terminate();
    // 显式声明 role:'extension' 是唯一被推荐的姿态。
    const legit = await authenticated(url, hub.token);
    assert.equal(hub.isConnected(), true);
    assert.equal(hub.clientOrigin, origin);
    legit.terminate();
});

test('second extension connection cannot replace owner or consume its response', async (t) => {
    const { hub, url } = await hubTest(t);
    const owner = await authenticated(url, hub.token);
    const second = await open(url);
    const closed = once(second, 'close');
    second.send(JSON.stringify({ type: 'hello', token: hub.token }));
    assert.equal((await closed)[0], 4003);
    assert.equal(hub.isConnected(), true);
    assert.notEqual(hub.client, second);
    assert.equal(hub.clientOrigin, origin);
    assert.match(hub.lastReplacementReason, /rejected duplicate/);
    const response = frame(owner);
    const pending = hub.call('ping', {}, { clientId: 'A', taskId: 'T', sessionId: 'S' });
    const request = await response;
    assert.equal(request.context.clientId, 'A');
    owner.send(JSON.stringify({ id: request.id, ...request.context, ok: true, result: 42 }));
    assert.equal(await pending, 42);
});

test('wrong client, task and stale socket responses cannot settle a newer request', async (t) => {
    const { hub, url } = await hubTest(t);
    const old = await authenticated(url, hub.token);
    const first = frame(old);
    const pending = hub.call('page.read', { tabId: 12 }, { clientId: 'A', taskId: 'T', sessionId: 'S' });
    const req = await first;
    old.send(JSON.stringify({ id: req.id, ...req.context, clientId: 'B', ok: true, result: 'stolen' }));
    old.send(JSON.stringify({ id: req.id, ...req.context, taskId: 'other', ok: true, result: 'stolen' }));
    old.send(JSON.stringify({ id: req.id, ...req.context, tabId: 13, ok: true, result: 'stolen' }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(hub.pending.size, 1);
    const disconnected = assert.rejects(pending, /disconnected/);
    old.terminate();
    await disconnected;
    const fresh = await authenticated(url, hub.token);
    const next = frame(fresh);
    const current = hub.call('ping', {}, { clientId: 'A', taskId: 'T', sessionId: 'S' });
    const req2 = await next;
    assert.notEqual(req2.id, req.id);
    fresh.send(JSON.stringify({ id: req.id, ...req.context, ok: true, result: 'stale' }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(hub.pending.size, 1);
    fresh.send(JSON.stringify({ id: req2.id, ...req2.context, ok: true, result: 'current' }));
    assert.equal(await current, 'current');
});

test('occupied owner rejects immediately with explicit port and PID diagnostic', async (t) => {
    const { hub } = await hubTest(t);
    const port = hub.wss.address().port;
    const contender = new ExtensionHub('other-secret', { port, pairOrigins: [origin] });
    await assert.rejects(contender.start(), (error) =>
        error.message.includes(`port ${port}`) && error.message.includes(`PID ${process.pid}`));
    assert.equal(contender.listening, false);
});

test('occupied Actspan owner reports verified PID and compatibility without takeover', async (t) => {
    const { hub } = await hubTest(t);
    const port = hub.wss.address().port;
    const contender = new ExtensionHub('other-secret', { port, pairOrigins: [origin] });
    await assert.rejects(contender.start(), (error) =>
        error.message.includes(`Actspan PID ${process.pid}`) && error.message.includes('compatible protocol'));
    assert.equal(contender.listening, false);
});

// free mode（docs/spec/actspan-free-mode-spec.md）：审批门已移除，requiresApproval 恒为 false；
// 但能力白名单、身份字段校验和权限分级都保留，这里继续钉住它们。
test('policy rejects unknown capabilities and never gates on approval under free mode', () => {
    const context = { clientId: 'A', requestId: 'R', taskId: 'T', sessionId: 'S', tabId: 1, trustAll: true,
        approval: { approved: true } };
    assert.throws(() => Policy.check('unknown', context), /Unsupported/);

    assert.throws(() => Policy.check('page.eval', { ...context, taskId: '' }), /taskId/);
    assert.equal(Policy.check('page.eval', context).requiresApproval, false);
    assert.equal(Policy.check('page.click', context).requiresApproval, false);
    // 权限分级仍然存在，只用于审计/日志
    assert.equal(Policy.check('page.eval', context).permission, 'dangerous');
    assert.equal(Policy.check('page.click', context).permission, 'interact');
});

// 自由化模式（docs/spec/actspan-free-mode-spec.md）：permission 只用于审计分级，
// 任何能力都不再要求审批——客户端自带 approved 也改变不了这个结果。
test('free mode never requires approval, even for writes and page.eval', () => {
    const context = { clientId: 'A', requestId: 'R', taskId: 'T', sessionId: 'S', tabId: 1 };
    for (const capability of ['page.eval', 'page.click', 'page.type', 'page.select', 'page.scroll', 'tab.navigate', 'tab.open']) {
        assert.equal(Policy.check(capability, context).requiresApproval, false, capability);
    }
});

// tabId 是调用方可选参数；free mode 下没有审批门，缺失 tabId 也不改变放行语义，
// 但能力仍必须被白名单承认并带上正确的权限分级。
test('free mode admits page writes and tab.navigate without approval, with or without a tabId', () => {
    const context = { clientId: 'A', requestId: 'R', taskId: 'T', sessionId: 'S' };
    for (const capability of ['page.click', 'page.type', 'page.select', 'page.scroll', 'tab.navigate']) {
        const result = Policy.check(capability, context);
        assert.equal(result.requiresApproval, false, capability);
        assert.equal(result.permission, 'interact', capability);
    }
    // tab.open 只是新建标签页，没有既有标签页可改。
    assert.equal(Policy.check('tab.open', context).requiresApproval, false);
});

test('policy admits every stable bridge capability with its minimum permission', () => {
    const context = { clientId: 'A', requestId: 'R', taskId: 'T', sessionId: 'S' };
    const capabilities = {
        'tabs.select': 'read', 'tab.open': 'interact', 'page.snapshot': 'read',
        'page.select': 'interact', 'page.upload': 'interact', 'page.key': 'interact',
        'page.wait': 'read', 'page.scroll': 'interact',
        'network.list': 'read', 'network.detail': 'read', 'network.query': 'read',
        'data.fetch': 'read', 'data.fetch_chunk': 'read', 'data.fetch_release': 'read',
        'data.paginate': 'read', 'data.paginate_page': 'read', 'data.download': 'interact',
        'act.draft': 'read', 'act.adopt': 'sensitive', 'page.status_update': 'read',
    };
    for (const [capability, permission] of Object.entries(capabilities)) {
        assert.equal(Policy.check(capability, context).permission, permission, capability);
    }
});

test('dedicated logs redact API keys and do not write to MCP stdout', () => {
    const key = 'extremely-secret-example-key';
    const previous = process.env.ACTSPAN_API_KEY;
    const write = process.stdout.write;
    let stdout = '';
    process.stdout.write = function (chunk) { stdout += String(chunk); return true; };
    process.env.ACTSPAN_API_KEY = key;
    try {
        log('request token=abc', key, 'Authorization:Bearer secret');
        assert.equal(stdout, '');
        const text = readFileSync(path.join(dir, 'bridge.log'), 'utf8');
        assert.doesNotMatch(text, /extremely-secret-example-key|token=abc|Bearer secret/);
        assert.match(text, /\[REDACTED\]/);
    } finally {
        process.stdout.write = write;
        if (previous === undefined) delete process.env.ACTSPAN_API_KEY;
        else process.env.ACTSPAN_API_KEY = previous;
    }
});

process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
