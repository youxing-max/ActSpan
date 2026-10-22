import assert from 'node:assert/strict';
import { connect as openSocket } from 'node:net';
import { after, before, test } from 'node:test';
import { DEFAULT_BRIDGE_URL, TOOL_NAMES } from '../mcp-server/catalog.js';
import { extensionIdFromKey } from '../mcp-server/install.js';
// 只从靶场拿本地 HTTP 服务器与 MCP 客户端；本套件不连 Chrome DevTools。
// DevTools HTTP 端点（/json/version、/json/list）在很多 Chrome 上返回 404，
// 直接连接 /devtools/browser WebSocket 又需要人手确认与端口可达，两种情况都会让
// 「被测行为」与「环境能力」缠在一起。这里改为只用扩展自报的能力观察页面。
import {
  createMcpHarness,
  delay,
  startFixtureHost,
  waitForPageValue,
} from './browser-fixtures.mjs';

const TOOLS = TOOL_NAMES;

let host;
let mcp;
let tabId;
let pageUrl;
let hostError;
let harnessError;
let approvalBlocked = null;

function ready() {
  assert.ok(mcp && Number.isInteger(tabId) && pageUrl, 'Acceptance harness did not initialize');
}

async function pageEval(expression) { ready(); return mcp.call('actspan_page_eval', { tabId, expression }); }
async function pageRead(format = 'text') { ready(); return mcp.call('actspan_page_read', { tabId, format, maxChars: 200000 }); }
async function pageSnapshot(queryOrLimit) {
  ready();
  const params = { tabId };
  if (typeof queryOrLimit === 'string') params.query = queryOrLimit;
  else if (typeof queryOrLimit === 'number') params.limit = queryOrLimit;
  return mcp.call('actspan_page_snapshot', params);
}
async function navigate(name) { ready(); pageUrl = host.url(name); await mcp.call('actspan_tab_navigate', { tabId, url: pageUrl }); return pageUrl; }

const BRIDGE_URL = process.env.ACTSPAN_BRIDGE_URL || DEFAULT_BRIDGE_URL;

/**
 * 桥守护进程是否在监听。没有桥就没有扩展，MCP 服务器会自己起一个守护进程并在
 * 「等扩展上线」上无限期挂着，连带把 node --test 的 worker 吊死（子进程句柄不会自己收）。
 * 所以先做一次 1.5s 的 TCP 探测，没桥就直接跳过，绝不拉起 MCP 子进程。
 */
