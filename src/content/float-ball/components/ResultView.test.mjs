import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const bundle = await build({
  stdin: {
    contents: `
      export { ResultView } from './src/content/float-ball/components/ResultView.tsx';
      export { ActspanContext } from './src/content/float-ball/context/context.ts';
    `,
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react'], jsx: 'transform',
});
const module = { exports: {} };
new Function('require', 'exports', 'module', bundle.outputFiles[0].text)(require, module.exports, module);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { ResultView, ActspanContext } = module.exports;

test('result container hides only failed link favicons through a CSP-safe React handler', (t) => {
  const createElement = React.createElement;
  let onError;
  t.mock.method(React, 'createElement', (type, props, ...children) => {
    if (props?.className === 'actspan-result visible') onError = props.onErrorCapture;
    return createElement(type, props, ...children);
  });
  const html = renderToStaticMarkup(React.createElement(ActspanContext.Provider, {
    value: { state: { currentTask: {
      id: 'csp-test', status: 'done', startedAt: 0, durationMs: 0,
      lastAIText: 'https://example.com/article', callStack: [], rounds: [],
    } } },
  }, React.createElement(ResultView)));
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.equal(typeof onError, 'function');

  const previous = globalThis.HTMLImageElement;
  class Image {
    constructor(isFavicon) {
      this.classList = { contains: (name) => isFavicon && name === 'actspan-link-favicon' };
      this.style = {};
    }
  }
  globalThis.HTMLImageElement = Image;
  try {
    const favicon = new Image(true);
    const screenshot = new Image(false);
    onError({ target: favicon });
    onError({ target: screenshot });
    onError({ target: null });
    onError({ target: { style: {} } });
    assert.equal(favicon.style.display, 'none');
    assert.equal(screenshot.style.display, undefined);
  } finally { globalThis.HTMLImageElement = previous; }
});
