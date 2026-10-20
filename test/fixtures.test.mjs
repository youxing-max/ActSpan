import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { resolve } from 'node:path';
import { Script } from 'node:vm';

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
