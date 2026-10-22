import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `
      export { getTextContent, stripImagesFromContent, estimateContextTokens, compactContext } from './src/ai/context-manager.ts';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { getTextContent, stripImagesFromContent, estimateContextTokens, compactContext } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`
);

test('getTextContent reads assistant output_text parts', () => {
  // Responses API 的助手消息使用 output_text；旧实现只识别 input_text，会返回空串。
  assert.equal(getTextContent([{ type: 'output_text', text: 'hi' }]), 'hi');
  assert.equal(
    getTextContent([
      { type: 'output_text', text: 'line1' },
      { type: 'output_text', text: 'line2' },
    ]),
    'line1\nline2',
  );
});

test('getTextContent still reads input_text and plain strings', () => {
  assert.equal(getTextContent([{ type: 'input_text', text: 'hello' }]), 'hello');
  assert.equal(getTextContent('plain'), 'plain');
  assert.equal(getTextContent([{ type: 'input_image', image_url: 'data:x' }]), '');
});

test('stripImagesFromContent keeps output_text and marks images', () => {
  assert.equal(
    stripImagesFromContent([
      { type: 'output_text', text: 'answer' },
      { type: 'input_image', image_url: 'data:x' },
    ]),
    'answer\n[图片已省略]',
  );
});

test('estimateContextTokens counts assistant output_text', () => {
  const tokens = estimateContextTokens([
    { role: 'assistant', content: [{ type: 'output_text', text: 'abcdefgh' }] },
  ]);
  assert.ok(tokens > 0);
});

test('compaction never leaves an orphan function_call_output at the tail start', () => {
  const context = [
    { role: 'user', content: 'goal' },
    ...Array.from({ length: 9 }, (_, index) => [
      { type: 'function_call', id: `id${index}`, call_id: `c${index}`, name: 'page', arguments: '{}' },
      { type: 'function_call_output', call_id: `c${index}`, output: '{"success":true}' },
    ]).flat(),
    { role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
  ];
  // 20 条、上限 8 → 初始 dropEnd=14 恰好落在 out6 上
  const changed = compactContext(context, 8, () => undefined);
  assert.equal(changed, true);
  assert.equal(context[1].role, 'assistant', 'summary must follow the first user message');
  assert.notEqual(context[2]?.type, 'function_call_output');
  for (const item of context) {
    if (item.type === 'function_call_output') {
      assert.ok(context.some((candidate) => candidate.type === 'function_call' && candidate.call_id === item.call_id),
        `orphan output ${item.call_id} survived compaction`);
    }
  }
});
