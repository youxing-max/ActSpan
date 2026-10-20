import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const bundle = await build({
  stdin: {
    contents: `
      export { AskUserCard } from './src/content/float-ball/components/AskUserCard.tsx';
      export { Trigger } from './src/content/float-ball/components/Trigger.tsx';
      export { ActspanContext } from './src/content/float-ball/context/context.ts';
    `,
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react'],
});
const module = { exports: {} };
new Function('require', 'exports', 'module', bundle.outputFiles[0].text)(require, module.exports, module);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { AskUserCard, Trigger, ActspanContext } = module.exports;

test('full ask card offers denial beside existing answer controls', () => {
  const html = renderToStaticMarkup(React.createElement(AskUserCard, {
    requestId: 'ask_1', question: 'Choose?', options: ['Yes'], allowFreeText: true,
  }));
  assert.match(html, /actspan-ask-user-option[^>]*>Yes<\/button>/);
  assert.match(html, /actspan-ask-user-submit[^>]*>发送<\/button>/);
  assert.match(html, /actspan-ask-user-deny[^>]*>拒绝<\/button>/);
});

test('mini ask card offers denial when free text is disabled', () => {
  globalThis.chrome = { runtime: { getURL: path => path } };
  globalThis.window = { location: { hostname: 'test.invalid' } };
  const html = renderToStaticMarkup(React.createElement(
    ActspanContext.Provider,
    { value: { state: { side: 'right', currentY: 100, askUserRequest: { requestId: 'ask_2', question: 'Choose?', options: ['Yes'], allowFreeText: false } }, dispatch() {} } },
    React.createElement(Trigger, { onRecordClick() {} }),
  ));
  assert.match(html, /pac-option[^>]*>Yes<\/button>/);
  assert.match(html, /pac-deny[^>]*>拒绝<\/button>/);
});
