#!/usr/bin/env node
/**
 * Actspan Cloud MCP 服务（多人共享云端）
 *
 * 一台机器上监听一个端口，同时服务两类客户端，按 token 做用户隔离与路由：
 *
 *   POST/GET/DELETE /mcp  —— Streamable HTTP MCP 端点，给 IDE（Claude Code/Cursor/Trae 等）
 *                            鉴权：请求头 Authorization: Bearer <token>
 *   WS /ws                —— WebSocket 端点，给浏览器扩展（src/background/cloud-bridge.ts）
 *                            鉴权：query ?token=<token>（浏览器 WebSocket 不允许自定义请求头）
 *   GET /health           —— 运维探针（无需鉴权，只暴露计数不暴露 token）
 *
 * 路由模型：
 *   IDE 会话（mcp-session-id）在 initialize 时绑定 token；
 *   浏览器 WebSocket 连接在握手时绑定同一个 token；
 *   IDE 的 tools/list、tools/call 被转发到该 token 对应的浏览器连接，在用户本地 Chrome 执行后回传。
 *
 * 约定：
 *   - 浏览器 token 无效：accept 后立即 close(4001, 'invalid token')，扩展端据此停止重连
 *   - 同一 token 重复连接浏览器：踢掉旧连接 close(4002, 'replaced by new connection')
 *   - 浏览器不在线时：tools/list 抛 MCP 错误；tools/call 返回 isError 结果（IDE 可见原因）
 *
 * 配置（环境变量 / 命令行）：
 *   --port / ACTSPAN_CLOUD_PORT          监听端口，默认 8787
 *   --host / ACTSPAN_CLOUD_HOST          监听地址，默认 0.0.0.0
 *   --tokens / ACTSPAN_CLOUD_TOKENS_FILE token 文件路径，默认 ./tokens.json
 *   ACTSPAN_CLOUD_TOKENS                 内联 JSON（优先级高于文件），形如 {"alice":"actspan_alice_xxx"}
 *   ACTSPAN_CLOUD_CALL_TIMEOUT_MS        转发到浏览器的超时，默认 120000
 *
 * tokens 文件格式（name → token）：
 *   { "alice": "actspan_alice_xxx", "bob": "actspan_bob_yyy" }
 *   文件变更自动热加载（2s 轮询），改 token 不用重启服务。
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { WebSocketServer } from 'ws';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
    ListToolsRequestSchema,
    CallToolRequestSchema,
    ErrorCode,
    McpError,
} from '@modelcontextprotocol/sdk/types.js';

// ============ 配置 ============

const argv = process.argv.slice(2);
const argValue = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
};

const PORT = Number(argValue('--port') || process.env.ACTSPAN_CLOUD_PORT || 8787);
const HOST = argValue('--host') || process.env.ACTSPAN_CLOUD_HOST || '0.0.0.0';
const TOKENS_FILE = resolvePath(argValue('--tokens') || process.env.ACTSPAN_CLOUD_TOKENS_FILE || 'tokens.json');
const CALL_TIMEOUT_MS = Number(process.env.ACTSPAN_CLOUD_CALL_TIMEOUT_MS || 120_000);
const PING_INTERVAL_MS = 30_000;

/** 与扩展端 src/background/cloud-bridge.ts 的 CLOSE_CODE_AUTH_FAILED 保持一致 */
const CLOSE_CODE_AUTH_FAILED = 4001;
/** 同 token 新连接顶替旧连接 */
const CLOSE_CODE_REPLACED = 4002;

// ============ token 注册表 ============

/** token → name */
let tokenRegistry = new Map();
let tokensMtime = 0;
/** token → { ws, name, connectedAt, lastPong, pending } */
const browsers = new Map();
/** mcp-session-id → { token, name, transport, server } */
const mcpSessions = new Map();

const replaceTokenRegistry = (next) => {
    tokenRegistry = next;
    for (const [token, session] of browsers) {
        if (tokenRegistry.has(token)) continue;
        browsers.delete(token);
        for (const { reject, timer } of session.pending.values()) {
            clearTimeout(timer);
            reject(new Error('token 已被吊销'));
        }
        session.pending.clear();
        session.ws.close(CLOSE_CODE_AUTH_FAILED, 'token revoked');
    }
    for (const [id, session] of mcpSessions) {
        if (tokenRegistry.has(session.token)) continue;
        mcpSessions.delete(id);
        // 先让被拒绝的在途调用写出错误回执，再关闭其 HTTP/SSE 会话。
        setImmediate(() => { void session.transport.close().catch(() => undefined); });
    }
};

