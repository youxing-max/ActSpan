/**
 * Cloud 服务端到端测试（无需真实 Chrome）
 *
 * 链路：MCP 客户端(模拟 IDE) ──HTTP /mcp──> cloud.js ──WS──> 假浏览器(模拟扩展)
 *
 * 覆盖：
 *   1. 正确 token 的浏览器 WS 连接成功，收到 notifications/ping 会回 pong
 *   2. 错误 token 的浏览器 WS 被 close(4001)
 *   3. IDE 无/错 Authorization → 401
 *   4. IDE listTools 拿到浏览器工具 + cloud_status
 *   5. IDE callTool 转发到浏览器并拿回结果
 *   6. cloud_status 在线状态正确
 *   7. 浏览器不在线时 callTool 返回 isError
 *   8. 同 token 第二个浏览器连接顶替第一个（4002）
 *
 * 运行：node test/cloud-e2e.mjs
 */

import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const here = dirname(fileURLToPath(import.meta.url));
const CLOUD_JS = join(here, '..', 'cloud.js');
const PORT = 18791;
const BASE = `http://127.0.0.1:${PORT}`;
const ALICE = 'e2e-alice-token';
const BOB = 'e2e-bob-token';

const tokensFile = join(mkdtempSync(join(tmpdir(), 'actspan-cloud-')), 'tokens.json');
writeFileSync(tokensFile, JSON.stringify({ alice: ALICE, bob: BOB }));

const log = (msg) => console.log(`  ✓ ${msg}`);

// ============ 启动云端服务 ============

const server = spawn(process.execPath, [CLOUD_JS, '--port', String(PORT), '--tokens', tokensFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => process.env.CLOUD_E2E_VERBOSE && process.stdout.write(`[srv] ${d}`));
server.stderr.on('data', (d) => process.stderr.write(`[srv:err] ${d}`));

const waitHealth = async (tries = 50) => {
    for (let i = 0; i < tries; i++) {
        try {
            const res = await fetch(`${BASE}/health`);
            if (res.ok) return res.json();
        } catch { /* 还没起来 */ }
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('云端服务启动超时');
};

// ============ 假浏览器（模拟扩展 cloud-bridge.ts 的行为） ============

const connectFakeBrowser = (token) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}`);
    const timer = setTimeout(() => reject(new Error('浏览器连接超时')), 5000);
    ws.on('open', () => { clearTimeout(timer); resolve(ws); });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
});

const armFakeBrowser = (ws) => {
    ws.on('message', (data) => {
        const frame = JSON.parse(data.toString());
        if (frame.method === 'notifications/ping') {
            ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/pong', params: { ts: Date.now() } }));
            return;
        }
        if (frame.method === 'tools/list') {
            ws.send(JSON.stringify({
                jsonrpc: '2.0',
                id: frame.id,
                result: {
                    tools: [{
                        name: 'echo',
                        description: '回显测试工具',
                        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
                        supportsParallel: true, // 扩展私有字段，云端应剥离
                    }],
                },
            }));
            return;
        }
        if (frame.method === 'tools/call') {
            const { name, arguments: args } = frame.params || {};
            ws.send(JSON.stringify({
                jsonrpc: '2.0',
                id: frame.id,
                result: {
                    content: [{ type: 'text', text: `echo:${args?.text ?? ''}` }],
                    isError: false,
                },
            }));
            void name;
            return;
        }
    });
    // 模拟扩展的 ready 通知
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/ready', params: { version: 'e2e', toolCount: 1 } }));
};

// ============ IDE 客户端 ============

const connectIde = (token) => {
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: 'e2e-ide', version: '0.0.0' });
    return client.connect(transport).then(() => client);
};

// ============ 用例 ============

const main = async () => {
    const health = await waitHealth();
    log(`健康探针 ok，tokensLoaded=${health.tokensLoaded}`);
    assert.equal(health.tokensLoaded, 2);

    // 2. 错误 token 的浏览器被 4001 拒绝
    await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=wrong-token`);
        ws.on('close', (code, reason) => {
            try {
                assert.equal(code, 4001, `期望 close 4001，实际 ${code}`);
                log(`错误 token 浏览器被拒绝 close=${code} reason=${reason}`);
                resolve();
            } catch (e) { reject(e); }
        });
        ws.on('error', reject);
        setTimeout(() => reject(new Error('4001 用例超时')), 5000);
    });

    // 7. 浏览器不在线时 IDE callTool 返回 isError
    {
        const client = await connectIde(BOB);
        const res = await client.callTool({ name: 'echo', arguments: { text: 'x' } });
        assert.equal(res.isError, true);
        assert.match(res.content[0].text, /不在线/);
        log('浏览器不在线时 callTool 返回 isError 且说明原因');
        await client.close();
    }

    // 3. IDE 无/错 token → 401
    {
        const res = await fetch(`${BASE}/mcp`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
        });
        assert.equal(res.status, 401);
        const res2 = await fetch(`${BASE}/mcp`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', Authorization: 'Bearer nope' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
        });
        assert.equal(res2.status, 401);
        log('IDE 无/错 Authorization 均 401');
    }

    // 1+4+5+6. alice 全链路
    const browser = await connectFakeBrowser(ALICE);
    armFakeBrowser(browser);
    await new Promise((r) => setTimeout(r, 200));

    const ide = await connectIde(ALICE);
    const { tools } = await ide.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('echo'), '应包含浏览器工具 echo');
    assert.ok(names.includes('cloud_status'), '应包含云端本地工具 cloud_status');
    const echoTool = tools.find((t) => t.name === 'echo');
    assert.equal(echoTool.supportsParallel, undefined, '扩展私有字段 supportsParallel 应被剥离');
    log(`IDE listTools 拿到 ${tools.length} 个工具，私有字段已剥离`);

    const callRes = await ide.callTool({ name: 'echo', arguments: { text: 'hello-cloud' } });
    assert.equal(callRes.isError, false);
    assert.equal(callRes.content[0].text, 'echo:hello-cloud');
    log('IDE callTool 经云端转发到浏览器并拿回结果');

    const statusRes = await ide.callTool({ name: 'cloud_status', arguments: {} });
    const status = JSON.parse(statusRes.content[0].text);
    assert.equal(status.online, true);
    assert.equal(status.user, 'alice');
    log(`cloud_status 在线 user=${status.user}`);

    // 心跳 pong
    await new Promise((r) => setTimeout(r, 300));

    // 8. 同 token 第二个浏览器顶替第一个
    await new Promise((resolve, reject) => {
        browser.once('close', (code) => {
            try {
                assert.equal(code, 4002, `旧连接应被 4002 顶替，实际 ${code}`);
                log('同 token 新浏览器连接顶替旧连接 (4002)');
                resolve();
            } catch (e) { reject(e); }
        });
        connectFakeBrowser(ALICE).then((ws2) => { armFakeBrowser(ws2); setTimeout(() => ws2.close(), 300); });
        setTimeout(() => reject(new Error('4002 用例超时')), 5000);
    });

    await ide.close();
    console.log('\ncloud-e2e: 全部通过 ✅');
};

const cleanup = () => {
    try { server.kill('SIGTERM'); } catch { /* 忽略 */ }
};

const guard = setTimeout(() => {
    console.error('\ncloud-e2e: 超时 ❌');
    cleanup();
    process.exit(1);
}, 30_000);

main()
    .then(() => { clearTimeout(guard); cleanup(); process.exit(0); })
    .catch((err) => {
        clearTimeout(guard);
        console.error('\ncloud-e2e: 失败 ❌', err);
        cleanup();
        process.exit(1);
    });
