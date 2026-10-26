import { VERSION } from '../config';

const DEFAULT_PORT = 30121;
const PROTOCOL_VERSION = 1;
const MAX_BACKOFF_MS = 30_000;

// offscreen 文档只有 chrome.runtime，设置读写与变更通知都得经 service worker 中转。
export const SETTINGS_GET_MESSAGE = 'actspan_mcp_settings_get';
export const SETTINGS_SET_AUTO_MESSAGE = 'actspan_mcp_settings_set_auto';
export const SETTINGS_CHANGED_MESSAGE = 'actspan_mcp_settings_changed';

export const MCP_RUNTIME_REQUEST = 'actspan_mcp_request';
export const MCP_RUNTIME_RESPONSE = 'actspan_mcp_response';
export const MCP_RUNTIME_AUDIT = 'actspan_mcp_audit';

export interface McpRequestContext {
    clientId: string;
    requestId: string;
    taskId: string;
    sessionId: string;
    tabId?: number;
    host?: string;
    onlineSessions?: Array<{ clientId: string; sessionId: string; label?: string }>;
}

export interface McpRequestFrame {
    id: string;
    method: string;
    params?: Record<string, unknown>;
    context: McpRequestContext;
    [key: string]: unknown;
}

interface BridgeSettings {
    enabled?: boolean;
    port?: number;
    token?: string;
}

interface AutoPairing {
    port?: number;
    token?: string;
    /** 首次配对时 bridge 签发的证明；bridge 重启或重新配对时必须带回 */
    pairingSecret?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const validIdentity = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= 256;

/** Keep the six-tuple owned by the authenticated extension request intact. */
export const isOwnedRequestFrame = (value: unknown): value is McpRequestFrame => {
    if (!isRecord(value) || !validIdentity(value.id) || typeof value.method !== 'string' || !value.method) return false;
    const context = value.context;
    if (!isRecord(context)) return false;
    if (![context.clientId, context.requestId, context.taskId, context.sessionId].every(validIdentity)) return false;
    if (value.id !== context.requestId) return false;
    // isRecord 只给到 unknown：Number.isInteger 不是类型守卫，必须先自己收窄成 number。
    if (context.tabId !== undefined && (typeof context.tabId !== 'number' || !Number.isInteger(context.tabId) || context.tabId <= 0)) return false;
    if (context.host !== undefined && !validIdentity(context.host)) return false;
    if (context.onlineSessions !== undefined && (!Array.isArray(context.onlineSessions) || context.onlineSessions.some((session) =>
        !isRecord(session) || !validIdentity(session.clientId) || !validIdentity(session.sessionId) ||
        (session.label !== undefined && !validIdentity(session.label))))) return false;
    if (value.params !== undefined && !isRecord(value.params)) return false;
    return true;
};

/** Exponential reconnect with a bounded ceiling; exported for deterministic tests. */
export const nextReconnectDelay = (previousMs: number): number =>
    Math.min(Math.max(1_000, previousMs) * 2, MAX_BACKOFF_MS);

const sendRuntimeMessage = (message: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message || 'Service worker unavailable'));
        else resolve(response);
    });
});

class McpOffscreenTransport {
    private reportStatus(status: string, details: Record<string, unknown> = {}): void {
        void sendRuntimeMessage({ type: 'actspan_mcp_transport_event', status, ...details }).catch(() => undefined);
    }
    private socket: WebSocket | null = null;
    private connecting = false;
    private authenticated = false;
    private started = false;
    private backoffMs = 1_000;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private autoToken: string | null = null;
    private autoPort: number | undefined;
    private autoPairingSecret: string | null = null;
    private readonly pending = new Map<string, WebSocket>();

    start(): void {
        if (this.started) return;
        this.started = true;
        this.backoffMs = 1_000;
        chrome.runtime.onMessage.addListener(this.onRuntimeMessage);
        void this.connect();
    }

    stop(): void {
        if (!this.started) return;
        this.started = false;
        chrome.runtime.onMessage.removeListener(this.onRuntimeMessage);
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.pending.clear();
        const socket = this.socket;
        this.socket = null;
        this.authenticated = false;
        this.connecting = false;
        try { socket?.close(); } catch { /* already closed */ }
    }

