// §4.1「子集达成」判据的真机验收：对着用户正在跑的 Chrome + 已配对的扩展跑。
//
// 前置：扩展已加载并用 actspan-install 配对到 ACTSPAN_BRIDGE_URL 指向的桥；
// 本脚本自己起靶场服务器（随机端口，127.0.0.1 与 localhost 双主机名制造跨源），
// 自建后台标签页，绝不触碰用户已有标签页，跑完关闭。
//
//   node test/acceptance.mjs
//
// 环境变量：ACTSPAN_BRIDGE_URL（默认 ws://127.0.0.1:30121）、
//          ACTSPAN_EXTENSION_IDS（默认取 package.json 的 actspan.extensionKey 推导值）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startFixtureHost } from '../../test/browser-fixtures.mjs';
import { extensionIdFromKey } from '../install.js';
import { stopBridgeDaemon } from '../bridge-lock.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../package.json', import.meta.url), 'utf8'));
const EXT_ID = process.env.ACTSPAN_EXTENSION_IDS || extensionIdFromKey(packageJson.actspan.extensionKey);
const BRIDGE_URL = process.env.ACTSPAN_BRIDGE_URL || 'ws://127.0.0.1:30121';
const ZERO_PORT = Number(process.env.ACTSPAN_ACCEPTANCE_ZERO_PORT || 31931);

const results = [];
const record = (id, ok, detail) => {
    results.push({ id, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${detail}`);
};

const env = {
    ...getDefaultEnvironment(),
    ACTSPAN_BRIDGE_URL: BRIDGE_URL,
    ACTSPAN_EXTENSION_IDS: EXT_ID,
    ACTSPAN_API_URL: '',
    ACTSPAN_API_KEY: '',
};
const spawnServer = (name) => new Client({ name, version: '1.0.0' }).connect(new StdioClientTransport({
    command: process.execPath, args: [path.join(here, '..', 'index.js')], cwd: path.join(here, '..'), env,
}));

const call = async (c, name, args = {}) => {
    const res = await c.callTool({ name, arguments: args });
    const text = res.content?.map((part) => part.text).join('\n') ?? '';
    return { isError: res.isError === true, text };
};
const json = (value) => { try { return JSON.parse(value); } catch { return null; } };

const host = await startFixtureHost();
const BASE = host.url('acceptance.html', '127.0.0.1');

const client = new Client({ name: 'actspan-acceptance', version: '1.0.0' });
await client.connect(new StdioClientTransport({
    command: process.execPath, args: [path.join(here, '..', 'index.js')], cwd: path.join(here, '..'), env,
}));

const { tools } = await client.listTools();
console.log('tools:', tools.length);

// ── 1a. 已配对模式：status 可读且 loop_mode=enabled ────────────────────
try {
    const status = await call(client, 'actspan_status');
    const parsed = json(status.text);
    record('4.1-1a', status.isError === false && parsed?.connected === true && parsed?.loop_mode === 'enabled',
        `connected=${parsed?.connected} loop_mode=${parsed?.loop_mode} pairing_required=${parsed?.pairing_required}`);
} catch (error) { record('4.1-1a', false, String(error.message)); }

// ── 1b. 零配置模式：无 API_URL/KEY/EXT_IDS，进程仍能起并答 status ───────
try {
    const zero = new Client({ name: 'actspan-acceptance-zero', version: '1.0.0' });
    await zero.connect(new StdioClientTransport({
        command: process.execPath, args: [path.join(here, '..', 'index.js')], cwd: path.join(here, '..'),
        env: { ...getDefaultEnvironment(), ACTSPAN_BRIDGE_URL: `ws://127.0.0.1:${ZERO_PORT}`, ACTSPAN_EXTENSION_IDS: '', ACTSPAN_API_URL: '', ACTSPAN_API_KEY: '' },
    }));
    const status = await call(zero, 'actspan_status');
    const parsed = json(status.text);
    record('4.1-1b', status.isError === false && parsed?.loop_mode === 'disabled' && parsed?.pairing_required === true && parsed?.hub_listening === true,
        `loop_mode=${parsed?.loop_mode} pairing_required=${parsed?.pairing_required} hub_listening=${parsed?.hub_listening}`);
    await zero.close();
    await stopBridgeDaemon({ port: ZERO_PORT });
} catch (error) { record('4.1-1b', false, String(error.message)); }

