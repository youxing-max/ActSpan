import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { ExtensionHub } from '../bridge.js';
import net from 'node:net';
import { bridgePaths, lockIsStale, processAlive, readCredential, tryAcquireStartLock, releaseStartLock, takeOverStartLock, STALE_LOCK_MS } from '../bridge-lock.js';

const origin = `chrome-extension://${'a'.repeat(32)}`;
const CLI = fileURLToPath(new URL('../bridge-cli.js', import.meta.url));

const runCli = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('close', (code) => resolve({ code, out }));
});

test('a lock whose owner is dead is stale regardless of mtime', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actspan-lock-'));
    const file = path.join(dir, 'bridge.lock');
    fs.writeFileSync(file, JSON.stringify({ pid: 2147483647, nonce: 'dead' }));
    try {
        assert.equal(processAlive(2147483647), false);
        assert.equal(lockIsStale(file), true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a live owner with a fresh heartbeat is not stale, but a frozen one is', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actspan-lock-'));
    const file = path.join(dir, 'bridge.lock');
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, nonce: 'live' }));
    try {
        assert.equal(lockIsStale(file), false);
        const frozen = new Date(Date.now() - STALE_LOCK_MS - 1000);
        fs.utimesSync(file, frozen, frozen);
        assert.equal(lockIsStale(file), true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('only one contender wins the start lock and a stale one is reclaimed', () => {
    const port = 30000 + Math.floor(Math.random() * 20000);
    const { startLockPath } = bridgePaths(port);
    fs.rmSync(startLockPath, { force: true });
    const first = tryAcquireStartLock(port);
    const second = tryAcquireStartLock(port);
    try {
        assert.equal(first.acquired, true);
        assert.equal(second.acquired, false);
        releaseStartLock(first);
        const third = tryAcquireStartLock(port);
        assert.equal(third.acquired, true);
        releaseStartLock(third);

        fs.writeFileSync(startLockPath, JSON.stringify({ pid: 2147483647, nonce: 'crashed' }));
        const reclaimed = tryAcquireStartLock(port);
        assert.equal(reclaimed.acquired, true);
        releaseStartLock(reclaimed);
    } finally {
        fs.rmSync(startLockPath, { force: true });
    }
});

test('the daemon takes over the start lock so its heartbeat keeps the lock fresh', () => {
    const port = 30000 + Math.floor(Math.random() * 20000);
    const { startLockPath } = bridgePaths(port);
    const held = tryAcquireStartLock(port);
    try {
        assert.equal(held.acquired, true);
        // 只有抢到 O_EXCL 的进程会 spawn daemon，所以此刻接管必然属于本次 spawn。
        const claimed = takeOverStartLock(port);
        assert.ok(claimed?.acquired);
        const owner = JSON.parse(fs.readFileSync(startLockPath, 'utf8'));
        assert.equal(owner.role, 'daemon');
        assert.equal(owner.pid, process.pid);
        releaseStartLock(claimed);
        assert.equal(fs.existsSync(startLockPath), false);
    } finally { fs.rmSync(startLockPath, { force: true }); }
});

test('bridge status and stop report honestly when no daemon is running', async () => {
    const port = 30000 + Math.floor(Math.random() * 20000);
    const status = await runCli(['status', '--port', String(port)]);
    const parsed = JSON.parse(status.out.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.state, 'not_running');
    assert.equal(parsed.pid, null);

    const stop = await runCli(['stop', '--port', String(port)]);
    const stopped = JSON.parse(stop.out.trim());
    assert.equal(stopped.ok, true);
    assert.equal(stopped.reason, 'not_running');
    assert.equal(stop.code, 0);
});

test('stopBridge only signals the pid recorded in bridge.json', async () => {
    const port = 30000 + Math.floor(Math.random() * 20000);
    const { metadataPath } = bridgePaths(port);
    const dir = path.dirname(metadataPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
    child.unref();
    fs.writeFileSync(metadataPath, JSON.stringify({ pid: child.pid, port, origins: [origin] }));
    try {
        const result = await runCli(['stop', '--port', String(port)]);
        const parsed = JSON.parse(result.out.trim());
        assert.equal(parsed.stopped, true);
        assert.equal(parsed.pid, child.pid);
        assert.equal(processAlive(child.pid), false);
    } finally {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        fs.rmSync(metadataPath, { force: true });
    }
});

test('a silent extension that never answers ping is terminated', async () => {
    const hub = new ExtensionHub('secret', { port: 0, pairOrigins: [origin], pingIdleMs: 60, pongTimeoutMs: 80 });
    await hub.start(0);
    const port = hub.wss.address().port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Origin: origin } });
    const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
    await new Promise((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({ type: 'hello', token: hub.token }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(hub.isConnected(), true);
    // 不回 pong：桥必须在 pongTimeoutMs 后 terminate，而不是永远挂着。
    await closed;
    assert.equal(hub.isConnected(), false);
    await hub.stop();
});

test('an extension that answers ping stays connected', async () => {
    const hub = new ExtensionHub('secret', { port: 0, pairOrigins: [origin], pingIdleMs: 60, pongTimeoutMs: 200 });
    await hub.start(0);
    const port = hub.wss.address().port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Origin: origin } });
    let pings = 0;
    ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === 'ping') { pings++; ws.send(JSON.stringify({ type: 'pong', at: Date.now() })); }
    });
    await new Promise((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({ type: 'hello', token: hub.token }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(pings >= 3, `expected repeated pings, saw ${pings}`);
    assert.equal(hub.isConnected(), true);
    ws.close();
    await hub.stop();
});

/** 最小 RPC 客户端：认证 + 一次调用，用来验证 daemon 的契约而不是 CLI 的行为。 */
function rpcCall(port, request, label) {
    return new Promise((resolve, reject) => {
        const credential = readCredential(port);
        if (!credential) return reject(new Error('no credential'));
        const socket = net.createConnection({ host: '127.0.0.1', port: credential.rpcPort });
        let buffered = '';
        const id = 'test-1';
        socket.on('connect', () => {
            socket.write(`${JSON.stringify({ type: 'auth', protocol: 'actspan-bridge-rpc-v1', secret: credential.secret,
                clientId: 'label-test', sessionId: 'label-test', ...(label ? { label } : {}) })}\n`);
            socket.write(`${JSON.stringify({ type: 'call', id, method: request, params: {} })}\n`);
        });
        socket.on('data', (chunk) => {
            buffered += chunk.toString('utf8');
            let end;
            while ((end = buffered.indexOf('\n')) >= 0) {
                const line = buffered.slice(0, end);
                buffered = buffered.slice(end + 1);
                if (!line) continue;
                const message = JSON.parse(line);
                if (message.type === 'result' && message.id === id) { socket.destroy(); resolve(message); }
            }
        });
        socket.on('error', reject);
        setTimeout(() => { socket.destroy(); reject(new Error('rpc timeout')); }, 5000).unref?.();
    });
}

test('the bridge label is frozen at connect and cannot be changed afterwards', async () => {
    const port = 37000 + (process.pid % 1000);
    const started = await runCli(['start', '--port', String(port), '--origins-json', JSON.stringify([origin])]);
    try {
        assert.equal(JSON.parse(started.out).ok, true, started.out);
        const accepted = await rpcCall(port, 'status.get', 'cursor');
        assert.equal(accepted.ok, true);
        // K2：连上之后不认改口——daemon 里已经没有 status.label 这条路。
        const rejected = await rpcCall(port, 'status.label', 'claude-desktop');
        assert.equal(rejected.ok, false);
        assert.match(rejected.error, /Unknown daemon method/);
    } finally {
        await runCli(['stop', '--port', String(port)]);
    }
});
 
test('restarts an older daemon before reuse', async () => {
    const port = 30000 + Math.floor(Math.random() * 20000);
    const started = await runCli(['start', '--port', String(port), '--origins-json', JSON.stringify([origin])]);
    assert.equal(JSON.parse(started.out).ok, true, started.out);
    const { credentialPath: rpcPath } = bridgePaths(port);
    const oldCredential = JSON.parse(fs.readFileSync(rpcPath, 'utf8'));
    fs.writeFileSync(rpcPath, JSON.stringify({ ...oldCredential, appVersion: '0.0.0' }));
    try {
        const restarted = await runCli(['start', '--port', String(port), '--origins-json', JSON.stringify([origin])]);
        const parsed = JSON.parse(restarted.out.trim());
        assert.equal(parsed.ok, true, restarted.out);
        assert.notEqual(parsed.daemonPid, oldCredential.pid);
        const active = readCredential(port);
        const packageVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
        assert.equal(active?.appVersion, packageVersion);
    } finally {
        await runCli(['stop', '--port', String(port)]);
    }
});
