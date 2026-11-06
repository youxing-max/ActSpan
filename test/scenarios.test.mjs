import assert from 'node:assert/strict';
import { connect as openSocket } from 'node:net';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { DEFAULT_BRIDGE_URL, TOOL_NAMES } from '../mcp-server/catalog.js';
import { extensionIdFromKey } from '../mcp-server/install.js';
// 默认只读本地夹具；显式 live 可通过调用方已有 Options 页安装完整 HTML。
// 安装器在被测 MCP 动作开始前释放 debugger，不创建浏览器或修改产品单例。
import {
  createMcpHarness,
  delay,
  startFixtureHost,
} from './browser-fixtures.mjs';
import { installPublicFixture, publicFixtureUrl, removeFixtureDownload, PUBLIC_JSON_URL, PUBLIC_PAGE_URL } from './helpers/public-fixtures.mjs';

const TOOLS = TOOL_NAMES;
const LIVE_ENABLED = process.env.ACTSPAN_LIVE === '1';

let host;
let mcp;
let tabId;
let pageUrl;
let hostError;
let harnessError;
let fixtureEvaluate;
let fixturePreviousTab;
const fixtureRunId = `scenarios-${Date.now()}`;

function ready() {
  assert.ok(mcp && Number.isInteger(tabId) && pageUrl, 'Acceptance harness did not initialize');
}

async function pageEval(expression) { ready(); return mcp.call('actspan_page_eval', { tabId, expression }); }
async function pageRead(format = 'text') { ready(); return mcp.call('actspan_page_read', { tabId, format, maxChars: 200000 }); }
async function pageText(selector) {
  ready();
  const { content } = await mcp.call('actspan_page_read', { tabId, selector });
  assert.ok(content.startsWith('<page-content untrusted>\n') && content.endsWith('\n</page-content>'));
  return content.slice('<page-content untrusted>\n'.length, -'\n</page-content>'.length);
}
async function assertPageValue(selector, expect) {
  ready();
  const result = await mcp.call('actspan_page_read', { tabId, selector, attr: 'value', expect });
  assert.equal(result.matched, true, JSON.stringify(result));
}
async function pageSnapshot(queryOrLimit, options = {}) {
  ready();
  const params = { tabId, ...options };
  if (typeof queryOrLimit === 'string') params.query = queryOrLimit;
  else if (typeof queryOrLimit === 'number') params.limit = queryOrLimit;
  return mcp.call('actspan_page_snapshot', params);
}
async function navigate(name, { reuse = false } = {}) {
  ready();
  if (fixtureEvaluate) {
    // 每个场景使用新的自有页，上一场景的持续 Network 监听不会阻碍安装器交接。
    if (!reuse) {
      await mcp.call('actspan_tab_close', { tabId });
      tabId = undefined;
      const opened = await mcp.call('actspan_tab_open', { url: 'about:blank', focus: true });
      if (!Number.isInteger(opened?.tabId)) throw new Error('Public fixture tab did not return an id');
      tabId = opened.tabId;
    }
    const installed = await installPublicFixture({ evaluate: fixtureEvaluate, tabId, name, runId: fixtureRunId });
    pageUrl = installed.url;
  } else {
    pageUrl = host.url(name);
    await mcp.call('actspan_tab_navigate', { tabId, url: pageUrl });
  }
  return pageUrl;
}

const BRIDGE_URL = process.env.ACTSPAN_BRIDGE_URL || DEFAULT_BRIDGE_URL;

/**
 * 桥守护进程是否在监听。没有桥就没有扩展，MCP 服务器会自己起一个守护进程并在
 * 「等扩展上线」上无限期挂着，连带把 node --test 的 worker 吊死（子进程句柄不会自己收）。
 * 所以先做一次 1.5s 的 TCP 探测，没桥就报告前置失败，绝不拉起 MCP 子进程。
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

async function finishCleanup(actions, errors = []) {
  for (const action of actions) {
    try { await action(); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, errors.map(error => error?.message || error).join('; '));
}

/**
 * 默认测试只跳过未显式启用的真机场景；显式启用后，初始化或工具失败必须报错。
 * ACTSPAN_FIXTURE_CONNECTOR 指向 export evaluate 的本地模块；未配置时本机导航仍
 * 被 SSRF 策略拒绝，保留真实失败，不关闭守卫换取通过。
 */