    private readonly onRuntimeMessage = (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
        if (sender.id && sender.id !== chrome.runtime.id) return false;
        if (!isRecord(message) || typeof message.type !== 'string') return false;
        if (this.onSettingsChanged(message)) { sendResponse({ accepted: true }); return false; }
        if (message.type === MCP_RUNTIME_RESPONSE || message.type === MCP_RUNTIME_AUDIT) {
            const frame = isRecord(message.frame)
                ? message.frame
                : Object.fromEntries(Object.entries(message).filter(([key]) => key !== 'type'));
            if (message.type === MCP_RUNTIME_RESPONSE) {
                const requestId = typeof frame.id === 'string' ? frame.id
                    : typeof frame.requestId === 'string' ? frame.requestId : undefined;
                if (!requestId) return false;
                const socket = this.pending.get(requestId);
                if (!socket || socket !== this.socket) return false;
                this.pending.delete(requestId);
                this.send(socket, { ...frame, id: requestId });
            } else if (message.type === MCP_RUNTIME_AUDIT) {
                this.send(this.socket, frame);
            }
            sendResponse({ delivered: true });
            return false;
        }
        if (message.type === 'actspan_mcp_event') {
            const frame = isRecord(message.frame) ? message.frame : undefined;
            if (frame) this.send(this.socket, frame);
            sendResponse({ delivered: true });
            return false;
        }
        if (message.type === 'actspan_mcp_transport_status') {
            sendResponse({ connected: this.authenticated && this.socket?.readyState === WebSocket.OPEN });
            return false;
        }
        return false;
    };

    /** 设置变更由 service worker 转发：offscreen 文档拿不到 chrome.storage。 */
    private readonly onSettingsChanged = (message: unknown): boolean => {
        if (!isRecord(message) || message.type !== SETTINGS_CHANGED_MESSAGE) return false;
        this.autoToken = null;
        this.autoPort = undefined;
        this.backoffMs = 1_000;
        this.reconnectTimer && clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        const socket = this.socket;
        this.socket = null;
        this.authenticated = false;
        this.connecting = false;
        this.pending.clear();
        try { socket?.close(); } catch { /* already closed */ }
        void this.connect();
        return true;
    };

    /**
     * offscreen 文档里只有 chrome.runtime 可用（官方限制：runtime 是唯一对 offscreen 开放的
     * 扩展 API），所以设置必须向 service worker 要，不能直接读 chrome.storage。
     */
    private async getSettings(): Promise<{ settings: BridgeSettings; auto: AutoPairing }> {
        const response = await sendRuntimeMessage({ type: SETTINGS_GET_MESSAGE });
        if (!isRecord(response)) return { settings: {}, auto: {} };
        return {
            settings: isRecord(response.settings) ? response.settings as BridgeSettings : {},
            auto: isRecord(response.auto) ? response.auto as AutoPairing : {},
        };
    }