const loadTokens = () => {
    const inline = process.env.ACTSPAN_CLOUD_TOKENS;
    if (inline) {
        try {
            const obj = JSON.parse(inline);
            replaceTokenRegistry(new Map(Object.entries(obj).map(([name, token]) => [String(token), name])));
            console.log(`[cloud] 已从环境变量加载 ${tokenRegistry.size} 个 token`);
            return;
        } catch (err) {
            console.error('[cloud] ACTSPAN_CLOUD_TOKENS 不是合法 JSON:', err.message);
        }
    }
    if (!existsSync(TOKENS_FILE)) {
        if (tokenRegistry.size > 0) replaceTokenRegistry(new Map());
        tokensMtime = 0;
        if (tokenRegistry.size === 0) {
            console.warn(`[cloud] token 文件不存在: ${TOKENS_FILE}（所有连接将被拒绝，直到文件出现）`);
        }
        return;
    }
    try {
        const mtime = statSync(TOKENS_FILE).mtimeMs;
        if (mtime === tokensMtime && tokenRegistry.size > 0) return;
        const obj = JSON.parse(readFileSync(TOKENS_FILE, 'utf8'));
        replaceTokenRegistry(new Map(Object.entries(obj).map(([name, token]) => [String(token), name])));
        tokensMtime = mtime;
        console.log(`[cloud] 已从 ${TOKENS_FILE} 加载 ${tokenRegistry.size} 个 token: ${[...tokenRegistry.values()].join(', ')}`);
    } catch (err) {
        console.error('[cloud] 读取 token 文件失败:', err.message);
    }
};

loadTokens();
// 热加载：文件变更 2s 内生效
setInterval(loadTokens, 2000).unref();

const nameOfToken = (token) => tokenRegistry.get(token) || null;

// ============ 浏览器会话注册表 ============

class BrowserOfflineError extends Error {
    constructor(name) {
        super(`浏览器不在线（用户 ${name}）。请确认对方 Chrome 已打开、扩展已启用云端连接`);
        this.name = 'BrowserOfflineError';
    }
}

/** 向某用户的浏览器转发一帧 JSON-RPC 请求并等待响应 */
const sendToBrowser = (token, method, params, timeoutMs = CALL_TIMEOUT_MS) => {
    if (!tokenRegistry.has(token)) return Promise.reject(new Error('token 已被吊销'));
    const session = browsers.get(token);
    if (!session || session.ws.readyState !== 1) {
        return Promise.reject(new BrowserOfflineError(nameOfToken(token) || '?'));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            session.pending.delete(id);
            reject(new Error(`浏览器响应超时（${timeoutMs}ms），method=${method}`));
        }, timeoutMs);
        session.pending.set(id, { resolve, reject, timer });
        session.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
};

// ============ HTTP + MCP（IDE 侧） ============

const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw.trim()) return resolve(undefined);
        try {
            resolve(JSON.parse(raw));
        } catch {
            reject(new Error('请求体不是合法 JSON'));
        }
    });
    req.on('error', reject);
});

/** 解析 Authorization: Bearer <token>；也容忍裸 token */
const authOfRequest = (req) => {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.trim()) return null;
    const m = header.trim().match(/^bearer\s+(.+)$/i);
    return (m ? m[1] : header.trim());
};

const sendJson = (res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
    });
    res.end(body);
};