function scenario(name, body, { harness = true } = {}) {
  test(name, async (t) => {
    if (harness) {
      if (!LIVE_ENABLED) return t.skip('live suite disabled; set ACTSPAN_LIVE=1 to run');
      if (hostError) throw hostError;
      if (harnessError) throw harnessError;
    } else if (hostError) {
      throw hostError;
    }
    await body(t);
  });
}

before(async () => {
  try {
    host = await startFixtureHost();
  } catch (error) {
    hostError = error instanceof Error ? error : new Error(String(error));
  }
  if (!LIVE_ENABLED) return;
  try {
    if (hostError) throw new Error('fixture host unavailable');
    if (!(await bridgeListening())) throw new Error(`ActSpan bridge is not listening at ${BRIDGE_URL}; the live acceptance suite needs a paired extension and never fakes one`);
    // 扩展 ID 由 manifest key 推导，和 install/acceptance 用同一事实源，不需要人手填环境变量。
    if (!process.env.ACTSPAN_EXTENSION_IDS && !process.env.ACTSPAN_EXTENSION_ID) {
      process.env.ACTSPAN_EXTENSION_IDS = extensionIdFromKey();
    }
    if (process.env.ACTSPAN_FIXTURE_CONNECTOR) {
      const source = process.env.ACTSPAN_FIXTURE_CONNECTOR;
      const connector = await import(source.startsWith('file:') ? source : pathToFileURL(resolve(source)).href);
      if (typeof connector.evaluate !== 'function') throw new Error('ACTSPAN_FIXTURE_CONNECTOR must export evaluate(expression) for an existing extension Options page');
      fixtureEvaluate = connector.evaluate;
      fixturePreviousTab = await fixtureEvaluate('chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => tabs[0]?.id)');
    }
    mcp = await createMcpHarness();
    pageUrl = fixtureEvaluate ? 'about:blank' : host.url('playground.html');
    // 真实夹具安装使用前台页，避免后台渲染调度拖住加载；产品动作仍走公开 MCP。
    const opened = await mcp.call('actspan_tab_open', { url: pageUrl, focus: Boolean(fixtureEvaluate) });
    tabId = opened?.tabId;
    if (!Number.isInteger(tabId)) throw new Error(`actspan_tab_open returned no tabId: ${JSON.stringify(opened)}`);
    if (fixtureEvaluate) await navigate('playground.html', { reuse: true });
    // 页面就绪以实际正文为准，不把工具返回成功当作加载完成。
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
  let restoreFocus = false;
  await finishCleanup([
    async () => {
      if (fixtureEvaluate && Number.isInteger(fixturePreviousTab) && Number.isInteger(tabId)) {
        restoreFocus = await fixtureEvaluate(`chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => tabs[0]?.id === ${tabId})`);
      }
    },
    async () => { if (mcp && Number.isInteger(tabId)) await mcp.call('actspan_tab_close', { tabId }); },
    async () => { if (restoreFocus) await fixtureEvaluate(`chrome.tabs.get(${fixturePreviousTab}).then(tab => chrome.tabs.update(tab.id, { active: true }), () => undefined)`); },
    async () => { if (mcp) await mcp.close(); },
    async () => { if (host) await host.close(); },
  ]);
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
  await navigate('playground.html');
  const page = await pageRead('html');
  assert.match(page.content, /id="event-log"/);
  assert.match(page.content, /id="shadow-host"/);
  assert.match(page.content, /id="fixture-frame"/);
  // 本地模式切换 hostname；公开模式由完整 HTML 指向另一公开 origin。
  const frameSrc = /<iframe[^>]*\bid="fixture-frame"[^>]*\bsrc="([^"]+)"/.exec(page.content)?.[1];
  assert.ok(frameSrc, 'the fixture iframe must expose its src in the live DOM');
  const expectedFrameUrl = fixtureEvaluate ? publicFixtureUrl('frame-inner.html', fixtureRunId) : host.url('frame-inner.html', '127.0.0.1');
  assert.equal(frameSrc, expectedFrameUrl);
  assert.notEqual(new URL(frameSrc).origin, new URL(pageUrl).origin);
  // 帧归属由产品自报的 frames 清单证明：跨源 iframe 必须以非主帧的 frame_id 出现在实时帧树里。
  const snapshot = await pageSnapshot(1, { include_frames: true });
  const child = (snapshot.frames || []).find((frame) => String(frame.url || '').endsWith('/frame-inner.html'));
  assert.ok(child, `cross-origin iframe must be present in the live frame tree; got ${JSON.stringify(snapshot.frames)}`);
  assert.notEqual(child.frame_id, 0, 'the child frame must not be reported as the main frame');
  assert.equal(child.url, expectedFrameUrl);
});

