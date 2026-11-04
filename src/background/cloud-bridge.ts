/**
 * Cloud Bridge：云端 MCP 桥接（token 隔离模式）
 *
 * 把扩展内的 MCPServer 通过 WebSocket 暴露给统一云端。
 * 多用户共享同一云端，通过 token 完成调用隔离：云端按 token 把每条连接绑定到用户，
 * 云端大脑（Agent）按 token 路由 tools/call 到对应用户的浏览器。
 *
 * 配置存于 chrome.storage.local['actspan_cloud_bridge_settings']：
 *   { enabled: boolean, serverUrl: string, token: string }
 * 实际连接 URL 由扩展拼接：<serverUrl>?token=<encodeURIComponent(token)>
 *
 * 鉴权失败约定：
 *   云端校验 token 失败时，必须以 close code 4001 关闭连接（reason 任意）。
 *   扩展收到 4001 后停止重连，状态标记为「token 无效」，直到用户修改配置。
 *
 * 协议（JSON-RPC 2.0 over WebSocket）：
 *   云端 → 扩展  {"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}
 *   扩展 → 云端  {"jsonrpc":"2.0","id":1,"result":{"tools":[...]}}
 *   云端 → 扩展  {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"page","arguments":{...}}}
 *   扩展 → 云端  {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"..."}],"isError":false}}
 *   错误          {"jsonrpc":"2.0","id":2,"error":{"code":-32603,"message":"..."}}
 *   扩展启动通知   {"jsonrpc":"2.0","method":"notifications/ready","params":{"version":"...","toolCount":N}}
 *   云端心跳      {"jsonrpc":"2.0","method":"notifications/ping"} → 扩展回 notifications/pong
 */

import { VERSION } from '../config';
import Channel from '../lib/channel';
import _console from '../lib/console';
import { mcpClient, ensureToolRegistryReady } from '../functions/registry';
import { acquireServiceWorkerKeepAlive } from './service-worker-keepalive';

// ============ 常量 ============

/** chrome.storage.local 配置键 */
export const CLOUD_BRIDGE_SETTINGS_KEY = 'actspan_cloud_bridge_settings';
/** 默认云端服务器地址（用户未配置时的回退值） */
export const DEFAULT_CLOUD_SERVER_URL = 'ws://actspan.chenyang-zhang.devbox.in.chaitin.net:8787/ws';
/** 重连间隔（ms） */
const RECONNECT_DELAY_MS = 2500;
/** 云端约定的鉴权失败 close code（私有段 4000-4999） */
export const CLOSE_CODE_AUTH_FAILED = 4001;
/** 频道消息：读取连接状态 */
const STATUS_GET_MESSAGE = '__cloud_bridge_status_get';
/** 频道消息：状态变更广播 */
const STATUS_CHANGED_MESSAGE = '__cloud_bridge_status_changed';

// ============ 类型 ============

export interface CloudBridgeSettings {
    /** 是否启用云端桥接 */
    enabled: boolean;
    /** 云端服务器地址（不含 query），如 ws://your-cloud.com:8787/ws */
    serverUrl: string;
    /** 用户 token（云端分配，云端按 token 隔离用户） */
    token: string;
}

/** 状态码：connected 已连接 / connecting 连接中 / disconnected 未连接 / auth_failed token 无效 */
export type CloudBridgeConnState = 'connected' | 'connecting' | 'disconnected' | 'auth_failed' | 'disabled';

export interface CloudBridgeStatus {
    /** 配置是否启用 */
    enabled: boolean;
    /** 当前连接状态 */
    state: CloudBridgeConnState;
    /** 服务器地址（不含 token） */
    serverUrl: string;
    /** 是否配置了 token（不回传 token 本体，防泄漏） */
    hasToken: boolean;
    /** 最近一次错误描述（无错误为 null） */
    lastError: string | null;
    /** 最近一次连接成功时间戳（ms，未连接过为 null） */
    lastConnectedAt: number | null;
}

// ============ 内部状态 ============

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let connState: CloudBridgeConnState = 'disabled';
let lastError: string | null = null;
let lastConnectedAt: number | null = null;
let started = false;

// 云端连接是长连接：启用期间常驻保活，防止 MV3 SW 空闲挂起导致 WS 反复断连(1006/1001)
let keepAliveRelease: (() => void) | null = null;
const ensureKeepAlive = (): void => {
    if (!keepAliveRelease) keepAliveRelease = acquireServiceWorkerKeepAlive();
};
const stopKeepAlive = (): void => {
    if (keepAliveRelease) { keepAliveRelease(); keepAliveRelease = null; }
};

// ============ 配置读写 ============

