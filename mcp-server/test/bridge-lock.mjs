import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { ExtensionHub } from '../bridge.js';
import { createLazyBridgeDaemonClient } from '../daemon-rpc.js';
import net from 'node:net';
import { bridgePaths, lockIsStale, processAlive, readCredential, tryAcquireStartLock, releaseStartLock, takeOverStartLock, STALE_LOCK_MS } from '../bridge-lock.js';

const origin = `chrome-extension://${'a'.repeat(32)}`;
// 每个测试文件使用独立状态目录，避免覆盖真实 ~/.actspan 或与其他套件并发冲突。
process.env.ACTSPAN_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'actspan-bridge-lock-'));
process.on('exit', () => { try { fs.rmSync(process.env.ACTSPAN_STATE_DIR, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ } });
/** 随机端口避开真实桥常用端口（30121），降低撞车概率。 */
const randomPort = () => {
    let port = 0;
    do { port = 30000 + Math.floor(Math.random() * 20000); } while (port === 30121 || port === 31921);
    return port;
};
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
    const port = randomPort();
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
    const port = randomPort();
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
    const port = randomPort();
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
    const port = randomPort();
    const { metadataPath } = bridgePaths(port);
    const dir = path.dirname(metadataPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // 命令行必须带 bridge daemon 标识：stop 会校验 /proc/<pid>/cmdline（或 ps）后才发信号。
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'bridge-daemon.js'], { stdio: 'ignore', detached: true });
    child.unref();
    fs.writeFileSync(metadataPath, JSON.stringify({ pid: child.pid, port, origins: [origin] }));
    try {
        const result = await runCli(['stop', '--port', String(port)]);
        const parsed = JSON.parse(result.out.trim());
        assert.equal(parsed.stopped, true, JSON.stringify(parsed));
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
    const hub = new ExtensionHub('secret', { port: 0, pairOrigins: [origin], pingIdleMs: 60, pongTimeoutMs: 1000 });
    await hub.start(0);
    const port = hub.wss.address().port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Origin: origin } });
    let pings = 0;
    let timeout;
    try {
        const repeatedPings = new Promise((resolve, reject) => {
            timeout = setTimeout(() => reject(new Error(`expected repeated pings, saw ${pings}`)), 5000);
            ws.once('error', reject);
            ws.once('open', () => ws.send(JSON.stringify({ type: 'hello', token: hub.token })));
            ws.on('message', (raw) => {
                const message = JSON.parse(raw.toString());
                if (message.type === 'ping') {
                    pings++;
                    ws.send(JSON.stringify({ type: 'pong', at: Date.now() }));
                    if (pings >= 3) resolve();
                }
            });
        });
        await repeatedPings;
        assert.equal(hub.isConnected(), true);
    } finally {
        clearTimeout(timeout);
        ws.terminate();
        await hub.stop();
    }
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
    const port = randomPort();
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

test('bridge-cli help, invalid origins and status never silently start a daemon', async () => {
    const port = randomPort();
    const { metadataPath } = bridgePaths(port);
    fs.rmSync(metadataPath, { force: true });

    const help = await runCli(['--port', String(port), '--help']);
    assert.equal(help.code, 0);
    assert.match(JSON.parse(help.out).usage, /start\|stop\|status\|usage/);

    const bad = await runCli(['start', '--port', String(port), '--origins-json', '[bad']);
    assert.equal(bad.code, 1);
    assert.equal(JSON.parse(bad.out).ok, false);
    assert.match(JSON.parse(bad.out).error, /Invalid --origins-json/);

    const status = await runCli(['--port', String(port), 'status']);
    assert.equal(status.code, 0);
    assert.equal(JSON.parse(status.out).state, 'not_running');
    assert.equal(fs.existsSync(metadataPath), false);
});