scenario('S5/G1/G2: real click produces complete event sequence and SVG effect evidence', async () => {
  await navigate('playground.html');
  await mcp.call('actspan_page_click', { tabId, selector: '#svg-button', real: true });
  const events = await pageText('#event-log');
  for (const event of ['pointerover', 'mouseover', 'mousemove', 'pointerdown', 'mousedown', 'focus', 'pointerup', 'mouseup', 'click']) assert.match(events, new RegExp(`svg-button:${event}`), `missing ${event}; actual event log: ${events}`);
  assert.equal(await pageText('#svg-result'), 'SVG action completed');
  await mcp.call('actspan_page_click', { tabId, selector: '#svg-path' });
  assert.equal(await pageText('#svg-result'), 'SVG action completed');
});

scenario('S5/find: semantic target resolution selects a fixture control and proves its effect', async () => {
  await navigate('playground.html');
  const result = await mcp.call('actspan_page_click', { tabId, find: { role: 'button', name: 'Expand details' } });
  assert.ok(result.clicked || result.success, JSON.stringify(result));
  assert.equal(await pageEval('document.querySelector("#hidden-content").hidden'), false);
});

scenario('S5/real: explicit real click uses CDP without a synthetic fallback', async () => {
  await navigate('playground.html');
  const result = await mcp.call('actspan_page_click', { tabId, selector: '#svg-path', real: true });
  assert.equal(result.escalation?.channel, 'cdp_real_events');
  assert.equal(result.escalation?.success, true, JSON.stringify(result));
  assert.equal(result.escalation?.fallback, undefined);
  const log = await pageText('#event-log');
  // SVG 会提升到可点击按钮，中心命中的子元素不固定；以通道、事件序列和实际效果共同验证。
  assert.equal(await pageText('#svg-result'), 'SVG action completed');
  assert.match(log, /svg-button:pointerdown/, 'trusted input must dispatch pointerdown');
  assert.match(log, /svg-button:mousedown/, 'trusted input must dispatch mousedown');
});

scenario('S5/sensitive/effect: free-mode act executes a DOM-only simulated confirmation once', async () => {
  await navigate('playground.html');
  const result = await mcp.call('actspan_act', { tabId, steps: [{ action: 'click', selector: '#confirm-payment' }] });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(await pageText('#pay-result'), 'Simulated payment confirmed for $12.34 (no transaction)');
  assert.equal((await pageText('#event-log')).split('\n').filter(line => line === 'confirm-payment:click').length, 1);
});

scenario('S5/G1/G3: mousedown-only menu opens and preventDefault preserves focus', async () => {
  await navigate('playground.html');
  await mcp.call('actspan_page_click', { tabId, selector: '#mousedown-menu', real: true });
  assert.equal(await pageEval('document.querySelector("#menu-panel").hidden'), false);
  assert.equal(await pageText('#menu-result'), 'Menu opened by mousedown');
  await mcp.call('actspan_page_type', { tabId, selector: '#focus-input', text: 'focus me' });
  await mcp.call('actspan_page_click', { tabId, selector: '#focus-preserving', real: true });
  assert.match(await pageText('#focus-result'), /focus-input/);
  assert.equal(await pageEval('document.activeElement.id'), 'focus-input');
});

