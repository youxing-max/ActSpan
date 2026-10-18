import assert from 'node:assert/strict';
import { build } from 'esbuild';
import test from 'node:test';

const bundle = await build({
  stdin: { contents: `export { buildSystemPrompt } from './src/ai/system-prompt.ts';`,
    resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { buildSystemPrompt } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`
);

test('system prompt gives deterministic workflow discovery and execution naming rules', () => {
  const prompt = buildSystemPrompt([], false);
  assert.match(prompt, /matched workflow|匹配.*工作流/i);
  assert.match(prompt, /skill\(action=["']list["']\)/);
  assert.match(prompt, /label/);
  assert.match(prompt, /description/);
  assert.match(prompt, /triggers/);
  assert.match(prompt, /skill\(action=["']detail["'], name=["']<skill_name>["']\)/);
  assert.match(prompt, /skill\(action=["']run["'], name=["']<workflow_name>["'], params=/);
  assert.match(prompt, /workflow_json/);
  assert.match(prompt, /explicitly confirms|明确确认/);
  assert.match(prompt, /录制步骤.*(?:起始 URL|URL).*参数.*(?:自动|补全|修正)|(?:自动|补全|修正).*录制步骤.*(?:起始 URL|URL).*参数/i);
  assert.match(prompt, /name.*英文 snake_case|英文 snake_case.*name/i);
  assert.match(prompt, /triggers.*自然语言|自然语言.*triggers/i);
  assert.match(prompt, /无法(?:可靠)?推断.*(?:ask_user|询问)|(?:ask_user|询问).*无法(?:可靠)?推断/i);
  assert.match(prompt, /修改.*完整.*workflow JSON.*(?:重新|再次)展示|(?:重新|再次)展示.*完整 workflow JSON/i);
  assert.match(prompt, /未经确认.*(?:禁止|不得).*save_workflow|(?:禁止|不得).*save_workflow.*未经确认/i);
});
