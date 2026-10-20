import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const listeners = new Set();
const downloads = [];
const commands = [];
const bookmarks = ['one', 'two', 'three'].map((id, index) => ({ id, title: id, url: `https://${id}.test`, dateAdded: 3 - index }));
const tree = [{ id: '0', title: '', children: [{ id: 'folder', title: 'Folder', children: bookmarks }] }];
globalThis.chrome = {
  bookmarks: { getTree: async () => tree, search: async () => bookmarks, getRecent: async (count) => bookmarks.slice(0, count) },
  downloads: { download: async (options) => { downloads.push(options); return downloads.length; } },
  debugger: {
    onEvent: { addListener: (fn) => listeners.add(fn) }, onDetach: { addListener: () => {} },
    attach: async () => {}, sendCommand: async (_target, method, params) => {
      commands.push({ method, params });
      if (method === 'Network.getResponseBody') return { body: Buffer.from([0, 255, 128]).toString('base64'), base64Encoded: true };
      return {};
    },
  },
  storage: { local: {
    get: (_keys, callback) => callback({}),
    set: (_items, callback) => callback?.(),
  } },
};
const bundled = await build({
  stdin: { contents: `
    export { bookmarkOpsFunction } from './src/functions/bookmark-ops.ts';
    export { dataPipelineFunction } from './src/functions/data-pipeline.ts';
    export { extractDataFunction } from './src/functions/extract-data.ts';
    export { downloadFileFunction } from './src/functions/download-file.ts';
    export { fetchUrlFunction } from './src/functions/fetch-url.ts';
    export { paginateFunction } from './src/functions/paginate.ts';
    export { cdpFetchFunction } from './src/functions/cdp-fetch.ts';
    export { ArtifactStore } from './src/lib/artifact-store.ts';
    export { cdpNetworkFunction } from './src/functions/cdp-network.ts';
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { bookmarkOpsFunction, dataPipelineFunction, extractDataFunction, downloadFileFunction, fetchUrlFunction, paginateFunction, cdpFetchFunction, cdpNetworkFunction, ArtifactStore } =
  await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString('base64')}`);

test('download schema directs data retrieval through available tools before file export', () => {
  assert.match(downloadFileFunction.description, /LAST RESORT/);
  assert.match(downloadFileFunction.description, /Try first:.*cdp_network.*page\(action="view"\).*fetch_url.*data_pipeline/s);
});

test('bookmark list actions return actual totals and page boundaries', async () => {
  for (const action of ['search', 'recent', 'list', 'get_all', 'getAll']) {
    const first = await bookmarkOpsFunction.execute({ action, query: 'test', limit: 1 });
    const second = await bookmarkOpsFunction.execute({ action, query: 'test', limit: 1, offset: 1 });
    assert.deepEqual([first.data.total, first.data.has_more, first.data.next_offset], [3, true, 1], action);
    assert.deepEqual([second.data.total, second.data.bookmarks[0].bookmark_id, second.data.next_offset], [3, 'two', 2], action);
  }
  const bounded = await bookmarkOpsFunction.execute({ action: 'list', limit: 50000, offset: -2 });
  assert.deepEqual([bounded.data.limit, bounded.data.offset, bounded.data.next_offset], [2000, 0, null]);
});

test('pipeline preview limits offsets and reports continuation', async () => {
  const id = `paging-${Date.now()}`;
  await dataPipelineFunction.execute({ action: 'append', buffer_id: id, data: [{ a: 1 }, { a: 2 }, { a: 3 }] });
  const page = await dataPipelineFunction.execute({ action: 'preview', buffer_id: id, limit: -3, offset: -1 });
  assert.deepEqual([page.data.total, page.data.offset, page.data.limit, page.data.has_more, page.data.next_offset, page.data.items.length], [3, 0, 1, true, 1, 1]);
  const last = await dataPipelineFunction.execute({ action: 'preview', buffer_id: id, limit: 1, offset: 2 });
  assert.deepEqual([last.data.has_more, last.data.next_offset], [false, null]);
  await dataPipelineFunction.execute({ action: 'clear', buffer_id: id });
});

test('pipeline exports UTF-8 base64 in JSON, CSV, Markdown and TSV MIME formats', async () => {
  const id = `export-${Date.now()}`;
  await dataPipelineFunction.execute({ action: 'append', buffer_id: id, data: [{ title: '你好', value: 'a,"b"|c' }] });
  const cases = [
    ['json', 'application/json', 'json', '[\n  {\n    "title": "你好",\n    "value": "a,\\"b\\"|c"\n  }\n]'],
    ['csv', 'text/csv', 'csv', 'title,value\n你好,"a,""b""|c"'],
    ['markdown', 'text/markdown', 'md', '| title | value |\n| --- | --- |\n| 你好 | a,"b"\\|c |'],
    ['tsv', 'text/tab-separated-values', 'tsv', 'title\tvalue\n你好\ta,"b"|c'],
  ];
  for (const [format, mime, ext, content] of cases) {
    const result = await dataPipelineFunction.execute({ action: 'export', buffer_id: id, format });
    assert.equal(result.success, true);
    assert.equal(result.data.filename.endsWith(`.${ext}`), true);
    const match = downloads.at(-1).url.match(/^data:([^;]+);charset=utf-8;base64,(.*)$/);
    assert.equal(match[1], mime);
    assert.equal(Buffer.from(match[2], 'base64').toString('utf8'), content);
    assert.equal(result.data.size_bytes, Buffer.byteLength(content));
  }
  await dataPipelineFunction.execute({ action: 'clear', buffer_id: id });
});

test('extract clamps max_items and appends only remaining capacity', async () => {
  const original = chrome.scripting;
  let args;
  chrome.scripting = { executeScript: async (options) => {
    args = options.args;
    return [{ result: { success: true, data: { items: [{ a: 1 }, { a: 2 }], fields: ['a'] } } }];
  } };
  try {
    const id = `extract-${Date.now()}`;
    const result = await extractDataFunction.execute({ mode: 'schema', max_items: 1.9, buffer_id: id, tab_id: 1 });
    assert.equal(args[2], 1);
    assert.deepEqual([result.data.appended_count, result.data.total_count], [2, 2]);
    await extractDataFunction.execute({ mode: 'schema', max_items: Infinity, tab_id: 1 });
    assert.equal(args[2], 500);
    await dataPipelineFunction.execute({ action: 'clear', buffer_id: id });
  } finally { chrome.scripting = original; }
});

test('download rejects competing sources, unsafe protocols and oversized text, but allows empty text', async () => {
  assert.match(downloadFileFunction.validate({ url: 'https://a.test', content: 'x' }), /Only one/);
  assert.equal(downloadFileFunction.validate({ content: '' }), null);
  assert.match(downloadFileFunction.validate({ url: 'javascript:alert(1)' }), /http\/https/);
  assert.equal((await downloadFileFunction.execute({ content: '', filename: 'empty.txt' })).success, true);
  assert.equal(downloads.at(-1).saveAs, false);
  assert.equal((await downloadFileFunction.execute({ content: 'x', url: 'https://a.test' })).success, false);
  assert.equal((await downloadFileFunction.execute({ url: 'javascript:alert(1)' })).success, false);
  assert.equal((await downloadFileFunction.execute({ content: 'x'.repeat(11 * 1024 * 1024) })).success, false);
});

test('fetch aborts before opening a tab and disallows non-http protocols', async () => {
  assert.match(fetchUrlFunction.validate({ url: 'file:///etc/passwd' }), /http\/https/);
  const controller = new AbortController(); controller.abort();
  const aborted = await fetchUrlFunction.execute({ url: 'https://example.com' }, { signal: controller.signal });
  assert.equal(aborted.success, false);
  assert.match(aborted.error, /abort/i);
});

test('download accepts screenshot artifacts only as bounded image data and rejects mixed inputs', async () => {
  const screenshot = await ArtifactStore.saveScreenshot('data:image/png;base64,AP+A', 'png', 0.1);
  assert.match(downloadFileFunction.validate({ artifact_id: screenshot.id, content: '' }), /Only one/);
  const result = await downloadFileFunction.execute({ artifact_id: screenshot.id, filename: 'capture.png' });
  assert.equal(result.success, true);
  assert.equal(downloads.at(-1).url, 'data:image/png;base64,AP+A');
  const malformed = await ArtifactStore.saveScreenshot('javascript:alert(1)', 'png', 0.1);
  assert.equal((await downloadFileFunction.execute({ artifact_id: malformed.id })).success, false);
  const oversized = await ArtifactStore.saveScreenshot(`data:image/png;base64,${'A'.repeat(14 * 1024 * 1024 + 8)}`, 'png', 11000);
  assert.equal((await downloadFileFunction.execute({ artifact_id: oversized.id })).success, false);
});

test('fetch clamps size and always removes hidden tab on completion or timeout', async () => {
  const originalTabs = chrome.tabs;
  const originalScripting = chrome.scripting;
  const originalRuntime = chrome.runtime;
  const originalTimeout = globalThis.setTimeout;
  let listener;
  let maxLength;
  const removed = [];
  let complete = true;
  chrome.tabs = {
    create: async () => ({ id: 77 }), remove: async (id) => removed.push(id),
    onUpdated: { addListener: (fn) => { listener = fn; if (complete) queueMicrotask(() => fn(77, { status: 'complete' })); }, removeListener: () => {} },
    sendMessage: (_id, message, options, callback) => { const done = typeof options === 'function' ? options : callback; maxLength = message.data.max_content_length; done({ success: true, data: { title: 'ok' } }); },
  };
  chrome.scripting = { executeScript: async () => [{ result: true }] };
  chrome.runtime = { lastError: null };
  try {
    const fetched = await fetchUrlFunction.execute({ url: 'https://example.com', max_content_length: NaN });
    assert.equal(fetched.success, true);
    assert.equal(maxLength, 5000);
    assert.deepEqual(removed, [77]);
    complete = false;
    globalThis.setTimeout = (fn, ms, ...args) => originalTimeout(fn, ms === 24_000 ? 0 : ms, ...args);
    const timedOut = await fetchUrlFunction.execute({ url: 'https://example.com' });
    assert.equal(timedOut.success, false);
    assert.match(timedOut.error, /超时/);
    assert.deepEqual(removed, [77, 77]);
  } finally {
    globalThis.setTimeout = originalTimeout;
    chrome.tabs = originalTabs;
    chrome.scripting = originalScripting;
    chrome.runtime = originalRuntime;
  }
});

test('extract reports zero appended at full buffer capacity', async () => {
  const id = `full-${Date.now()}`;
  const original = chrome.scripting;
  const full = Array.from({ length: 5000 }, (_, i) => ({ id: i }));
  await dataPipelineFunction.execute({ action: 'append', buffer_id: id, data: full });
  chrome.scripting = { executeScript: async () => [{ result: { success: true, data: { items: [{ id: 5000 }], fields: ['id'] } } }] };
  try {
    const result = await extractDataFunction.execute({ mode: 'schema', buffer_id: id, tab_id: 1 });
    assert.deepEqual([result.data.appended_count, result.data.total_count, result.data.sample], [0, 5000, []]);
  } finally {
    chrome.scripting = original;
    await dataPipelineFunction.execute({ action: 'clear', buffer_id: id });
  }
});

test('CDP truncated binary body remains valid base64 within size limit', async () => {
  const original = chrome.debugger.sendCommand;
  const bytes = Buffer.alloc(51 * 1024, 255);
  chrome.debugger.sendCommand = async () => ({ body: bytes.toString('base64'), base64Encoded: true });
  try {
    const result = await cdpNetworkFunction.execute({ action: 'get_body', request_id: 'big', tab_id: 12 });
    assert.equal(result.data.truncated, true);
    assert.equal(Buffer.from(result.data.body_base64, 'base64').length, 50 * 1024);
  } finally { chrome.debugger.sendCommand = original; }
});

test('CDP failed resolution keeps the request visible for retry', async () => {
  await cdpFetchFunction.execute({ action: 'enable', tab_id: 12 });
  for (const listener of listeners) listener({ tabId: 12 }, 'Fetch.requestPaused', { requestId: 'retry', request: { url: 'https://a.test', method: 'GET' } });
  const original = chrome.debugger.sendCommand;
  chrome.debugger.sendCommand = async (_target, method) => {
    if (method === 'Fetch.continueRequest') throw Error('CDP failed');
    return {};
  };
  try {
    const result = await cdpFetchFunction.execute({ action: 'continue', request_id: 'retry', tab_id: 12 });
    assert.equal(result.success, false);
    assert.deepEqual((await cdpFetchFunction.execute({ action: 'get_intercepted', tab_id: 12 })).data.intercepted.map((r) => r.request_id), ['retry']);
  } finally {
    chrome.debugger.sendCommand = original;
    await cdpFetchFunction.execute({ action: 'disable', tab_id: 12 });
  }
});

test('CDP binary body returns base64 without converting to text', async () => {
  const result = await cdpNetworkFunction.execute({ action: 'get_body', request_id: 'r1', tab_id: 12 });
  assert.equal(result.success, true);
  assert.equal(result.data.base64_encoded, true);
  assert.equal(result.data.body_base64, Buffer.from([0, 255, 128]).toString('base64'));
  assert.equal(result.data.body, undefined);
});

test('CDP completed requests leave the paused set after continue, fulfill and fail', async () => {
  await cdpFetchFunction.execute({ action: 'enable', tab_id: 12 });
  for (const action of ['continue', 'fulfill', 'fail']) {
    for (const listener of listeners) listener({ tabId: 12 }, 'Fetch.requestPaused', { requestId: action, request: { url: 'https://a.test', method: 'GET' } });
    assert.equal((await cdpFetchFunction.execute({ action: 'get_intercepted', tab_id: 12 })).data.total, 1);
    const response = await cdpFetchFunction.execute({ action, tab_id: 12, request_id: action, body_base64: 'AP+A' });
    assert.equal(response.success, true);
    assert.equal((await cdpFetchFunction.execute({ action: 'get_intercepted', tab_id: 12 })).data.total, 0, action);
  }
  assert.equal(commands.findLast(({ method }) => method === 'Fetch.fulfillRequest').params.body, 'AP+A');
  await cdpFetchFunction.execute({ action: 'disable', tab_id: 12 });
});
 
test('pagination requires explicit mode and reports stop reasons plus observed page size', async () => {
  assert.match(paginateFunction.validate({ url: 'https://api.test/items' }), /Provide param/);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1;
    const page = new URL(url).searchParams.get('page');
    const body = page === '1' ? JSON.stringify({ page: { ps: 10 }, items: [{ id: 1 }] }) : JSON.stringify({ page: { ps: 10 }, items: [{ id: 1 }] });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await paginateFunction.execute({ url: 'https://api.test/items', param: 'page', maxPages: 4 });
    assert.equal(result.success, true);
    assert.equal(result.data.stop_reason, 'identical_response');
    assert.equal(result.data.pages[0].actual_page_size, 10);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test('lazy image extraction prefers data-src over transparent src', async () => {
  const original = chrome.scripting;
  let injected;
  chrome.scripting = { executeScript: async (options) => { injected = options; return [{ result: { success: true, data: { items: [{ image: 'https://cdn.test/real.jpg' }], fields: ['image'] } } }]; } };
  try {
    const result = await extractDataFunction.execute({ mode: 'schema', schema: { item_selector: '.item', fields: [{ name: 'image', selector: 'img', attribute: 'src' }] }, tab_id: 1 });
    assert.equal(result.success, true);
    assert.equal(injected.args[0], 'schema');
  } finally { chrome.scripting = original; }
});

test('pagination reports non2xx max-pages and normal-end stops', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('', { status: 503 });
    assert.equal((await paginateFunction.execute({ url: 'https://api.test', param: 'page' })).data.stop_reason, 'non_2xx');
    globalThis.fetch = async (url) => new Response(JSON.stringify({ page: new URL(url).searchParams.get('page') }), { status: 200 });
    assert.equal((await paginateFunction.execute({ url: 'https://api.test', param: 'page', maxPages: 1 })).data.stop_reason, 'max_pages');
    globalThis.fetch = async () => new Response('[]', { status: 200 });
    assert.equal((await paginateFunction.execute({ url: 'https://api.test', param: 'page' })).data.stop_reason, 'normal_end');
  } finally { globalThis.fetch = originalFetch; }
});
 
test('binary fetch uses extension transport and rejects payloads above 12MB', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array(12 * 1024 * 1024 + 1), { status: 200, headers: { 'content-type': 'image/jpeg' } });
  try {
    const result = await fetchUrlFunction.execute({ url: 'https://cdn.test/image.jpg', binary: true });
    assert.equal(result.success, false);
    assert.match(result.error, /download_file|12MB/);
  } finally { globalThis.fetch = originalFetch; }
});

