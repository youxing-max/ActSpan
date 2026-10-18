import { Policy } from './policy.js';
import { randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOG_FILE = process.env.ACTSPAN_MCP_LOG || path.join(os.homedir(), '.actspan', 'mcp-server.log');

function log(...a) {
    try {
        fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
        fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [actspan-mcp] ${a.map(redact).join(' ')}\n`);
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


export class ExtensionHub {
    constructor(token, { port = 30121, pairOrigins = [] } = {}) {
        this.token = token || randomUUID().replaceAll('-', '');
        this.port = port;
        this.pairOrigins = new Set(pairOrigins.filter((origin) => /^chrome-extension:\/\/[a-p]{32}$/.test(origin)));
        this.client = null;
        this.pending = new Map();
        this.clientId = randomUUID();
        this.connectedAt = null;
        this.clientOrigin = null;
        this.lastReplacementReason = null;
        this.listening = false;
        this.lastError = null;
    }

    start(port = this.port) {
        this.port = port;
        return new Promise((resolve, reject) => {
            const wss = new WebSocketServer({ host: '127.0.0.1', port });
            this.wss = wss;
            wss.once('listening', () => {
                this.listening = true;
                this.lastError = null;
                log(`ws hub listening on ws://127.0.0.1:${wss.address().port} pid=${process.pid}`);
                resolve();
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
                log('ws hub startup failed:', this.lastError);
                reject(new Error(this.lastError));
            });
            wss.on('connection', (ws, req) => this.onConnection(ws, req));
        });
    }

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
            socket.on('open', () => socket.send(JSON.stringify({ type: 'owner.info' })));
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

    onConnection(ws, req) {
        let ready = false;
        const origin = req?.headers?.origin || '';
        if (origin === OWNER_PROBE_ORIGIN) {
            ws.once('message', (raw) => {
                let msg;
                try { msg = JSON.parse(raw.toString()); } catch { ws.close(4000, 'bad frame'); return; }
                if (msg.type !== 'owner.info') { ws.close(4001, 'unauthorized'); return; }
                ws.send(JSON.stringify({ type: 'owner_info', protocol: OWNER_PROTOCOL, pid: process.pid,
                    origins: [...this.pairOrigins].sort(), port: this.wss.address()?.port }), () => ws.close());
            });
            return;
        }
        if (!this.allowPair(origin)) {
            ws.close(4001, 'unauthorized origin');
            return;
        }
        ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch { ws.close(4000, 'bad frame'); return; }
            if (!ready) {
                if (msg.type === 'hello' && msg.token === this.token) {
                    if (this.client && this.client.readyState === this.client.OPEN && this.client !== ws) {
                        this.lastReplacementReason = 'rejected duplicate extension; active owner retained';
                        ws.close(4003, 'extension already connected');
                        return;
                    }
                    ready = true;
                    this.client = ws;
                    this.clientOrigin = origin;
                    this.connectedAt = Date.now();
                    this.lastReplacementReason = null;
                    log(`extension connected origin=${origin}`);
                    ws.send(JSON.stringify({ type: 'hello_ok' }));
                } else if (msg.type === 'pair') {
                    ws.send(JSON.stringify({ type: 'pair_ok', token: this.token, port: this.port }));
                } else {
                    ws.close(4001, 'unauthorized');
                }
                return;
            }
            if (ws !== this.client || typeof msg.id !== 'string') return;
            const pending = this.pending.get(msg.id);
            if (!pending || pending.socket !== ws || msg.clientId !== pending.context.clientId ||
                msg.requestId !== pending.context.requestId || msg.taskId !== pending.context.taskId ||
                msg.sessionId !== pending.context.sessionId || msg.tabId !== pending.context.tabId) return;
            this.pending.delete(msg.id);
            pending.settle(msg);
        });
        ws.on('close', () => {
            if (this.client !== ws) return;
            this.client = null;
            this.clientOrigin = null;
            log('extension disconnected');
            for (const [id, pending] of this.pending) {
                if (pending.socket !== ws) continue;
                this.pending.delete(id);
                pending.settle({ ok: false, error: 'bridge disconnected' });
            }
        });
    }

    allowPair(origin) {
        return this.pairOrigins.has(origin);
    }

    call(method, params = {}, timeoutMs = 60000, context = {}) {
        if (typeof timeoutMs === 'object' && timeoutMs !== null) {
            context = timeoutMs;
            timeoutMs = 60000;
        }
        if (!this.client || this.client.readyState !== this.client.OPEN) {
            return Promise.reject(new Error(this.listening
                ? 'Actspan extension not connected or not allowlisted'
                : `Bridge unavailable: ${this.lastError || `port ${this.port} not listening`}`));
        }
        const socket = this.client;
        const request = {
            clientId: context.clientId || this.clientId,
            requestId: context.requestId || randomUUID(),
            taskId: context.taskId || params.taskId || randomUUID(),
            sessionId: context.sessionId || params.sessionId || randomUUID(),
            tabId: params.tabId,
        };
        const decision = Policy.check(method, request);
        const id = request.requestId;
        if (this.pending.has(id)) return Promise.reject(new Error('Duplicate requestId'));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Bridge request timed out (${timeoutMs}ms): ${method}`));
            }, timeoutMs);
            this.pending.set(id, {
                socket, context: request,
                settle: (msg) => {
                    clearTimeout(timer);
                    if (msg.ok) resolve(msg.result);
                    else reject(new Error(msg.error || 'Bridge request failed'));
                },
            });
            try {
                socket.send(JSON.stringify({ id, method, params, context: request, policy: decision }));
            } catch (error) {
                this.pending.delete(id);
                clearTimeout(timer);
                reject(error);
            }
        });
    }

    isConnected() {
        return this.client !== null && this.client.readyState === this.client.OPEN;
    }
}

export { log };