/** 为某个已鉴权的 IDE 会话创建 MCP Server，handler 闭包绑定 token */
const createMcpServerForToken = (token, name) => {
    const server = new Server(
        { name: 'actspan-cloud', version: '1.1.0' },
        { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        // 云端本地工具：连接状态自检。浏览器不在线时也返回它，保证 IDE「测试连接」可通过
        const statusTool = {
            name: 'cloud_status',
            description: '查询当前用户浏览器的在线状态（云端本地工具，不经过浏览器）。online=false 表示该用户的浏览器扩展未连接，需先在扩展「云端连接器」里启用并填入同一个 token。',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        };
        try {
            const resp = await sendToBrowser(token, 'tools/list', {});
            const rawTools = Array.isArray(resp?.tools) ? resp.tools : [];
            // 只保留 MCP 标准字段，剥离扩展私有字段（supportsParallel 等）
            const tools = rawTools.map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
            }));
            tools.push(statusTool);
            return { tools };
        } catch {
            // 浏览器不在线：不让「工具发现」整体失败（否则 IDE 会误报"检查地址和网络"）。
            // 只回云端本地工具，让连接测试通过；agent 调 cloud_status 即可看到 online=false 自行诊断。
            return { tools: [statusTool] };
        }
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name: toolName, arguments: args } = request.params;

        // 云端本地工具
        if (toolName === 'cloud_status') {
            const session = browsers.get(token);
            const online = Boolean(session && session.ws.readyState === 1);
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: true,
                        user: name,
                        online,
                        connectedAt: session?.connectedAt || null,
                        lastPong: session?.lastPong || null,
                    }),
                }],
                isError: false,
            };
        }

        try {
            const result = await sendToBrowser(token, 'tools/call', { name: toolName, arguments: args || {} });
            // 浏览器返回的已是 MCP ToolResult 形状（content + isError）
            return {
                content: result?.content || [{ type: 'text', text: JSON.stringify(result) }],
                isError: result?.isError === true,
            };
        } catch (err) {
            if (err instanceof BrowserOfflineError) {
                return {
                    content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }) }],
                    isError: true,
                };
            }
            return {
                content: [{ type: 'text', text: JSON.stringify({ success: false, error: err?.message || '转发失败' }) }],
                isError: true,
            };
        }
    });

    return server;
};

const handleMcpRequest = async (req, res, body) => {
    const token = authOfRequest(req);
    const name = token ? nameOfToken(token) : null;
    if (!token || !name) {
        sendJson(res, 401, {
            error: 'unauthorized',
            message: '缺少或无效的 Authorization: Bearer <token>',
        });
        return;
    }

    const sessionId = req.headers['mcp-session-id'];

    // initialize：无 session id
    if (!sessionId || typeof sessionId !== 'string') {
        const sid = randomUUID();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => sid });
        const server = createMcpServerForToken(token, name);
        mcpSessions.set(sid, { token, name, transport, server });
        transport.onclose = () => {
            mcpSessions.delete(sid);
            console.log(`[cloud] IDE 会话关闭 sid=${sid.slice(0, 8)} user=${name}`);
        };
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        console.log(`[cloud] IDE 会话建立 sid=${sid.slice(0, 8)} user=${name}`);
        return;
    }

    // 已有会话：校验 token 与建会话时一致（防 session id 被窃取后跨用户复用）
    const session = mcpSessions.get(sessionId);
    if (!session) {
        sendJson(res, 404, { error: 'session not found', message: 'mcp-session-id 不存在或已过期' });
        return;
    }
    if (session.token !== token) {
        sendJson(res, 403, { error: 'forbidden', message: 'token 与该会话不匹配' });
        return;
    }
    await session.transport.handleRequest(req, res, body);
};