test('a lazy RPC client reconnects after daemon replacement with its original identity', async () => {
    const port = randomPort();
    const client = createLazyBridgeDaemonClient({ port, pairOrigins: [origin], clientId: 'reconnect-client', sessionId: 'reconnect-session', label: 'codex' });
    try {
        const started = await runCli(['start', '--port', String(port), '--origins-json', JSON.stringify([origin])]);
        assert.equal(started.code, 0, started.out);
        await client.status();
        const originalPid = readCredential(port).pid;
        const stopped = await runCli(['stop', '--port', String(port)]);
        assert.equal(stopped.code, 0, stopped.out);
        const deadline = Date.now() + 5000;
        while (client.isConnected() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(client.isConnected(), false);
        const restarted = await runCli(['start', '--port', String(port), '--origins-json', JSON.stringify([origin])]);
        assert.equal(restarted.code, 0, restarted.out);
        assert.notEqual(readCredential(port).pid, originalPid);
        const statuses = await Promise.all([client.status(), client.status(), client.call('status.get')]);
        assert.ok(statuses.every((status) => status.listening === true));
        assert.equal(client.isConnected(), true);
        assert.equal(client.label, 'codex');
        assert.throws(() => { client.label = 'other'; }, /frozen/);
        assert.throws(() => { client.sessionId = 'other'; }, /frozen/);
    } finally {
        client.stop();
        await runCli(['stop', '--port', String(port)]);
    }
});

test('lazy RPC recovery shares one connection, restores listeners, and never replays a disconnected write', async () => {
    const port = randomPort();
    const sockets = new Set();
    const authentications = [];
    let writes = 0;
    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => {});
        let buffered = '';
        socket.on('data', (chunk) => {
            buffered += chunk.toString('utf8');
            let end;
            while ((end = buffered.indexOf('\n')) >= 0) {
                const message = JSON.parse(buffered.slice(0, end));
                buffered = buffered.slice(end + 1);
                if (message.type === 'auth') {
                    authentications.push(message);
                    socket.write(`${JSON.stringify({ type: 'auth_ok', port, listening: true })}\n`);
                } else if (message.method === 'write.once') {
                    writes++;
                    socket.destroy();
                } else {
                    socket.write(`${JSON.stringify({ type: 'event', event: { type: 'probe' } })}\n`);
                    socket.write(`${JSON.stringify({ type: 'result', id: message.id, ok: true, result: { listening: true } })}\n`);
                }
            }
        });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const { credentialPath: rpcPath } = bridgePaths(port);
    fs.writeFileSync(rpcPath, JSON.stringify({ protocol: 'actspan-bridge-rpc-v1', pid: process.pid, rpcPort: server.address().port,
        secret: 'test-only-rpc-secret', nonce: 'test-only-rpc-nonce', origins: [origin] }));
    const client = createLazyBridgeDaemonClient({ port, pairOrigins: [origin], clientId: 'safe-client', sessionId: 'safe-session', label: 'codex' });
    const events = [];
    client.on('event', (event) => events.push(event.type));
    try {
        await client.status();
        await assert.rejects(client.call('write.once'), /Bridge daemon disconnected/);
        assert.equal(authentications.length, 1);
        await Promise.all([client.status(), client.status(), client.call('status.get')]);
        assert.equal(authentications.length, 2);
        assert.ok(authentications.every((auth) => auth.clientId === 'safe-client' && auth.sessionId === 'safe-session' && auth.label === 'codex'));
        assert.deepEqual(events, ['probe', 'probe', 'probe', 'probe']);
        assert.equal(writes, 1);
        client.stop();
        await assert.rejects(client.connect(), /stopped/);
        await assert.rejects(client.status(), /stopped/);
        assert.equal(authentications.length, 2);
        const pendingClient = createLazyBridgeDaemonClient({ port, pairOrigins: [origin], clientId: 'stopped-client', sessionId: 'stopped-session' });
        const connection = pendingClient.connect();
        pendingClient.stop();
        await assert.rejects(connection, /stopped/);
        assert.equal(pendingClient.isConnected(), false);
        await assert.rejects(pendingClient.status(), /stopped/);
        assert.equal(authentications.length, 3);
    } finally {
        client.stop();
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(rpcPath, { force: true });
    }
});