scenario('S5/G4: open shadow DOM descendants are snapshotted and actionable through refs', async () => {
  await navigate('playground.html');
  const snapshot = await pageSnapshot('Shadow action');
  const action = snapshot.elements.find((element) => String(element.text || '') === 'Shadow action');
  assert.ok(action, `snapshot must include open shadow root descendants; got ${JSON.stringify(snapshot)}`);
  assert.equal(/@f\d+$/.test(String(action.element_id)), false, 'shadow descendants live in the main frame and must not carry a frame suffix');

  const clicked = await mcp.call('actspan_page_click', { tabId, ref: action.element_id, snapshotId: snapshot.snapshot_id });
  assert.match(String(clicked.message || ''), /已触发目标元素点击/, JSON.stringify(clicked));
  assert.equal(await pageText('#shadow-result'), 'Shadow action completed');
  assert.match(await pageText('#event-log'), /shadow-action:click/);
});

scenario('S5/G5/H2: cross-origin iframe refs are frame-qualified and route to the exact frame', async () => {
  await navigate('playground.html');
  const frameSource = await pageEval('document.querySelector("#fixture-frame").src');
  const expectedFrameUrl = fixtureEvaluate ? publicFixtureUrl('frame-inner.html', fixtureRunId) : host.url('frame-inner.html', '127.0.0.1');
  assert.equal(frameSource, expectedFrameUrl);
  assert.notEqual(new URL(frameSource).origin, new URL(pageUrl).origin);
  const liveFrames = await pageSnapshot(1, { include_frames: true });
  const childFrame = (liveFrames.frames || []).find((frame) => String(frame.url || '').endsWith('/frame-inner.html'));
  assert.ok(childFrame, `cross-origin iframe was not present in the live frame list; got ${JSON.stringify(liveFrames.frames)}`);
  assert.notEqual(childFrame.frame_id, 0, 'the child frame must not be reported as the main frame');
  assert.equal(await pageEval('document.querySelector("#frame-value-result") === null'), true,
    'the parent frame must not define the child frame ids, so any observed effect can only come from the child frame');

  const snapshot = await pageSnapshot('Frame action', { include_frames: true });
  const action = snapshot.elements.find((element) => String(element.text || '') === 'Frame action');
  assert.ok(action, `snapshot must expose the child frame control; got ${JSON.stringify(snapshot)}`);
  const suffix = /@f(\d+)$/.exec(String(action.element_id));
  assert.ok(suffix, `child frame ref must be frame-qualified with @fN; got ${action.element_id}`);
  const frameId = Number(suffix[1]);
  assert.ok(frameId > 0, 'child frame must not be reported as the main frame');
  assert.equal(action.frame_id, frameId, 'snapshot must report the owning frame id');
  assert.match(String(action.frame_url || ''), /frame-inner\.html$/);

  const clicked = await mcp.call('actspan_page_click', { tabId, ref: action.element_id, snapshotId: snapshot.snapshot_id });
  assert.match(String(clicked.message || ''), /已触发目标元素点击/, JSON.stringify(clicked));

  const after = await pageSnapshot('Frame action completed', { include_frames: true });
  const result = after.elements.find((element) => String(element.text || '') === 'Frame action completed');
  assert.ok(result, `child frame effect must be observable in the child frame; got ${JSON.stringify(after.elements)}`);
  assert.equal(Number(/@f(\d+)$/.exec(String(result.element_id))?.[1]), frameId, 'the effect must be reported from the same child frame');
  const read = await mcp.call('actspan_page_read', { tabId, ref: result.element_id, snapshotId: after.snapshot_id });
  assert.equal(read.content, '<page-content untrusted>\nFrame action completed\n</page-content>');
});

