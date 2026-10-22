import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `export { siteExperienceKey, mergeSiteExperience, chooseRecipe, mergeSiteExperienceLayers, getSiteExperienceLayers, stripSiteExperienceProvenance, saveSiteExperience, addSiteExperienceDraft, rememberSiteRepairExperience, markRecentSiteRepair } from './src/functions/site-experience.ts'; export { BUILTIN_SITE_EXPERIENCE, BUILTIN_EXPERIENCE_SOURCE, builtinSiteExperience } from './src/functions/builtin-experience.ts';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { siteExperienceKey, mergeSiteExperience, chooseRecipe, mergeSiteExperienceLayers, getSiteExperienceLayers, stripSiteExperienceProvenance, saveSiteExperience, addSiteExperienceDraft, rememberSiteRepairExperience, markRecentSiteRepair, BUILTIN_SITE_EXPERIENCE, BUILTIN_EXPERIENCE_SOURCE, builtinSiteExperience } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

test('按 host 归一化并丢弃 query、fragment 与端口', () => {
  assert.equal(siteExperienceKey('HTTPS://Example.COM:443/path?token=secret#frag'), 'example.com');
  assert.equal(siteExperienceKey('example.com/path?password=secret'), 'example.com');
  assert.equal(siteExperienceKey('not a host'), '');
});

// 保留字会命中 Object.prototype 上的继承属性：'constructor' 会让 domains[host] 解析到
// Object 构造函数，随后的写入就落到 Object.selectors 上，污染整个扩展 realm。
test('保留 host 名一律拒绝，且不污染 Object', async () => {
  for (const host of ['constructor', '__proto__', 'prototype', 'CONSTRUCTOR']) {
    assert.equal(siteExperienceKey(host), '', `${host} must not be a host key`);
  }
  const state = installStorage();
  await saveSiteExperience({ version: 1, domains: { constructor: { selectors: { '#x': { actions: {} } }, failureReasons: {} } } });
  assert.equal(Object.prototype.selectors, undefined);
  assert.equal(Object.prototype.failureReasons, undefined);
  const stored = state.actspan_site_experience_layers_v1;
  assert.equal(JSON.stringify(stored || {}).includes('constructor'), false);
});

// 选择器可能内嵌属性值（input[name="csrf_token"]），落盘前必须过 selectorOf。
test('修复库落盘的选择器一律脱敏', async () => {
  const state = installStorage();
  await rememberSiteRepairExperience('example.com', 'login form', [
    { tag: 'input', selector_candidates: ['input[name="csrf_token"]'] },
    { tag: 'input', selector_candidates: ['#username'] },
  ]);
  const stored = JSON.stringify(state.actspan_site_experience_v1 || {});
  assert.equal(stored.includes('csrf_token'), false);
  assert.equal(stored.includes('#username'), true);

  await markRecentSiteRepair('example.com', 'login form', [
    { tag: 'input', selector_candidates: ['input[name="password"]', '#submit'] },
  ]);
  const recent = JSON.stringify(state.actspan_site_experience_recent_repair_v1 || {});
  assert.equal(recent.includes('password'), false);
  assert.equal(recent.includes('#submit'), true);
});

test('按 host 桶累积 selector 成功率和失败原因', () => {
  let experience = {};
  experience = mergeSiteExperience(experience, { url: 'https://example.com/a?secret=1', action: 'click', selector: '#submit', success: true });
  experience = mergeSiteExperience(experience, { host: 'EXAMPLE.com', action: 'click', selector: '#submit', success: false, failureReason: 'timeout' });
  const selector = experience.domains['example.com'].selectors['#submit'];
  assert.equal(selector.actions.click.attempts, 2);
  assert.equal(selector.actions.click.successes, 1);
  assert.equal(selector.actions.click.successRate, 0.5);
  assert.equal(experience.domains['example.com'].failureReasons.timeout, 1);
});

test('低置信度或 click/type 冲突时只返回安全 fallback', () => {
  let experience = {};
  experience = mergeSiteExperience(experience, { host: 'example.com', action: 'click', selector: '#go', success: true });
  assert.equal(chooseRecipe(experience, 'click', { host: 'example.com' }).action, 'screenshot');

  experience = mergeSiteExperience(experience, { host: 'example.com', action: 'type', selector: '#go', success: true });
  experience = mergeSiteExperience(experience, { host: 'example.com', action: 'type', selector: '#go', success: true });
  experience = mergeSiteExperience(experience, { host: 'example.com', action: 'click', selector: '#go', success: true });
  assert.equal(chooseRecipe(experience, 'click', { host: 'example.com' }).action, 'screenshot');
});

test('缺少登录、弹窗或 challenge 前置条件时不执行动作', () => {
  let experience = {};
  experience = mergeSiteExperience(experience, { host: 'example.com', action: 'click', selector: '#go', success: true, requiredPreconditions: ['login', 'popup', 'challenge'] });
  experience = mergeSiteExperience(experience, { host: 'example.com', action: 'click', selector: '#go', success: true, requiredPreconditions: ['login', 'popup', 'challenge'] });
  const recipe = chooseRecipe(experience, 'click', { host: 'example.com', preconditions: ['login'] });
  assert.equal(recipe.action, 'needs_precondition');
  assert.deepEqual(recipe.requiredPreconditions, ['challenge', 'popup']);
  assert.equal(recipe.fallback, 'screenshot');
});

test('recipe 包含稳定字段且不持久化凭据、表单值或完整 URL query', () => {
  const experience = mergeSiteExperience({}, {
    url: 'https://example.com/login?password=top-secret&token=abc',
    action: 'type',
    selector: '#email',
    value: 'alice@example.com',
    password: 'top-secret',
    success: true,
  });
  const serialized = JSON.stringify(experience);
  assert.equal(serialized.includes('top-secret'), false);
  assert.equal(serialized.includes('alice@example.com'), false);
  assert.equal(serialized.includes('?password='), false);
  const recipe = chooseRecipe(experience, 'type', { host: 'example.com' });
  for (const key of ['action', 'reason', 'confidence', 'requiredPreconditions', 'fallback']) assert.ok(key in recipe);
  assert.equal(recipe.action, 'screenshot');
});

test('builtin 与 local 合并，local 同 selector 覆盖且保留父域回退', () => {
  const builtin = mergeSiteExperience({}, { host: 'example.com', action: 'click', selector: '#builtin', success: true });
  const local = mergeSiteExperience({}, { host: 'shop.example.com', action: 'click', selector: '#local', success: true });
  const layers = getSiteExperienceLayers(builtin, local, 'https://shop.example.com/path?token=x');
  assert.equal(layers.host, 'shop.example.com');
  assert.equal(layers.merged.domains['shop.example.com'].selectors['#local'].actions.click.successes, 1);
  assert.equal(layers.hasRecords, true);
  assert.match(layers.guidance, /提示不是规则/);
  const merged = mergeSiteExperienceLayers(builtin, local);
  assert.ok(merged.domains['example.com']);
});

test('回贴反污染只保留有限站点字段', () => {
  const clean = stripSiteExperienceProvenance({
    domains: {
      'example.com': {
        selectors: { '#go': { actions: { click: { attempts: 2, successes: 2, successRate: 1 } }, requiredPreconditions: [] } },
        failureReasons: {},
        provenance: 'builtin',
        guide: 'secret guide',
      },
    },
    credential: 'password=secret',
  });
  const serialized = JSON.stringify(clean);
  assert.equal(serialized.includes('secret'), false);
  assert.equal(serialized.includes('provenance'), false);
});

test('保存本机层按域合并，不会清空其他站点', async () => {
  const state = {};
  globalThis.chrome = { storage: { local: {
    get(keys, callback) { callback(typeof keys === 'string' ? { [keys]: state[keys] } : state); },
    set(items, callback) { Object.assign(state, items); callback(); },
  } } };
  await saveSiteExperience(mergeSiteExperience({}, { host: 'bank.example', action: 'click', selector: '#transfer', success: true }));
  await saveSiteExperience(mergeSiteExperience({}, { host: 'shop.example', action: 'click', selector: '#buy', success: true }));
  const stored = state.actspan_site_experience_layers_v1;
  assert.ok(stored.domains['bank.example']);
  assert.ok(stored.domains['shop.example']);

  await saveSiteExperience({ version: 1, domains: {} });
  assert.ok(state.actspan_site_experience_layers_v1.domains['bank.example'], '空提交不能清空已有经验');
});

test('保存本机层保留最近十份并返回免责提示', async () => {
  const state = {};
  globalThis.chrome = { storage: { local: {
    get(keys, callback) { callback(typeof keys === 'string' ? { [keys]: state[keys] } : state); },
    set(items, callback) { Object.assign(state, items); callback(); },
  } } };
  let latest;
  for (let index = 0; index < 11; index += 1) latest = await saveSiteExperience(mergeSiteExperience({}, { host: `site-${index}.test`, action: 'click', selector: '#go', success: true }));
  assert.equal(latest.revisions.length, 10);
  assert.ok(latest.revisions[0].domains['site-9.test']);
  assert.match(latest.warning, /提示不是规则/);
});

// ── F1：出厂内置层 + 本机层 ─────────────────────────────────────────────

const FACTORY_DRAFT = { id: `act-${'a'.repeat(24)}`, steps: [{ action: 'read', find: { role: 'button', name: '出厂按钮' } }] };
const LOCAL_DRAFT = { id: `act-${'b'.repeat(24)}`, steps: [{ action: 'click', find: { role: 'button', name: '本机按钮' } }] };

const FACTORY = {
  version: 1,
  domains: {
    'example.com': {
      selectors: { '#go': { actions: { click: { attempts: 10, successes: 9, successRate: 0.9 } }, requiredPreconditions: ['login'] } },
      failureReasons: { timeout: 3 },
      drafts: [FACTORY_DRAFT],
    },
  },
};

const installStorage = (state = {}) => {
  globalThis.chrome = { storage: { local: {
    get(keys, callback) { callback(typeof keys === 'string' ? { [keys]: state[keys] } : state); },
    set(items, callback) { Object.assign(state, items); callback(); },
  } } };
  return state;
};

test('F1 出厂段可被整段识别，且与本机层分开返回', () => {
  const local = mergeSiteExperience({}, { host: 'example.com', action: 'type', selector: '#mine', success: true });
  const layers = getSiteExperienceLayers(FACTORY, local, 'https://example.com/page');
  assert.deepEqual(layers.factoryHosts, ['example.com']);
  assert.ok(layers.builtin.domains['example.com'].selectors['#go']);
  assert.equal(layers.builtin.domains['example.com'].selectors['#mine'], undefined);
  assert.ok(layers.local.domains['example.com'].selectors['#mine']);
  assert.equal(layers.local.domains['example.com'].selectors['#go'], undefined);
  // 合并视图两层都在
  assert.ok(layers.merged.domains['example.com'].selectors['#go']);
  assert.ok(layers.merged.domains['example.com'].selectors['#mine']);
});

test('F1 出厂层换版不覆盖本机层', () => {
  const local = mergeSiteExperience({}, { host: 'example.com', action: 'type', selector: '#mine', success: true });
  const upgraded = {
    version: 1,
    domains: { 'example.com': { selectors: { '#new': { actions: { click: { attempts: 2, successes: 2, successRate: 1 } }, requiredPreconditions: [] } }, failureReasons: {} } },
  };
  const before = getSiteExperienceLayers(FACTORY, local, 'example.com');
  const after = getSiteExperienceLayers(upgraded, local, 'example.com');
  assert.deepEqual(after.local, before.local);
  assert.ok(after.local.domains['example.com'].selectors['#mine']);
  assert.equal(after.factoryHosts.length, 1);
  assert.ok(after.merged.domains['example.com'].selectors['#new']);
  assert.ok(after.merged.domains['example.com'].selectors['#mine']);
});

test('F1 出厂层是只读的，保存不会把出厂条目写进本机层', async () => {
  const state = installStorage();
  const merged = getSiteExperienceLayers(FACTORY, null, 'example.com').merged;
  const result = await saveSiteExperience(merged, FACTORY);
  assert.deepEqual(result.experience.domains, {});
  assert.deepEqual(state.actspan_site_experience_layers_v1.domains, {});
});

test('F1 出厂层出厂条目为空时机制仍然成立', () => {
  assert.deepEqual(BUILTIN_SITE_EXPERIENCE.domains, {});
  assert.equal(BUILTIN_EXPERIENCE_SOURCE.license, 'MIT');
  assert.match(BUILTIN_EXPERIENCE_SOURCE.requirement, /复测/);
  assert.deepEqual(builtinSiteExperience().domains, {});
});

// ── F6：回贴反污染 ──────────────────────────────────────────────────────

test('F6 把 get 的全文原样存回去时保留本机层', async () => {
  installStorage();
  // 先落一份本机经验
  await saveSiteExperience(mergeSiteExperience({}, { host: 'example.com', action: 'type', selector: '#mine', success: true }));
  const pasted = getSiteExperienceLayers(FACTORY, mergeSiteExperience({}, { host: 'example.com', action: 'type', selector: '#mine', success: true }), 'example.com');
  const result = await saveSiteExperience(pasted, FACTORY);
  assert.ok(result.experience.domains['example.com'], '回贴不能把本机层清空');
  assert.ok(result.experience.domains['example.com'].selectors['#mine']);
  // 出厂条目一个都不许进本机层
  assert.equal(result.experience.domains['example.com'].selectors['#go'], undefined);
  assert.equal(result.experience.domains['example.com'].failureReasons.timeout, undefined);
  assert.equal(result.experience.domains['example.com'].drafts, undefined);
});

test('F6 回贴的全文自带出厂段，不靠调用方另传', async () => {
  installStorage();
  const pasted = getSiteExperienceLayers(FACTORY, mergeSiteExperience({}, { host: 'example.com', action: 'type', selector: '#mine', success: true }), 'example.com');
  const result = await saveSiteExperience(pasted);
  assert.ok(result.experience.domains['example.com'].selectors['#mine']);
  assert.equal(result.experience.domains['example.com'].selectors['#go'], undefined);
});

test('F6 重复回贴不会让出厂失败计数越存越多', async () => {
  installStorage();
  const local = mergeSiteExperience({}, { host: 'example.com', action: 'click', selector: '#mine', success: false, failureReason: 'timeout' });
  let stored = local;
  for (let round = 0; round < 3; round += 1) {
    const pasted = getSiteExperienceLayers(FACTORY, stored, 'example.com');
    stored = (await saveSiteExperience(pasted, FACTORY)).experience;
  }
  // 本机自己记了 1 次 timeout，出厂段记了 3 次：只留本机那 1 次。
  assert.equal(stored.domains['example.com'].failureReasons.timeout, 1);
});

test('F6 回贴的 JSON 文本同样被识别', async () => {
  installStorage();
  const pasted = getSiteExperienceLayers(FACTORY, mergeSiteExperience({}, { host: 'example.com', action: 'type', selector: '#mine', success: true }), 'example.com');
  const result = await saveSiteExperience(JSON.stringify(pasted), FACTORY);
  assert.ok(result.experience.domains['example.com'].selectors['#mine']);
  assert.equal(result.experience.domains['example.com'].selectors['#go'], undefined);
});

test('F6 认不出来的回贴直接拒绝，不清空本机层', async () => {
  const state = installStorage();
  await saveSiteExperience(mergeSiteExperience({}, { host: 'example.com', action: 'type', selector: '#mine', success: true }));
  const before = JSON.stringify(state.actspan_site_experience_layers_v1);
  for (const bad of [null, undefined, 'not json', 42, [], '']) {
    await assert.rejects(() => saveSiteExperience(bad), /requires a memory object/);
  }
  assert.equal(JSON.stringify(state.actspan_site_experience_layers_v1), before);
});

test('F6 本机草稿保留，出厂草稿不进本机层', async () => {
  installStorage();
  await addSiteExperienceDraft('example.com', LOCAL_DRAFT);
  const pasted = getSiteExperienceLayers(FACTORY, { version: 1, domains: { 'example.com': { selectors: {}, failureReasons: {}, drafts: [LOCAL_DRAFT, FACTORY_DRAFT] } } }, 'example.com');
  const result = await saveSiteExperience(pasted, FACTORY);
  assert.deepEqual(result.experience.domains['example.com'].drafts, [LOCAL_DRAFT]);
});

test('并发保存不同域不会互相覆盖', async () => {
  const state = {};
  globalThis.chrome = { storage: { local: {
    get(keys, callback) {
      const key = typeof keys === 'string' ? keys : '';
      setTimeout(() => callback(key ? { [key]: state[key] } : state), 0);
    },
    set(items, callback) {
      setTimeout(() => { Object.assign(state, items); callback(); }, 0);
    },
  } } };
  const a = mergeSiteExperience({}, { host: 'a.example', action: 'click', selector: '#a', success: true });
  const b = mergeSiteExperience({}, { host: 'b.example', action: 'click', selector: '#b', success: true });
  await Promise.all([saveSiteExperience(a), saveSiteExperience(b)]);
  const stored = state.actspan_site_experience_layers_v1;
  assert.ok(stored.domains['a.example'], '并发写入后 a.example 仍在');
  assert.ok(stored.domains['b.example'], '并发写入后 b.example 仍在');
});
