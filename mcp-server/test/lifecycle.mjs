import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { ExtensionHub } from '../bridge.js';
import { MAX_FRAME_BYTES } from '../daemon-rpc.js';
import { extensionIdFromKey } from '../install.js';

const origin = `chrome-extension://${extensionIdFromKey()}`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('daemon RPC frame budget carries the advertised 12 MB base64 upload', () => {
    assert.ok(MAX_FRAME_BYTES > 12_000_000 + 64 * 1024);
});

async function freePort() {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    server.close();
    await once(server, 'close');
    return port;
}

async function connect(hub, onRequest = () => {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${hub.wss.address().port}`, { headers: { Origin: origin } });
    ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.id) onRequest(message, ws);
    });
    await once(ws, 'open');
    const welcome = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'hello', token: hub.token }));
    const helloMessage = JSON.parse((await welcome)[0].toString());
    assert.equal(helloMessage.type, 'hello_ok');
    assert.equal(helloMessage.appVersion, '1.1.0');
    assert.equal(helloMessage.protocolVersion, 1);
    return ws;
}

test('snake-case tab identity is bound into the authenticated request context', async (t) => {
    const hub = new ExtensionHub('secret-token', { port: 0, pairOrigins: [origin] });
    await hub.start();
    t.after(() => hub.stop());
    let resolveRequest;
    const request = new Promise((resolve) => { resolveRequest = resolve; });
    const ws = await connect(hub, (message) => resolveRequest(message));
    t.after(() => ws.terminate());
    const pending = hub.call('ping', { tab_id: 73 }, 500);
    const frame = await request;
    assert.equal(frame.context.tabId, 73);
    ws.send(JSON.stringify({ id: frame.id, ...frame.context, ok: true, result: 'bound' }));
    assert.equal(await pending, 'bound');
});

test('exclusive lock blocks competing hub without deleting owner metadata or exposing token', async (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'actspan-lock-'));
    const port = await freePort();
    const lockPath = path.join(dir, 'owner.lock');
    const metadataPath = path.join(dir, 'bridge.json');
    const owner = new ExtensionHub('private-owner-token', { port, pairOrigins: [origin], lockPath, metadataPath });
    const contender = new ExtensionHub('other-private-token', { port, pairOrigins: [origin], lockPath, metadataPath });
    t.after(async () => { await contender.stop(); await owner.stop(); rmSync(dir, { recursive: true, force: true }); });
    await owner.start();
    assert.equal(JSON.parse(readFileSync(metadataPath, 'utf8')).pid, process.pid);
    await assert.rejects(contender.start(), (error) =>
        error.message.includes(`port ${port}`) && error.message.includes(`Actspan PID ${process.pid}`) &&
        error.message.includes('compatible protocol') && !error.message.includes(owner.token));
    await contender.stop();
    assert.equal(owner.listening, true);
    assert.equal(existsSync(lockPath), true);
    assert.equal(existsSync(metadataPath), true);
    assert.doesNotMatch(readFileSync(lockPath, 'utf8') + readFileSync(metadataPath, 'utf8'), /private-owner-token|other-private-token/);
    await owner.stop();
    assert.equal(existsSync(lockPath), false);
    assert.equal(existsSync(metadataPath), false);
    await contender.start();
    assert.equal(contender.listening, true);
});

test('stale process lock can be reclaimed, but only own lock and metadata are removed', async (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'actspan-stale-'));
    const lockPath = path.join(dir, 'owner.lock');
    const metadataPath = path.join(dir, 'bridge.json');
    const port = await freePort();
    writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, nonce: 'stale' }));
    writeFileSync(metadataPath, JSON.stringify({ pid: 2147483647, nonce: 'stale' }));
    const hub = new ExtensionHub('secret', { port, pairOrigins: [origin], lockPath, metadataPath });
    t.after(async () => { await hub.stop(); rmSync(dir, { recursive: true, force: true }); });
    await hub.start();
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, process.pid);
    await hub.stop();
    assert.equal(existsSync(lockPath), false);
    assert.equal(existsSync(metadataPath), false);
});

test('failed bind releases only the lock acquired by that hub', async (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'actspan-bind-'));
    const occupied = createServer();
    occupied.listen(0, '127.0.0.1');
    await once(occupied, 'listening');
    const port = occupied.address().port;
    const lockPath = path.join(dir, 'owner.lock');
    const metadataPath = path.join(dir, 'bridge.json');
    const hub = new ExtensionHub('secret', { port, pairOrigins: [origin], lockPath, metadataPath });
    t.after(async () => { await hub.stop(); occupied.close(); rmSync(dir, { recursive: true, force: true }); });
    await assert.rejects(hub.start(), /port .*occupied/);
    assert.equal(existsSync(lockPath), false);
    assert.equal(existsSync(metadataPath), false);
});

test('disconnect rejects in-flight calls and reconnect grace only forwards live queued calls', async (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'actspan-grace-'));
    const hub = new ExtensionHub('secret', { port: await freePort(), pairOrigins: [origin],
        lockPath: path.join(dir, 'owner.lock'), metadataPath: path.join(dir, 'bridge.json'), reconnectGraceMs: 150 });
    t.after(async () => { await hub.stop(); rmSync(dir, { recursive: true, force: true }); });
    await hub.start();
    const old = await connect(hub);
    const request = once(old, 'message');
    const inFlight = hub.call('ping', {}, 1000);
    await request;
    const failure = assert.rejects(inFlight, /disconnected/);
    old.terminate();
    await failure;
    const queued = hub.call('ping', {}, 1000);
    const expired = hub.call('ping', {}, 20);
    await assert.rejects(expired, /timed out/);
    let resolveRequest;
    const requestAfterReconnect = new Promise((resolve) => { resolveRequest = resolve; });
    const fresh = await connect(hub, (message, ws) => resolveRequest({ message, ws }));
    const { message: frame } = await requestAfterReconnect;
    fresh.send(JSON.stringify({ id: frame.id, ...frame.context, ok: true, result: 17 }));
    assert.equal(await queued, 17);
    assert.equal(hub.pending.size, 0);
    const freshClosed = once(fresh, 'close');
    fresh.terminate();
    await freshClosed;
    await pause(180);
    await assert.rejects(hub.call('ping'), /not connected/);
});

test('queued calls fail explicitly when reconnect grace expires', async (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'actspan-expiry-'));
    const hub = new ExtensionHub('secret', { port: await freePort(), pairOrigins: [origin],
        lockPath: path.join(dir, 'owner.lock'), metadataPath: path.join(dir, 'bridge.json'), reconnectGraceMs: 40 });
    t.after(async () => { await hub.stop(); rmSync(dir, { recursive: true, force: true }); });
    await hub.start();
    const ws = await connect(hub);
    const closed = once(ws, 'close');
    ws.terminate();
    await closed;
    for (let tries = 0; hub.client && tries < 50; tries++) await pause(2);
    assert.equal(hub.client, null);
    await assert.rejects(hub.call('ping', {}, 1000), /reconnect grace elapsed/);
    assert.equal(hub.pending.size, 0);
});

test('stopping while disconnected rejects queued calls and forbids new calls', async (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'actspan-stop-'));
    const hub = new ExtensionHub('secret', { port: await freePort(), pairOrigins: [origin],
        lockPath: path.join(dir, 'owner.lock'), metadataPath: path.join(dir, 'bridge.json'), reconnectGraceMs: 200 });
    t.after(async () => { await hub.stop(); rmSync(dir, { recursive: true, force: true }); });
    await hub.start();
    const ws = await connect(hub);
    const closed = once(ws, 'close');
    ws.terminate();
    await closed;
    for (let tries = 0; hub.client && tries < 50; tries++) await pause(2);
    assert.equal(hub.client, null);
    const pending = hub.call('ping', {}, 500);
    const failure = assert.rejects(pending, /closed|stopped/);
    await hub.stop();
    await failure;
    await assert.rejects(hub.call('ping'), /unavailable|closed|stopped/);
});

test('closing MCP stdio preserves daemon-owned listener and metadata', async (t) => {
    const port = await freePort();
    const lockPath = path.join(os.homedir(), '.actspan', `bridge-${port}.lock`);
    const metadataPath = path.join(os.homedir(), '.actspan', `bridge-${port}.json`);
    const child = spawn(process.execPath, [fileURLToPath(new URL('../index.js', import.meta.url))], {
        env: { ...process.env, ACTSPAN_API_URL: 'https://api.example.com', ACTSPAN_API_KEY: 'test-only-key',
            ACTSPAN_EXTENSION_IDS: origin.slice('chrome-extension://'.length),
            ACTSPAN_BRIDGE_URL: `ws://127.0.0.1:${port}` },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    for (let tries = 0; !existsSync(metadataPath) && tries < 500; tries++) await pause(20);
    assert.equal(existsSync(metadataPath), true, stderr);
    assert.notEqual(JSON.parse(readFileSync(metadataPath, 'utf8')).pid, child.pid);
    child.stdin.end();
    await pause(250);
    if (child.exitCode === null) child.kill('SIGKILL');
    if (child.exitCode === null) await once(child, 'exit');
    assert.equal(existsSync(lockPath), true);
    assert.equal(existsSync(metadataPath), true);
    rmSync(lockPath, { force: true });
    rmSync(metadataPath, { force: true });
});

