#!/usr/bin/env node
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { ExtensionHub } from './bridge.js';
import { takeOverStartLock, releaseStartLock, startLockHeartbeat, BRIDGE_APP_VERSION, bridgePaths } from './bridge-lock.js';

const PROTOCOL = 'actspan-bridge-rpc-v1';
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
/** 单个客户端在途请求上限，防止本地客户端堆满内存。 */
const MAX_PENDING_REQUESTS_PER_CLIENT = 32;
const portArg = process.argv.indexOf('--port');
const originsArg = process.argv.indexOf('--origins-json');
const bridgePort = Number(portArg >= 0 ? process.argv[portArg + 1] : 30121);
let pairOrigins = [];
try { pairOrigins = JSON.parse(originsArg >= 0 ? process.argv[originsArg + 1] : '[]'); } catch { pairOrigins = []; }

const rpcPath = bridgePaths(bridgePort).credentialPath;
const frame = (value) => {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > MAX_FRAME_BYTES - 1) throw new Error('RPC frame too large');
    return `${text}\n`;
};
function parser(onFrame, onError) {
    let buffered = Buffer.alloc(0);
    let dead = false;
    const fail = (error) => {
        if (dead) return;
        dead = true;
        buffered = Buffer.alloc(0);
        onError(error);
    };
    return (chunk) => {
        if (dead) return;
        buffered = Buffer.concat([buffered, chunk]);
        while (true) {
            const end = buffered.indexOf(10);
            if (end < 0) {
                // 只有一条完整帧都收不齐时才判超限；否则含多条合法帧的大 chunk 会被误杀。
                if (buffered.length > MAX_FRAME_BYTES) fail(new Error('RPC frame too large'));
                return;
            }
            const line = buffered.subarray(0, end);
            buffered = buffered.subarray(end + 1);
            if (!line.length) continue;
            let value;
            try { value = JSON.parse(line.toString('utf8')); } catch { fail(new Error('Invalid RPC frame')); return; }
            onFrame(value);
        }
    };
}
function removeStaleCredential() {
    try {
        const owner = JSON.parse(fs.readFileSync(rpcPath, 'utf8'));
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return;
        try { process.kill(owner.pid, 0); return; } catch (error) {
            if (error.code !== 'ESRCH') return;
        }
        if (JSON.parse(fs.readFileSync(rpcPath, 'utf8')).nonce === owner.nonce) fs.unlinkSync(rpcPath);
    } catch { /* Missing or concurrently replaced credential. */ }
}
function safeClose(socket) { try { socket.destroy(); } catch { /* no-op */ } }
function validAuth(value, secret) {
    return value?.type === 'auth' && value.protocol === PROTOCOL && value.secret === secret &&
        typeof value.clientId === 'string' && value.clientId.length > 0 &&
        typeof value.sessionId === 'string' && value.sessionId.length > 0;
}

let hub;
let rpcServer;
let credential;
const clients = new Set();
let shuttingDown = false;
let startLock = null;
let stopHeartbeat = null;

function onlineSessions() {
    const sessions = [];
    for (const client of clients) {
        for (const sessionId of client.sessions) sessions.push({ clientId: client.clientId, sessionId, ...(client.label ? { label: client.label } : {}) });
    }
    return sessions;
}

function status() {
    return {
        connectedAt: hub?.connectedAt || null,
        clientOrigin: hub?.clientOrigin || null,
        extensionConnected: hub?.isConnected() === true,
        listening: hub?.listening === true,
        lastReplacementReason: hub?.lastReplacementReason || null,
        lastError: hub?.lastError || null,
        compatibility: hub?.compatibility || null,
        port: bridgePort,
    };
}

function removeClient(client) {
    if (!clients.delete(client)) return;
    for (const sessionId of client.sessions) {
        try { hub?.sessionDisconnected?.(client.clientId, sessionId); } catch { /* Bridge cleanup is best effort. */ }
    }
    for (const requestId of client.requests.values()) {
        try { hub?.cancelRequest?.(requestId); } catch { /* Request may already be settled. */ }
    }
}

