import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import WebSocket, { WebSocketServer } from 'ws';
import { identityCheck, probeBridge, runDoctor } from '../doctor.js';
import { ExtensionHub } from '../bridge.js';
import { extensionIdFromKey } from '../install.js';

test('doctor says when bridge metadata is absent', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'actspan-doctor-'));
    const messages = [];
    const result = await runDoctor({ metadataPath: path.join(dir, 'missing.json'), output: (text) => messages.push(text) });
    assert.equal(result.status.state, 'not_running');
    assert.match(messages.join('\n'), /桥未运行/);
});

test('doctor reports stale bridge pid honestly', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'actspan-doctor-'));
    const file = path.join(dir, 'bridge.json');
    writeFileSync(file, JSON.stringify({ pid: 2147483647, port: 30121, origins: [] }));
    const messages = [];
    const result = await runDoctor({ metadataPath: file, output: (text) => messages.push(text) });
    assert.equal(result.status.state, 'stale');
    assert.match(messages.join('\n'), /pid .*已经没了/);
});

test('doctor does not start a daemon without explicit confirmation', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'actspan-doctor-'));
    await assert.rejects(() => runDoctor({ metadataPath: path.join(dir, 'missing.json'), start: true }), /--start --yes/);
});

async function withOwnerInfo(connected, check) {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    server.on('connection', (socket) => socket.once('message', () => socket.send(JSON.stringify({ type: 'owner_info', connected }))));
    try { await check(server.address().port); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('doctor reports successful live extension handshake', async () => {
    await withOwnerInfo(true, async (port) => {
        const result = await probeBridge({ port });
        assert.equal(result.state, 'online');
        assert.equal(result.message, '握手正常 · 扩展在线');
    });
});

test('doctor preserves hub_listening hint when extension is offline', async () => {
    await withOwnerInfo(false, async (port) => {
        const result = await probeBridge({ port });
        assert.equal(result.state, 'hub_listening');
        assert.match(result.message, /hub_listening/);
    });
});

test('doctor observes a real paired extension without exposing its token', async () => {
    const extensionId = 'c'.repeat(32);
    const origin = `chrome-extension://${extensionId}`;
    const hub = new ExtensionHub(undefined, { port: 0, pairOrigins: [origin] });
    await hub.start();
    const port = hub.wss.address().port;
    const extension = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Origin: origin } });
    await new Promise((resolve, reject) => {
        extension.on('open', () => extension.send(JSON.stringify({ type: 'pair' })));
        extension.on('message', (raw) => {
            const message = JSON.parse(raw.toString());
            if (message.type === 'pair_ok') extension.send(JSON.stringify({ type: 'hello', token: message.token }));
            if (message.type === 'hello_ok') resolve();
        });
        extension.on('error', reject);
    });
    try {
        const result = await probeBridge({ port });
        assert.deepEqual(result, { state: 'online', message: '握手正常 · 扩展在线' });
        assert.equal(JSON.stringify(result).includes(hub.token), false);
    } finally {
        extension.terminate();
        await hub.stop();
    }
});

test('doctor accepts the manifest-derived extension identity', () => {
    const canonical = extensionIdFromKey();
    assert.equal(identityCheck({ extensionId: canonical }).match, true);
    assert.equal(identityCheck({ origins: [`chrome-extension://${canonical}`] }).match, true);
});

test('doctor reports an identity mismatch instead of silently accepting a wrong origin', () => {
    const drifted = 'a'.repeat(32);
    const requested = identityCheck({ extensionId: drifted });
    assert.equal(requested.match, false);
    assert.match(requested.message, /扩展 ID 不匹配/);
    assert.match(requested.message, new RegExp(extensionIdFromKey()));

    const allowlist = identityCheck({ origins: [`chrome-extension://${drifted}`] });
    assert.equal(allowlist.match, false);
    assert.match(allowlist.message, /allowlist/);
    assert.match(allowlist.message, new RegExp(extensionIdFromKey()));
});

test('doctor surfaces the identity mismatch through runDoctor output', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'actspan-doctor-'));
    const file = path.join(dir, 'bridge.json');
    writeFileSync(file, JSON.stringify({ pid: process.pid, port: 30121, origins: [`chrome-extension://${'a'.repeat(32)}`] }));
    const messages = [];
    const result = await runDoctor({ metadataPath: file, output: (text) => messages.push(text) });
    assert.equal(result.identity.match, false);
    assert.match(messages.join('\n'), /扩展 ID 不匹配|allowlist/);
});

test('doctor refuses to start a bridge for a drifted extension id', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'actspan-doctor-'));
    await assert.rejects(
        () => runDoctor({ metadataPath: path.join(dir, 'missing.json'), start: true, yes: true, extensionId: 'a'.repeat(32) }),
        /扩展 ID 不匹配/,
    );
});