// ============ WebSocket（浏览器侧） ============

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, token, name) => {
    // 同 token 顶替旧连接
    const old = browsers.get(token);
    if (old && old.ws !== ws && old.ws.readyState === 1) {
        console.log(`[cloud] 用户 ${name} 有新浏览器连接，顶替旧连接`);
        try { old.ws.close(CLOSE_CODE_REPLACED, 'replaced by new connection'); } catch { /* 忽略 */ }
    }

    const session = {
        ws,
        name,
        connectedAt: Date.now(),
        lastPong: null,
        pending: new Map(),
    };
    browsers.set(token, session);
    console.log(`[cloud] 浏览器上线 user=${name}（当前在线 ${browsers.size} 人）`);

    ws.on('message', (data) => {
        let frame;
        try {
            frame = JSON.parse(data.toString());
        } catch {
            return;
        }
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return;
        // 响应帧：resolve 在途请求
        if (frame.id !== undefined && session.pending.has(frame.id)) {
            const { resolve, reject, timer } = session.pending.get(frame.id);
            clearTimeout(timer);
            session.pending.delete(frame.id);
            if (frame.error) reject(new Error(frame.error.message || '浏览器返回错误'));
            else resolve(frame.result);
            return;
        }
        // 通知帧
        if (frame.method === 'notifications/ready') {
            console.log(`[cloud] 浏览器就绪 user=${name} version=${frame.params?.version} toolCount=${frame.params?.toolCount}`);
            return;
        }
        if (frame.method === 'notifications/pong') {
            session.lastPong = frame.params?.ts || Date.now();
            return;
        }
    });

    ws.on('close', (code, reason) => {
        if (browsers.get(token)?.ws === ws) browsers.delete(token);
        for (const { reject, timer } of session.pending.values()) {
            clearTimeout(timer);
            reject(new Error('浏览器连接已断开'));
        }
        session.pending.clear();
        console.log(`[cloud] 浏览器下线 user=${name} code=${code} reason=${reason || '(无)'}（剩余在线 ${browsers.size} 人）`);
    });

    ws.on('error', (err) => console.error(`[cloud] 浏览器连接错误 user=${name}:`, err.message));
});

// 心跳：30s ping 一次所有浏览器
setInterval(() => {
    for (const session of browsers.values()) {
        if (session.ws.readyState === 1) {
            try { session.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/ping' })); } catch { /* 忽略 */ }
        }
    }
}, PING_INTERVAL_MS).unref();

// ============ HTTP 路由 ============

const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    // CORS 预检（Web 版 IDE 可能触发）
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'access-control-allow-origin': '*',
            'access-control-allow-headers': 'authorization, content-type, mcp-session-id, mcp-protocol-version',
            'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
            'access-control-expose-headers': 'mcp-session-id',
        });
        res.end();
        return;
    }

    if (url.pathname === '/health') {
        sendJson(res, 200, {
            ok: true,
            uptimeSec: Math.round(process.uptime()),
            browsersOnline: browsers.size,
            browserUsers: [...browsers.values()].map((s) => s.name),
            mcpSessions: mcpSessions.size,
            tokensLoaded: tokenRegistry.size,
        });
        return;
    }

    if (url.pathname === '/mcp') {
        try {
            const body = req.method === 'POST' ? await readBody(req) : undefined;
            await handleMcpRequest(req, res, body);
        } catch (err) {
            if (!res.headersSent) sendJson(res, 400, { error: 'bad request', message: err?.message || '请求处理失败' });
            else res.end();
        }
        return;
    }

    sendJson(res, 404, { error: 'not found' });
});

// WebSocket 握手：/ws?token=xxx
httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== '/ws') {
        socket.destroy();
        return;
    }
    const token = url.searchParams.get('token') || '';
    const name = nameOfToken(token);
    if (!name) {
        // 先完成握手再 close(4001)，保证扩展端能读到关闭码
        wss.handleUpgrade(req, socket, head, (ws) => {
            console.warn(`[cloud] 拒绝浏览器连接：token ${token ? '无效' : '缺失'}`);
            ws.close(CLOSE_CODE_AUTH_FAILED, 'invalid token');
        });
        return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, token, name));
});

httpServer.listen(PORT, HOST, () => {
    console.log(`[cloud] Actspan Cloud MCP 服务已启动`);
    console.log(`[cloud]   MCP 端点（IDE）:      http://${HOST}:${PORT}/mcp   鉴权: Authorization: Bearer <token>`);
    console.log(`[cloud]   WebSocket（浏览器）: ws://${HOST}:${PORT}/ws      鉴权: ?token=<token>`);
    console.log(`[cloud]   健康探针:            http://${HOST}:${PORT}/health`);
    console.log(`[cloud] 生产部署请在反向代理后挂 TLS，对外暴露 https://…/mcp 与 wss://…/ws`);
});

// 优雅退出
const shutdown = () => {
    console.log('[cloud] 正在关闭...');
    for (const session of browsers.values()) {
        try { session.ws.close(1001, 'server shutting down'); } catch { /* 忽略 */ }
    }
    for (const session of mcpSessions.values()) {
        try { void session.transport.close(); } catch { /* 忽略 */ }
    }
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
