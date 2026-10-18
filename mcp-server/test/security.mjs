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
const origin = 'chrome-extension://afadkcbnpkhbofmbmlhjcppegjhkckdi';
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
    ws.send(JSON.stringify({ type: 'hello', token }));
    assert.equal((await reply).type, 'hello_ok');
    return ws;
}
async function hubTest(t) {
    const hub = new ExtensionHub('test-secret', { port: 0, pairOrigins: [origin] });
    await hub.start();
    t.after(() => { hub.client?.terminate(); hub.wss.close(); });
    return { hub, url: `ws://127.0.0.1:${hub.wss.address().port}` };
}

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

test('policy rejects unknown capabilities and self-approval cannot bypass extension approval', () => {
    const context = { clientId: 'A', requestId: 'R', taskId: 'T', sessionId: 'S', tabId: 1, trustAll: true,
        approval: { approved: true } };
    assert.throws(() => Policy.check('unknown', context), /Unsupported/);

    assert.throws(() => Policy.check('page.eval', { ...context, taskId: '' }), /taskId/);
    assert.equal(Policy.check('page.eval', context).requiresApproval, true);
    assert.equal(Policy.check('page.click', context).requiresApproval, true);
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