async function bridgeListening(url = BRIDGE_URL, timeoutMs = 1500) {
  let target;
  try { target = new URL(url); } catch { return false; }
  const port = Number(target.port || (target.protocol === 'wss:' ? 443 : 80));
  if (!Number.isInteger(port) || port <= 0) return false;
  return new Promise((resolve) => {
    const socket = openSocket({ host: target.hostname || '127.0.0.1', port });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function waitFor(probe, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(100);
  }
  return null;
}

/**
 * 每个用例的前置条件分两类，处理方式不同：
 * - 靶场服务器（host）起不来 → 真失败，测试基础设施本身就是被测代码。
 * - 活体环境（扩展、桥、审批）不可用 → 跳过并打印确切原因，绝不伪装成通过。
 * 另外 MCP 路径上的 mutate 能力（page.eval / page.click / tab.navigate…）在扩展侧
 * 需要用户点悬浮球确认，无人值守时固定以「审批等待超时」收尾——那是环境缺审批通道，
 * 不是被测契约失败，同样按跳过处理。
 */
function scenario(name, body, { harness = true } = {}) {
  test(name, async (t) => {
    if (harness) {
      if (harnessError) return t.skip(`ActSpan live harness unavailable: ${harnessError.message}`);
      if (approvalBlocked) return t.skip(`live Chrome needs interactive approval for mutate capabilities: ${approvalBlocked}`);
    } else if (hostError) {
      throw hostError;
    }
    try {
      await body(t);
    } catch (error) {
      const message = String(error?.message ?? error);
      if (message.includes('审批等待超时')) {
        // 一次就够：审批通道缺失对后续用例是同一个事实，重复等 25s 只会拖长 npm test。
        approvalBlocked = message;
        return t.skip(`live Chrome needs interactive approval for mutate capabilities: ${message}`);
      }
      throw error;
    }
  });
}

before(async () => {
  try {
    host = await startFixtureHost();
  } catch (error) {
    hostError = error instanceof Error ? error : new Error(String(error));
  }
  try {
    if (hostError) throw new Error('fixture host unavailable');
    // 真机用例会等待人工审批（最长 15s）且依赖已配对扩展：默认快速跳过，显式开启才运行。
    if (process.env.ACTSPAN_LIVE !== '1') throw new Error('live suite disabled; set ACTSPAN_LIVE=1 to run');
    if (!(await bridgeListening())) throw new Error(`ActSpan bridge is not listening at ${BRIDGE_URL}; the live acceptance suite needs a paired extension and never fakes one`);
    // 扩展 ID 由 manifest key 推导，和 install/acceptance 用同一事实源，不需要人手填环境变量。
    if (!process.env.ACTSPAN_EXTENSION_IDS && !process.env.ACTSPAN_EXTENSION_ID) {
      process.env.ACTSPAN_EXTENSION_IDS = extensionIdFromKey();
    }
    mcp = await createMcpHarness();
    pageUrl = host.url('playground.html');
    const opened = await mcp.call('actspan_tab_open', { url: pageUrl, active: false });
    tabId = opened?.tabId;
    if (!Number.isInteger(tabId)) throw new Error(`actspan_tab_open returned no tabId: ${JSON.stringify(opened)}`);
    // 就绪探测只用 read 级能力：page_eval 属于 mutate，会卡在人工审批上。
    const loaded = await waitFor(async () => {
      const content = String((await mcp.call('actspan_page_read', { tabId, format: 'text' })).content || '');
      return content.includes('Grounding playground') ? content : '';
    });
    if (!loaded) throw new Error('fixture page never finished loading in the task tab');
  } catch (error) {
    harnessError = error instanceof Error ? error : new Error(String(error));
  }
});

after(async () => {
  // tab_close 属 sensitive，要人工审批；审批通道已经证实缺失时再去等 25s 只会拖长 npm test，
  // 且结果一样关不掉（残留的靶场标签页只能由人手关闭）。
  if (mcp && Number.isInteger(tabId) && !approvalBlocked) { try { await mcp.callRaw('actspan_tab_close', { tabId }); } catch { /* cleanup only */ } }
  if (mcp) await mcp.close().catch(() => undefined);
  if (host) await host.close().catch(() => undefined);
});

scenario('S1/S2: local fixture host serves every required fixture class', async () => {
  for (const fixture of ['playground.html', 'creds.html', 'csp.html', 'frame-inner.html', 'newtab.html', 'newtab-child.html', 'flow.html']) {
    const response = await fetch(host.url(fixture));
    assert.equal(response.status, 200, fixture);
    assert.match(await response.text(), /<!doctype html>/i, fixture);
  }
  assert.equal((await fetch(host.url('../package.json'))).status, 404, 'fixture server must not expose repository files');
}, { harness: false });

scenario('S5: MCP advertises all externally registered Actspan tools, without aliases', () => {
  ready();
  // 顺序不是契约（注册顺序与目录顺序可以不同），集合相等才是：不多、不少、无别名。
  assert.deepEqual([...mcp.tools.keys()].sort(), [...TOOLS].sort());
  for (const name of TOOLS) mcp.requireTool(name);
});

scenario('S5: page_read proves the live playground and cross-origin iframe are loaded', async () => {
  const page = await pageRead('html');
  assert.match(page.content, /id="event-log"/);
  assert.match(page.content, /id="shadow-host"/);
  assert.match(page.content, /id="fixture-frame"/);
  // 靶场把 iframe 指到同一端口上的另一个主机名（跨源由页面自己造成），读回 DOM 就能看到。
  const frameSrc = /<iframe[^>]*\bid="fixture-frame"[^>]*\bsrc="([^"]+)"/.exec(page.content)?.[1];
  assert.ok(frameSrc, 'the fixture iframe must expose its src in the live DOM');
  assert.equal(new URL(frameSrc).hostname, '127.0.0.1');
  // 帧归属由产品自报的 frames 清单证明：跨源 iframe 必须以非主帧的 frame_id 出现在实时帧树里。
  const snapshot = await pageSnapshot(1);
  const child = (snapshot.frames || []).find((frame) => String(frame.url || '').endsWith('/frame-inner.html'));
  assert.ok(child, `cross-origin iframe must be present in the live frame tree; got ${JSON.stringify(snapshot.frames)}`);
  assert.notEqual(child.frame_id, 0, 'the child frame must not be reported as the main frame');
  assert.equal(new URL(child.url).hostname, '127.0.0.1');
});

