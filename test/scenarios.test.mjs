import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { TOOL_NAMES } from '../mcp-server/catalog.js';
import {
  connectOverCDP,
  createMcpHarness,
  delay,
  evaluateTarget,
  startFixtureHost,
  waitForPageValue,
} from './browser-fixtures.mjs';

const TOOLS = TOOL_NAMES;

let host;
let browser;
let mcp;
let tabId;
let pageUrl;
let setupError;

function ready() {
  if (setupError) assert.fail(`Acceptance setup blocked: ${setupError.message}`);
  assert.ok(mcp && browser && tabId && pageUrl, 'Acceptance harness did not initialize');
}

async function pageEval(expression) { ready(); return mcp.call('actspan_page_eval', { tabId, expression }); }
async function pageRead(format = 'text') { ready(); return mcp.call('actspan_page_read', { tabId, format, maxChars: 200000 }); }
async function navigate(name) { ready(); pageUrl = host.url(name); await mcp.call('actspan_tab_navigate', { tabId, url: pageUrl }); return pageUrl; }
async function targetForCurrentPage() { ready(); return browser.target((target) => target.type === 'page' && target.url?.startsWith(pageUrl)); }

before(async () => {
  try {
    host = await startFixtureHost();
    browser = await connectOverCDP();
    mcp = await createMcpHarness();
    pageUrl = host.url('playground.html');
    const opened = await mcp.call('actspan_tab_open', { url: pageUrl, active: false });
    tabId = opened?.tabId;
    if (!Number.isInteger(tabId)) throw new Error(`actspan_tab_open returned no tabId: ${JSON.stringify(opened)}`);
    await waitForPageValue(pageEval, 'document.title', 'Actspan Playground');
  } catch (error) { setupError = error instanceof Error ? error : new Error(String(error)); }
});

after(async () => {
  if (mcp && Number.isInteger(tabId)) { try { await mcp.callRaw('actspan_tab_close', { tabId }); } catch { /* cleanup only */ } }
  if (mcp) await mcp.close().catch(() => undefined);
  if (browser) browser.close();
  if (host) await host.close().catch(() => undefined);
});

test('S1/S2: local fixture host serves every required fixture class', async () => {
  ready();
  for (const fixture of ['playground.html', 'creds.html', 'csp.html', 'frame-inner.html', 'newtab.html', 'newtab-child.html', 'flow.html']) {
    const response = await fetch(host.url(fixture));
    assert.equal(response.status, 200, fixture);
    assert.match(await response.text(), /<!doctype html>/i, fixture);
  }
  assert.equal((await fetch(host.url('../package.json'))).status, 404, 'fixture server must not expose repository files');
});

test('S5: MCP advertises all externally registered Actspan tools, without aliases', () => {
  ready();
  assert.deepEqual([...mcp.tools.keys()], TOOLS);
  for (const name of TOOLS) mcp.requireTool(name);
});

test('S5: page_read proves the live playground and cross-origin iframe are loaded', async () => {
  const page = await pageRead('html');
  assert.match(page.content, /id="event-log"/);
  assert.match(page.content, /id="shadow-host"/);
  assert.match(page.content, /id="fixture-frame"/);
  const src = await pageEval('document.querySelector("#fixture-frame").src');
  assert.equal(new URL(src).hostname, '127.0.0.1');
  const pageTarget = await targetForCurrentPage();
  const frameTree = await pageTarget.send('Page.getFrameTree');
  pageTarget.close();
  const child = frameTree?.frameTree?.childFrames?.find((entry) => entry.frame?.url?.endsWith('/frame-inner.html'));
  assert.ok(child?.frame?.id, 'cross-origin iframe must be present in the live frame tree');
  assert.equal(new URL(child.frame.url).hostname, '127.0.0.1');
});