/** 读取云端桥接配置；未配置返回 null */
export const readCloudBridgeSettings = async (): Promise<CloudBridgeSettings | null> => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return null;
    return new Promise((resolve) => {
        chrome.storage.local.get([CLOUD_BRIDGE_SETTINGS_KEY], (result) => {
            const raw = result?.[CLOUD_BRIDGE_SETTINGS_KEY];
            const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
            const serverUrl = (typeof obj.serverUrl === 'string' ? obj.serverUrl.trim() : '') || DEFAULT_CLOUD_SERVER_URL;
            const token = typeof obj.token === 'string' ? obj.token.trim() : '';
            const enabled = obj.enabled === true;
            resolve({ enabled, serverUrl, token });
        });
    });
};

/** 保存云端桥接配置 */
export const saveCloudBridgeSettings = async (settings: CloudBridgeSettings): Promise<void> => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    return new Promise((resolve) => {
        chrome.storage.local.set({ [CLOUD_BRIDGE_SETTINGS_KEY]: settings }, () => resolve());
    });
};

/** 拼接完整连接 URL：serverUrl?token=xxx；serverUrl 已有 query 时用 & 拼接 */
const buildConnectUrl = (serverUrl: string, token: string): string => {
    const u = new URL(serverUrl);
    if (token) u.searchParams.set('token', token);
    return u.toString();
};

// ============ 状态查询 ============

const getStatus = async (): Promise<CloudBridgeStatus> => {
    const settings = await readCloudBridgeSettings();
    return {
        enabled: settings?.enabled === true,
        state: connState,
        serverUrl: settings?.serverUrl || '',
        hasToken: Boolean(settings?.token),
        lastError,
        lastConnectedAt,
    };
};

const setState = (next: CloudBridgeConnState, error: string | null = null) => {
    const changed = connState !== next || lastError !== error;
    connState = next;
    lastError = error;
    if (changed) broadcastStatus();
};

const broadcastStatus = () => {
    void getStatus().then((status) => {
        try {
            Channel.broadcast(STATUS_CHANGED_MESSAGE, status);
        } catch {
            /* 广播失败不致命 */
        }
    });
};

// ============ 消息处理 ============

interface JsonRpcRequest {
    jsonrpc?: string;
    id?: string | number | null;
    method?: string;
    params?: unknown;
}

const sendFrame = (frame: Record<string, unknown>) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
        ws.send(JSON.stringify(frame));
    } catch (err) {
        _console.warn('[cloud-bridge] 发送帧失败:', err);
    }
};

const sendResult = (id: string | number | null, result: unknown) => {
    sendFrame({ jsonrpc: '2.0', id, result });
};

const sendError = (id: string | number | null, code: number, message: string) => {
    sendFrame({ jsonrpc: '2.0', id, error: { code, message } });
};

/** 把一帧 JSON-RPC 请求路由到本地 MCPServer */
const handleRequest = async (frame: JsonRpcRequest) => {
    const id = frame.id ?? null;
    const method = frame.method;
    if (!method || typeof method !== 'string') {
        if (id !== null) sendError(id, -32600, 'Invalid Request: missing method');
        return;
    }

    // 通知类帧：无 id，不需要响应
    if (id === null || id === undefined) {
        if (method === 'notifications/ping') {
            sendFrame({ jsonrpc: '2.0', method: 'notifications/pong', params: { ts: Date.now() } });
        }
        return;
    }

    if (method !== 'tools/list' && method !== 'tools/call') {
        sendError(id, -32601, `Method not found: ${method}`);
        return;
    }

    try {
        await ensureToolRegistryReady();
        if (method === 'tools/list') {
            const tools = await mcpClient.listTools();
            sendResult(id, { tools });
            return;
        }
        // tools/call
        const params = (frame.params || {}) as { name?: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> };
        if (typeof params.name !== 'string' || !params.name) {
            sendError(id, -32602, 'tools/call 缺少 name 字段');
            return;
        }
        const result = await mcpClient.callTool(
            params.name,
            (params.arguments && typeof params.arguments === 'object') ? params.arguments : {},
            params._meta as Record<string, unknown> | undefined,
        );
        sendResult(id, result);
    } catch (err: any) {
        sendError(id, -32603, err?.message || '工具执行出错');
    }
};

// ============ 连接管理 ============

const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
};

const scheduleReconnect = () => {
    if (reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect();
    }, RECONNECT_DELAY_MS);
};

const disconnect = () => {
    clearReconnectTimer();
    const socket = ws;
    ws = null;
    if (socket) {
        try {
            socket.onopen = null;
            socket.onmessage = null;
            socket.onclose = null;
            socket.onerror = null;
            socket.close();
        } catch {
            /* 忽略关闭异常 */
        }
    }
};