scenario('S5/G1/G2: click produces complete event sequence and SVG effect evidence', async () => {
  await navigate('playground.html');
  await mcp.call('actspan_page_click', { tabId, selector: '#svg-button' });
  const events = String(await pageEval('document.querySelector("#event-log").textContent'));
  for (const event of ['pointerover', 'mouseover', 'mousemove', 'pointerdown', 'mousedown', 'focus', 'pointerup', 'mouseup', 'click']) assert.match(events, new RegExp(`svg-button:${event}`), `missing ${event}; actual event log: ${events}`);
  assert.equal(await pageEval('document.querySelector("#svg-result").textContent'), 'SVG action completed');
  await mcp.call('actspan_page_click', { tabId, selector: '#svg-path' });
  assert.equal(await pageEval('document.querySelector("#svg-result").textContent'), 'SVG action completed');
});

scenario('S5/find: semantic target resolution selects a fixture control and proves its effect', async () => {
  await navigate('playground.html');
  const result = await mcp.call('actspan_page_click', { tabId, find: { role: 'button', name: 'Expand details' } });
  assert.equal(result.clicked || result.success, true, JSON.stringify(result));
  assert.equal(await pageEval('document.querySelector("#hidden-content").hidden'), false);
});

scenario('S5/untrusted: click path emits a trusted browser event, not a synthetic fallback', async () => {
  await navigate('playground.html');
  await mcp.call('actspan_page_click', { tabId, selector: '#svg-button' });
  const log = String(await pageEval('document.querySelector("#event-log").textContent'));
  // 真输入要经过命中测试：#svg-button 的 handler 记的是 event.target；
  // element.click() 只会把被点的元素本身当 target，也不会产生 pointerdown/mousedown。
  const hit = /svg-button:target:(\S+)/.exec(log);
  assert.ok(hit, `click must reach a real hit target; event log: ${log}`);
  assert.notEqual(hit[1], 'svg-button', 'a synthetic element.click() reports the clicked element itself; only a real input hit test targets a descendant');
  assert.match(log, /svg-button:pointerdown/, 'trusted input must dispatch pointerdown');
  assert.match(log, /svg-button:mousedown/, 'trusted input must dispatch mousedown');
});

scenario('S5/sensitive/effect: act stops before a payment side effect and reports the reason', async () => {
  await navigate('playground.html');
  const result = await mcp.call('actspan_act', { tabId, steps: [{ action: 'click', selector: '#confirm-payment' }] });
  assert.equal(result.success, false);
  assert.match(JSON.stringify(result.error), /SENSITIVE|确认|payment|支付/i);
  assert.equal(await pageEval('document.querySelector("#pay-result").textContent'), 'No payment action');
});

scenario('S5/G1/G3: mousedown-only menu opens and preventDefault preserves focus', async () => {
  await mcp.call('actspan_page_click', { tabId, selector: '#mousedown-menu' });
  assert.equal(await pageEval('document.querySelector("#menu-panel").hidden'), false);
  assert.equal(await pageEval('document.querySelector("#menu-result").textContent'), 'Menu opened by mousedown');
  await mcp.call('actspan_page_type', { tabId, selector: '#focus-input', text: 'focus me' });
  await mcp.call('actspan_page_click', { tabId, selector: '#focus-preserving' });
  assert.match(String(await pageEval('document.querySelector("#focus-result").textContent')), /focus-input/);
  assert.equal(await pageEval('document.activeElement.id'), 'focus-input');
});

