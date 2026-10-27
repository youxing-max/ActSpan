import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { credentialPath, ensureBridgeDaemon, readCredential } from './bridge-lock.js';

const PROTOCOL = 'actspan-bridge-rpc-v1';
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60000;
const CONNECT_TIMEOUT_MS = 1000;

const validPort = (value) => Number.isInteger(value) && value > 0 && value <= 65535;
const sortedOrigins = (origins) => [...new Set((Array.isArray(origins) ? origins : []).filter((origin) => typeof origin === 'string'))].sort();

function frame(value) {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > MAX_FRAME_BYTES - 1) throw new Error('RPC frame too large');
    return `${text}\n`;
}

function createParser(onFrame, onError) {
    let buffered = Buffer.alloc(0);
    let dead = false;
    // 出错后帧边界已不可信：清空缓冲并停收，否则旧数据会一直留在 buffered 里继续增长。
    const fail = (error) => {
        buffered = Buffer.alloc(0);
        dead = true;
        onError(error);
    };
    return (chunk) => {
        if (dead) return;
        buffered = Buffer.concat([buffered, chunk]);
        while (true) {
            const end = buffered.indexOf(10);
            if (end < 0) {
                // 只在一条完整帧都收不齐时才判超限，避免多帧合并的 chunk 被误伤。
                if (buffered.length > MAX_FRAME_BYTES) fail(new Error('RPC frame too large'));
                return;
            }
            const line = buffered.subarray(0, end);
            buffered = buffered.subarray(end + 1);
            if (!line.length) continue;
            if (line.length > MAX_FRAME_BYTES) return fail(new Error('RPC frame too large'));
            let value;
            try { value = JSON.parse(line.toString('utf8')); } catch { return fail(new Error('Invalid RPC frame')); }
            onFrame(value);
        }
    };
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }



function connectSocket(credential, options) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port: credential.rpcPort });
        let settled = false;
        let authenticated = false;
        const timer = setTimeout(() => finish(new Error('Bridge daemon connection timed out')), CONNECT_TIMEOUT_MS);
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) {
                socket.destroy();
                reject(error);
            } else resolve({ socket, value });
        };
        const parser = createParser((message) => {
            if (!authenticated) {
                if (message?.type !== 'auth_ok') return finish(new Error('Bridge daemon authentication failed'));
                authenticated = true;
                finish(null, message);
                return;
            }
            options.onMessage(message);
        }, (error) => {
            if (!settled) return finish(error);
            // 解析器已停收，连接留着只会让在途请求干等到超时：断开，由上层重连重建。
            options.onDisconnect(error);
            socket.destroy();
        });
        socket.setNoDelay(true);
        socket.on('connect', () => {
            try {
                socket.write(frame({
                    type: 'auth',
                    protocol: PROTOCOL,
                    secret: credential.secret,
                    clientId: options.clientId,
                    sessionId: options.sessionId,
                    ...(options.label ? { label: options.label } : {}),
                }));
            } catch (error) { finish(error); }
        });
        socket.on('data', parser);
        socket.on('error', (error) => {
            if (!settled) finish(error);
            else options.onDisconnect(error);
        });
        socket.on('close', () => {
            if (!settled) finish(new Error('Bridge daemon disconnected'));
            else options.onDisconnect(new Error('Bridge daemon disconnected'));
        });
    });
}


class BridgeDaemonClient {
    constructor(socket, auth, options) {
        this.socket = socket;
        this.options = options;
        this.requests = new Map();
        this.listeners = new Set();
        this.connected = true;
        this.connectedAt = auth.connectedAt || null;
        this.clientOrigin = auth.clientOrigin || null;
        this.extensionConnected = auth.extensionConnected === true;
        this.port = auth.port ?? null;
        this.listening = auth.listening === true;
        this.lastReplacementReason = auth.lastReplacementReason || null;
        this.lastError = auth.lastError || null;
        this._requestPrefix = `${randomUUID()}:`;
        this.compatibility = auth.compatibility || null;
    }

    _onMessage(message) {
        if (message?.type === 'event') {
            for (const listener of this.listeners) {
                try { listener(message.event); } catch { /* Listener errors cannot break IPC. */ }
            }
            return;
        }
        if (message?.type === 'status') {
            this._updateStatus(message.status || message);
            return;
        }
        if (message?.type !== 'result' || typeof message.id !== 'string') return;
        const pending = this.requests.get(message.id);
        if (!pending) return;
        this.requests.delete(message.id);
        if (message.ok) pending.resolve(message.result);
        else pending.reject(new Error(message.error || 'Bridge daemon request failed'));
    }

    _updateStatus(status) {
        this._status = status;
        if (Object.hasOwn(status, 'clientOrigin')) this.clientOrigin = status.clientOrigin;
        if (Object.hasOwn(status, 'extensionConnected')) this.extensionConnected = status.extensionConnected === true;
        if (Object.hasOwn(status, 'port')) this.port = status.port ?? null;
        if (Object.hasOwn(status, 'listening')) this.listening = status.listening;
        if (Object.hasOwn(status, 'lastReplacementReason')) this.lastReplacementReason = status.lastReplacementReason;
        if (Object.hasOwn(status, 'lastError')) this.lastError = status.lastError;
        if (Object.hasOwn(status, 'compatibility')) this.compatibility = status.compatibility;
    }
    async status() {
        const value = await this.call('status.get', {}, 5000);
        this._updateStatus(value);
        return value;
    }