function broadcast(event) {
    for (const client of clients) {
        if (!client.authenticated) continue;
        try { client.socket.write(frame({ type: 'event', event })); } catch { safeClose(client.socket); }
    }
}

async function request(client, message) {
    if (message.type !== 'call' || typeof message.id !== 'string' || typeof message.method !== 'string') throw new Error('Invalid RPC request');
    if (message.method === 'status.get') {
        client.socket.write(frame({ type: 'result', id: message.id, ok: true, result: status() }));
        return;
    }
    if (message.method === 'status.shutdown') {
        // 主客户端可以退；操作员（actspan bridge stop，凭 0600 凭据认证）也可以退。
        if (client !== [...clients][0] && !client.operator) throw new Error('Only daemon primary client may shut down bridge');
        client.socket.write(frame({ type: 'result', id: message.id, ok: true, result: { shuttingDown: true } }));
        setImmediate(() => shutdown());
        return;
    }
    // `status.*` 是 daemon 自己的命名空间：不认识的必须当面报错，不能当成扩展命令转发出去。
    if (message.method.startsWith('status.')) {
        client.socket.write(frame({ type: 'result', id: message.id, ok: false, error: `Unknown daemon method: ${message.method}` }));
        return;
    }
    // 同一客户端的 message.id 是响应关联键：重复 id 会覆盖在途记录，导致前一个请求再也收不到结果。
    if (client.requests.has(message.id)) {
        client.socket.write(frame({ type: 'result', id: message.id, ok: false, error: 'Duplicate request id' }));
        return;
    }
    if (client.requests.size >= MAX_PENDING_REQUESTS_PER_CLIENT) {
        client.socket.write(frame({ type: 'result', id: message.id, ok: false, error: 'Too many pending requests' }));
        return;
    }
    // requestId 必须在这里生成：它既是 hub 的响应关联键，也是取消在途请求的句柄。
    // 之前这里引用了一个不存在的名字，ReferenceError 被外层 .catch(() => fail()) 吞掉，
    // 表现成「认证成功、一发 call 就断线」。
    const requestId = `${client.prefix}${randomUUID()}`;
    client.requests.set(message.id, requestId);
    const requestedSessionId = typeof message.context?.sessionId === 'string' && message.context.sessionId ? message.context.sessionId : client.sessionId;
    client.sessions.add(requestedSessionId);
    const context = {
        ...(message.context && typeof message.context === 'object' ? message.context : {}),
        clientId: client.clientId,
        sessionId: requestedSessionId,
        requestId,
        onlineSessions: onlineSessions(),
    };
    try {
        const result = await hub.call(message.method, message.params || {}, message.timeoutMs, context);
        if (client.closed) return;
        client.socket.write(frame({ type: 'result', id: message.id, ok: true, result }));
    } catch (error) {
        if (client.closed) return;
        client.socket.write(frame({ type: 'result', id: message.id, ok: false, error: String(error?.message || error) }));
    } finally {
        client.requests.delete(message.id);
    }
}

function onConnection(socket) {
    const client = { socket, authenticated: false, closed: false, operator: false, clientId: null, sessionId: null, label: '', sessions: new Set(), requests: new Map(), prefix: `${randomUUID()}:` };
    let authTimer = setTimeout(() => safeClose(socket), 2000);
    const fail = () => { clearTimeout(authTimer); client.closed = true; removeClient(client); safeClose(socket); };
    const parse = parser((message) => {
        if (!client.authenticated) {
            if (!validAuth(message, credential.secret)) return fail();
            clearTimeout(authTimer);
            client.authenticated = true;
            client.operator = message.role === 'operator';
            // validAuth 已经保证了 clientId 非空；不落下来的话 onlineSessions 会报 null，
            // 断开时的 sessionDisconnected(clientId, ...) 也会因为 clientId 非字符串直接返回。
            client.clientId = message.clientId;
            client.sessionId = message.sessionId;
            client.label = typeof message.label === 'string' ? message.label.slice(0, 128) : '';
            client.sessions.add(client.sessionId);
            clients.add(client);
            try { socket.write(frame({ type: 'auth_ok', ...status() })); } catch { fail(); }
            return;
        }
        Promise.resolve(request(client, message)).catch(() => fail());
    }, fail);
    socket.setNoDelay(true);
    socket.on('data', parse);
    socket.on('error', fail);
    socket.on('close', () => { clearTimeout(authTimer); client.closed = true; removeClient(client); });
}

