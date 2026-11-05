import { readFile } from 'node:fs/promises';

export const PUBLIC_PAGE_URL = 'https://www.selenium.dev/selenium/web/web-form.html';
export const PUBLIC_JSON_URL = 'https://jsonplaceholder.typicode.com/posts';
const FIXTURE_NAMES = new Set(['playground.html', 'creds.html', 'csp.html', 'frame-inner.html', 'newtab.html', 'newtab-child.html', 'flow.html', 'acceptance.html', 'gaps.html']);

export function publicFixtureUrl(name, runId) {
  if (!FIXTURE_NAMES.has(name)) throw new Error(`Unknown fixture: ${name}`);
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(runId)) throw new Error('Fixture runId must contain only letters, digits, underscores or hyphens');
  const origin = name === 'frame-inner.html' ? 'https://example.com' : 'https://www.selenium.dev';
  return `${origin}/__actspan_acceptance__/${runId}/${name}`;
}

// 此函数整体序列化到已有扩展 Options 页；只使用临时 Chrome API 监听器，不导入产品单例。
async function installInOptions({ tabId, url, routes, markers, timeoutMs }) {
  const target = { tabId };
  const deadline = Date.now() + timeoutMs;
  const pause = () => new Promise(resolve => setTimeout(resolve, 80));
  let attached = false;
  let interceptionEnabled = false;
  let autoAttachEnabled = false;
  let installError;
  let installed;
  let navigationProbeError;
  let fixtureWindowId;
  let previousActiveTabId;
  let lastFrames = [];
  const requestErrors = [];
  const cleanupErrors = [];
  const fulfilledUrls = [];
  const childStages = {};
  const unfinishedRequests = new Map();
  const failedRequests = [];
  const lifecycle = [];
  const pending = new Set();
  const childSessions = new Set();
  const patterns = Object.keys(routes).map(urlPattern => ({ urlPattern, requestStage: 'Request' }));
  const command = (method, params = {}, source = target) => chrome.debugger.sendCommand(source, method, params);
  const observe = async (source) => {
    await command('Page.enable', {}, source);
    await command('Page.setLifecycleEventsEnabled', { enabled: true }, source);
    await command('Network.enable', {}, source);
  };
  const onEvent = (source, method, params = {}) => {
    if (source.tabId !== tabId) return;
    const sessionId = source.sessionId || 'root';
    const requestKey = `${sessionId}:${params.requestId}`;
    if (method === 'Network.requestWillBeSent') {
      unfinishedRequests.set(requestKey, { sessionId, requestId: params.requestId, url: params.request.url, type: params.type, frameId: params.frameId });
      return;
    }
    if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      if (method === 'Network.loadingFailed') {
        failedRequests.push({ ...unfinishedRequests.get(requestKey), sessionId, requestId: params.requestId, error: params.errorText });
      }
      unfinishedRequests.delete(requestKey);
      return;
    }
    if (method === 'Page.lifecycleEvent' || method === 'Page.domContentEventFired' || method === 'Page.loadEventFired') {
      lifecycle.push({ sessionId, frameId: params.frameId, name: params.name || method, timestamp: params.timestamp });
      return;
    }
    if (method === 'Target.detachedFromTarget') {
      childSessions.delete(params.sessionId);
      childStages[params.sessionId] = 'detached';
      return;
    }
    if (method !== 'Fetch.requestPaused' && method !== 'Target.attachedToTarget') return;
    const operation = (async () => {
      if (method === 'Target.attachedToTarget') {
        const child = { tabId, sessionId: params.sessionId };
        childSessions.add(params.sessionId);
        childStages[params.sessionId] = 'enabling_fetch';
        await command('Fetch.enable', { patterns }, child);
        childStages[params.sessionId] = 'enabling_observation';
        await observe(child);
        childStages[params.sessionId] = 'enabling_auto_attach';
        await command('Target.setAutoAttach', {
          autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
          filter: [{ type: 'iframe', exclude: false }, { exclude: true }],
        }, child);
        childStages[params.sessionId] = 'resuming';
        await command('Runtime.runIfWaitingForDebugger', {}, child);
        childStages[params.sessionId] = 'resumed';
        return;
      }
      const route = routes[params.request.url];
      if (!route) {
        await command('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }, source);
        throw new Error(`Unexpected fixture request: ${params.request.url}`);
      }
      await command('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }, { name: 'Cache-Control', value: 'no-store' }],
        body: route,
      }, source);
      fulfilledUrls.push(params.request.url);
    })().catch(error => { requestErrors.push(error); });
    pending.add(operation);
    void operation.finally(() => pending.delete(operation));
  };
  try {
    // 仅夹具安装临时前台加载，避免 Chrome 延迟后台文档完成；被测产品动作仍按原焦点运行。
    const ownedTab = await chrome.tabs.get(tabId);
    fixtureWindowId = ownedTab.windowId;
    previousActiveTabId = (await chrome.tabs.query({ windowId: fixtureWindowId, active: true }))[0]?.id;
    await chrome.tabs.move(tabId, { index: -1 });
    await chrome.tabs.update(tabId, { active: true });
    // 上一次产品 CDP 动作可能还在 5 秒 idle 期；只等待释放，绝不强拆另一会话。
    while (!attached) {
      try { await chrome.debugger.attach(target, '1.3'); attached = true; }
      catch (error) {
        if (!String(error?.message || error).includes('Another debugger is already attached') || Date.now() >= deadline) throw error;
        await pause();
      }
    }
    chrome.debugger.onEvent.addListener(onEvent);
    await observe(target);
    await command('Fetch.enable', { patterns });
    interceptionEnabled = true;
    if (markers.length > 1) {
      await command('Target.setAutoAttach', {
        autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
        filter: [{ type: 'iframe', exclude: false }, { exclude: true }],
      });
      autoAttachEnabled = true;
    }
    const navigation = await command('Page.navigate', { url });
    if (navigation.errorText) throw new Error(navigation.errorText);
    while (Date.now() < deadline) {
      if (requestErrors.length) throw requestErrors[0];
      let frames;
      try {
        frames = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true }, world: 'ISOLATED', injectImmediately: true,
          func: () => ({
            url: location.href,
            marker: document.documentElement?.getAttribute('data-actspan-fixture'),
            ready: document.readyState === 'complete',
            rawReady: document.readyState,
            scriptCount: document.scripts.length,
            tail: document.body?.innerHTML.slice(-100),
            shadowReady: Boolean(document.querySelector('#shadow-host')?.shadowRoot),
          }),
        });
        lastFrames = frames.map(frame => ({ frameId: frame.frameId, ...frame.result }));
        navigationProbeError = undefined;
      } catch (error) {
        // Page.navigate 已接受不代表导航已提交；旧主框架可被移除，about:blank 也尚无 host 权限。
        // 只重试这两个精确已知过渡，目标 URL 的权限失败及其它异常必须立即保留。
        const message = String(error?.message || error);
        if (message !== 'Frame with ID 0 was removed.' && !/^Cannot access contents of url ["']about:blank["']\./.test(message)) throw error;
        navigationProbeError = error;
        await pause();
        continue;
      }
      if (markers.every(marker => frames.some(frame => frame.result?.ready && frame.result.marker === marker))) {
        if (requestErrors.length) throw requestErrors[0];
        installed = { tabId, url, loaded: true };
        break;
      }
      await pause();
    }
    if (!installed) throw navigationProbeError || new Error(`Fixture did not finish loading: ${url}`);
  } catch (error) {
    installError = error;
  }
  // 清理逐项尝试；主失败、迟到请求失败和清理失败一起保留，不在 finally 中覆盖异常。
  const cleanup = async (label, action) => {
    try { await action(); }
    catch (error) { cleanupErrors.push(new Error(`${label}: ${error?.message || error}`)); }
  };
  await Promise.allSettled([...pending]);
  const diagnostics = {
    lastFrames, fulfilledUrls, childStages: { ...childStages },
    unfinishedRequests: [...unfinishedRequests.values()], failedRequests, lifecycle,
  };
  for (const sessionId of childSessions) await cleanup(`child ${sessionId} Fetch.disable`, () => command('Fetch.disable', {}, { tabId, sessionId }));
  if (autoAttachEnabled) await cleanup('Target.setAutoAttach', () => command('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }));
  if (interceptionEnabled) await cleanup('Fetch.disable', () => command('Fetch.disable'));
  await cleanup('removeListener', () => chrome.debugger.onEvent.removeListener(onEvent));
  if (attached) await cleanup('detach', () => chrome.debugger.detach(target));
  await Promise.allSettled([...pending]);
  if (previousActiveTabId !== undefined && previousActiveTabId !== tabId) {
    await cleanup('restore active tab', async () => {
      const tabs = await chrome.tabs.query({ windowId: fixtureWindowId });
      // 用户若已切页或原页已关闭，不抢回焦点；所有 CDP 清理完成后才恢复原活动页。
      if (tabs.find(tab => tab.active)?.id === tabId && tabs.some(tab => tab.id === previousActiveTabId)) {
        await chrome.tabs.update(previousActiveTabId, { active: true });
      }
    });
  }
  const errors = [...new Set([installError, ...requestErrors, ...cleanupErrors].filter(Boolean))];
  if (errors.length) {
    throw new AggregateError(errors, `${errors.map(error => error?.message || error).join('; ')}; fixture diagnostics: ${JSON.stringify(diagnostics)}`);
  }
  return installed;
}

/** evaluate 在调用方已创建的 Options 页执行表达式并等待 Promise；不创建浏览器或标签。 */
export async function installPublicFixture({ evaluate, tabId, name, runId, timeoutMs = 20000 }) {
  if (typeof evaluate !== 'function') throw new Error('Public fixtures require an evaluate function for an existing extension Options page');
  if (!Number.isInteger(tabId)) throw new Error('Public fixtures require an explicitly owned tabId');
  const url = publicFixtureUrl(name, runId);
  const names = name === 'playground.html' ? [name, 'frame-inner.html'] : [name];
  const routes = {};
  for (const fixture of names) {
    const html = await readFile(new URL(`../fixtures/${fixture}`, import.meta.url), 'utf8');
    const marked = html.replace('<html ', `<html data-actspan-fixture="${runId}:${fixture}" `)
      .replace('src="frame-inner.html"', `src="${publicFixtureUrl('frame-inner.html', runId)}"`);
    routes[publicFixtureUrl(fixture, runId)] = Buffer.from(marked).toString('base64');
  }
  const markers = names.map(fixture => `${runId}:${fixture}`);
  const installed = await evaluate(`(${installInOptions.toString()})(${JSON.stringify({ tabId, url, routes, markers, timeoutMs })})`);
  if (installed?.loaded !== true || installed.tabId !== tabId || installed.url !== url) throw new Error(`Fixture installation did not return a verified page: ${JSON.stringify(installed)}`);
  return { ...installed, detached: true };
}

/** 只删除本轮通过已安装扩展创建、且文件名精确匹配的下载。 */
export async function removeFixtureDownload({ evaluate, downloadId, filename, timeoutMs = 5000 }) {
  if (typeof evaluate !== 'function') throw new Error('Download cleanup requires an existing extension Options connector');
  if (!Number.isInteger(downloadId) || downloadId < 0) throw new Error('Download cleanup requires the returned download_id');
  if (!/^actspan-scenarios-\d+-acceptance\.txt$/.test(filename)) throw new Error('Download cleanup requires a unique acceptance filename');
  const removeInOptions = async ({ downloadId, filename, timeoutMs }) => {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const [item] = await chrome.downloads.search({ id: downloadId });
      if (!item || item.byExtensionId !== chrome.runtime.id || item.filename.split(/[\\/]/).pop() !== filename) {
        throw new Error(`Refusing cleanup of unmatched download ${downloadId}`);
      }
      if (item.state === 'complete') break;
      if (item.state === 'interrupted' || Date.now() >= deadline) throw new Error(`Download ${downloadId} did not complete: ${item.state}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await chrome.downloads.removeFile(downloadId);
    const erased = await chrome.downloads.erase({ id: downloadId });
    if (!erased.includes(downloadId)) throw new Error(`Download ${downloadId} file removed but history was not erased`);
    return { downloadId, removed: true, erased: true };
  };
  const result = await evaluate(`(${removeInOptions.toString()})(${JSON.stringify({ downloadId, filename, timeoutMs })})`);
  if (result?.downloadId !== downloadId || result.removed !== true || result.erased !== true) {
    throw new Error(`Download ${downloadId} cleanup did not return a verified result: ${JSON.stringify(result)}`);
  }
  return result;
}