    isConnected() { return this.connected && !this.socket.destroyed; }

    call(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS, context = {}) {
        if (typeof timeoutMs === 'object' && timeoutMs !== null) {
            context = timeoutMs;
            timeoutMs = DEFAULT_TIMEOUT_MS;
        }
        if (!this.isConnected()) return Promise.reject(new Error('Bridge daemon disconnected'));
        const id = `${this._requestPrefix}${randomUUID()}`;
        const timeout = Math.max(1, Math.min(Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS, 300000));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.requests.delete(id);
                reject(new Error(`Bridge request timed out (${timeout}ms): ${method}`));
            }, timeout);
            this.requests.set(id, {
                resolve: (value) => { clearTimeout(timer); resolve(value); },
                reject: (error) => { clearTimeout(timer); reject(error); },
            });
            try {
                this.socket.write(frame({ type: 'call', id, method, params, timeoutMs: timeout, context }));
            } catch (error) {
                clearTimeout(timer);
                this.requests.delete(id);
                reject(error);
            }
        });
    }

    on(event, listener) {
        if (event !== 'event' || typeof listener !== 'function') return this;
        this.listeners.add(listener);
        return this;
    }

    _disconnect(error = new Error('Bridge daemon disconnected')) {
        if (!this.connected) return;
        this.connected = false;
        this.lastError = error.message;
        for (const pending of this.requests.values()) pending.reject(error);
        this.requests.clear();
        this.socket.destroy();
    }

    stop() { this._disconnect(new Error('Bridge daemon IPC client stopped')); }

    async shutdown() {
        if (!this.isConnected()) return;
        await this.call('status.shutdown', {}, 5000);
        this.stop();
    }
}

/**
 * K2：label 只在认证帧里发一次，连上之后不可改。所以身份必须在连桥**之前**定好，
 * 调用方先 await `ensureBridgeDaemon`（daemon 与元数据先就位），再调这里。
 */
export async function connectBridgeDaemonClient({ port, pairOrigins = [], clientId, sessionId, label } = {}) {
    if (!validPort(port)) throw new Error('Invalid bridge port');
    if (typeof clientId !== 'string' || !clientId || typeof sessionId !== 'string' || !sessionId) {
        throw new Error('clientId and sessionId are required');
    }
    const options = { clientId, sessionId, label, onMessage: () => {}, onDisconnect: () => {} };
    const credential = readCredential(port);
    if (!credential) throw new Error(`Bridge daemon is not ready on port ${port}`);
    if (JSON.stringify(sortedOrigins(credential.origins)) !== JSON.stringify(sortedOrigins(pairOrigins))) {
        throw new Error(`Bridge port ${port} is owned by an incompatible extension allowlist`);
    }
    let client;
    const connection = await connectSocket(credential, {
        ...options,
        onMessage: (message) => client?._onMessage(message),
        onDisconnect: (error) => client?._disconnect(error),
    });
    client = new BridgeDaemonClient(connection.socket, connection.value, options);
    return client;
}

/** E1：单例 daemon 由 bridge-lock 统一仲裁（抢锁 / 轮询 / 残留自愈），这里只负责连上它。 */
export async function connectBridgeDaemon(options = {}) {
    await ensureBridgeDaemon({ port: options.port, pairOrigins: options.pairOrigins });
    return connectBridgeDaemonClient(options);
}

export function createLazyBridgeDaemonClient(options = {}) {
    let client = null;
    let pending = null;
    let stopped = false;
    const listeners = [];
    const connect = () => {
        if (stopped) return Promise.reject(new Error('Bridge daemon IPC client stopped'));
        if (client?.isConnected()) return Promise.resolve(client);
        if (pending) return pending;
        pending = connectBridgeDaemonClient(options).then((value) => {
            if (stopped) {
                value.stop();
                throw new Error('Bridge daemon IPC client stopped');
            }
            client = value;
            for (const [event, listener] of listeners) value.on(event, listener);
            return value;
        }).finally(() => { pending = null; });
        return pending;
    };
    // Reconnect only for a new call; a disconnected in-flight write must never be replayed.
    const require = () => connect();
    return {
        connect,
        /** K2：连上之后 label 冻结，改口只能发生在连桥之前。 */
        get label() { return options.label ?? ''; },
        set label(value) {
            if (client) throw new Error('Bridge label is frozen once connected');
            options.label = value;
        },
        set sessionId(value) {
            if (client) throw new Error('Bridge sessionId is frozen once connected');
            options.sessionId = value;
        },
        get connectedAt() { return client?.connectedAt ?? null; },
        get clientOrigin() { return client?.clientOrigin ?? null; },
        get lastReplacementReason() { return client?.lastReplacementReason ?? null; },
        get compatibility() { return client?.compatibility ?? null; },
        get extensionConnected() { return client?.extensionConnected === true; },
        get listening() { return client?.listening === true; },
        get port() { return client?.port ?? options.port ?? null; },
        get lastError() { return client?.lastError ?? null; },
        isConnected: () => Boolean(client?.isConnected()),
        call: async (...args) => (await require()).call(...args),
        status: async (...args) => (await require()).status(...args),
        // 注册监听不触发连接：身份定好之前不该连桥。
        on: (event, listener) => { listeners.push([event, listener]); return undefined; },
        stop: () => { stopped = true; client?.stop(); },
        shutdown: async () => { stopped = true; if (client) await client.shutdown(); },
    };
}

export { credentialPath, MAX_FRAME_BYTES };