scenario('S5: browser read, network and data tools have fixture round trips', async (t) => {
  const readUrl = fixtureEvaluate ? PUBLIC_PAGE_URL : host.url('playground.html');
  const expectedText = fixtureEvaluate ? /Web form/ : /Grounding playground/;
  await mcp.call('actspan_tab_navigate', { tabId, url: readUrl });
  const tabs = await mcp.call('actspan_tabs_list');
  assert.ok(Array.isArray(tabs));
  assert.ok(tabs.some((tab) => tab.id === tabId));
  const shot = await mcp.callRaw('actspan_screenshot', { tabId });
  assert.notEqual(shot.isError, true, shot.content?.[0]?.text);
  assert.equal(shot.content?.[0]?.type, 'image');
  const navigated = await mcp.call('actspan_tab_navigate', { tabId, url: readUrl });
  assert.equal(navigated.tabId, tabId);
  const read = await mcp.call('actspan_page_read', { tabId, format: 'text', maxChars: 2000 });
  assert.match(read.content, expectedText);
  const snapshot = await mcp.call('actspan_page_snapshot', { tabId, limit: 10 });
  assert.ok(Array.isArray(snapshot.elements) && snapshot.elements.length > 0, JSON.stringify(snapshot));
  assert.match(String(snapshot.snapshot_id || ''), /^snap-/);
  assert.ok(snapshot.frames?.some((frame) => frame.frame_id === 0), 'the main frame must always be reported');
  const networkList = await mcp.call('actspan_network_list', { tabId, reload: true, limit: 20 });
  const request = networkList.events.find(event => event.url === readUrl);
  assert.ok(request?.requestId, 'reload must capture the fixture document');
  const networkDetail = await mcp.call('actspan_network_detail', { tabId, requestId: request.requestId, includeBody: true });
  assert.equal(networkDetail.statusCode, 200);
  assert.match(networkDetail.body, expectedText);
  const networkQuery = await mcp.call('actspan_network_query', { tabId, urlFilter: request.url });
  assert.match(networkQuery.body, expectedText);
  const fetched = await mcp.call('actspan_data_fetch', { tabId, url: readUrl, sections: ['headings', 'meta'], max_content_length: 4000 });
  assert.match(JSON.stringify(fetched), expectedText);
  // DOM 安装器不拦截后台 fetch 或隐藏标签，数据接口始终使用真实网络响应。
  const pagination = fixtureEvaluate
    ? { url: PUBLIC_JSON_URL, params: { _limit: 2 }, param: '_page', maxPages: 2 }
    : { url: host.url('acceptance.json'), param: 'page', maxPages: 2 };
  const paginated = await mcp.call('actspan_data_paginate', { tabId, ...pagination });
  assert.equal(paginated.stop_reason, fixtureEvaluate ? 'max_pages' : 'identical_response');
  assert.equal(paginated.page_count, fixtureEvaluate ? 2 : 1);
  assert.equal(typeof fixtureEvaluate, 'function', 'Download acceptance requires ACTSPAN_FIXTURE_CONNECTOR to remove its own file and download record');
  const filename = `actspan-${fixtureRunId}-acceptance.txt`;
  const downloaded = await mcp.call('actspan_data_download', { tabId, content: 'acceptance fixture', filename });
  assert.ok(Number.isInteger(downloaded?.download_id) && downloaded.download_id >= 0, JSON.stringify(downloaded));
  t.after(() => removeFixtureDownload({ evaluate: fixtureEvaluate, downloadId: downloaded.download_id, filename }));
  t.diagnostic(`acceptance download_id=${downloaded.download_id}, filename=${filename}`);
});

scenario('S5/G6/G7/G8: file role, unlabeled controls, current values and accessibility hooks remain observable', async () => {
  await navigate('playground.html');
  const html = await pageRead('html');
  assert.match(html.content, /type="file"/);
  assert.match(html.content, /data-testid="email"/);
  assert.match(html.content, /aria-label="Drop a fixture file"/);
  await mcp.call('actspan_page_type', { tabId, selector: '#email', text: 'current@example.test' });
  await assertPageValue('#email', 'current@example.test');
  const accessibility = await pageEval('Array.from(document.querySelectorAll("[role],label,[aria-label]")).map((node) => ({ role: node.getAttribute("role"), label: node.getAttribute("aria-label"), text: (node.innerText || node.textContent || "").trim() })).filter((item) => item.text || item.label)');
  assert.ok(accessibility.some((item) => item.role === 'status'));
  assert.ok(accessibility.some((item) => item.label === 'Drop a fixture file'));
});

scenario('S5/G8/C1: one type call fills the complete form and delayed validation reports success', async () => {
  await navigate('playground.html');
  await mcp.call('actspan_page_type', { tabId, selector: '#email', text: 'acceptance@example.test' });
  await mcp.call('actspan_page_type', { tabId, selector: '#password', text: 'synthetic-secret' });
  await assertPageValue('#email', 'acceptance@example.test');
  await assertPageValue('#password', 'synthetic-secret');
  await mcp.call('actspan_page_click', { tabId, selector: '#submit' });
  assert.ok(await waitFor(async () => (await pageText('#form-result')) === 'Submitted successfully'));
  assert.match(await pageText('#event-log'), /submit:validation-complete/);
});

