import { Policy } from './policy.js';
import { DEFAULT_AGENTS } from './identity.js';
import { createUsageLedger } from './usage.js';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareProtocolVersions, PROTOCOL_VERSION } from './protocol-version.js';
import { bridgePaths, lockIsStale } from './bridge-lock.js';
const LOCAL_VERSION = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
/** 单个 hub 在途请求上限，防止本地客户端堆满内存。 */
const MAX_PENDING_REQUESTS = 64;

function logFile() {
    return process.env.ACTSPAN_MCP_LOG
        || path.join(process.env.ACTSPAN_STATE_DIR || path.join(os.homedir(), '.actspan'), 'mcp-server.log');
}

function log(...a) {
    try {
        const target = logFile();
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.appendFileSync(target, `${new Date().toISOString()} [actspan-mcp] ${a.map(redact).join(' ')}\n`);
    } catch {
        // Logging must never break the stdio MCP transport.
    }
}

function redact(value) {
    const text = String(value);
    const secrets = [process.env.ACTSPAN_API_KEY, process.env.MOLE_MCP_API_KEY].filter(Boolean);
    return secrets.reduce((s, secret) => s.replaceAll(secret, '[REDACTED]'), text)
        .replace(/(authorization\s*:\s*bearer\s+)\S+/gi, '$1[REDACTED]')
        .replace(/(token|api[_-]?key|authorization)(["'=:\s]+)([^\s,;]+)/gi, '$1$2[REDACTED]');
}

const OWNER_PROBE_ORIGIN = 'actspan-mcp://owner-probe';
const OWNER_PROTOCOL = 'actspan-bridge-v1';


export class ExtensionHub extends EventEmitter {
    constructor(token, { port = 30121, pairOrigins = [], lockPath, metadataPath, auditPath, reconnectGraceMs = 250, initialQueueMs = 250, pingIdleMs = 30000, pongTimeoutMs = 10000 } = {}) {
        super();
        this.token = token || randomUUID().replaceAll('-', '');
        /**
         * 配对证明：首次配对（TOFU）时签发随机 secret，之后所有 pair 请求必须携带它。
         * 仅凭 Origin 头不能证明扩展身份（本地进程可伪造），token 不能无证明下发。
         */
        this.pairSecretHash = null;
        this.port = port;
        this.pairOrigins = new Set(pairOrigins.filter((origin) => /^chrome-extension:\/\/[a-p]{32}$/.test(origin)));
        this.lockPath = lockPath || bridgePaths(port).lockPath;
        this.metadataPath = metadataPath || bridgePaths(port).metadataPath;
        this.auditPath = auditPath || path.join(bridgePaths(port).dir, 'audit.jsonl');
        this.usage = createUsageLedger({ path: path.join(path.dirname(this.auditPath), 'usage.json') });
        this.customLockPath = Boolean(lockPath);
        this.customMetadataPath = Boolean(metadataPath);
        this.reconnectGraceMs = reconnectGraceMs;
        this.initialQueueMs = initialQueueMs;
        this.pingIdleMs = pingIdleMs;
        this.pongTimeoutMs = pongTimeoutMs;
        this.livenessTimer = null;
        this.pongTimer = null;
        this.awaitingPong = false;
        this.lockNonce = null;
        this.disconnectedAt = null;
        this.stopped = false;
        this.client = null;
        this.pending = new Map();
        this.clientId = randomUUID();
        this.sessionDisconnects = new Map();
        this.startedAt = null;
        this.connectedAt = null;
        this.clientOrigin = null;
        this.lastReplacementReason = null;
        this.compatibility = compareProtocolVersions({ appVersion: LOCAL_VERSION, protocolVersion: PROTOCOL_VERSION }, {});
        this.listening = false;
        this.lastError = null;
    }

    async start(port = this.port) {
        if (this.listening || this.lockNonce) throw new Error('Bridge already started');
        if (port !== this.port) {
            if (!this.customLockPath) this.lockPath = bridgePaths(port).lockPath;
            if (!this.customMetadataPath) this.metadataPath = bridgePaths(port).metadataPath;
        }
        this.port = port;
        this.stopped = false;
        if (port !== 0) {
            try { this.acquireLock(); } catch (error) {
                if (error.code !== 'EEXIST') throw error;
                const owner = await this.probeOwner(port);
                const compatible = owner && JSON.stringify(owner.origins) === JSON.stringify([...this.pairOrigins].sort());
                this.lastError = owner
                    ? `port ${port} owned by Actspan PID ${owner.pid} (${compatible
                        ? 'compatible protocol, but no authenticated proxy is available'
                        : 'incompatible extension allowlist'}; this PID ${process.pid})`
                    : `port ${port} locked by PID ${error.ownerPid || 'unavailable'} (owner bridge unavailable; this PID ${process.pid})`;
                throw new Error(this.lastError);
            }
        }
        return new Promise((resolve, reject) => {
            let wss;
            try { wss = new WebSocketServer({ host: '127.0.0.1', port }); } catch (error) {
                this.releaseOwnership();
                reject(error);
                return;
            }
            this.wss = wss;
            wss.once('listening', () => {
                try {
                    if (this.lockNonce) {
                        fs.mkdirSync(path.dirname(this.metadataPath), { recursive: true, mode: 0o700 });
                        this.loadPairSecretHash();
                        fs.writeFileSync(this.metadataPath, JSON.stringify({
                            pid: process.pid, nonce: this.lockNonce, protocol: OWNER_PROTOCOL,
                            port, origins: [...this.pairOrigins].sort(),
                            ...(this.pairSecretHash ? { pairSecretHash: this.pairSecretHash } : {}),
                        }), { mode: 0o600 });
                    }
                    this.listening = true;
                    this.startedAt = Date.now();
                    this.lastError = null;
                    log(`ws hub listening on ws://127.0.0.1:${wss.address().port} pid=${process.pid}`);
                    resolve();
                } catch (error) {
                    this.lastError = `port ${port}: ${error.message}`;
                    wss.close();
                    this.releaseOwnership();
                    reject(new Error(this.lastError));
                }
            });
            wss.once('error', async (error) => {
                this.listening = false;
                if (error.code === 'EADDRINUSE') {
                    const owner = await this.probeOwner(port);
                    const compatible = owner && JSON.stringify(owner.origins) === JSON.stringify([...this.pairOrigins].sort());
                    this.lastError = owner
                        ? `port ${port} owned by Actspan PID ${owner.pid} (${compatible
                            ? 'compatible protocol, but no authenticated proxy is available'
                            : 'incompatible extension allowlist'}; this PID ${process.pid})`
                        : `port ${port} occupied by incompatible or unidentified owner (owner PID unavailable; this PID ${process.pid})`;
                } else {
                    this.lastError = `port ${port}: ${error.message}`;
                }
                this.releaseOwnership();
                log('ws hub startup failed:', this.lastError);
                reject(new Error(this.lastError));
            });
            wss.on('connection', (ws, req) => this.onConnection(ws, req));
        });
    }

    acquireLock() {
        fs.mkdirSync(path.dirname(this.lockPath), { recursive: true, mode: 0o700 });
        for (let attempt = 0; attempt < 2; attempt++) {
            const nonce = randomUUID();
            try {
                fs.writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, nonce }), { flag: 'wx', mode: 0o600 });
                this.lockNonce = nonce;
                return;
            } catch (error) {
                if (error.code !== 'EEXIST') throw error;
                let owner;
                try { owner = JSON.parse(fs.readFileSync(this.lockPath, 'utf8')); } catch { throw error; }
                if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw error;
                // E1：pid 已死，或锁 mtime 超过 30s 没有心跳（持有者卡死）→ 判为崩溃残留并自愈。
                if (lockIsStale(this.lockPath)) {
                    try {
                        if (fs.readFileSync(this.lockPath, 'utf8') === JSON.stringify(owner)) fs.unlinkSync(this.lockPath);
                    } catch { /* Another process healed it first. */ }
                    continue;
                }
                error.ownerPid = owner.pid;
                throw error;
            }
        }
        throw new Error('Bridge lock changed while reclaiming stale owner');
    }

    releaseOwnership() {
        if (!this.lockNonce) return;
        for (const file of [this.metadataPath, this.lockPath]) {
            try {
                if (JSON.parse(fs.readFileSync(file, 'utf8')).nonce === this.lockNonce) fs.unlinkSync(file);
            } catch { /* Never remove another process's ownership file. */ }
        }
        this.lockNonce = null;
    }

    async stop() {
        this.clearLiveness();
        this.stopped = true;
        this.listening = false;
        this.disconnectedAt = null;
        this.sessionDisconnects.clear();
        for (const [id, pending] of this.pending) {
            this.pending.delete(id);
            pending.settle({ ok: false, error: 'Bridge stopped' });
        }
        const wss = this.wss;
        this.wss = null;
        this.client = null;
        this.clientOrigin = null;
        if (wss) {
            for (const socket of wss.clients) socket.terminate();
            await new Promise((resolve) => wss.close(resolve));
        }
        this.releaseOwnership();
    }

    close() { return this.stop(); }

    probeOwner(port) {
        return new Promise((resolve) => {
            const socket = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Origin: OWNER_PROBE_ORIGIN } });
            let settled = false;
            const finish = (owner = null) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                socket.terminate();
                resolve(owner);
            };
            const timer = setTimeout(() => finish(), 500);
            // 另一个实例通过 0600 的元数据文件读取 owner nonce，证明自己不是任意本地进程
            let nonce;
            try {
                nonce = JSON.parse(fs.readFileSync(this.metadataPath, 'utf8')).nonce;
            } catch { /* 临时端口或首次启动没有元数据 */ }
            socket.on('open', () => socket.send(JSON.stringify({
                type: 'owner.info', ...(nonce ? { nonce } : {}),
            })));
            socket.on('message', (raw) => {
                try {
                    const info = JSON.parse(raw.toString());
                    if (info.type === 'owner_info' && info.protocol === OWNER_PROTOCOL &&
                        Number.isSafeInteger(info.pid) && info.pid > 0 && Array.isArray(info.origins)) finish(info);
                } catch { finish(); }
            });
            socket.on('error', () => finish());
            socket.on('close', () => finish());
        });
    }

    static hashPairSecret(secret) {
        return createHash('sha256').update(secret).digest('hex');
    }

    verifyPairSecret(secret) {
        if (!this.pairSecretHash || !/^[a-f0-9]{64}$/.test(secret)) return false;
        const actual = Buffer.from(ExtensionHub.hashPairSecret(secret), 'hex');
        const expected = Buffer.from(this.pairSecretHash, 'hex');
        return actual.length === expected.length && timingSafeEqual(actual, expected);
    }

    loadPairSecretHash() {
        try {
            const previous = JSON.parse(fs.readFileSync(this.metadataPath, 'utf8'));
            if (typeof previous.pairSecretHash === 'string' && /^[a-f0-9]{64}$/.test(previous.pairSecretHash)) {
                this.pairSecretHash = previous.pairSecretHash;
            }
        } catch { /* 首次启动没有元数据 */ }
    }

    persistPairSecretHash() {
        if (!this.lockNonce) return;
        try {
            fs.mkdirSync(path.dirname(this.metadataPath), { recursive: true, mode: 0o700 });
            fs.writeFileSync(this.metadataPath, JSON.stringify({
                pid: process.pid, nonce: this.lockNonce, protocol: OWNER_PROTOCOL,
                port: this.port, origins: [...this.pairOrigins].sort(),
                pairSecretHash: this.pairSecretHash,
            }), { mode: 0o600 });
        } catch (error) {
            log('failed to persist pairing secret hash:', error?.message || String(error));
        }
    }

    onConnection(ws, req) {
        if (this.stopped) { ws.close(4001, 'bridge stopped'); return; }
        let ready = false;
        const origin = req?.headers?.origin || '';
        if (origin === OWNER_PROBE_ORIGIN) {
            ws.once('message', (raw) => {
                let msg;
                try { msg = JSON.parse(raw.toString()); } catch { ws.close(4000, 'bad frame'); return; }
                // owner 信息包含扩展 ID、端口与在线状态：生产端口必须证明持有 0600 owner nonce。
                // port=0 的临时实例没有所有权文件，仅用于测试，允许无 nonce 探测。
                if (msg.type !== 'owner.info' || (this.lockNonce && msg.nonce !== this.lockNonce)) {
                    ws.close(4001, 'unauthorized');
                    return;
                }
                ws.send(JSON.stringify({ type: 'owner_info', protocol: OWNER_PROTOCOL, pid: process.pid,
                    origins: [...this.pairOrigins].sort(), port: this.wss?.address()?.port,
                    connected: this.isConnected() }), () => ws.close());
            });
            return;
        }
        if (!this.allowPair(origin)) {
            ws.close(4001, 'unauthorized origin');
            return;
        }
        ws.on('message', (raw) => {
            if (this.stopped) { ws.close(4001, 'bridge stopped'); return; }
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch { ws.close(4000, 'bad frame'); return; }
            if (!ready) {
                if (msg.type === 'hello' && msg.token === this.token) {
                    // D12：Origin 白名单只证明「来自已配对的扩展」。hello 一旦自报 role 就必须自认
                    // extension；报 agent/operator 的扩展是冒充，直接断开。未声明 role 的存量帧
                    // 靠 Origin + token 兜底，按 extension 兼容放行。
                    if (msg.role !== undefined && msg.role !== 'extension') {
                        this.lastError = `extension handshake declared role=${String(msg.role)}; expected extension`;
                        log(`extension handshake rejected origin=${origin} role=${String(msg.role)}`);
                        ws.close(4001, 'extension role required');
                        return;
                    }
                    if (this.client && this.client.readyState === this.client.OPEN && this.client !== ws) {
                        this.lastReplacementReason = 'rejected duplicate extension; active owner retained';
                        ws.close(4003, 'extension already connected');
                        return;
                    }
                    this.compatibility = compareProtocolVersions(
                        { appVersion: LOCAL_VERSION, protocolVersion: PROTOCOL_VERSION }, msg);
                    if (!this.compatibility.compatible) {
                        this.lastError = this.compatibility.error;
                        ws.send(JSON.stringify({ type: 'hello_error', appVersion: LOCAL_VERSION,
                            protocolVersion: PROTOCOL_VERSION, compatibility: this.compatibility }), () =>
                            ws.close(4002, 'incompatible extension protocol'));
                        return;
                    }
                    ready = true;
                    this.watchLiveness(ws);
                    this.client = ws;
                    this.clientOrigin = origin;
                    this.connectedAt = Date.now();
                    this.lastReplacementReason = null;
                    log(`extension connected origin=${origin}`);
                    ws.send(JSON.stringify({ type: 'hello_ok', appVersion: LOCAL_VERSION,
                        protocolVersion: PROTOCOL_VERSION, compatibility: this.compatibility }));
                    this.disconnectedAt = null;
                    for (const notice of this.sessionDisconnects.values()) ws.send(JSON.stringify(notice));
                    this.sessionDisconnects.clear();
                    for (const [id, pending] of this.pending) {
                        if (pending.socket !== null) continue;
                        clearTimeout(pending.graceTimer);
                        if (Date.now() >= pending.deadline) {
                            this.pending.delete(id);
                            pending.settle({ ok: false, error: `Bridge request timed out: ${pending.method}` });
                            continue;
                        }
                        if (Date.now() >= pending.graceDeadline) {
                            this.pending.delete(id);
                            pending.settle({ ok: false, error: pending.initialQueue ? 'Bridge initial offline queue expired' : 'Bridge reconnect grace elapsed' });
                            continue;
                        }
                        pending.socket = ws;
                        try { ws.send(pending.frame); } catch {
                            this.pending.delete(id);
                            pending.settle({ ok: false, error: 'bridge disconnected' });
                        }
                    }
                } else if (msg.type === 'pair') {
                    const provided = typeof msg.pairingSecret === 'string' ? msg.pairingSecret : '';
                    if (this.pairSecretHash) {
                        if (!this.verifyPairSecret(provided)) {
                            log(`pair rejected origin=${origin} reason=missing-or-invalid-proof`);
                            ws.close(4001, 'pairing proof required');
                            return;
                        }
                        ws.send(JSON.stringify({ type: 'pair_ok', token: this.token, port: this.port }));
                        return;
                    }
                    // 首次配对：签发一次性 pairing secret；此后无证明的 pair 一律拒绝。
                    const secret = randomBytes(32).toString('hex');
                    this.pairSecretHash = ExtensionHub.hashPairSecret(secret);
                    this.persistPairSecretHash();
                    log(`pair accepted origin=${origin} reason=trust-on-first-use`);
                    ws.send(JSON.stringify({
                        type: 'pair_ok', token: this.token, port: this.port, pairingSecret: secret,
                    }));
                } else {
                    ws.close(4001, 'unauthorized');
                }
                return;
            }
            // E9：静默连接先收 ping；回 pong 的活着，不回的才 terminate。
            if (msg.type === 'pong') {
                if (ws === this.client) {
                    this.awaitingPong = false;
                    clearTimeout(this.pongTimer);
                    this.pongTimer = null;
                }
                return;
            }
            if (ws === this.client && msg.type === 'event' && msg.event?.type === 'tab_closed' &&
                Number.isSafeInteger(msg.event.tabId) && msg.event.tabId >= 0) {
                this.emit('event', { type: 'tab_closed', tabId: msg.event.tabId });
                return;
            }
            if (ws !== this.client || typeof msg.id !== 'string') return;
            const pending = this.pending.get(msg.id);
            if (!pending || pending.socket !== ws || msg.clientId !== pending.context.clientId ||
                msg.requestId !== pending.context.requestId || msg.taskId !== pending.context.taskId ||
                msg.sessionId !== pending.context.sessionId || msg.tabId !== pending.context.tabId) return;
            if (msg.type === 'audit') {
                if (!pending.audited && this.appendAudit(msg.entry, pending)) pending.audited = true;
                return;
            }
            this.pending.delete(msg.id);
            pending.settle(msg);
        });
        ws.on('close', () => {
            if (this.client !== ws) return;
            this.clearLiveness();
            this.client = null;
            this.clientOrigin = null;
            this.disconnectedAt = Date.now();
            log('extension disconnected');
            for (const [id, pending] of this.pending) {
                if (pending.socket !== ws) continue;
                this.pending.delete(id);
                pending.settle({ ok: false, error: 'bridge disconnected' });
            }
        });
    }
    /**
     * E9 探活：空闲 pingIdleMs 后发 ping，pongTimeoutMs 内不回就 terminate。
     * 只对当前 client 生效，避免把正在握手的连接误杀。
     */
    watchLiveness(ws) {
        this.clearLiveness();
        this.livenessTimer = setInterval(() => {
            if (this.client !== ws || ws.readyState !== ws.OPEN) return;
            // 已在等 pong 时不再补发：裁决权归 pongTimer，避免每次 tick 重置超时。
            if (this.awaitingPong) return;
            this.awaitingPong = true;
            try { ws.send(JSON.stringify({ type: 'ping', at: Date.now() })); } catch { this.awaitingPong = false; return; }
            this.pongTimer = setTimeout(() => {
                if (this.client !== ws || this.awaitingPong !== true) return;
                log('extension liveness probe unanswered; terminating socket');
                ws.terminate();
            }, this.pongTimeoutMs);
            this.pongTimer.unref?.();
        }, this.pingIdleMs);
        this.livenessTimer.unref?.();
    }

    clearLiveness() {
        clearInterval(this.livenessTimer);
        clearTimeout(this.pongTimer);
        this.livenessTimer = null;
        this.pongTimer = null;
        this.awaitingPong = false;
    }
    allowPair(origin) {
        return this.pairOrigins.has(origin);
    }

    sessionDisconnected(clientId, sessionId) {
        if (typeof clientId !== 'string' || typeof sessionId !== 'string' || !clientId || !sessionId) return;
        const notice = { type: 'session_disconnected', clientId, sessionId };
        if (this.isConnected()) this.client.send(JSON.stringify(notice));
        else this.sessionDisconnects.set(JSON.stringify([clientId, sessionId]), notice);
    }

    cancelRequest(id) {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.settle({ ok: false, error: 'MCP client closed' });
    }

    call(method, params = {}, timeoutMs = 60000, context = {}) {
        if (typeof timeoutMs === 'object' && timeoutMs !== null) {
            context = timeoutMs;
            timeoutMs = 60000;
        }
        const socket = this.isConnected() ? this.client : null;
        const graceDeadline = this.disconnectedAt !== null ? this.disconnectedAt + this.reconnectGraceMs
            : this.connectedAt === null && this.startedAt !== null ? this.startedAt + this.initialQueueMs : 0;
        if (!socket && (!this.listening || this.stopped || Date.now() >= graceDeadline)) {
            return Promise.reject(new Error(this.listening
                ? 'Actspan extension not connected or not allowlisted'
                : `Bridge unavailable: ${this.lastError || `port ${this.port} not listening`}`));
        }
        if (!socket && [...this.pending.values()].filter((entry) => entry.socket === null).length >= 16) {
            return Promise.reject(new Error('Bridge reconnect queue is full'));
        }
        if (context.host !== undefined && !/^[a-z0-9](?:[a-z0-9-]{0,127})$/.test(context.host)) {
            throw new Error('Invalid host identity');
        }
        const request = {
            clientId: context.clientId || this.clientId,
            requestId: context.requestId || randomUUID(),
            taskId: context.taskId || params.taskId || randomUUID(),
            sessionId: context.sessionId || params.sessionId || randomUUID(),
            tabId: params.tabId ?? params.tab_id,
            ...(context.host ? { host: context.host } : {}),
            onlineSessions: Array.isArray(context.onlineSessions) ? context.onlineSessions : [],
        };
        const decision = Policy.check(method, request);
        const id = request.requestId;
        if (this.pending.has(id)) return Promise.reject(new Error('Duplicate requestId'));
        if (this.pending.size >= MAX_PENDING_REQUESTS) return Promise.reject(new Error('Too many pending bridge requests'));
        return new Promise((resolve, reject) => {
            const deadline = Date.now() + timeoutMs;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Bridge request timed out (${timeoutMs}ms): ${method}`));
            }, timeoutMs);
            const frame = JSON.stringify({ id, method, params, context: request, policy: decision });
            const pending = {
                socket, context: request, deadline, graceDeadline, method, frame, initialQueue: this.disconnectedAt === null,
                graceTimer: null,
                settle: (msg) => {
                    clearTimeout(timer);
                    clearTimeout(pending.graceTimer);
                    if (msg.ok) resolve(msg.result);
                    else reject(new Error(msg.error || 'Bridge request failed'));
                },
            };
            this.pending.set(id, pending);
            if (!socket) {
                pending.graceTimer = setTimeout(() => {
                    if (this.pending.get(id) !== pending || pending.socket) return;
                    this.pending.delete(id);
                    pending.settle({ ok: false, error: pending.initialQueue ? 'Bridge initial offline queue expired' : 'Bridge reconnect grace elapsed' });
                }, Math.max(0, graceDeadline - Date.now()));
                return;
            }
            try { socket.send(frame); } catch (error) {
                this.pending.delete(id);
                pending.settle({ ok: false, error: `bridge disconnected: ${error.message}` });
            }
        });
    }

    appendAudit(entry, pending) {
        const hostName = (pending.context.host || (typeof entry?.host === 'string' ? entry.host : '')).slice(0, 128).toLowerCase();
        const host = !hostName ? 'unknown' : Object.hasOwn(DEFAULT_AGENTS, hostName)
            ? hostName : `host-${createHash('sha256').update(hostName).digest('hex').slice(0, 12)}`;
        const params = { redacted: true };
        for (const key of ['tabId', 'expressionChars', 'textChars']) {
            const value = entry?.params?.[key];
            if (Number.isSafeInteger(value) && value >= 0) params[key] = value;
        }
        for (const key of ['active', 'submit', 'allowSensitive', 'real']) {
            const value = entry?.params?.[key];
            if (typeof value === 'boolean') params[key] = value;
        }
        if (['html', 'text'].includes(entry?.params?.format)) params.format = entry.params.format;
        const success = entry?.effect?.success;
        const summary = entry?.effect?.summary;
        const time = Number.isSafeInteger(entry?.time) ? entry.time : Date.now();
        const line = JSON.stringify({
            time,
            host, sessionId: pending.context.sessionId, tool: pending.method, params,
            effect: { ...(typeof success === 'boolean' ? { success } : {}),
                summary: ['ok', 'denied', 'error'].includes(summary) ? summary : 'redacted' },
        }) + '\n';
        if (Buffer.byteLength(line) > 2048) return false;
        let fd;
        try {
            fs.mkdirSync(path.dirname(this.auditPath), { recursive: true, mode: 0o700 });
            fd = fs.openSync(this.auditPath, 'a', 0o600);
            fs.fchmodSync(fd, 0o600);
            fs.writeSync(fd, line);
            // K3：同一次已认证调用同时进审计与配额归因账本，身份只解析一次。
            this.usage.record({ host, tool: pending.method, sessionId: pending.context.sessionId, at: time });
            return true;
        } catch {
            log('audit write failed');
            return false;
        } finally {
            if (fd !== undefined) {
                try { fs.closeSync(fd); } catch { /* Append result is already known. */ }
            }
        }
    }

    isConnected() {
        return this.client !== null && this.client.readyState === this.client.OPEN;
    }
}

export { log };