// ── 10. 第二个 MCP server 连同一 hub，无 EADDRINUSE ────────────────────
try {
    const second = new Client({ name: 'actspan-acceptance-2', version: '1.0.0' });
    await second.connect(new StdioClientTransport({
        command: process.execPath, args: [path.join(here, '..', 'index.js')], cwd: path.join(here, '..'), env,
    }));
    const status2 = await call(second, 'actspan_status');
    record('4.1-10', status2.isError === false && json(status2.text)?.connected === true, 'second server shares the same hub');
    await second.close();
} catch (error) { record('4.1-10', false, String(error.message)); }

// 自建后台标签页（绝不碰用户已有标签页）
let tabId = null;
let taskId = null;
try {
    const opened = await call(client, 'actspan_tab_open', { url: BASE });
    const parsed = json(opened.text);
    tabId = parsed?.tabId ?? parsed?.tab_id;
    taskId = parsed?.taskId ?? parsed?.task_id ?? null;
    record('tab.open', Number.isInteger(tabId), `tabId=${tabId}`);
} catch (error) { record('tab.open', false, String(error.message)); }
const ctx = tabId === null ? {} : { tabId };
// data.fetch 会自建临时标签页，按任务归属鉴权，必须带 taskId
const fetchCtx = taskId === null ? ctx : { ...ctx, taskId };

const navigate = async (url) => {
    await call(client, 'actspan_tab_navigate', { ...ctx, url });
    await new Promise((resolve) => setTimeout(resolve, 900));
};

// ── 6. page.click 返回值含 changed，且印出实际命中的元素 ────────────────
try {
    await navigate(BASE);
    const click = await call(client, 'actspan_page_click', { ...ctx, selector: '#plain' });
    const parsed = json(click.text);
    record('4.1-6', parsed !== null && typeof parsed.changed === 'boolean' && parsed.changed === true,
        `changed=${parsed?.changed} hit=${JSON.stringify(parsed?.target ?? parsed?.element)?.slice(0, 120)}`);
} catch (error) { record('4.1-6', false, String(error.message)); }

// ── 5. page.read 读凭据页：无凭据明文 ──────────────────────────────────
try {
    await navigate(BASE);
    const read = await call(client, 'actspan_page_read', { ...ctx, selector: '#secret' });
    const leaked = read.text.includes('hunter2secret');
    record('4.1-5', read.isError === false && !leaked, `leaked=${leaked} text=${read.text.slice(0, 180)}`);
} catch (error) { record('4.1-5', false, String(error.message)); }

// ── 4. page.eval 不能在敏感表单上触发提交 ──────────────────────────────
try {
    await navigate(BASE);
    const evalRes = await call(client, 'actspan_page_eval', { ...ctx, expression: "document.getElementById('sensitive-form').requestSubmit(); window.__submitted === 1" });
    const submitted = evalRes.isError === false && /true/.test(evalRes.text);
    record('4.1-4', !submitted, `isError=${evalRes.isError} submitted=${submitted} text=${evalRes.text.slice(0, 180)}`);
} catch (error) { record('4.1-4', false, String(error.message)); }

// ── 7. SVG 图标按钮：点击真的发生 ──────────────────────────────────────
try {
    await navigate(BASE);
    const click = await call(client, 'actspan_page_click', { ...ctx, selector: '#svg-link' });
    const after = await call(client, 'actspan_page_read', { ...ctx, selector: '#svg-out' });
    record('4.1-7', after.text.includes('svg-hit'), `click.isError=${click.isError} out=${after.text.slice(0, 140)}`);
} catch (error) { record('4.1-7', false, String(error.message)); }

