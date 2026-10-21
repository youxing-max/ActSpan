import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TOOL_NAMES } from '../catalog.js';
import { extensionIdFromKey } from '../install.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const home = mkdtempSync(path.join(os.tmpdir(), 'actspan-e2e-'));
const port = Number(process.env.ACTSPAN_E2E_PORT || 31921);
const extensionId = extensionIdFromKey();
const url = `ws://127.0.0.1:${port}`;
let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? 'PASS' : 'FAIL'}: ${name}${extra ? ` ${extra}` : ''}`);
    if (!condition) failures += 1;
};
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function handshake(frames, match) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(url, { headers: frames.headers });
        const seen = [];
        const timer = setTimeout(() => { socket.close(); resolve({ frames: seen, close: 'timeout' }); }, 6000);
        socket.on('open', () => { for (const frame of frames.send) socket.send(JSON.stringify(frame)); });
        socket.on('message', raw => {
            const message = JSON.parse(raw.toString());
            seen.push(message);
            if (message.type === 'hello_ok' || (match && match(message))) {
                clearTimeout(timer);
                resolve({ frames: seen, socket });
            }
        });
        socket.on('close', code => { clearTimeout(timer); resolve({ frames: seen, close: code }); });
        socket.on('error', error => { clearTimeout(timer); reject(error); });
    });
}

const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, '..', 'index.js'), '--client', 'claude-desktop'],
    cwd: path.join(here, '..'),
    env: {
        ...getDefaultEnvironment(),
        ACTSPAN_API_URL: 'https://api.example.com',
        ACTSPAN_API_KEY: 'e2e-key',
        ACTSPAN_BRIDGE_URL: url,
        ACTSPAN_EXTENSION_IDS: extensionId,
        MOLE_MCP_LOG: path.join(home, 'server.log'),
    },
});
const client = new Client({ name: 'actspan-e2e', version: '1.0.0' });
await client.connect(transport);
await wait(100);

const tools = await client.listTools();
check('MCP tools/list matches the fixed Actspan catalog',
    tools.tools.length === TOOL_NAMES.length && TOOL_NAMES.every(name => tools.tools.some(tool => tool.name === name)));
const tabOpenTool = tools.tools.find(tool => tool.name === 'actspan_tab_open');
// D10: the foreground escape hatch must be explicit and its cost stated in the description.
check('tab open exposes focus as the only foreground escape hatch',
    tabOpenTool?.inputSchema?.properties?.focus?.type === 'boolean'
    && tabOpenTool.inputSchema.properties.focus.default === false
    && tabOpenTool.inputSchema.properties.active === undefined);
check('tab open description says the default is a background tab that interrupts nothing',
    /background/i.test(tabOpenTool?.description || '') && /foreground/i.test(tabOpenTool?.description || ''));
check('tab open description warns that focus:true interrupts the user',
    /interrupt/i.test(tabOpenTool?.description || '') && /interrupt/i.test(tabOpenTool?.inputSchema?.properties?.focus?.description || ''));
const call = (name, args = {}) => client.callTool({ name, arguments: args });
const statusText = async () => (await call('actspan_status')).content[0].text;
const before = JSON.parse(await statusText());
check('unpaired status reports connected=false', before.connected === false);
check('unpaired status reports loop_mode=disabled with pairing satisfied', before.loop_mode === 'disabled' && before.pairing_required === false);
check('Bridge is listening', before.hub_listening === true, `port=${before.port}`);
check('MCP host identity uses initialize clientInfo.name', before.host?.slug === 'actspan-e2e' && before.host?.source === 'self');
check('status exposes the K3 quota attribution slice for this host',
    before.usage?.host === 'actspan-e2e' && Number.isSafeInteger(before.usage?.calls) && before.usage.calls >= 0
    && typeof before.usage?.tools === 'object');

const paired = await handshake({
    headers: { Origin: `chrome-extension://${extensionId}` },
    send: [{ type: 'pair' }],
}, frame => frame.type === 'pair_ok');
const pair = paired.frames.find(frame => frame.type === 'pair_ok');
check('allowlisted extension can pair', typeof pair?.token === 'string' && pair.token.length > 0);
const socket = paired.socket;
socket.send(JSON.stringify({ type: 'hello', token: pair.token }));
await wait(100);
check('paired extension authenticates', paired.frames.some(frame => frame.type === 'hello_ok'));