test('authenticated audit receipts require the full pending identity and never persist secrets', async (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'actspan-audit-'));
    const auditPath = path.join(dir, 'audit.jsonl');
    const hub = new ExtensionHub('secret-token', { port: await freePort(), pairOrigins: [origin],
        lockPath: path.join(dir, 'owner.lock'), metadataPath: path.join(dir, 'bridge.json'), auditPath });
    t.after(async () => { await hub.stop(); rmSync(dir, { recursive: true, force: true }); });
    await hub.start();
    const ws = await connect(hub);
    const requestFrame = once(ws, 'message');
    const result = hub.call('ping', { tabId: 7 }, 500);
    const request = JSON.parse((await requestFrame)[0].toString());
    const entry = { tool: 'ping', params: { tabId: 7, active: true, submit: false, allowSensitive: true, real: true, format: 'text',
        expressionChars: 41, textChars: 12, url: 'https://example.com/?api_key=raw-secret',
        query: 'raw-secret', nested: { token: 'raw-secret', data: 'x'.repeat(5000) } },
        effect: { success: true, summary: 'ok', note: 'raw-secret' }, time: Date.now(), host: 'codex' };
    ws.send(JSON.stringify({ type: 'audit', id: request.id, ...request.context, taskId: 'wrong', entry }));
    await pause(10);
    assert.equal(existsSync(auditPath), false);
    ws.send(JSON.stringify({ type: 'audit', id: request.id, ...request.context, entry }));
    ws.send(JSON.stringify({ type: 'audit', id: request.id, ...request.context, entry }));
    ws.send(JSON.stringify({ id: request.id, ...request.context, ok: true, result: 42 }));
    assert.equal(await result, 42);
    const lines = readFileSync(auditPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.ok(lines[0].length < 2048);
    assert.doesNotMatch(lines[0], /raw-secret|api_key|query|secret-token|https:\/\/example.com|xxxxx/);
    const audit = JSON.parse(lines[0]);
    assert.equal(audit.tool, 'ping');
    assert.equal(audit.host, 'codex');
    assert.equal(audit.params.tabId, 7);
    assert.equal(audit.sessionId, request.context.sessionId);
    assert.equal(audit.params.allowSensitive, true);
    assert.equal(audit.params.active, true);
    assert.equal(audit.params.submit, false);
    assert.equal(audit.params.real, true);
    assert.equal(audit.params.format, 'text');
    assert.equal(audit.params.expressionChars, 41);
    assert.equal(audit.params.textChars, 12);
    assert.equal(audit.effect.success, true);
    assert.equal(audit.effect.summary, 'ok');
    const nextFrame = once(ws, 'message');
    const nextResult = hub.call('ping', {}, 500);
    const next = JSON.parse((await nextFrame)[0].toString());
    ws.send(JSON.stringify({ type: 'audit', id: next.id, ...next.context, entry: {
        ...entry, host: 'raw-secret', params: { format: 'raw-secret', tabId: 'raw-secret' },
        effect: { success: false, summary: 'raw-secret' },
    } }));
    ws.send(JSON.stringify({ id: next.id, ...next.context, ok: true, result: 1 }));
    assert.equal(await nextResult, 1);
    const appended = readFileSync(auditPath, 'utf8').trim().split('\n');
    assert.equal(appended.length, 2);
    assert.doesNotMatch(appended[1], /raw-secret/);
    assert.match(JSON.parse(appended[1]).host, /^host-[a-f0-9]{12}$/);
    assert.equal(JSON.parse(appended[1]).effect.summary, 'redacted');
    // K3：同一次已认证调用的身份也进配额归因账本，键与审计逐条一致。
    const usage = JSON.parse(readFileSync(path.join(dir, 'usage.json'), 'utf8'));
    assert.equal(usage.version, 1);
    assert.deepEqual(Object.keys(usage.hosts).sort(), ['codex', JSON.parse(appended[1]).host].sort());
    assert.equal(usage.hosts.codex.calls, 1);
    assert.deepEqual(usage.hosts.codex.tools, { ping: 1 });
    assert.equal(usage.hosts.codex.sessions[audit.sessionId], 1);
    assert.equal(usage.hosts.codex.firstAt, usage.hosts.codex.lastAt);
});

