import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { resolve } from 'node:path';
import { Script } from 'node:vm';
import { installPublicFixture, publicFixtureUrl, removeFixtureDownload } from './helpers/public-fixtures.mjs';

const fixtureRoot = resolve('test/fixtures');
const fixtures = {
  playground: ['id="event-log"', 'id="svg-icon"', 'id="mousedown-menu"', 'id="focus-preserving"', 'id="hidden-content"', 'id="form-result"', 'id="disabled"', 'id="upload"', 'id="drop-zone"', 'id="amount"', 'id="pay-result"', 'id="fixture-frame"', 'id="scroll-result"', 'id="shadow-host"', 'data-testid="email"'],
  creds: ['data-credential-page', 'name="password"', 'id="code-group-a"', 'id="code-group-b"', 'id="ordinary-reference"', 'id="credential-result"'],
  csp: ['Content-Security-Policy', "script-src 'nonce-fixture-only'", 'id="data-csp-probe"', 'id="csp-inline-blocked"', 'id="csp-result"'],
  'frame-inner': ['data-frame-inner', 'data-testid="frame-action"', 'id="frame-value-result"', 'id="frame-event-log"'],
  newtab: ['data-newtab-launcher', 'target="_blank"', 'id="newtab-window-open"', 'id="newtab-result"'],
  'newtab-child': ['data-newtab-child', 'id="child-action"', 'id="child-result"'],
  flow: ['data-flow-step="start"', 'data-flow-step="finish"', 'id="add-item"', 'id="optional-banner"', 'id="finish-flow"', 'id="flow-event-log"'],
  acceptance: ['id="plain"', 'id="svg-link"', 'id="dropdown"', 'id="secret"', 'id="sensitive-form"', 'id="cross"'],
  gaps: ['data-gaps-fixture', 'id="tab-a"', 'aria-selected="true"', 'id="icon-glyph"', 'id="gap-email"', 'id="card-close"'],
};