// ── 8. 只监听 mousedown 的下拉能被打开 ─────────────────────────────────
try {
    await navigate(BASE);
    await call(client, 'actspan_page_click', { ...ctx, selector: '#dropdown' });
    const list = await call(client, 'actspan_page_read', { ...ctx, selector: '#dropdown-list' });
    record('4.1-8', list.text.includes('dropdown-items'), `list=${list.text.slice(0, 140)}`);
} catch (error) { record('4.1-8', false, String(error.message)); }

// ── 9. 跨源 iframe 内元素进快照（ref 形如 e5@f2）且可操作 ───────────────
try {
    await navigate(BASE);
    const snap = await call(client, 'actspan_page_snapshot', ctx);
    const parsed = json(snap.text);
    const inner = parsed?.elements?.find((el) => el.text === 'inner-button');
    const frameRef = inner?.element_id;
    const hasFrameRef = typeof frameRef === 'string' && /@f\d+$/.test(frameRef);
    const frameListed = parsed?.frames?.some((f) => f.url.includes('frame-inner.html')) === true;
    let operable = false;
    if (hasFrameRef) {
        // ref 与 snapshotId 必须成对出现，否则桥会直接拒绝。
        const click = await call(client, 'actspan_page_click', { ...ctx, ref: frameRef, snapshotId: parsed.snapshot_id });
        const receipt = json(click.text);
        // 内层按钮的效果落在兄弟节点 #inner-out 上，按钮自身不会 changed；
        // 回执里的 surrounding_text 是跨源框架内真实生效的证据。
        operable = click.isError === false && String(receipt?.surrounding_text || '').includes('inner-hit');
    }
    record('4.1-9', hasFrameRef && frameListed && operable,
        `frameRef=${frameRef} frameListed=${frameListed} operable=${operable} frames=${JSON.stringify(parsed?.frames)}`);
} catch (error) { record('4.1-9', false, String(error.message)); }

// ── 11. data.fetch 在含跨源 iframe 的页面上取主 frame，不取 iframe 内容 ──
try {
    await navigate(BASE);
    const fetched = json((await call(client, 'actspan_data_fetch', { ...fetchCtx, url: BASE, max_content_length: 500 })).text);
    const ok = fetched?.url === BASE && fetched?.title === 'ActSpan 验收靶场';
    record('4.1-11', ok, `url=${fetched?.url} title=${fetched?.title}`);
} catch (error) { record('4.1-11', false, String(error.message)); }

// ── 12. status.update 走扩展能力，不被 daemon 的 status.* 命名空间拦下 ──
try {
    const status = await call(client, 'actspan_status_update', { ...fetchCtx, text: '验收：状态更新' });
    const parsed = json(status.text);
    record('4.1-12', status.isError === false && parsed?.acknowledged === true && Number.isInteger(parsed?.tabId),
        `acknowledged=${parsed?.acknowledged} tabId=${parsed?.tabId} text=${status.text.slice(0, 160)}`);
} catch (error) { record('4.1-12', false, String(error.message)); }

// ── 13. G11：aria-selected 三态与 class 状态进快照 ──────────────────────
try {
    await navigate(host.url('gaps.html', '127.0.0.1'));
    const parsed = json((await call(client, 'actspan_page_snapshot', ctx)).text);
    const els = parsed?.elements ?? [];
    const byText = (needle) => els.find((el) => String(el.text || '').includes(needle));
    const tabA = byText('Tab A');
    const tabB = byText('Tab B');
    const tabC = byText('Tab C');
    const ok = tabA?.aria_selected === true && tabB?.aria_selected === false &&
        tabC !== undefined && tabC.aria_selected === undefined &&
        typeof tabA?.class_name === 'string' && tabA.class_name.includes('is-active');
    record('4.1-13', ok,
        `A=${JSON.stringify({ sel: tabA?.aria_selected, cls: tabA?.class_name })} B=${tabB?.aria_selected} C=${JSON.stringify(tabC?.aria_selected)}`);
} catch (error) { record('4.1-13', false, String(error.message)); }