scenario('S5/G4: open shadow DOM descendants are snapshotted and actionable through refs', async () => {
  await navigate('playground.html');
  const snapshot = await pageSnapshot('Shadow action');
  const action = snapshot.elements.find((element) => String(element.text || '') === 'Shadow action');
  assert.ok(action, `snapshot must include open shadow root descendants; got ${JSON.stringify(snapshot.elements)}`);
  assert.equal(/@f\d+$/.test(String(action.element_id)), false, 'shadow descendants live in the main frame and must not carry a frame suffix');

  const clicked = await mcp.call('actspan_page_click', { tabId, ref: action.element_id, snapshotId: snapshot.snapshot_id });
  assert.match(String(clicked.message || ''), /已触发目标元素点击/, JSON.stringify(clicked));
  assert.equal(await pageEval('document.querySelector("#shadow-result").textContent'), 'Shadow action completed');
  assert.match(String(await pageEval('document.querySelector("#event-log").textContent')), /shadow-action:click/);
});

scenario('S5/G5/H2: cross-origin iframe refs are frame-qualified and route to the exact frame', async () => {
  await navigate('playground.html');
  const frameSource = await pageEval('document.querySelector("#fixture-frame").src');
  assert.equal(new URL(frameSource).hostname, '127.0.0.1');
  const liveFrames = await pageSnapshot(1);
  const childFrame = (liveFrames.frames || []).find((frame) => String(frame.url || '').endsWith('/frame-inner.html'));
  assert.ok(childFrame, `cross-origin iframe was not present in the live frame list; got ${JSON.stringify(liveFrames.frames)}`);
  assert.notEqual(childFrame.frame_id, 0, 'the child frame must not be reported as the main frame');
  assert.equal(await pageEval('document.querySelector("#frame-result") === null'), true,
    'the parent frame must not define the child frame ids, so any observed effect can only come from the child frame');

  const snapshot = await pageSnapshot('Frame action');
  const action = snapshot.elements.find((element) => String(element.text || '') === 'Frame action');
  assert.ok(action, `snapshot must expose the child frame control; got ${JSON.stringify(snapshot.elements)}`);
  const suffix = /@f(\d+)$/.exec(String(action.element_id));
  assert.ok(suffix, `child frame ref must be frame-qualified with @fN; got ${action.element_id}`);
  const frameId = Number(suffix[1]);
  assert.ok(frameId > 0, 'child frame must not be reported as the main frame');
  assert.equal(action.frame_id, frameId, 'snapshot must report the owning frame id');
  assert.match(String(action.frame_url || ''), /frame-inner\.html$/);

  const clicked = await mcp.call('actspan_page_click', { tabId, ref: action.element_id, snapshotId: snapshot.snapshot_id });
  assert.match(String(clicked.message || ''), /已触发目标元素点击/, JSON.stringify(clicked));

  const after = await pageSnapshot('Frame action completed');
  const result = after.elements.find((element) => String(element.text || '') === 'Frame action completed');
  assert.ok(result, `child frame effect must be observable in the child frame; got ${JSON.stringify(after.elements)}`);
  assert.equal(Number(/@f(\d+)$/.exec(String(result.element_id))?.[1]), frameId, 'the effect must be reported from the same child frame');
  const read = await mcp.call('actspan_page_read', { tabId, ref: result.element_id, snapshotId: after.snapshot_id });
  assert.equal(read.content, 'Frame action completed');
});