    private scheduleReconnect(): void {
        if (!this.started || this.reconnectTimer) return;
        const delay = this.backoffMs;
        this.backoffMs = nextReconnectDelay(this.backoffMs);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            void this.connect();
        }, delay);
    }

    private send(socket: WebSocket | null, frame: Record<string, unknown>): void {
        if (socket && socket === this.socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(frame));
        }
    }

    private failForward(socket: WebSocket, frame: McpRequestFrame): void {
        if (this.pending.get(frame.id) !== socket || socket !== this.socket) return;
        this.pending.delete(frame.id);
        this.send(socket, {
            id: frame.id,
            ...frame.context,
            ok: false,
            error: '背景服务暂不可用，请重试',
        });
    }

    private async connect(): Promise<void> {
        if (!this.started || this.connecting || this.socket) return;
        let settings: BridgeSettings;
        let auto: AutoPairing;
        try {
            ({ settings, auto } = await this.getSettings());
        } catch {
            this.scheduleReconnect();
            return;
        }
        if (settings.enabled === false) return;
        const port = Number.isInteger(settings.port) && settings.port! > 0 ? settings.port! : DEFAULT_PORT;
        if (!settings.token && auto.port === port && typeof auto.token === 'string') {
            this.autoToken = auto.token;
            this.autoPort = port;
        }
        this.autoPairingSecret = auto.port === port && typeof auto.pairingSecret === 'string'
            ? auto.pairingSecret
            : null;
        const token = settings.token || (this.autoPort === port ? this.autoToken : null);
        this.connecting = true;
        let socket: WebSocket;
        try {
            socket = new WebSocket(`ws://127.0.0.1:${port}`);
            this.socket = socket;
        } catch {
            this.connecting = false;
            this.scheduleReconnect();
            return;
        }
        socket.onopen = () => {
            if (this.socket !== socket) return;
            this.connecting = false;
            socket.send(JSON.stringify(token
                ? { type: 'hello', role: 'extension', token, appVersion: VERSION, protocolVersion: PROTOCOL_VERSION }
                : {
                    type: 'pair', role: 'extension', appVersion: VERSION, protocolVersion: PROTOCOL_VERSION,
                    ...(this.autoPairingSecret ? { pairingSecret: this.autoPairingSecret } : {}),
                }));
        };
        socket.onmessage = (event) => { void this.onSocketMessage(socket, event.data, port, settings); };
        socket.onclose = (event) => {
            if (this.socket !== socket) return;
            this.pending.forEach((pendingSocket, id) => { if (pendingSocket === socket) this.pending.delete(id); });
            this.socket = null;
            this.connecting = false;
            this.authenticated = false;
            this.reportStatus('disconnected');
            if (event.code === 4001 && token && !settings.token) {
                // 令牌失效不代表配对证明失效；重新配对仍需原证明。
                this.autoToken = null;
                this.autoPort = undefined;
                void sendRuntimeMessage({
                    type: SETTINGS_SET_AUTO_MESSAGE,
                    value: this.autoPairingSecret ? { port, pairingSecret: this.autoPairingSecret } : {},
                }).catch(() => undefined);
            }
            void this.getSettings().then(({ settings: current }) => {
                if (this.started && current.enabled !== false) this.scheduleReconnect();
            });
        };
        socket.onerror = () => {
            try { socket.close(); } catch { /* already closing */ }
        };
    }

    private async onSocketMessage(socket: WebSocket, data: unknown, port: number, settings: BridgeSettings): Promise<void> {
        if (this.socket !== socket) return;
        let message: unknown;
        try { message = JSON.parse(String(data)); } catch { return; }
        if (!isRecord(message)) return;
        if (message.type === 'pair_ok' && typeof message.token === 'string' && !this.authenticated) {
            this.autoToken = message.token;
            this.autoPort = port;
            if (typeof message.pairingSecret === 'string' && message.pairingSecret) {
                this.autoPairingSecret = message.pairingSecret;
            }
            // 配对令牌由 service worker 落盘：offscreen 文档没有 chrome.storage。
            void sendRuntimeMessage({
                type: SETTINGS_SET_AUTO_MESSAGE,
                value: {
                    port, token: message.token, pairedAt: Date.now(),
                    ...(this.autoPairingSecret ? { pairingSecret: this.autoPairingSecret } : {}),
                },
            }).catch(() => undefined);
            socket.send(JSON.stringify({ type: 'hello', role: 'extension', token: message.token, appVersion: VERSION, protocolVersion: PROTOCOL_VERSION }));
            return;
        }
        if (message.type === 'hello_ok') {
            const peerProtocol = message.protocolVersion;
            if (peerProtocol !== undefined && peerProtocol !== PROTOCOL_VERSION) {
                this.reportStatus('incompatible_protocol', { protocolVersion: peerProtocol });
                try { socket.close(1002, 'incompatible protocol'); } catch { /* already closing */ }
                return;
            }
            if (message.compatibility === false) {
                this.reportStatus('incompatible_peer', { appVersion: message.appVersion });
                try { socket.close(1002, 'incompatible peer'); } catch { /* already closing */ }
                return;
            }
            if (typeof message.appVersion === 'string' && VERSION && message.appVersion !== VERSION) {
                this.reportStatus('version_warning', { appVersion: message.appVersion });
            }
            this.authenticated = true;
            this.backoffMs = 1_000;
            this.reportStatus('connected', { appVersion: message.appVersion, protocolVersion: peerProtocol });
            return;
        }
        // E9 探活：桥发 ping，扩展必须回 pong，否则桥会在 pongTimeoutMs 后 terminate。
        if (message.type === 'ping') {
            try { socket.send(JSON.stringify({ type: 'pong', at: Date.now() })); } catch { /* closing */ }
            return;
        }
        if (this.authenticated && typeof message.type === 'string') {
            void sendRuntimeMessage({ type: 'actspan_mcp_socket_event', frame: message }).catch(() => undefined);
            return;
        }
        if (!this.authenticated || !isOwnedRequestFrame(message)) return;
        this.pending.set(message.id, socket);
        try {
            await sendRuntimeMessage({ type: MCP_RUNTIME_REQUEST, frame: message });
        } catch {
            this.failForward(socket, message);
        }
        if (settings.enabled === false) {
            this.pending.delete(message.id);
        }
    }
}

export const mcpOffscreenTransport = new McpOffscreenTransport();
export const startMcpTransport = (): void => mcpOffscreenTransport.start();
export const stopMcpTransport = (): void => mcpOffscreenTransport.stop();
if (typeof chrome !== 'undefined' && chrome.runtime) startMcpTransport();
