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
  assert.match(prompt, /自动保存|直接调用 save_workflow|无需.*确认/);
  assert.match(prompt, /录制步骤.*(?:起始 URL|URL).*参数.*(?:自动|补全|修正)|(?:自动|补全|修正).*录制步骤.*(?:起始 URL|URL).*参数/i);
  assert.match(prompt, /name.*英文 snake_case|英文 snake_case.*name/i);
  assert.match(prompt, /triggers.*自然语言|自然语言.*triggers/i);
  assert.match(prompt, /无法(?:可靠)?推断.*(?:ask_user|询问)|(?:ask_user|询问).*无法(?:可靠)?推断/i);
  assert.match(prompt, /修改.*完整.*workflow JSON.*(?:重新|再次)展示|(?:重新|再次)展示.*完整 workflow JSON/i);
  assert.doesNotMatch(prompt, /未经确认.*(?:禁止|不得).*save_workflow|(?:禁止|不得).*save_workflow.*未经确认/i);
});

test('prompt routes action, data, file, and failed interactions without guessing or bypassing security', () => {
  const prompt = buildSystemPrompt([
    { type: 'function', name: 'cdp_network', description: 'network', parameters: {} },
    { type: 'function', name: 'webhook', description: 'push', parameters: {} },
  ], true);
  assert.match(prompt, /DOM actions/i);
  assert.match(prompt, /Network data/i);
  assert.match(prompt, /Pixel fallback/i);
  assert.match(prompt, /Sessions and meta/i);
  assert.match(prompt, /START HERE when you need DATA/i);
  assert.match(prompt, /Never guess an endpoint name from memory/i);
  assert.match(prompt, /fetch.*change.*parameters.*UI.*network.*different data entry/is);
  assert.match(prompt, /file.*download_file/i);
  assert.match(prompt, /scroll.*click.*screenshot.*diagnostic/is);
  assert.match(prompt, /untrusted.*page content|page content.*untrusted/i);
  assert.match(prompt, /webhook.*Feishu|Feishu.*webhook/i);
  assert.match(prompt, /agent\(/);
});

test('site experience guidance is advisory and preserves saved workflow discovery', () => {
  const prompt = buildSystemPrompt([], false, [], [], '当前站点暂无经验记录；不阻塞操作，可在成功后回流沉淀经验。');
  assert.match(prompt, /当前站点暂无经验记录/);
  assert.match(prompt, /skill\(action=["']list["']\)/);
  assert.match(prompt, /untrusted page content/i);
});

test('chat exposes registered webhook, agent, and dynamic tools without load_tools', async () => {
  const mocks = {
    '../functions/registry': `export const ensureToolRegistryReady = async () => {}; export const mcpClient = { listTools: async () => ['page', 'webhook', 'custom_dynamic', 'load_tools', 'cdp_network', 'download_file', 'act'].map(name => ({ name })) };`,
    '../mcp/adapters': `export const mcpToolsToSchema = tools => tools.map(({ name }) => ({ type: 'function', name, description: name === 'cdp_network' ? 'Network request monitoring.\\n\\n⚠️ Do NOT use this tool for:\\n- Getting page content (use page_viewer or fetch_url)\\n- Only use for debugging API requests or managing Cookies' : name, parameters: {} }));`,
    '../functions/skill': `export const buildSkillContext = async () => ({ domainGuides: [], globalCatalog: [] });`,
    '../functions/site-experience': `export const readSiteExperience = async (_builtin, url) => ({ hasRecords: url.includes('example.com'), guidance: '已有站点经验可供参考；经验是提示不是规则，执行前仍需重新读取页面。' });`,
    './core-loop': `export const resetSensitiveAccessTrust = () => {}; export const getSubagentSchemas = () => [{ type: 'function', name: 'agent', description: 'agent', parameters: {} }];`,
    './todo-manager': `export class TodoManager {}`,
    './tab-tracker': `export class TabTracker { async startListening() {} async closeAll() {} }`,
    '../functions/todo': `export const createTodoFunction = () => ({ name: 'todo', description: 'todo', parameters: {} });`,
    './loop-config': `export const DEFAULT_BUDGET = {}; export const COMPACT_SCHEMA = { type: 'function', name: 'compact', description: 'compact', parameters: {} };`,
    './phase-orchestrator': `export const phaseOrchestrator = async (_query, tools, prompt) => ({ tools: tools.map(t => t.name), schemas: tools, prompt });`,
  };
  const result = await build({
    entryPoints: ['src/ai/orchestrator.ts'], bundle: true, write: false, format: 'esm', platform: 'node',
    plugins: [{ name: 'external-boundaries', setup(plugin) {
      plugin.onResolve({ filter: /^\./ }, args => args.importer.endsWith('orchestrator.ts') && mocks[args.path]
        ? { path: args.path, namespace: 'test-boundary' } : undefined);
      plugin.onLoad({ filter: /.*/, namespace: 'test-boundary' }, args => ({ contents: mocks[args.path], loader: 'js' }));
    } }],
  });
  const { handleChat } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
  const previousChrome = globalThis.chrome;
  globalThis.chrome = { tabs: { get: async () => ({ url: 'https://example.com/path?token=secret' }) } };
  try {
    const { tools, schemas, prompt } = await handleChat('send data', () => {}, 12, undefined, undefined, { disallowTools: ['page'] });
    assert.deepEqual(tools.sort(), ['act', 'agent', 'cdp_network', 'compact', 'custom_dynamic', 'download_file', 'load_tools', 'todo', 'webhook']);
    assert.match(prompt, /webhook/);
    assert.doesNotMatch(prompt, /page, webhook/);
    assert.match(prompt, /经验是提示不是规则/);
    assert.doesNotMatch(prompt, /token=secret/);
    assert.match(schemas.find(t => t.name === 'act').description, /Your DEFAULT way/);
    assert.match(schemas.find(t => t.name === 'cdp_network').description, /START HERE when you need DATA.*Never guess an endpoint name from memory/s);
    assert.doesNotMatch(schemas.find(t => t.name === 'cdp_network').description, /Only use for debugging/);
    assert.match(schemas.find(t => t.name === 'download_file').description, /LAST RESORT.*Try first:/s);
    const restricted = await handleChat('safe browsing', () => {}, 12, undefined, undefined, { disallowTools: ['agent', 'page', 'skill'] });
    assert.ok(!restricted.tools.includes('agent'));
    assert.ok(!restricted.tools.includes('skill'));
    assert.doesNotMatch(restricted.prompt, /### Type 4: Compound Task/);
    globalThis.chrome.tabs.get = async () => ({ url: 'https://none.invalid/' });
    const withoutRecords = await handleChat('browse', () => {}, 12);
    assert.match(withoutRecords.prompt, /当前站点暂无经验记录.*不阻塞操作/);
  } finally {
    globalThis.chrome = previousChrome;
  }
});