// ── 14. G15：嵌套装饰候选折叠，弱候选保留，名字不丢 ────────────────────
try {
    const parsed = json((await call(client, 'actspan_page_snapshot', ctx)).text);
    const els = parsed?.elements ?? [];
    const glyph = els.find((el) => el.aria_label === 'star');
    const favorite = els.find((el) => String(el.text || '').includes('Favorite'));
    const close = els.find((el) => String(el.text || '').includes('×'));
    const emailInput = els.find((el) => el.name === 'email');
    const emailLabel = els.find((el) => el.tag === 'label' && String(el.text || '').includes('Email'));
    const ok = glyph === undefined && favorite !== undefined && close !== undefined &&
        emailInput !== undefined && emailLabel === undefined;
    record('4.1-14', ok,
        `glyphFolded=${glyph === undefined} buttonKept=${favorite !== undefined} weakKept=${close !== undefined} inputKept=${emailInput !== undefined} labelFolded=${emailLabel === undefined}`);
} catch (error) { record('4.1-14', false, String(error.message)); }

// ── 15. G13：滚动补发 wheel，且 changed:false 并列报三因诊断 ───────────
try {
    await navigate(host.url('playground.html', '127.0.0.1'));
    const first = json((await call(client, 'actspan_page_scroll', { ...ctx, selector: '#scroll-box', deltaY: 300 })).text);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const read = json((await call(client, 'actspan_page_read', { ...ctx, selector: '#scroll-result' })).text);
    const wheel = Number(/wheel:(\d+)/.exec(String(read?.content || ''))?.[1] ?? 0);
    // 先滚到边界，再滚同样距离即可制造 changed:false
    await call(client, 'actspan_page_scroll', { ...ctx, selector: '#scroll-box', deltaY: 100000 });
    const edge = json((await call(client, 'actspan_page_scroll', { ...ctx, selector: '#scroll-box', deltaY: 100000 })).text);
    const diagnostic = String(edge?.diagnostic || '');
    const ok = first?.changed === true && wheel > 0 && edge?.changed === false &&
        /不可滚动/.test(diagnostic) && /focus:true/.test(diagnostic) && /懒加载/.test(diagnostic) &&
        // 已滚到边界，余量必须是 0；报总量（320）会让调用方以为还能再滚。
        /余量 x=0 y=0/.test(diagnostic);
    record('4.1-15', ok,
        `changed=${first?.changed} wheel=${wheel} edgeChanged=${edge?.changed} diagnostic=${diagnostic.slice(0, 200)}`);
} catch (error) { record('4.1-15', false, String(error.message)); }

// ── 2. 能列网络请求 ────────────────────────────────────────────────────
try {
    await navigate(BASE);
    const net = await call(client, 'actspan_network_list', { ...ctx });
    const parsed = json(net.text);
    record('4.1-2', net.isError === false && parsed !== null && typeof parsed.total === 'number',
        `total=${parsed?.total} diagnostic=${String(parsed?.diagnostic).slice(0, 80)}`);
} catch (error) { record('4.1-2', false, String(error.message)); }

// ── 3. 飞书未配置时的错误信息 ──────────────────────────────────────────
try {
    const feishu = await call(client, 'actspan_feishu_push', { title: 't', message: 'm' });
    record('4.1-3', feishu.isError === true || /Webhook|entry|name|type|enabled|host/i.test(feishu.text),
        `text=${feishu.text.slice(0, 200)}`);
} catch (error) { record('4.1-3', false, String(error.message)); }

if (tabId !== null) {
    try { await call(client, 'actspan_tab_close', { tabId }); console.log(`closed tab ${tabId}`); }
    catch (error) { console.log('close failed', error.message); }
}
await client.close();
await host.close();

const passed = results.filter((row) => row.ok).length;
console.log(`\n=== ${passed}/${results.length} passed ===`);
for (const row of results.filter((r) => !r.ok)) console.log(`FAILED ${row.id}: ${row.detail}`);
process.exitCode = passed === results.length ? 0 : 1;