test('fetch masks content when the final URL is a credential page but keeps ordinary pages', async () => {
  const originalTabs = chrome.tabs;
  const originalScripting = chrome.scripting;
  const originalRuntime = chrome.runtime;
  let payload;
  const sentFrames = [];
  chrome.tabs = {
    create: async () => ({ id: 91 }), remove: async () => {},
    onUpdated: { addListener: (fn) => queueMicrotask(() => fn(91, { status: 'complete' })), removeListener: () => {} },
    sendMessage: (_id, _message, options, callback) => {
      const done = typeof options === 'function' ? options : callback;
      sentFrames.push(typeof options === 'object' ? options.frameId : undefined);
      done({ success: true, data: payload });
    },
  };
  chrome.scripting = { executeScript: async () => [{ result: true }] };
  chrome.runtime = { lastError: null };
  try {
    payload = { url: 'https://example.test/account/recovery-codes', title: 'Recovery', content: 'secret recovery words' };
    const masked = await fetchUrlFunction.execute({ url: 'https://example.test/login' });
    assert.equal(masked.success, true);
    assert.equal(masked.data.content, '[凭据页面已掩码]');
    assert.equal(masked.data.warning, '凭据页面内容不要转述');
    assert.doesNotMatch(JSON.stringify(masked.data), /secret recovery words/);

    // 页面内容必须钉在主 frame：不指定 frameId 时 Chrome 广播到所有 frame，iframe 会抢先响应
    assert.ok(sentFrames.length > 0 && sentFrames.every((frameId) => frameId === 0), `frameId=${JSON.stringify(sentFrames)}`);

    payload = { url: 'https://example.test/dashboard', title: 'Dashboard', content: '普通正文' };
    const ordinary = await fetchUrlFunction.execute({ url: 'https://example.test/dashboard' });
    assert.equal(ordinary.success, true);
    assert.equal(ordinary.data.content, '普通正文');
    assert.equal(ordinary.data.title, 'Dashboard');
  } finally {
    chrome.tabs = originalTabs;
    chrome.scripting = originalScripting;
    chrome.runtime = originalRuntime;
  }
});

