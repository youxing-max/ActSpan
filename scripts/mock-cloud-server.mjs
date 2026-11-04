/**
 * 本地云端 Mock Server（token 隔离模式）
 *
 * 模拟云端 MCP Host，演示多用户共享一个云端、按 token 隔离调用的模型。
 *
 * 用法：
 *   node scripts/mock-cloud-server.mjs
 *
 * 默认监听 ws://127.0.0.1:18080/ws
 * 内置 3 个测试 token：
 *   - alice-token-001 → 用户 alice
 *   - bob-token-002   → 用户 bob
 *   - carol-token-003 → 用户 carol
 * 其他 token 一律以 close code 4001 拒绝（鉴权失败）。
 *
 * 测试流程：
 *   1. 启动本脚本
 *   2. 扩展 Options → 云端连接器：
 *        服务器地址：ws://127.0.0.1:18080/ws
 *        Token：alice-token-001
 *   3. 启用后，本脚本会自动跑一遍演示（tools/list、tab_navigate、page.view、错误工具）
 *   4. 可以再开一个 Chrome profile，用 bob-token-002 登录，观察云端按 token 区分用户
 */

import { createRequire } from 'node:module';
// 复用 mcp-server/node_modules 里的 ws，避免在根目录重复安装
const require = createRequire(new URL('../mcp-server/package.json', import.meta.url));
const { WebSocketServer } = require('ws');

const PORT = 18080;

/** token → 用户标识（云端用户库） */
const USER_DB = new Map([
    ['alice-token-001', { userId: 'u_alice', name: 'alice' }],
    ['bob-token-002', { userId: 'u_bob', name: 'bob' }],
    ['carol-token-003', { userId: 'u_carol', name: 'carol' }],
]);

/** 鉴权失败 close code（与扩展端 src/background/cloud-bridge.ts 中的 CLOSE_CODE_AUTH_FAILED 保持一致） */
const CLOSE_CODE_AUTH_FAILED = 4001;

let nextId = 1;
/** userId → Set<WebSocket>，演示同一用户多设备/多浏览器 */
const sessionsByUser = new Map();

const wss = new WebSocketServer({ port: PORT, path: '/ws' });

const sendRequest = (ws, method, params) =>
    new Promise((resolve, reject) => {
        const id = nextId++;
        const pending = ws._pending || (ws._pending = new Map());
        const timer = setTimeout(() => {
            if (pending.has(id)) {
                pending.delete(id);
                reject(new Error(`请求 ${id} (${method}) 超时`));
            }
        }, 30_000);
        pending.set(id, { resolve, timer });
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });

const pretty = (obj) => JSON.stringify(obj, null, 2).slice(0, 1500);

wss.on('listening', () => {
    console.log(`[mock-cloud] 监听 ws://127.0.0.1:${PORT}/ws`);
    console.log(`[mock-cloud] 内置测试 token:`);
    for (const [token, user] of USER_DB) {
        console.log(`  - ${token} → ${user.name}`);
    }
    console.log();
});

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const token = url.searchParams.get('token') || '';
    const user = USER_DB.get(token);

    // ============ 鉴权 ============
    if (!user) {
        console.warn(`[mock-cloud] 拒绝连接：token 无效 (token="${token || '(空)'}")`);
        ws.close(CLOSE_CODE_AUTH_FAILED, 'invalid token');
        return;
    }

    // ============ 绑定用户 ============
    if (!sessionsByUser.has(user.userId)) sessionsByUser.set(user.userId, new Set());
    sessionsByUser.get(user.userId).add(ws);
    ws._user = user;

    const sessionCount = sessionsByUser.get(user.userId).size;
    console.log(`[mock-cloud] 用户 ${user.name}(${user.userId}) 已连接，当前该用户共 ${sessionCount} 条连接`);

    ws.on('message', async (data) => {
        let frame;
        try {
            frame = JSON.parse(data.toString());
        } catch {
            console.warn(`[mock-cloud:${user.name}] 收到非 JSON 帧`);
            return;
        }

        // 响应帧
        if (frame.id !== undefined && ws._pending?.has(frame.id)) {
            const { resolve, timer } = ws._pending.get(frame.id);
            clearTimeout(timer);
            ws._pending.delete(frame.id);
            resolve(frame);
            return;
        }

        // 通知帧
        if (frame.method === 'notifications/ready') {
            console.log(`[mock-cloud] ${user.name} 的扩展就绪 version=${frame.params?.version} toolCount=${frame.params?.toolCount}`);
            await demo(ws, user);
            return;
        }
        if (frame.method === 'notifications/pong') {
            // 心跳应答，静默
            return;
        }
        console.log(`[mock-cloud] ${user.name} 收到未识别帧:`, frame);
    });

    ws.on('close', (code, reason) => {
        sessionsByUser.get(user.userId)?.delete(ws);
        console.log(`[mock-cloud] 用户 ${user.name} 断开 (code=${code} reason=${reason || '(无)'})`);
    });

    ws.on('error', (err) => console.error(`[mock-cloud:${user.name}] 连接错误:`, err.message));
});

/** 演示一遍完整调用链 */
async function demo(ws, user) {
    const prefix = `[demo:${user.name}]`;
    try {
        // 1) 列出所有工具
        const listResp = await sendRequest(ws, 'tools/list');
        const tools = listResp.result?.tools || [];
        console.log(`\n${prefix} tools/list 拿到 ${tools.length} 个工具，前 8 个：`);
        for (const t of tools.slice(0, 8)) console.log(`  - ${t.name}`);
        console.log();

        // 2) 调用 tab_navigate 列出当前标签页
        const tabsResp = await sendRequest(ws, 'tools/call', {
            name: 'tab_navigate',
            arguments: { action: 'list' },
        });
        console.log(`${prefix} tab_navigate.list 结果（截断）:`);
        console.log(pretty(tabsResp));

        // 3) 调一个不存在的工具，看错误响应
        const errResp = await sendRequest(ws, 'tools/call', {
            name: 'not_exist_tool',
            arguments: {},
        });
        console.log(`\n${prefix} 调用不存在工具的错误响应:`);
        console.log(pretty(errResp));

        console.log(`\n${prefix} 演示完成，连接保持打开。`);
    } catch (err) {
        console.error(`${prefix} 失败:`, err.message);
    }
}

// 演示云端主动心跳（可选）
setInterval(() => {
    for (const [userId, sessions] of sessionsByUser) {
        for (const ws of sessions) {
            if (ws.readyState === 1) {
                ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/ping' }));
            }
        }
    }
}, 60_000);