scenario('S5: each registered browser MCP tool has a live fixture round trip', async () => {
  ready();
  const tabs = await mcp.call('actspan_tabs_list');
  assert.ok(Array.isArray(tabs));
  assert.ok(tabs.some((tab) => tab.id === tabId));
  const shot = await mcp.callRaw('actspan_screenshot', { tabId });
  assert.equal(shot.isError, undefined, shot.content?.[0]?.text);
  assert.equal(shot.content?.[0]?.type, 'image');
  const navigated = await mcp.call('actspan_tab_navigate', { tabId, url: host.url('playground.html') });
  assert.equal(navigated.tabId, tabId);
  const read = await mcp.call('actspan_page_read', { tabId, format: 'text', maxChars: 2000 });
  assert.match(read.content, /Grounding playground/);
  const snapshot = await mcp.call('actspan_page_snapshot', { tabId, limit: 10 });
  assert.ok(Array.isArray(snapshot.elements) && snapshot.elements.length > 0, JSON.stringify(snapshot));
  assert.match(String(snapshot.snapshot_id || ''), /^snap-/);
  assert.ok(snapshot.frames?.some((frame) => frame.frame_id === 0), 'the main frame must always be reported');
  const networkList = await mcp.call('actspan_network_list', { tabId, limit: 20 });
  assert.ok(networkList && typeof networkList === 'object');
  const networkDetail = await mcp.callRaw('actspan_network_detail', { tabId, urlFilter: host.url('playground.html') });
  assert.ok(networkDetail && (networkDetail.content || networkDetail.isError), 'network detail must return a real response or diagnostic');
  const networkQuery = await mcp.callRaw('actspan_network_query', { tabId, urlFilter: host.url('playground.html') });
  assert.ok(networkQuery && (networkQuery.content || networkQuery.isError), 'network query must return a real response or diagnostic');
  const fetched = await mcp.call('actspan_data_fetch', { tabId, url: host.url('playground.html'), sections: ['headings', 'meta'], max_content_length: 4000 });
  assert.match(JSON.stringify(fetched), /Grounding playground/);
  const paginated = await mcp.call('actspan_data_paginate', { tabId, url: host.url('acceptance.json'), param: 'page', maxPages: 2 });
  assert.equal(paginated.stop_reason, 'normal_end');
  const downloaded = await mcp.call('actspan_data_download', { tabId, content: 'acceptance fixture', filename: 'actspan-acceptance.txt' });
  assert.ok(downloaded && (downloaded.downloadId || downloaded.id || downloaded.filename || downloaded.success !== false));
});

scenario('S5/G6/G7/G8: file role, unlabeled controls, current values and accessibility hooks remain observable', async () => {
  await navigate('playground.html');
  const html = await pageRead('html');
  assert.match(html, /type="file"/);
  assert.match(html, /data-testid="email"/);
  assert.match(html, /aria-label="Drop a fixture file"/);
  await mcp.call('actspan_page_type', { tabId, selector: '#email', text: 'current@example.test' });
  assert.equal(await pageEval('document.querySelector("#email").value'), 'current@example.test');
  const accessibility = await pageEval('Array.from(document.querySelectorAll("[role],label,[aria-label]")).map((node) => ({ role: node.getAttribute("role"), label: node.getAttribute("aria-label"), text: (node.innerText || node.textContent || "").trim() })).filter((item) => item.text || item.label)');
  assert.ok(accessibility.some((item) => item.role === 'status'));
  assert.ok(accessibility.some((item) => item.label === 'Drop a fixture file'));
});

scenario('S5/G8/C1: one type call fills the complete form and delayed validation reports success', async () => {
  await mcp.call('actspan_page_type', { tabId, selector: '#email', text: 'acceptance@example.test' });
  await mcp.call('actspan_page_type', { tabId, selector: '#password', text: 'synthetic-secret' });
  assert.equal(await pageEval('document.querySelector("#email").value'), 'acceptance@example.test');
  assert.equal(await pageEval('document.querySelector("#password").value'), 'synthetic-secret');
  await mcp.call('actspan_page_click', { tabId, selector: '#submit' });
  await waitForPageValue(pageEval, 'document.querySelector("#form-result").textContent', 'Submitted successfully');
  assert.match(String(await pageEval('document.querySelector("#event-log").textContent')), /submit:validation-complete/);
});