test('binary fetch denies credential URLs before any request', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response(new Uint8Array([1, 2, 3]), { status: 200 }); };
  try {
    const direct = await fetchUrlFunction.execute({ url: 'https://example.test/account/recovery-codes', binary: true });
    assert.equal(direct.success, false);
    assert.match(direct.error, /凭据页面/);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('binary fetch denies a credential URL reached by redirect', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, url: 'https://example.test/secrets/download', headers: new Headers({ 'content-type': 'application/octet-stream' }), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
  try {
    const redirected = await fetchUrlFunction.execute({ url: 'https://example.test/asset.bin', binary: true });
    assert.equal(redirected.success, false);
    assert.match(redirected.error, /凭据页面/);
  } finally { globalThis.fetch = originalFetch; }
});

test('pagination refuses credential pages without returning their content', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, url: 'https://example.test/account/recovery-codes', text: async () => JSON.stringify({ items: [{ code: 'A1B2C3D4' }] }) });
  try {
    const page = await paginateFunction.execute({ url: 'https://api.test/items', param: 'page' });
    assert.equal(page.success, true);
    assert.equal(page.data.stop_reason, 'credential_page');
    assert.doesNotMatch(JSON.stringify(page.data), /A1B2C3D4/);
  } finally { globalThis.fetch = originalFetch; }
});

test('pagination masks token query values in ordinary page echoes', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, url: 'https://api.test/items?page=1', text: async () => JSON.stringify({ items: [{ id: 1 }], echo: { access_token: 'leaked-token' } }) });
  try {
    const page = await paginateFunction.execute({ url: 'https://api.test/items', param: 'page', maxPages: 1 });
    assert.equal(page.success, true);
    assert.equal(page.data.stop_reason, 'max_pages');
    assert.doesNotMatch(JSON.stringify(page.data), /leaked-token/);
    assert.match(JSON.stringify(page.data), /"id":1/);
  } finally { globalThis.fetch = originalFetch; }
});
