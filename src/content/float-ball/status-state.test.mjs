import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `export { nextStatusState } from './src/content/float-ball/status-state.ts'; export { StatusCurtain } from './src/content/float-ball/ActspanRoot.tsx';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { nextStatusState, StatusCurtain } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

test('the latest explicit status replaces the previous one immediately', () => {
  const first = nextStatusState(null, { text: 'Opening the menu', language: 'en' });
  const second = nextStatusState(first, { text: 'Reading the results', language: 'en' });
  assert.equal(first.text, 'Opening the menu');
  assert.equal(second.text, 'Reading the results');
});

test('active false and empty text return the cockpit to idle, not to a sticky last status', () => {
  const running = nextStatusState(null, { text: 'Opening the menu' });
  assert.equal(nextStatusState(running, { active: false }), null);
  assert.equal(nextStatusState(running, { text: '' }), null);
});

test('invalid status payload leaves existing status unchanged', () => {
  const running = nextStatusState(null, { text: 'Opening the menu' });
  assert.equal(nextStatusState(running, { text: 123 }), running);
});

test('curtain renders current status accessibly and disappears in idle state', () => {
  const running = renderToStaticMarkup(React.createElement(StatusCurtain, { text: 'Reading the results' }));
  assert.match(running, /role="status"/);
  assert.match(running, /aria-live="polite"/);
  assert.match(running, /Reading the results/);
  assert.equal(renderToStaticMarkup(React.createElement(StatusCurtain, { text: '' })), '');
});