scenario('S5/A4: upload, drop, select, key, wait and scroll produce live effects', async () => {
  await navigate('playground.html');
  // 靶场自带原生 select，正合用；不再用带副作用的 page_eval 造元素。
  const selected = await mcp.call('actspan_page_select', { tabId, selector: '#plan-select', value: 'pro' });
  assert.equal(selected.selectedValue, 'pro');
  await assertPageValue('#plan-select', 'pro');
  assert.equal(await pageText('#select-result'), 'Plan selected: pro');
  const base64 = Buffer.from('fixture-upload').toString('base64');
  const uploaded = await mcp.call('actspan_page_upload', { tabId, selector: '#upload', filename: 'acceptance.txt', base64, mimeType: 'text/plain' });
  assert.equal(uploaded.uploaded, true);
  assert.match(await pageText('#upload-result'), /acceptance\.txt/);
  const dropped = await mcp.call('actspan_page_upload', { tabId, dropSelector: '#drop-zone', filename: 'dropped.txt', base64, mimeType: 'text/plain' });
  assert.equal(dropped.via, 'drop');
  assert.match(await pageText('#drop-result'), /dropped\.txt/);
  const keyed = await mcp.call('actspan_page_key', { tabId, selector: '#focus-input', keys: ['a', 'b'] });
  assert.equal(keyed.pressed, 2);
  const waited = await mcp.call('actspan_page_wait', { tabId, for: 'selector', selector: '#drop-zone', timeoutMs: 1000 });
  assert.equal(waited.found, true);
  const scrolled = await mcp.call('actspan_page_scroll', { tabId, selector: '#scroll-box', deltaY: 300 });
  assert.ok(scrolled.after.y > scrolled.before.y);
  assert.equal(scrolled.changed, true);
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
  await assertPageValue('#email', 'act@example.test');
  assert.equal(await pageEval('document.querySelector("#hidden-content").hidden'), false);
});

scenario('S5/G12/G13: late validation and scroll effects are reported from the live page', async () => {
  await navigate('playground.html');
  await mcp.call('actspan_page_click', { tabId, selector: '#submit' });
  await mcp.call('actspan_page_type', { tabId, selector: '#email', text: 'late@example.test' });
  assert.ok(await waitFor(async () => (await pageText('#form-result')) === 'Email validation failed'),
    'delayed validation must report the email captured before the later input');
  // 用产品自己的 scroll 动作制造滚动，跨源/跨线程的 scroll 事件由页面记录。
  await mcp.call('actspan_page_scroll', { tabId, selector: '#scroll-box', deltaY: 300 });
  assert.ok(await waitFor(async () => /scroll:[1-9]\d*/.test(await pageText('#scroll-result'))),
    'scroll handler must observe the changed container position');
});

scenario('S5/G14/C1: free-mode simulated payment and ordinary confirmation update only fixture DOM', async () => {
  await navigate('playground.html');
  await mcp.call('actspan_page_click', { tabId, selector: '#confirm-payment' });
  assert.equal(await pageText('#pay-result'), 'Simulated payment confirmed for $12.34 (no transaction)');
  await mcp.call('actspan_page_click', { tabId, selector: '#confirm-generic' });
  assert.equal(await pageText('#confirm-result'), 'Ordinary confirmation completed');
});

