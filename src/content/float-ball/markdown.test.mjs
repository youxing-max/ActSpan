import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `export { markdownToHtml, inlineMarkdown } from './src/content/float-ball/markdown.ts';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { markdownToHtml, inlineMarkdown } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`
);

test('dangerous link protocols are stripped to plain text', () => {
  const html = markdownToHtml('[click](javascript:alert(1))');
  assert.equal(html.includes('href'), false);
  assert.equal(html.includes('javascript:'), false);
  assert.ok(html.includes('click'));
});

test('control characters cannot smuggle a javascript: URL past the scheme check', () => {
  for (const raw of ['java\nscript:alert(1)', 'java\tscript:alert(1)', 'java\u0000script:alert(1)']) {
    const html = markdownToHtml(`[click](${raw})`);
    assert.equal(html.includes('href'), false, raw);
    assert.equal(html.includes('javascript:'), false, raw);
  }
});

test('data: and other non-whitelisted image sources are not rendered', () => {
  const html = markdownToHtml('![x](data:image/png;base64,AAAA)');
  assert.equal(html.includes('<img'), false);
});

test('https links survive with noopener and noreferrer', () => {
  const html = inlineMarkdown('[a](https://example.com/x?a=1&amp;b=2)');
  assert.ok(html.includes('href="https://example.com/x?a=1&amp;b=2"'));
  assert.ok(html.includes('rel="noopener noreferrer"'));
});

test('model output cannot collide with the slot placeholder', () => {
  // 输入中的 %%SLOT0%% 必须原样保留，不能被真实链接替换
  const html = inlineMarkdown('%%SLOT0%% [a](https://example.com)');
  assert.ok(html.includes('%%SLOT0%%'));
  assert.ok(html.includes('href="https://example.com"'));
});

test('tables render in a scrollable wrapper with column-count sizing', () => {
  const html = markdownToHtml([
    '| # | 标题 | 来源 | 摘要 |',
    '|---|---|---|---|',
    '| 1 | Google Play | play.google.com/apps/dev?id=1 | 123 CO., LTD. |',
  ].join('\n'));
  assert.ok(html.includes('class="actspan-table-wrap"'), html);
  assert.ok(html.includes('class="actspan-md-table cols-4"'), html);
  assert.ok(html.trimEnd().endsWith('</table></div>'), html);
});

test('domain-only link text becomes a compact link chip', () => {
  const html = markdownToHtml('[play.google.com/apps/dev?id=1](https://play.google.com/apps/dev?id=1)');
  assert.ok(html.includes('class="actspan-link-chip"'), html);
  assert.ok(html.includes('play.google.com/apps/dev'),
    'chip keeps a shortened, readable URL');
});

test('link chips render without inline event handlers under extension CSP', () => {
  for (const text of [
    'https://example.com/article',
    '[https://example.com/article](https://example.com/article)',
    '[example.com/article](https://example.com/article)',
  ]) {
    const html = markdownToHtml(text);
    assert.match(html, /class="actspan-link-favicon"/);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
    assert.match(html, /href="https:\/\/example\.com\/article"/);
  }
});