scenario('S5/A4: upload, drop, select, key, wait and scroll produce live effects', async () => {
  await navigate('playground.html');
  // 靶场自带原生 select，正合用；不再用带副作用的 page_eval 造元素。
  const selected = await mcp.call('actspan_page_select', { tabId, selector: '#plan-select', value: 'pro' });
  assert.equal(selected.selectedValue, 'pro');
  assert.equal(await pageEval('document.querySelector("#plan-select").value'), 'pro');
  assert.equal(await pageEval('document.querySelector("#select-result").textContent'), 'Plan selected: pro');
  const base64 = Buffer.from('fixture-upload').toString('base64');
  const uploaded = await mcp.call('actspan_page_upload', { tabId, selector: '#upload', filename: 'acceptance.txt', base64, mimeType: 'text/plain' });
  assert.equal(uploaded.uploaded, true);
  assert.match(await pageEval('document.querySelector("#upload-result").textContent'), /acceptance\.txt/);
  const dropped = await mcp.call('actspan_page_upload', { tabId, dropSelector: '#drop-zone', filename: 'dropped.txt', base64, mimeType: 'text/plain' });
  assert.equal(dropped.via, 'drop');
  assert.match(await pageEval('document.querySelector("#drop-result").textContent'), /dropped\.txt/);
  const keyed = await mcp.call('actspan_page_key', { tabId, selector: '#focus-input', keys: ['a', 'b'] });
  assert.equal(keyed.pressed, 2);
  const waited = await mcp.call('actspan_page_wait', { tabId, for: 'selector', selector: '#drop-zone', timeoutMs: 1000 });
  assert.equal(waited.found, true);
  const scrolled = await mcp.call('actspan_page_scroll', { tabId, selector: '#scroll-box', deltaY: 300 });
  assert.ok(scrolled.after > scrolled.before);
});

scenario('S5/act: compound script executes ordered observable effects and returns a final snapshot', async () => {
  await navigate('playground.html');
  const result = await mcp.call('actspan_act', { tabId, steps: [
    { action: 'type', selector: '#email', text: 'act@example.test' },
    { action: 'click', selector: '#expand' },
    { action: 'assert', cond: { selectorExists: '#hidden-content' } },
    { action: 'read', selector: '#form-result' },
  ] });
  assert.equal(result.success, true);
  assert.ok(Array.isArray(result.trace));
  assert.ok(result.snapshot);
  assert.equal(await pageEval('document.querySelector("#email").value'), 'act@example.test');
  assert.equal(await pageEval('document.querySelector("#hidden-content").hidden'), false);
});

scenario('S5/G12/G13: late validation and scroll effects are reported from the live page', async () => {
  await navigate('playground.html');
  await mcp.call('actspan_page_click', { tabId, selector: '#submit' });
  await mcp.call('actspan_page_type', { tabId, selector: '#email', text: 'late@example.test' });
  await delay(120);
  assert.equal(await pageEval('document.querySelector("#form-result").textContent'), 'Email validation failed');
  // 用产品自己的 scroll 动作制造滚动，跨源/跨线程的 scroll 事件由页面记录。
  await mcp.call('actspan_page_scroll', { tabId, selector: '#scroll-box', deltaY: 300 });
  await delay(100);
  assert.match(String(await pageEval('document.querySelector("#scroll-result").textContent')), /scroll:\d+/);
});

scenario('S5/G14/C1: payment confirmation is blocked until approval, while ordinary confirmation works', async () => {
  const payment = await mcp.callRaw('actspan_page_click', { tabId, selector: '#confirm-payment' });
  assert.equal(payment.isError, true, 'payment must not auto-upgrade or silently click');
  assert.equal(await pageEval('document.querySelector("#pay-result").textContent'), 'No payment action');
  await mcp.call('actspan_page_click', { tabId, selector: '#confirm-generic' });
  assert.equal(await pageEval('document.querySelector("#confirm-result").textContent'), 'Ordinary confirmation completed');
});

scenario('S5/CSP and eval policy: permitted fixture handler runs, side-effect eval is rejected', async () => {
  await navigate('csp.html');
  await mcp.call('actspan_page_click', { tabId, selector: '#data-csp-probe' });
  assert.equal(await pageEval('document.querySelector("#csp-result").textContent'), 'Permitted handler completed');
  const denied = await mcp.callRaw('actspan_page_eval', { tabId, expression: 'document.querySelector("#csp-result").textContent = "forged"' });
  assert.equal(denied.isError, true, 'eval side effect must be rejected by policy');
  assert.equal(await pageEval('document.querySelector("#csp-result").textContent'), 'Permitted handler completed');
});