test('validated host slug travels in request context without changing clientId binding', async (t) => {
    const hub = new ExtensionHub('secret', { port: 0, pairOrigins: [origin] });
    await hub.start();
    t.after(() => hub.stop());
    const ws = await connect(hub);
    const frame = once(ws, 'message');
    const result = hub.call('ping', {}, 500, { clientId: 'unique-client-id', host: 'codex' });
    const request = JSON.parse((await frame)[0].toString());
    assert.equal(request.context.clientId, 'unique-client-id');
    assert.equal(request.context.host, 'codex');
    ws.send(JSON.stringify({ id: request.id, ...request.context, ok: true, result: 'bound' }));
    assert.equal(await result, 'bound');
    assert.throws(() => hub.call('ping', {}, 500, { host: 'token=private-secret' }), /host/i);
});

test('initially offline command waits for first authenticated extension with finite deadline', async (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'actspan-initial-offline-'));
    const hub = new ExtensionHub('secret', { port: await freePort(), pairOrigins: [origin],
        lockPath: path.join(dir, 'owner.lock'), metadataPath: path.join(dir, 'bridge.json'), initialQueueMs: 1000 });
    t.after(async () => { await hub.stop(); rmSync(dir, { recursive: true, force: true }); });
    await hub.start();
    let resolveFrame;
    const request = new Promise((resolve) => { resolveFrame = resolve; });
    const queued = hub.call('ping', {}, 2000);
    void queued.catch(() => {});
    const ws = await connect(hub, (frame) => resolveFrame(frame));
    const frame = await Promise.race([request, pause(500).then(() => { throw new Error('first extension never received queued request'); })]);
    ws.send(JSON.stringify({ id: frame.id, ...frame.context, ok: true, result: 'first connection' }));
    assert.equal(await queued, 'first connection');
    ws.terminate();
});

test('initial offline queue expires without extension instead of hanging', async (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'actspan-initial-expiry-'));
    const hub = new ExtensionHub('secret', { port: await freePort(), pairOrigins: [origin],
        lockPath: path.join(dir, 'owner.lock'), metadataPath: path.join(dir, 'bridge.json'), initialQueueMs: 40 });
    t.after(async () => { await hub.stop(); rmSync(dir, { recursive: true, force: true }); });
    await hub.start();
    await assert.rejects(hub.call('ping', {}, 500), /offline queue expired/);
    assert.equal(hub.pending.size, 0);
});
