import assert from 'node:assert/strict';
import { build } from 'esbuild';
import test from 'node:test';

const bundle = await build({
  stdin: { contents: `export { buildSystemPrompt } from './src/ai/system-prompt.ts';`,
    resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { buildSystemPrompt } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`,
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
});
