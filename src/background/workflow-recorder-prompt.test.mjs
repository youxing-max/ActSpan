import assert from 'node:assert/strict';
import { build } from 'esbuild';
import test from 'node:test';

const bundle = await build({
  stdin: {
    contents: `export { buildRecorderAuditPrompt } from './src/background/workflow-recorder-prompt.ts';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { buildRecorderAuditPrompt } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`
);

const cleanSteps = [
  {
    seq: 1,
    action: 'navigate',
    selector: '',
    semanticHint: '打开商品搜索页',
    tag: '',
    url: 'https://shop.example/search',
  },
  {
    seq: 2,
    action: 'click',
    selector: 'input[name="q"]',
    semanticHint: '搜索框',
    tag: 'input',
    url: 'https://shop.example/search',
  },
  {
    seq: 3,
    action: 'type',
    selector: 'input[name="q"]',
    semanticHint: '输入商品关键词',
    tag: 'input',
    value: '咖啡',
    url: 'https://shop.example/search',
  },
];

const prompt = buildRecorderAuditPrompt(cleanSteps, 'https://shop.example/search');

test('录制审计 prompt 规定四项元数据和可调用触发短语', () => {
  assert.match(prompt, /name/);
  assert.match(prompt, /label/);
  assert.match(prompt, /description/);
  assert.match(prompt, /triggers/);
  assert.match(prompt, /英文 snake_case/);
  assert.match(prompt, /2[-至]5|2-5/);
  assert.match(prompt, /中文.*(?:调用|短语)|调用.*中文/);
});

test('录制审计 prompt 优先根据步骤自动补全并仅在无法推断时询问', () => {
  assert.match(prompt, /录制步骤.*(?:起始 URL|URL).*自动(?:生成|推断|补全|修正)/s);
  assert.match(prompt, /先.*自动(?:修正|补全|推断)/s);
  assert.match(prompt, /只有.*无法.*(?:推断|判断).*询问|无法.*才.*询问/s);
});

test('录制审计 prompt 要求修改后展示完整 JSON 且严格 JSON 输出', () => {
  assert.match(prompt, /修改.*(?:完整 workflow JSON|完整 JSON).*展示|更新.*完整.*JSON/s);
  assert.match(prompt, /严格 JSON/);
  assert.match(prompt, /workflow_json.*(?:不|禁止|不得).*(?:保存|save_workflow)|(?:不|禁止|不得).*(?:保存|save_workflow).*workflow_json/s);
  assert.match(prompt, /readable_steps/);
  assert.match(prompt, /plan/);
  assert.match(prompt, /parameters/);
  assert.match(prompt, /"parameters": \{\s*"type": "object",\s*"properties": \{\}\s*\}/s);
});