/** E5：退之前先把在途命令回成错误，不让 agent 干等到超时。 */
async function failInFlight(reason) {
    const flushing = [];
    for (const client of clients) {
        for (const [messageId] of client.requests) {
            try { client.socket.write(frame({ type: 'result', id: messageId, ok: false, error: reason })); } catch { /* Socket already gone. */ }
        }
        client.requests.clear();
        if (!client.socket.destroyed) flushing.push(new Promise((resolve) => client.socket.end(resolve)));
    }
    if (!flushing.length) return;
    await Promise.race([Promise.all(flushing), new Promise((resolve) => setTimeout(resolve, 500))]);
}

async function cleanup() {
    for (const client of clients) safeClose(client.socket);
    clients.clear();
    if (rpcServer) await new Promise((resolve) => rpcServer.close(resolve));
    try {
        if (credential && JSON.parse(fs.readFileSync(rpcPath, 'utf8')).nonce === credential.nonce) fs.unlinkSync(rpcPath);
    } catch { /* Never remove another daemon's credential. */ }
    stopHeartbeat?.();
    releaseStartLock(startLock);
    try { await hub?.stop(); } catch { /* Process is exiting. */ }
}

async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    await failInFlight('Bridge daemon is shutting down');
    await cleanup();
    process.exit(0);
}

async function main() {
    if (!Number.isInteger(bridgePort) || bridgePort <= 0 || bridgePort > 65535) return;
    hub = new ExtensionHub(undefined, { port: bridgePort, pairOrigins });
    try { await hub.start(); } catch { return; }
    hub.on('event', broadcast);
    const secret = randomBytes(32).toString('base64url');
    const nonce = randomUUID();
    rpcServer = net.createServer(onConnection);
    await new Promise((resolve, reject) => {
        rpcServer.once('error', reject);
        rpcServer.listen({ host: '127.0.0.1', port: 0 }, resolve);
    }).catch(async () => { await cleanup(); });
    if (!rpcServer?.listening) return;
    const address = rpcServer.address();
    credential = { protocol: PROTOCOL, pid: process.pid, nonce, rpcPort: address.port, secret, origins: [...new Set(pairOrigins)].sort(), appVersion: BRIDGE_APP_VERSION };
    try {
        fs.mkdirSync(path.dirname(rpcPath), { recursive: true, mode: 0o700 });
        removeStaleCredential();
        const fd = fs.openSync(rpcPath, 'wx', 0o600);
        try { fs.writeFileSync(fd, JSON.stringify(credential)); fs.fchmodSync(fd, 0o600); } finally { fs.closeSync(fd); }
    } catch {
        await cleanup();
        return;
    }
    // E1：接管启动锁并持续心跳，让 mtime 成为「daemon 还活着」的可判据。
    startLock = takeOverStartLock(bridgePort);
    stopHeartbeat = startLockHeartbeat(bridgePort);
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    process.on('exit', () => {
        releaseStartLock(startLock);
        try { if (credential && JSON.parse(fs.readFileSync(rpcPath, 'utf8')).nonce === credential.nonce) fs.unlinkSync(rpcPath); } catch { /* owner-only cleanup */ }
    });
}

main().catch(() => {});