const connect = async () => {
    const settings = await readCloudBridgeSettings();
    if (!settings || !settings.enabled || !settings.serverUrl || !settings.token) {
        disconnect();
        stopKeepAlive();
        setState('disabled', null);
        return;
    }
    // 启用期间常驻保活，避免 SW 空闲挂起把长连接打死
    ensureKeepAlive();
    // 已连接或正在连接时直接复用
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    // 校验服务器地址
    let serverUrl: URL;
    try {
        serverUrl = new URL(settings.serverUrl);
        if (serverUrl.protocol !== 'wss:' && serverUrl.protocol !== 'ws:') {
            throw new Error(`仅支持 ws:// 或 wss://，当前: ${serverUrl.protocol}`);
        }
    } catch (err: any) {
        setState('disconnected', `服务器地址非法: ${err?.message || '未知错误'}`);
        _console.warn('[cloud-bridge] 服务器地址非法:', settings.serverUrl);
        return;
    }

    const connectUrl = buildConnectUrl(settings.serverUrl, settings.token);
    setState('connecting', null);
    _console.log(`[cloud-bridge] 正在连接 ${serverUrl.origin}${serverUrl.pathname} (token 长度 ${settings.token.length})`);

    let socket: WebSocket;
    try {
        socket = new WebSocket(connectUrl);
    } catch (err: any) {
        setState('disconnected', `WebSocket 构造失败: ${err?.message || '未知错误'}`);
        _console.warn('[cloud-bridge]', lastError);
        scheduleReconnect();
        return;
    }
    ws = socket;

    socket.onopen = () => {
        lastConnectedAt = Date.now();
        setState('connected', null);
        _console.log('[cloud-bridge] 已连接');
        // 主动通知云端：扩展就绪
        void (async () => {
            try {
                await ensureToolRegistryReady();
                const tools = await mcpClient.listTools();
                sendFrame({
                    jsonrpc: '2.0',
                    method: 'notifications/ready',
                    params: { version: VERSION, toolCount: tools.length },
                });
            } catch (err) {
                _console.warn('[cloud-bridge] 发送 ready 通知失败:', err);
            }
        })();
    };

    socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        let frame: JsonRpcRequest;
        try {
            frame = JSON.parse(event.data);
        } catch {
            sendError(null, -32700, 'Parse error');
            return;
        }
        void handleRequest(frame);
    };

    socket.onerror = () => {
        // 错误细节由 onclose 处理；这里只标记一下，避免 onclose 拿到空 reason
        if (!lastError) lastError = 'WebSocket 连接错误';
    };

    socket.onclose = (event) => {
        if (ws === socket) ws = null;

        // 鉴权失败：停止重连
        if (event.code === CLOSE_CODE_AUTH_FAILED) {
            _console.warn(`[cloud-bridge] 鉴权失败 (4001): ${event.reason || '(无原因)'}，停止重连。请检查 token`);
            setState('auth_failed', `token 无效${event.reason ? `: ${event.reason}` : ''}`);
            return;
        }

        const reason = event.reason || `连接已关闭 (code=${event.code})`;
        _console.log(`[cloud-bridge] 连接关闭 code=${event.code} reason=${reason}，${RECONNECT_DELAY_MS}ms 后重连`);
        setState('disconnected', reason);

        // 仅在配置仍启用时重连
        void readCloudBridgeSettings().then((s) => {
            if (s?.enabled && s.serverUrl && s.token) scheduleReconnect();
        });
    };
};

// ============ 对外接口 ============

/** 应用配置变更：根据当前配置决定连接或断开 */
export const applyCloudBridgeSettings = async (): Promise<void> => {
    const settings = await readCloudBridgeSettings();
    if (!settings || !settings.enabled || !settings.serverUrl || !settings.token) {
        disconnect();
        setState('disabled', null);
        return;
    }
    // 配置变更后强制重连（serverUrl/token 可能改了）
    disconnect();
    await connect();
};

/** 启动 Cloud Bridge（background.ts 调用一次） */
export const initCloudBridge = (): void => {
    if (started) return;
    started = true;

    // 注册状态查询 handler，供 Options 页读取
    Channel.on(STATUS_GET_MESSAGE, (_data, _sender, sendResponse) => {
        if (!sendResponse) return false;
        void getStatus().then(sendResponse);
        return true;
    });

    // 监听配置变更
    if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName !== 'local') return;
            if (Object.prototype.hasOwnProperty.call(changes, CLOUD_BRIDGE_SETTINGS_KEY)) {
                _console.log('[cloud-bridge] 配置变更，重新应用');
                void applyCloudBridgeSettings();
            }
        });
    }

    // 首次启动
    void connect();
    _console.log('[cloud-bridge] 已初始化');
};