test('fixture pages expose unique, stable assertion hooks and executable inline scripts', async () => {
  for (const [name, markers] of Object.entries(fixtures)) {
    const html = await readFile(resolve(fixtureRoot, `${name}.html`), 'utf8');
    for (const marker of markers) assert.ok(html.includes(marker), `${name} missing ${marker}`);
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length, `${name} has duplicate ids`);
    for (const [, source] of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
      assert.doesNotThrow(() => new Script(source, { filename: `${name}.html` }));
    }
  }
  // 安装器的故障路径必须释放本次 attach，且必须把完整 CSP HTML 交给浏览器解析。
  for (const [fixtureName, failNavigation, probeMode] of [
    ['csp.html', false], ['csp.html', true], ['playground.html', false],
    ['csp.html', false, 'transition'], ['csp.html', false, 'permission'], ['csp.html', false, 'blank-timeout'],
    ['csp.html', false, 'frame-transition'], ['csp.html', false, 'frame-timeout'], ['csp.html', false, 'other-frame-error'],
    ['csp.html', true, 'cleanup-error'], ['csp.html', false, 'late-request'], ['playground.html', false, 'network-timeout'],
    ['csp.html', false, 'user-switch'], ['csp.html', false, 'original-closed'], ['csp.html', false, 'original-active'],
  ]) {
    const commands = [];
    const listeners = new Set();
    let probeCount = 0;
    const tabs = [
      { id: 42, windowId: 7, active: probeMode === 'original-active' },
      { id: 55, windowId: 7, active: probeMode !== 'original-active' },
      { id: 77, windowId: 7, active: false },
    ];
    const chrome = { tabs: {
      async get(id) { commands.push(['tabs.get', id]); return tabs.find(tab => tab.id === id); },
      async query(query) {
        commands.push(['tabs.query', query]);
        return tabs.filter(tab => tab.windowId === query.windowId && (!query.active || tab.active));
      },
      async move(id, options) { commands.push(['tabs.move', id, options]); },
      async update(id, options) {
        commands.push(['tabs.update', id, options]);
        assert.equal(options.active, true);
        for (const tab of tabs) tab.active = tab.id === id;
      },
    }, scripting: { async executeScript(injection) {
      assert.equal(injection.injectImmediately, true, 'readiness probes must observe loading documents without waiting for document_idle');
      probeCount += 1;
      if ((probeMode === 'transition' && probeCount === 1) || probeMode === 'blank-timeout') {
        throw new Error('Cannot access contents of url "about:blank". Extension manifest must request permission to access this host.');
      }
      if ((probeMode === 'frame-transition' && probeCount === 1) || probeMode === 'frame-timeout') throw new Error('Frame with ID 0 was removed.');
      if (probeMode === 'other-frame-error') throw new Error('Frame with ID 7 was removed.');
      if (probeMode === 'permission') throw new Error('Cannot access contents of url "https://www.selenium.dev/private". Extension manifest must request permission to access this host.');
      return ['csp.html', 'playground.html', 'frame-inner.html'].map(name => ({ result: { ready: probeMode !== 'network-timeout', marker: `offline-adapter:${name}` } }));
    } }, debugger: {
      async attach() { commands.push(['attach']); },
      async detach() { commands.push(['detach']); },
      onEvent: { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); } },
      async sendCommand(target, method, params) {
        commands.push([method, params, target.sessionId || 'root']);
        if (method === 'Fetch.disable' && probeMode === 'cleanup-error') throw new Error('disable failed');
        if (method === 'Fetch.fulfillRequest' && probeMode === 'late-request') {
          await new Promise(resolve => setTimeout(resolve, 10));
          throw new Error('late fulfill failed');
        }
        if (method === 'Page.navigate') {
          if (probeMode === 'user-switch') for (const tab of tabs) tab.active = tab.id === 77;
          if (probeMode === 'original-closed') tabs.splice(tabs.findIndex(tab => tab.id === 55), 1);
          if (failNavigation) throw new Error('navigation failed');
          for (const listener of listeners) listener(target, 'Page.frameResized');
          for (const listener of listeners) listener(target, 'Fetch.requestPaused', { requestId: 'fixture-request', request: { url: params.url } });
          if (fixtureName === 'playground.html') {
            for (const listener of listeners) {
              listener(target, 'Target.attachedToTarget', { sessionId: 'child-session', targetInfo: { type: 'iframe' } });
              listener({ tabId: target.tabId, sessionId: 'child-session' }, 'Fetch.requestPaused', { requestId: 'child-request', request: { url: publicFixtureUrl('frame-inner.html', 'offline-adapter') } });
            }
          }
          if (probeMode === 'network-timeout') {
            for (const listener of listeners) {
              listener(target, 'Network.requestWillBeSent', { requestId: 'done', request: { url: params.url }, type: 'Document', frameId: 'main' });
              listener(target, 'Network.loadingFinished', { requestId: 'done' });
              listener(target, 'Network.requestWillBeSent', { requestId: 'failed', request: { url: 'https://example.com/favicon.ico' }, type: 'Image', frameId: 'main' });
              listener(target, 'Network.loadingFailed', { requestId: 'failed', errorText: 'net::ERR_FAILED' });
              const child = { tabId: target.tabId, sessionId: 'child-session' };
              listener(child, 'Network.requestWillBeSent', { requestId: 'pending', request: { url: publicFixtureUrl('frame-inner.html', 'offline-adapter') }, type: 'Document', frameId: 'child' });
              listener(target, 'Page.lifecycleEvent', { frameId: 'main', name: 'DOMContentLoaded', timestamp: 1 });
              listener(child, 'Page.domContentEventFired', { timestamp: 2 });
            }
          }
        }
        return method === 'Runtime.evaluate' ? { result: { value: true } } : {};
      },
    } };
    const evaluate = expression => new Script(expression).runInNewContext({ chrome, setTimeout, Date });
    const installing = installPublicFixture({ evaluate, tabId: 42, name: fixtureName, runId: 'offline-adapter', ...(probeMode?.endsWith('timeout') ? { timeoutMs: 25 } : {}) });
    if (probeMode === 'cleanup-error') {
      await assert.rejects(installing, error => {
        assert.match(error.message, /navigation failed/);
        assert.match(error.message, /Fetch.disable: disable failed/);
        assert.equal(error.errors.length, 2);
        return true;
      });
    } else if (probeMode === 'late-request') await assert.rejects(installing, /late fulfill failed/);
    else if (probeMode === 'network-timeout') {
      await assert.rejects(installing, error => {
        const diagnostics = JSON.parse(error.message.split('; fixture diagnostics: ')[1]);
        assert.deepEqual(diagnostics.unfinishedRequests, [{ sessionId: 'child-session', requestId: 'pending', url: publicFixtureUrl('frame-inner.html', 'offline-adapter'), type: 'Document', frameId: 'child' }]);
        assert.equal(diagnostics.failedRequests[0].error, 'net::ERR_FAILED');
        assert.deepEqual(diagnostics.lifecycle.map(event => [event.sessionId, event.name]), [['root', 'DOMContentLoaded'], ['child-session', 'Page.domContentEventFired']]);
        return true;
      });
      for (const session of ['root', 'child-session']) {
        assert.ok(commands.some(([method, , id]) => method === 'Network.enable' && id === session));
        assert.ok(commands.some(([method, , id]) => method === 'Page.setLifecycleEventsEnabled' && id === session));
      }
    } else if (failNavigation) await assert.rejects(installing, /navigation failed/);
    else if (probeMode === 'permission') {
      await assert.rejects(installing, /Cannot access contents of url "https:/);
      assert.equal(probeCount, 1, 'a permission failure on the destination must not be retried');
    } else if (probeMode === 'blank-timeout') await assert.rejects(installing, /Cannot access contents of url "about:blank"/);
    else if (probeMode === 'frame-timeout') await assert.rejects(installing, /Frame with ID 0 was removed\./);
    else if (probeMode === 'other-frame-error') {
      await assert.rejects(installing, /Frame with ID 7 was removed\./);
      assert.equal(probeCount, 1, 'an unrelated frame failure must not be retried');
    }
    else {
      const result = await installing;
      assert.equal(result.detached, true);
      assert.equal(result.url, publicFixtureUrl(fixtureName, 'offline-adapter'));
      const fulfilled = commands.find(([method]) => method === 'Fetch.fulfillRequest')[1];
      const body = Buffer.from(fulfilled.body, 'base64').toString('utf8');
      if (fixtureName === 'csp.html') {
        assert.match(body, /<meta http-equiv="Content-Security-Policy"/);
        assert.match(body, /<script nonce="fixture-only">/);
      } else {
        assert.match(body, /src="https:\/\/example.com\/__actspan_acceptance__\/offline-adapter\/frame-inner.html"/);
        assert.equal(commands.filter(([method]) => method === 'Fetch.fulfillRequest').length, 2);
        assert.ok(commands.some(([method]) => method === 'Runtime.runIfWaitingForDebugger'));
      }
      assert.ok(body.includes(`data-actspan-fixture="offline-adapter:${fixtureName}"`));
      if (probeMode === 'transition' || probeMode === 'frame-transition') assert.equal(probeCount, 2, 'the complete marker must be verified after navigation commits');
    }
    assert.equal(listeners.size, 0);
    assert.deepEqual(commands.slice(0, 5).map(([method]) => method), ['tabs.get', 'tabs.query', 'tabs.move', 'tabs.update', 'attach']);
    assert.equal(commands[2][1], 42);
    assert.equal(commands[2][2].index, -1, 'only the owned fixture tab is moved to the right edge');
    assert.equal(commands[3][1], 42);
    assert.deepEqual(commands.filter(([method]) => !method.startsWith('tabs.')).slice(-2).map(([method]) => method), ['Fetch.disable', 'detach']);
    const restore = commands.findIndex(([method, id]) => method === 'tabs.update' && id === 55);
    if (['user-switch', 'original-closed', 'original-active'].includes(probeMode)) {
      assert.equal(restore, -1, 'cleanup must not override a user switch, revive a closed tab, or re-activate the same tab');
      assert.equal(tabs.find(tab => tab.active)?.id, probeMode === 'user-switch' ? 77 : 42);
    } else {
      assert.ok(restore > commands.findIndex(([method]) => method === 'detach'), 'restore the previous active tab after detach, including failed installations');
      assert.equal(tabs.find(tab => tab.active)?.id, 55);
    }
  }
  assert.throws(() => publicFixtureUrl('../package.json', 'offline-adapter'), /Unknown fixture/);
  for (const mode of ['owned', 'wrong-owner', 'wrong-file', 'remove-error']) {
    const mutations = [];
    const filename = 'actspan-scenarios-123-acceptance.txt';
    const chrome = { runtime: { id: 'fixture-extension' }, downloads: {
      async search({ id }) {
        assert.equal(id, 42);
        return [{ id, state: 'complete', byExtensionId: mode === 'wrong-owner' ? 'other-extension' : 'fixture-extension', filename: `C:/Downloads/${mode === 'wrong-file' ? 'user.txt' : filename}` }];
      },
      async removeFile(id) { mutations.push(['removeFile', id]); if (mode === 'remove-error') throw new Error('file removal failed'); },
      async erase({ id }) { mutations.push(['erase', id]); return [id]; },
    } };
    const evaluate = expression => new Script(expression).runInNewContext({ chrome, setTimeout, Date });
    const cleaning = removeFixtureDownload({ evaluate, downloadId: 42, filename });
    if (mode === 'owned') {
      assert.equal((await cleaning).removed, true);
      assert.deepEqual(mutations, [['removeFile', 42], ['erase', 42]]);
    } else if (mode === 'remove-error') {
      await assert.rejects(cleaning, /file removal failed/);
      assert.deepEqual(mutations, [['removeFile', 42]], 'failed file deletion must preserve its download record');
    } else {
      await assert.rejects(cleaning, /Refusing cleanup of unmatched download/);
      assert.deepEqual(mutations, [], 'downloads not owned by this exact test must remain unchanged');
    }
  }
});

test('playground exercises event order and actual DOM effects', async () => {
  const html = await readFile(resolve(fixtureRoot, 'playground.html'), 'utf8');
  for (const eventName of ['pointerover', 'mouseover', 'mousemove', 'pointerdown', 'mousedown', 'focus', 'pointerup', 'mouseup', 'click']) {
    assert.ok(html.includes(`'${eventName}'`), `playground missing ${eventName} recorder`);
  }
  for (const effect of ["addEventListener('mousedown'", 'event.preventDefault()', 'validation-complete', "addEventListener('change'", "addEventListener('drop'", "addEventListener('scroll'"]) {
    assert.ok(html.includes(effect), `playground missing ${effect}`);
  }
});

test('new-tab and iframe routes remain on local fixtures', async () => {
  const parent = await readFile(resolve(fixtureRoot, 'newtab.html'), 'utf8');
  const playground = await readFile(resolve(fixtureRoot, 'playground.html'), 'utf8');
  assert.match(parent, /href="newtab-child\.html"/);
  assert.match(parent, /window\.open\('newtab-child\.html'/);
  assert.match(playground, /src="frame-inner\.html"/);
});