test('S5/G1/G2: click produces complete event sequence and SVG effect evidence', async () => {
  await pageEval('document.querySelector("#clear-log").click()');
  await mcp.call('actspan_page_click', { tabId, selector: '#svg-button' });
  const events = String(await pageEval('document.querySelector("#event-log").textContent'));
  for (const event of ['pointerover', 'mouseover', 'mousemove', 'pointerdown', 'mousedown', 'focus', 'pointerup', 'mouseup', 'click']) assert.match(events, new RegExp(`svg-button:${event}`), `missing ${event}; actual event log: ${events}`);
  assert.equal(await pageEval('document.querySelector("#svg-result").textContent'), 'SVG action completed');
  await mcp.call('actspan_page_click', { tabId, selector: '#svg-path' });
  assert.equal(await pageEval('document.querySelector("#svg-result").textContent'), 'SVG action completed');
});
test('S5/find: semantic target resolution selects a fixture control and proves its effect', async () => {
  await navigate('playground.html');
  const result = await mcp.call('actspan_page_click', { tabId, find: { role: 'button', name: 'Expand details' } });
  assert.equal(result.clicked || result.success, true, JSON.stringify(result));
  assert.equal(await pageEval('document.querySelector("#hidden-content").hidden'), false);
});
test('S5/untrusted: click path emits a trusted browser event, not a synthetic fallback', async () => {
  await navigate('playground.html');
  const target = await targetForCurrentPage();
  await evaluateTarget(target, 'window.__acceptanceTrusted = null; document.querySelector("#svg-button").addEventListener("click", (event) => { window.__acceptanceTrusted = event.isTrusted; }, { once: true });');
  target.close();
  await mcp.call('actspan_page_click', { tabId, selector: '#svg-button' });
  assert.equal(await pageEval('window.__acceptanceTrusted'), true, 'synthetic click is not acceptable for the trusted-event contract');
});
test('S5/sensitive/effect: act stops before a payment side effect and reports the reason', async () => {
  await navigate('playground.html');
  const result = await mcp.call('actspan_act', { tabId, steps: [{ action: 'click', selector: '#confirm-payment' }] });
  assert.equal(result.success, false);
  assert.match(JSON.stringify(result.error), /SENSITIVE|确认|payment|支付/i);
  assert.equal(await pageEval('document.querySelector("#pay-result").textContent'), 'No payment action');
});

test('S5/G1/G3: mousedown-only menu opens and preventDefault preserves focus', async () => {
  await mcp.call('actspan_page_click', { tabId, selector: '#mousedown-menu' });
  assert.equal(await pageEval('document.querySelector("#menu-panel").hidden'), false);
  assert.equal(await pageEval('document.querySelector("#menu-result").textContent'), 'Menu opened by mousedown');
  await mcp.call('actspan_page_type', { tabId, selector: '#focus-input', text: 'focus me' });
  await mcp.call('actspan_page_click', { tabId, selector: '#focus-preserving' });
  assert.match(String(await pageEval('document.querySelector("#focus-result").textContent')), /focus-input/);
  assert.equal(await pageEval('document.activeElement.id'), 'focus-input');
});

test('S5/G4: open shadow DOM descendants are snapshotted and actionable through refs', async () => {
  await navigate('playground.html');
  const pageTarget = await targetForCurrentPage();
  assert.equal(await evaluateTarget(pageTarget, 'Boolean(document.querySelector("#shadow-host").shadowRoot?.querySelector("#shadow-action"))'), true);
  assert.equal(await evaluateTarget(pageTarget, 'document.querySelector("#shadow-result").textContent'), 'Shadow idle');
  pageTarget.close();

  const snapshot = await mcp.call('actspan_page_snapshot', { tabId, query: 'Shadow action' });
  const action = snapshot.elements.find((element) => String(element.text || '') === 'Shadow action');
  assert.ok(action, `snapshot must include open shadow root descendants; got ${JSON.stringify(snapshot.elements)}`);
  assert.equal(/@f\d+$/.test(String(action.element_id)), false, 'shadow descendants live in the main frame and must not carry a frame suffix');

  const clicked = await mcp.call('actspan_page_click', { tabId, ref: action.element_id, snapshotId: snapshot.snapshot_id });
  assert.match(String(clicked.message || ''), /已触发目标元素点击/, JSON.stringify(clicked));
  assert.equal(await pageEval('document.querySelector("#shadow-result").textContent'), 'Shadow action completed');
  assert.match(String(await pageEval('document.querySelector("#event-log").textContent')), /shadow-action:click/);
});

