// 模拟用户全量测试（第一性原理口径）：不照规格打勾，而是问「一个真实用户想让
// AI 替他操作自己的浏览器，这件事到底能不能成」，然后在真机、真站点上跑一遍。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = {
    ...getDefaultEnvironment(),
    ACTSPAN_BRIDGE_URL: 'ws://127.0.0.1:30121',
    ACTSPAN_EXTENSION_IDS: 'kcmnglipboiheaicckjcinkdmpgjcgog',
    ACTSPAN_API_URL: '', ACTSPAN_API_KEY: '',
};
const client = new Client({ name: 'sim-user', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(here, '..', 'index.js')], cwd: path.join(here, '..'), env }));

const notes = [];
const say = (kind, id, detail) => { notes.push({ kind, id, detail }); console.log(`${kind}  ${id}  ${detail}`); };
const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const parts = res.content ?? [];
    const text = parts.map((p) => p.text).join('\n') ?? '';
    return { isError: res.isError === true, text, parts };
};
const j = (v) => { try { return JSON.parse(v); } catch { return null; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const tabIds = [];
const openTab = async (url) => {
    const r = await call('actspan_tab_open', { url });
    const id = j(r.text)?.tabId;
    if (Number.isInteger(id)) tabIds.push(id);
    return id;
};

// ── 用户请求 1：「把这个仓库页面读给我，我要知道它是干嘛的」 ──────────────
const REPO = 'https://github.com/alchaincyf/huashu-chrome';
let tabId = await openTab(REPO);
await wait(2500);
try {
    const read = await call('actspan_page_read', { tabId });
    // 校验正文本身，而不是 JSON 信封长度：url 里就含 huashu，拿整段文本判断恒真。
    const p = j(read.text);
    const content = String(p?.content ?? '');
    const useful = !read.isError && content.length > 400 && /huashu|chrome|agent/i.test(content);
    say(useful ? 'OK' : 'WEAK', 'U1 读页面', `len=${content.length} url=${String(p?.url || '').slice(0, 50)}`);
} catch (e) { say('FAIL', 'U1 读页面', e.message); }

// ── 用户请求 2：「这页上有什么能点的？列出来」 ────────────────────────────
let snap = null;
try {
    const s = await call('actspan_page_snapshot', { tabId });
    snap = j(s.text);
    const els = snap?.elements ?? [];
    const named = els.filter((e) => e.name || e.text).length;
    const roles = new Set(els.map((e) => e.role).filter(Boolean));
    say(els.length > 10 && named > 5 ? 'OK' : 'WEAK', 'U2 快照',
        `元素=${els.length} 有名字=${named} 角色=${roles.size} [${[...roles].slice(0, 8).join(',')}]`);
} catch (e) { say('FAIL', 'U2 快照', e.message); }

// ── 用户请求 3：「用自然语言找一个东西并点开它」 ──────────────────────────
try {
    const f = await call('actspan_page_click', { tabId, find: { role: 'link', name: 'Code' } });
    const p = j(f.text);
    // changed 只表示 DOM 变了；导航型点击返回 status=requested。二者任一才算点到了东西。
    const acted = !f.isError && (p?.changed === true || p?.clicked === true || p?.status === 'requested');
    say(acted ? 'OK' : 'WEAK', 'U3 find+click', `isError=${f.isError} changed=${p?.changed} status=${p?.status} msg=${String(p?.message || f.text).slice(0, 60)}`);
} catch (e) { say('FAIL', 'U3 find+click', e.message); }

// ── 用户请求 4：「截个图我看看」 ─────────────────────────────────────────
try {
    const s = await call('actspan_screenshot', { tabId });
    // 截图正文是图片分片、text 恒为空：只看 isError 等于没验证。
    const hasImage = s.parts.some((part) => part.type === 'image' && String(part.data || '').length > 100);
    say(!s.isError && hasImage ? 'OK' : 'WEAK', 'U4 截图', `isError=${s.isError} 图片分片=${hasImage} parts=${s.parts.length}`);
} catch (e) { say('FAIL', 'U4 截图', e.message); }

// ── 用户请求 5：「这页刚才发了哪些请求？」 ───────────────────────────────
try {
    // 首次调用才开始抓包，不 reload 只能拿到 0 条：这正是产品对「刚才发了什么」的真实边界。
    const n = await call('actspan_network_list', { tabId, reload: true, limit: 50 });
    const p = j(n.text);
    const total = Number(p?.total ?? 0);
    say(!n.isError && total > 0 ? 'OK' : 'WEAK', 'U5 网络', `total=${total} diag=${String(p?.diagnostic || '').slice(0, 60)}`);
} catch (e) { say('FAIL', 'U5 网络', e.message); }

// ── 用户请求 6：「往下滚，把内容给我」 ───────────────────────────────────
try {
    // page_scroll 的入参是 {selector, deltaX, deltaY}，没有 direction；整页 innerText 长度不随滚动变化，所以只断言动作成功。
    const s = await call('actspan_page_scroll', { tabId, deltaY: 800 });
    const p = j(s.text);
    say(!s.isError ? 'OK' : 'WEAK', 'U6 滚动', `isError=${s.isError} 结果=${JSON.stringify(p ?? s.text).slice(0, 80)}`);
} catch (e) { say('FAIL', 'U6 滚动', e.message); }

// ── 用户请求 7：「在搜索框里输入关键词并回车」 ────────────────────────────
// GitHub 仓库页根本没有搜索输入框（搜索入口是个按钮，点开才出现输入框），
// 所以换一个真有搜索框的站点，用 find 走完整流程，并断言页面真的跳转了。
try {
    await call('actspan_tab_navigate', { tabId, url: 'https://en.wikipedia.org/wiki/Main_Page' });
    await wait(3000);
    const s = await call('actspan_page_type', { tabId, find: { role: 'textbox', name: 'Search Wikipedia' }, text: 'Chrome DevTools', submit: true });
    await wait(3000);
    const url = String(j((await call('actspan_page_read', { tabId })).text)?.url ?? '');
    const submitted = /search=Chrome\+DevTools|Chrome_DevTools/i.test(url);
    say(s.isError === false && submitted ? 'OK' : 'WEAK', 'U7 输入并提交', `isError=${s.isError} 已跳转=${submitted} url=${url.slice(0, 70)}`);
} catch (e) { say('FAIL', 'U7 输入并提交', e.message); }

// ── 用户请求 8：「换个站点，读一篇文档」 ─────────────────────────────────
try {
    const t2 = await openTab('https://datawhalechina.github.io/jev-cookbook/course/01/');
    await wait(2500);
    const read = await call('actspan_page_read', { tabId: t2 });
    const p = j(read.text);
    const body = String(p?.content ?? read.text);
    say(body.length > 300 ? 'OK' : 'WEAK', 'U8 换站读文档', `len=${body.length} title=${String(p?.title || '').slice(0, 50)}`);
} catch (e) { say('FAIL', 'U8 换站读文档', e.message); }

// ── 用户请求 9：「用一条脚本把这几步一次做完」 ───────────────────────────
try {
    // schema 要顶层 steps；合法原子动作是 click/type/select/scroll/wait/assert/read，没有 goto。
    const act = await call('actspan_act', {
        tabId,
        steps: [
            { action: 'scroll', deltaY: 300 },
            { action: 'read' },
        ],
    });
    const p = j(act.text);
    // act 用 runStructured：步骤失败时 isError 仍为 false，必须看 success。
    say(!act.isError && p?.success === true ? 'OK' : 'WEAK', 'U9 act 脚本', `isError=${act.isError} success=${p?.success} trace=${JSON.stringify(p?.trace ?? []).slice(0, 70)}`);
} catch (e) { say('FAIL', 'U9 act 脚本', e.message); }

// ── 用户请求 10：「给我推个飞书通知」 ────────────────────────────────────
try {
    const f = await call('actspan_feishu_push', { title: 'sim', message: 'sim' });
    // 这条依赖扩展里有没有配 Webhook：配了会真发，没配会给可操作提示。两种情况都算正常，只有「报错且无指引」才是问题。
    const actionable = /Webhook|Options|启用|配置/i.test(f.text);
    const delivered = f.isError === false;
    say(delivered || actionable ? 'OK' : 'WEAK', 'U10 飞书', `isError=${f.isError} 已发送=${delivered} 提示可操作=${actionable} text=${f.text.slice(0, 80)}`);
} catch (e) { say('FAIL', 'U10 飞书未配置', e.message); }

// ── 用户请求 11：「我关掉这个标签页」 ────────────────────────────────────
try {
    const c = await call('actspan_tab_close', { tabId: tabIds[0] });
    say(c.isError === false ? 'OK' : 'WEAK', 'U11 关标签页', `isError=${c.isError}`);
} catch (e) { say('FAIL', 'U11 关标签页', e.message); }

// ── 用户请求 12：「现在有哪些标签页是我能让你操作的？」 ──────────────────
try {
    const l = await call('actspan_tabs_list', {});
    const p = j(l.text);
    // tabs.list 返回裸数组，不是 { tabs } 信封。
    const list = Array.isArray(p) ? p : (p?.tabs ?? p?.items ?? []);
    say(!l.isError && list.length > 0 ? 'OK' : 'WEAK', 'U12 标签页列表', `isError=${l.isError} count=${Array.isArray(list) ? list.length : 'n/a'}`);
} catch (e) { say('FAIL', 'U12 标签页列表', e.message); }

for (const id of tabIds.slice(1)) { try { await call('actspan_tab_close', { tabId: id }); } catch { /* cleanup */ } }
await client.close();

const tally = notes.reduce((acc, n) => { acc[n.kind] = (acc[n.kind] || 0) + 1; return acc; }, {});
console.log('\n=== 汇总 ===', JSON.stringify(tally));
process.exit(0);
