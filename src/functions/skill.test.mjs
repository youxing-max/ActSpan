import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import test from 'node:test';

const bundle = await build({
  stdin: { contents: `
    export { buildSkillContext, skillFunction } from './src/functions/skill.ts';
    export { registryService } from './src/functions/skill-registry.ts';
    export { isWorkflowPlanActionAllowed, isWorkflowPlanSubActionAllowed, registerBuiltinFunctionResolver } from './src/functions/remote-workflow.ts';
    export { pageFunction } from './src/functions/page.ts';
    export { tabNavigateFunction } from './src/functions/tab-navigate.ts';
    export { screenshotFunction } from './src/functions/screenshot.ts';
    export { extractDataFunction } from './src/functions/extract-data.ts';
    export { cdpDomFunction } from './src/functions/cdp-dom.ts';
    export { cdpFrameFunction } from './src/functions/cdp-frame.ts';
    export { cdpInputFunction } from './src/functions/cdp-input.ts';
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
});

globalThis.chrome = {
  storage: {
    local: {
      get(key, callback) {
        if (callback) callback({});
        return Promise.resolve({});
      },
      set(items, callback) {
        if (callback) callback();
        return Promise.resolve(items);
      },
    },
    onChanged: { addListener() {} },
  },
  runtime: { getURL: () => '' },
  alarms: { onAlarm: { addListener() {} }, create() {} },
};

const {
  buildSkillContext, skillFunction, registryService,
  isWorkflowPlanActionAllowed, isWorkflowPlanSubActionAllowed, registerBuiltinFunctionResolver,
  pageFunction, tabNavigateFunction, screenshotFunction, extractDataFunction,
  cdpDomFunction, cdpFrameFunction, cdpInputFunction,
} = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`
);

// plan 白名单按解析后的内置工具名收窄；这里照 registry 的方式只接线 plan 相关工具。
const planBuiltins = [pageFunction, tabNavigateFunction, screenshotFunction, extractDataFunction,
  cdpDomFunction, cdpFrameFunction, cdpInputFunction];
registerBuiltinFunctionResolver(
  (name) => planBuiltins.find((tool) => tool.name === name),
  () => planBuiltins.map((tool) => tool.name),
);

await buildSkillContext('https://unmatched.example/');
await registryService.upsertSkill({
  name: 'shopping-skill',
  label: '购物助手',
  description: '在商城中搜索商品',
  scope: 'domain',
  url_patterns: ['*://shop.example/*'],
  guide: '',
  workflows: [
    {
      name: 'search-products',
      label: '搜索商品',
      description: '按关键词搜索商品',
      triggers: ['找商品', '搜索商品'],
      parameters: { type: 'object', properties: { query: { type: 'string', description: '关键词', default: '茶' } } },
      plan: { steps: [{ action: 'page', params: { action: 'read' } }] },
    },
    {
      name: 'legacy-checkout',
      label: '旧版结算',
      description: '检查旧版结算页',
      parameters: { type: 'object', properties: {} },
      plan: { steps: [{ action: 'page', params: { action: 'read' } }] },
    },
  ],
  enabled: true,
  source: 'user',
  version: 1,
  createdAt: 1,
  updatedAt: 1,
});

test('list returns lightweight workflow metadata without plans and supports calls without name', async () => {
  const result = await skillFunction.execute({ action: 'list' });
  assert.equal(result.success, true, result.error);
  const workflows = result.data.skills.find((skill) => skill.name === 'shopping-skill').workflows;
  assert.deepEqual(workflows[0], {
    name: 'search-products',
    label: '搜索商品',
    description: '按关键词搜索商品',
    triggers: ['找商品', '搜索商品'],
    parameters: { type: 'object', properties: { query: { type: 'string', description: '关键词', default: '茶' } } },
  });
  assert.equal(Object.hasOwn(workflows[0], 'plan'), false);
  assert.equal(Object.hasOwn(workflows[1], 'triggers'), false);
  assert.equal(Object.hasOwn(workflows[1], 'plan'), false);
});

test('detail repeats workflow metadata and run resolves the internal workflow name', async () => {
  const detail = await skillFunction.execute({ action: 'detail', name: 'shopping-skill' });
  assert.equal(detail.success, true, detail.error);
  const workflow = detail.data.workflows.find((item) => item.name === 'search-products');
  assert.deepEqual(workflow.triggers, ['找商品', '搜索商品']);
  assert.deepEqual(workflow.parameters, { type: 'object', properties: { query: { type: 'string', description: '关键词', default: '茶' } } });
  assert.match(detail.data.hint, /Skill name/);
  assert.match(detail.data.hint, /workflow name/);

  const run = await skillFunction.execute({
    action: 'run',
    name: 'search-products',
    params: { query: '咖啡' },
  });
  assert.equal(/Workflow not found/.test(run.error || ''), false);
});

test('unmatched URLs still receive a dynamic schema whose list action does not require name', async () => {
  const context = await buildSkillContext('https://elsewhere.example/');
  assert.ok(context.schema);
  assert.deepEqual(context.schema.parameters.required, undefined);
  assert.deepEqual(context.schema.parameters.properties.action.enum, ['run', 'detail', 'list']);
});

// 内置技能 plan 必须整体落在 plan 白名单内：任何一步越界都会在 workflow_run 时被 E_POLICY_DENIED 拒绝，
// 保存时也不会警告，所以只能在离线阶段把 (action, subAction) 全部过一遍。
test('builtin domain skill plans stay inside the workflow-plan allowlist', async () => {
  const manifest = JSON.parse(await readFile('public/skills/domains/manifest.json', 'utf8'));
  for (const name of ['taobao', 'tophub', 'boss-zhipin']) {
    const skill = manifest.skills.find((item) => item.name === name);
    assert.ok(skill, `builtin domain manifest is missing ${name}`);
    for (const workflow of skill.workflows) {
      for (const [index, step] of workflow.plan.steps.entries()) {
        const action = String(step.action || '').trim();
        const rawSubAction = step.params && typeof step.params === 'object' ? step.params.action : undefined;
        const subAction = typeof rawSubAction === 'string' ? rawSubAction.trim().toLowerCase() : '';
        const label = `${name}/${workflow.name} step ${index + 1}`;
        assert.equal(isWorkflowPlanActionAllowed(action), true, `${label} action ${action} is not allowlisted`);
        assert.equal(isWorkflowPlanSubActionAllowed(action, subAction), true,
          `${label} sub-action ${action}.${subAction} is not allowlisted`);
      }
    }
  }
});

// cdp_frame 主 frame 的 evaluate 结果是 { result, type, message }；模板与 resultPath 必须穿过这层信封，
// 否则 when / fill 会静默拿到 undefined（Boss 自动回复永远不触发）。
test('builtin domain skill plan templates read saved steps through the result envelope', async () => {
  const manifest = JSON.parse(await readFile('public/skills/domains/manifest.json', 'utf8'));
  for (const name of ['taobao', 'tophub', 'boss-zhipin']) {
    const skill = manifest.skills.find((item) => item.name === name);
    assert.ok(skill, `builtin domain manifest is missing ${name}`);
    for (const workflow of skill.workflows) {
      const savedActions = new Map();
      for (const [index, step] of workflow.plan.steps.entries()) {
        const label = `${name}/${workflow.name} step ${index + 1}`;
        for (const match of JSON.stringify(step).matchAll(/{{\s*steps\.([^.}\s]+)\.?([^}\s]*)}}/g)) {
          const [, saveAs, tail] = match;
          assert.ok(savedActions.has(saveAs), `${label} references steps.${saveAs} before it is saved`);
          if (savedActions.get(saveAs) === 'cdp_frame') {
            assert.equal(tail.split('.')[0], 'result',
              `${label} must read steps.${saveAs}.result.* because cdp_frame nests its value under data.result`);
          }
        }
        if (step.saveAs) savedActions.set(step.saveAs, step.action);
      }
      const resultPath = String(workflow.plan.resultPath || '').replace(/^steps\./, '');
      if (!resultPath) continue;
      const [saveAs, ...segments] = resultPath.split('.');
      assert.ok(savedActions.has(saveAs), `${name}/${workflow.name} resultPath ${workflow.plan.resultPath} has no matching saved step`);
      if (savedActions.get(saveAs) === 'cdp_frame') {
        assert.equal(segments[0], 'result',
          `${name}/${workflow.name} resultPath must include .result because cdp_frame nests its value under data.result`);
      }
    }
  }
});