scenario('S5/CSP and eval policy: permitted fixture handler runs, side-effect eval is rejected', async () => {
  await navigate('csp.html');
  await mcp.call('actspan_page_click', { tabId, selector: '#data-csp-probe' });
  assert.equal(await pageText('#csp-result'), 'Permitted handler completed');
  await mcp.call('actspan_page_click', { tabId, selector: '#csp-inline-blocked' });
  assert.equal(await pageText('#csp-inline-result'), 'Inline handler blocked');
  const denied = await mcp.callRaw('actspan_page_eval', { tabId, expression: 'document.querySelector("#csp-result").textContent = "forged"' });
  assert.equal(denied.isError, true, 'eval side effect must be rejected by policy');
  assert.equal(await pageText('#csp-result'), 'Permitted handler completed');
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
  ready();
  assert.equal(typeof fixtureEvaluate, 'function', 'drift requires the existing Options connector for out-of-band navigation');
  // 漂移按会话只提示一次；夹具安装已消耗共享会话的提示，必须独立建立同 URL 基线。
  const identity = { taskId: `${fixtureRunId}-drift-task`, sessionId: `${fixtureRunId}-drift-session` };
  const baselineUrl = publicFixtureUrl('creds.html', fixtureRunId);
  const previousTab = await fixtureEvaluate('chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => tabs[0]?.id)');
  const opened = await mcp.call('actspan_tab_open', { ...identity, url: baselineUrl, focus: true });
  assert.ok(Number.isInteger(opened?.tabId), 'drift fixture tab did not return an id');
  const driftTabId = opened.tabId;
  const errors = [];
  try {
    assert.equal(opened.url, baselineUrl, 'the task must establish its baseline at the exact fixture URL');
    await installPublicFixture({ evaluate: fixtureEvaluate, tabId: driftTabId, name: 'creds.html', runId: fixtureRunId });
    const read = () => mcp.call('actspan_page_read', { ...identity, tabId: driftTabId, format: 'text' });
    assert.doesNotMatch((await read()).warning || '', /漂移|drift/i);
    const driftUrl = new URL('account/recovery-codes', baselineUrl).href;
    // 由测试连接器在任务外改 history，避免把 MCP 自己点击引起的导航误称为带外导航。
    const actualUrl = await fixtureEvaluate(`chrome.scripting.executeScript({
      target: { tabId: ${driftTabId} }, world: 'MAIN',
      func: (url) => { history.replaceState(null, '', url); return location.href; },
      args: [${JSON.stringify(driftUrl)}]
    }).then(results => results[0]?.result)`);
    assert.equal(actualUrl, driftUrl);
    assert.match((await read()).warning || '', /漂移|drift/i);
    assert.doesNotMatch((await read()).warning || '', /漂移|drift/i, 'the same session must not repeat its drift warning');
  } catch (error) {
    errors.push(error);
  } finally {
    let restore = false;
    await finishCleanup([
      async () => { restore = await fixtureEvaluate(`chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => tabs[0]?.id === ${driftTabId})`); },
      async () => { await mcp.call('actspan_tab_close', { ...identity, tabId: driftTabId }); },
      async () => { if (restore && Number.isInteger(previousTab)) await fixtureEvaluate(`chrome.tabs.get(${previousTab}).then(tab => chrome.tabs.update(tab.id, { active: true }), () => undefined)`); },
    ], errors);
  }
});

scenario('S5/new-tabs: child opened by the fixture is observable and follows its opener', async () => {
  await navigate('newtab.html');
  await mcp.call('actspan_page_click', { tabId, selector: '#data-newtab-launcher' });
  assert.equal(await pageText('#newtab-result'), 'Link launch requested');
  const childUrl = fixtureEvaluate ? publicFixtureUrl('newtab-child.html', fixtureRunId) : host.url('newtab-child.html');
  const childTab = await waitFor(async () => (await mcp.call('actspan_tabs_list')).find((tab) => tab.url === childUrl), 5000);
  assert.ok(childTab?.id, 'the opened child tab must be tracked by the task, proving it follows its opener');
  try {
    // 先由真实点击和任务 tabs_list 证明 child 归属，再给该 child 安装完整文档。
    if (fixtureEvaluate) await installPublicFixture({ evaluate: fixtureEvaluate, tabId: childTab.id, name: 'newtab-child.html', runId: fixtureRunId });
    const childRead = await mcp.call('actspan_page_read', { tabId: childTab.id, format: 'text' });
    assert.match(childRead.content, /Child loaded/);
  } finally {
    await mcp.call('actspan_tab_close', { tabId: childTab.id });
  }
});

scenario('S5/catalog: registry and skill detail are readable without executing workflows', async () => {
  ready();
  const catalog = await mcp.call('actspan_skills_list');
  assert.ok(Number.isInteger(catalog.revision)); assert.ok(Array.isArray(catalog.skills));
  const firstSkill = catalog.skills.find((skill) => skill.name);
  assert.ok(firstSkill, 'registry must expose at least one local skill');
  const detail = await mcp.call('actspan_skill_detail', { name: firstSkill.name }); assert.equal(detail.skill?.name, firstSkill.name);
});