test('S5/G5/H2: cross-origin iframe refs are frame-qualified and route to the exact frame', async () => {
  await navigate('playground.html');
  const pageTarget = await targetForCurrentPage();
  const frameTree = await pageTarget.send('Page.getFrameTree');
  const child = frameTree?.frameTree?.childFrames?.find((entry) => entry.frame?.url?.endsWith('/frame-inner.html'));
  assert.ok(child?.frame?.id, 'cross-origin iframe was not present in the live frame tree');
  const frameSource = await pageTarget.send('Runtime.evaluate', { expression: 'document.querySelector("#fixture-frame").src', returnByValue: true });
  assert.equal(new URL(frameSource.result.value).hostname, '127.0.0.1');
  assert.equal(await evaluateTarget(pageTarget, 'document.querySelector("#frame-result") === null'), true,
    'the parent frame must not define the child frame ids, so any observed effect can only come from the child frame');
  pageTarget.close();

  const snapshot = await mcp.call('actspan_page_snapshot', { tabId, query: 'Frame action' });
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

  const after = await mcp.call('actspan_page_snapshot', { tabId, query: 'Frame action completed' });
  const result = after.elements.find((element) => String(element.text || '') === 'Frame action completed');
  assert.ok(result, `child frame effect must be observable in the child frame; got ${JSON.stringify(after.elements)}`);
  assert.equal(Number(/@f(\d+)$/.exec(String(result.element_id))?.[1]), frameId, 'the effect must be reported from the same child frame');
  const read = await mcp.call('actspan_page_read', { tabId, ref: result.element_id, snapshotId: after.snapshot_id });
  assert.equal(read.content, 'Frame action completed');
});
test('S5: each registered browser MCP tool has a live fixture round trip', async () => {
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

test('S5/G6/G7/G8: file role, unlabeled controls, current values and accessibility hooks remain observable', async () => {
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

test('S5/G8/C1: one type call fills the complete form and delayed validation reports success', async () => {
  await mcp.call('actspan_page_type', { tabId, selector: '#email', text: 'acceptance@example.test' });
  await mcp.call('actspan_page_type', { tabId, selector: '#password', text: 'synthetic-secret' });
  assert.equal(await pageEval('document.querySelector("#email").value'), 'acceptance@example.test');
  assert.equal(await pageEval('document.querySelector("#password").value'), 'synthetic-secret');
  await mcp.call('actspan_page_click', { tabId, selector: '#submit' });
  await waitForPageValue(pageEval, 'document.querySelector("#form-result").textContent', 'Submitted successfully');
  assert.match(String(await pageEval('document.querySelector("#event-log").textContent')), /submit:validation-complete/);
});

test('S5/A4: upload, drop, select, key, wait and scroll produce live effects', async () => {
  await navigate('playground.html');
  const target = await targetForCurrentPage();
  await evaluateTarget(target, '(() => { const select = document.createElement("select"); select.id = "acceptance-select"; select.innerHTML = "<option value=one>One</option><option value=two>Two</option>"; document.body.append(select); return true; })()');
  target.close();
  const selected = await mcp.call('actspan_page_select', { tabId, selector: '#acceptance-select', value: 'two' });
  assert.equal(selected.selectedValue, 'two');
  assert.equal(await pageEval('document.querySelector("#acceptance-select").value'), 'two');
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
test('S5/act: compound script executes ordered observable effects and returns a final snapshot', async () => {
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

test('S5/G12/G13: late validation and scroll effects are reported from the live page', async () => {
  await navigate('playground.html');
  await mcp.call('actspan_page_click', { tabId, selector: '#submit' });
  await mcp.call('actspan_page_type', { tabId, selector: '#email', text: 'late@example.test' });
  await delay(120);
  assert.equal(await pageEval('document.querySelector("#form-result").textContent'), 'Email validation failed');
  const target = await targetForCurrentPage();
  await evaluateTarget(target, 'document.querySelector("#scroll-box").scrollTop = 300');
  await delay(100);
  assert.match(String(await pageEval('document.querySelector("#scroll-result").textContent')), /scroll:\d+/);
  target.close();
});

test('S5/G14/C1: payment confirmation is blocked until approval, while ordinary confirmation works', async () => {
  const payment = await mcp.callRaw('actspan_page_click', { tabId, selector: '#confirm-payment' });
  assert.equal(payment.isError, true, 'payment must not auto-upgrade or silently click');
  assert.equal(await pageEval('document.querySelector("#pay-result").textContent'), 'No payment action');
  await mcp.call('actspan_page_click', { tabId, selector: '#confirm-generic' });
  assert.equal(await pageEval('document.querySelector("#confirm-result").textContent'), 'Ordinary confirmation completed');
});

test('S5/CSP and eval policy: permitted fixture handler runs, side-effect eval is rejected', async () => {
  await navigate('csp.html');
  await mcp.call('actspan_page_click', { tabId, selector: '#data-csp-probe' });
  assert.equal(await pageEval('document.querySelector("#csp-result").textContent'), 'Permitted handler completed');
  const denied = await mcp.callRaw('actspan_page_eval', { tabId, expression: 'document.querySelector("#csp-result").textContent = "forged"' });
  assert.equal(denied.isError, true, 'eval side effect must be rejected by policy');
  assert.equal(await pageEval('document.querySelector("#csp-result").textContent'), 'Permitted handler completed');
});

test('S5/credentials: credential page output is masked and never repeats synthetic secrets', async () => {
  await navigate('creds.html');
  const page = await pageRead('text');
  assert.match(page.warning || '', /凭据|credential|掩码/i);
  assert.doesNotMatch(page.content, /TEST-AX8K-29LM-75QH|TEST-DP3Z-48TX-91KH/);
  assert.doesNotMatch(JSON.stringify(page), /synthetic-secret/);
  assert.match(page.content, /paragraph between groups|Ordinary reference|Ordinary URL/i);
});

test('S5/drift: direct navigation outside the Actspan task produces a warning', async () => {
  await navigate('playground.html'); await pageRead();
  const target = await targetForCurrentPage();
  await target.send('Page.navigate', { url: host.url('flow.html') }); await delay(300);
  const page = await pageRead();
  assert.match(page.warning || '', /漂移|drift/i);
  target.close(); await navigate('playground.html');
});

test('S5/new-tabs: local child opened by the fixture is observable and follows its opener', async () => {
  await navigate('newtab.html');
  await mcp.call('actspan_page_click', { tabId, selector: '#data-newtab-launcher' });
  assert.equal(await pageEval('document.querySelector("#newtab-result").textContent'), 'Link launch requested');
  const child = await browser.target((candidate) => candidate.type === 'page' && candidate.url?.endsWith('/newtab-child.html'));
  assert.match(await evaluateTarget(child, 'document.querySelector("#child-result").textContent'), /Child fixture loaded/);
  const childInfo = (await browser.targets()).find((candidate) => candidate.url?.endsWith('/newtab-child.html'));
  assert.ok(childInfo?.openerId || childInfo?.openerTabId, 'new tab must retain an opener relationship');
  child.close();
  const owned = await mcp.call('actspan_tabs_list');
  const childTab = owned.find((tab) => tab.url?.endsWith('/newtab-child.html'));
  if (childTab?.id !== undefined) await mcp.call('actspan_tab_close', { tabId: childTab.id });
});

test('S5/catalog and async tools: registry, workflow, agent lifecycle and notification contracts are live', async () => {
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