let revision = 1;
let feishuRequest;
let taskSubmitRequest;
let pingRequest;
let tabOpenRequest;
let statusContext;
socket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (!message.id || !message.context) return;
    let result = { ok: true };
    if (message.method === 'ping') { pingRequest = message; result = { pong: true, version: 'e2e' }; }
    if (message.method === 'feishu.push') {
        feishuRequest = message;
        result = message.params.title === '失败'
            ? { success: false, error: '飞书推送失败' }
            : { sent: 1, failed: 0, names: [message.params.webhookName || '研发群'] };
    }
    if (message.method === 'registry.list') result = { revision: revision++, skills: [], updatedAt: Date.now() };
    if (message.method === 'registry.detail') result = { name: message.params.name, workflows: [] };
    if (message.method === 'workflow.run' || message.method === 'task.submit') {
        if (message.method === 'task.submit') taskSubmitRequest = message;
        result = { taskId: message.context.taskId, sessionId: message.context.sessionId, registryRevision: 1, state: 'queued' };
    }
    if (message.method === 'tab.open') {
        tabOpenRequest = message;
        result = { tabId: 4242, url: message.params.url, title: 'Example', taskId: message.context.taskId, sessionId: message.context.sessionId };
    }
    if (message.method === 'task.status') {
        statusContext = message.context;
        result = { taskId: message.context.taskId, sessionId: message.context.sessionId, state: 'running' };
    }
    if (message.method === 'task.result') result = { taskId: message.context.taskId, sessionId: message.context.sessionId, state: 'succeeded', result: { done: true } };
    if (message.method === 'task.cancel') result = { taskId: message.context.taskId, sessionId: message.context.sessionId, state: 'cancelled' };
    socket.send(JSON.stringify({ id: message.id, ...message.context, ok: true, result }));
});
await wait(100);
const pairedStatus = JSON.parse(await statusText());
check('paired status reports loop_mode=enabled', pairedStatus.loop_mode === 'enabled' && pairedStatus.connected === true && pairedStatus.pairing_required === false);
check('bridge label carries the self-reported host, not the wrong --client fallback',
    pingRequest?.context?.onlineSessions?.some(session => session.label === 'actspan-e2e') === true
    && pingRequest.context.onlineSessions.every(session => session.label !== 'claude-desktop'));
const push = JSON.parse((await call('actspan_feishu_push', {
    title: '任务完成', message: '处理结果已生成', webhookName: '研发群',
})).content[0].text);
check('Feishu push forwards an optional webhook name through the bridge',
    push.sent === 1 && feishuRequest?.params?.webhookName === '研发群');
const allPush = JSON.parse((await call('actspan_feishu_push', {
    title: '广播', message: '发送到全部配置',
})).content[0].text);
check('Feishu push omits target name for the default-all behavior',
    allPush.sent === 1 && feishuRequest?.params?.webhookName === undefined);
const failedPush = await call('actspan_feishu_push', { title: '失败', message: '模拟失败' });
check('Feishu delivery failures are MCP tool errors',
    failedPush.isError === true && failedPush.content?.[0]?.text.includes('飞书推送失败'));
const first = JSON.parse((await call('actspan_skills_list')).content[0].text);
const second = JSON.parse((await call('actspan_skills_list')).content[0].text);
check('next catalog lookup sees new revision', second.revision > first.revision);
const detail = JSON.parse((await call('actspan_skill_detail', { name: 'demo' })).content[0].text);
check('catalog detail round trip succeeds', detail.name === 'demo');
const handle = JSON.parse((await call('actspan_workflow_run', { name: 'demo', input: {} })).content[0].text);
check('workflow run returns async task handle', handle.state === 'queued' && handle.taskId && handle.sessionId);
check('workflow handle defaults session ownership to task id', handle.sessionId === handle.taskId);
const task = JSON.parse((await call('actspan_agent_status', { taskId: handle.taskId })).content[0].text);
check('task status preserves task ownership context', task.taskId === handle.taskId && task.state === 'running');
const agentHandle = JSON.parse((await call('actspan_agent_submit', {
    input: { query: '读取当前页面标题' },
})).content[0].text);
check('agent submit forwards nested query to task runner',
    agentHandle.state === 'queued' && taskSubmitRequest?.params?.query === '读取当前页面标题');
const opened = JSON.parse((await call('actspan_tab_open', { url: 'https://example.test/docs' })).content[0].text);
check('tab open reports the session-owned task handle', opened.sessionId !== opened.taskId);
// D10: omitting focus must still reach the extension as a background tab.
check('tab open defaults to a background tab', tabOpenRequest?.params?.active === false);
const focused = JSON.parse((await call('actspan_tab_open', { url: 'https://example.test/seen', focus: true })).content[0].text);
check('focus:true forwards the foreground request without leaking the MCP-only param',
    focused.tabId === 4242 && tabOpenRequest?.params?.active === true && tabOpenRequest?.params?.focus === undefined);
const unfocused = JSON.parse((await call('actspan_tab_open', { url: 'https://example.test/later', focus: false })).content[0].text);
check('focus:false stays in the background', unfocused.tabId === 4242 && tabOpenRequest?.params?.active === false);
await call('actspan_agent_status', { taskId: opened.taskId });
check('task lookup inherits the current session for a tab-owned task id',
    statusContext?.taskId === opened.taskId && statusContext?.sessionId === opened.sessionId);

const webPair = await handshake({ headers: { Origin: 'https://evil.example' }, send: [{ type: 'pair' }] }, frame => frame.type === 'pair_ok');
check('web origin cannot pair', webPair.close === 4001);
check('web rejection does not leak token', !webPair.frames.some(frame => frame.token === pair.token));
const bad = await handshake({ headers: { Origin: `chrome-extension://${extensionId}` }, send: [{ type: 'hello', token: 'wrong' }] }, () => true);
check('wrong token is rejected', bad.close === 4001);

await client.close();
console.log(failures ? `\n${failures} e2e checks failed` : '\nall e2e checks passed');
process.exit(failures ? 1 : 0);