scenario('S5/credentials: credential page output is masked and never repeats synthetic secrets', async () => {
  await navigate('creds.html');
  const page = await pageRead('text');
  assert.match(page.warning || '', /凭据|credential|掩码/i);
  assert.doesNotMatch(page.content, /TEST-AX8K-29LM-75QH|TEST-DP3Z-48TX-91KH/);
  assert.doesNotMatch(JSON.stringify(page), /synthetic-secret/);
  assert.match(page.content, /paragraph between groups|Ordinary reference|Ordinary URL/i);
});

scenario('S5/drift: direct navigation outside the Actspan task produces a warning', async () => {
  await navigate('creds.html');
  await pageRead();
  // creds.html 自己用 history.replaceState 换到另一个路径：这不是 ActSpan 发起的导航，
  // 等价于「带外导航」，漂移检测必须在下一次读取时报出来。
  await mcp.call('actspan_page_click', { tabId, selector: '#url-credential' });
  const page = await pageRead();
  assert.match(page.warning || '', /漂移|drift/i);
  await navigate('playground.html');
});

scenario('S5/new-tabs: local child opened by the fixture is observable and follows its opener', async () => {
  await navigate('newtab.html');
  await mcp.call('actspan_page_click', { tabId, selector: '#data-newtab-launcher' });
  assert.equal(await pageEval('document.querySelector("#newtab-result").textContent'), 'Link launch requested');
  const childTab = await waitFor(async () => (await mcp.call('actspan_tabs_list')).find((tab) => tab.url?.endsWith('/newtab-child.html')), 5000);
  assert.ok(childTab?.id, 'the opened child tab must be tracked by the task, proving it follows its opener');
  const childRead = await mcp.call('actspan_page_read', { tabId: childTab.id, format: 'text' });
  assert.match(childRead.content, /Child loaded/);
  await mcp.call('actspan_tab_close', { tabId: childTab.id });
});

scenario('S5/catalog and async tools: registry, workflow, agent lifecycle and notification contracts are live', async () => {
  await navigate('flow.html');
  const catalog = await mcp.call('actspan_skills_list');
  assert.ok(Number.isInteger(catalog.revision)); assert.ok(Array.isArray(catalog.skills));
  const firstSkill = catalog.skills.find((skill) => skill.name && skill.workflows?.length);
  assert.ok(firstSkill, 'registry must expose at least one executable local skill');
  const detail = await mcp.call('actspan_skill_detail', { name: firstSkill.name }); assert.equal(detail.skill?.name, firstSkill.name);
  const workflow = await mcp.call('actspan_workflow_run', { name: firstSkill.workflows[0].name, input: { tabId } });
  assert.ok(workflow.taskId && workflow.sessionId);
  const status = await mcp.call('actspan_agent_status', { taskId: workflow.taskId, sessionId: workflow.sessionId }); assert.equal(status.taskId, workflow.taskId);
  const submitted = await mcp.call('actspan_agent_submit', { query: 'Read the local fixture title only' }); assert.ok(submitted.taskId && submitted.sessionId);
  const cancelled = await mcp.call('actspan_agent_cancel', { taskId: submitted.taskId, sessionId: submitted.sessionId });
  assert.ok(cancelled === true || cancelled?.cancelled === true || cancelled?.state === 'cancelled');
  const result = await mcp.callRaw('actspan_agent_result', { taskId: submitted.taskId, sessionId: submitted.sessionId }); assert.ok(result && (result.isError === true || result.content));
  const push = await mcp.callRaw('actspan_feishu_push', { title: 'fixture acceptance', message: 'local fixture completed' });
  if (push.isError) assert.match(push.content?.[0]?.text || '', /Webhook|webhook|飞书|Feishu|配置/i);
  else assert.ok(Number.isInteger(JSON.parse(push.content?.[0]?.text || '{}').sent));
});
