import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import registerActTool from '../../mcp-server/act-tool.js';

const bundle = await build({
  stdin: {
    contents: `export { recordSuccessfulActDraft, listActDrafts, adoptActDraft } from './src/background/act-drafts.ts';
export { readSiteExperience } from './src/functions/site-experience.ts';`,
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { recordSuccessfulActDraft, listActDrafts, adoptActDraft, readSiteExperience } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const state = {};
globalThis.chrome = { storage: { local: {
  async get(keys, callback) {
    const result = typeof keys === 'string' ? { [keys]: state[keys] } : Object.fromEntries(keys.map(key => [key, state[key]]));
    callback?.(result);
    return result;
  },
  async set(items, callback) { Object.assign(state, structuredClone(items)); callback?.(); },
} }, tabs: { async get(id) { return { id, url: id === 88 ? 'https://other.example.com/' : 'https://shop.example.com/path?secret=tab-url-secret' }; } } };

const steps = (value = 'super-secret-email@example.com') => [
  { action: 'click', ref: 'unstable-ref-1', snapshotId: 'snapshot-secret', find: { role: 'button', name: 'Sign in' } },
  { action: 'type', ref: 'unstable-ref-2', find: { role: 'textbox', name: 'Email address' }, text: value },
  { action: 'click', find: { role: 'button', name: 'Continue' } },
];
const input = (script = steps(), overrides = {}) => ({
  tabId: 77, steps: script, audit: { success: true, stepCount: 3, effectiveCount: 3, hasMutation: true }, ...overrides,
});

// Removing placeholder replacement or allowing arbitrary step properties makes this privacy test fail.
test('completed act persists find descriptors and named placeholders without typed text, refs or URLs', async () => {
  const result = await recordSuccessfulActDraft(input());
  assert.equal(result.success, true);
  assert.ok(result.draftId);
  const [draft] = await listActDrafts('shop.example.com');
  assert.equal(draft.id, result.draftId);
  assert.deepEqual(draft.steps[0], { action: 'click', find: { role: 'button', name: 'Sign in' } });
  assert.deepEqual(draft.steps[1], { action: 'type', find: { role: 'textbox', name: 'Email address' }, text: '${email_address}' });
  assert.equal(draft.successCount, 1);
  assert.doesNotMatch(JSON.stringify(state), /super-secret-email@example.com|unstable-ref|snapshot-secret|tab-url-secret/);
});

// Using typed values or volatile refs in the structural key makes this dedupe test fail.
test('repeat success with different typed text increments existing structural draft only', async () => {
  const first = await recordSuccessfulActDraft(input(steps('first-typed-secret')));
  const second = await recordSuccessfulActDraft(input(steps('second-typed-secret')));
  assert.equal(first.draftId, second.draftId);
  assert.equal(second.created, false);
  assert.equal(second.successCount, first.successCount + 1);
  assert.equal((await listActDrafts('shop.example.com')).length, 1);
  assert.doesNotMatch(JSON.stringify(state), /first-typed-secret|second-typed-secret/);
});

// Removing any of the eligibility guards makes an excluded act persist.
test('failed, short, read-only, and anonymous-target acts do not persist', async () => {
  const before = (await listActDrafts('shop.example.com')).length;
  const cases = [
    input(steps(), { audit: { success: false, stepCount: 3, effectiveCount: 3, hasMutation: true } }),
    input(steps().slice(0, 2), { audit: { success: true, stepCount: 2, effectiveCount: 2, hasMutation: true } }),
    input([{ action: 'read' }, { action: 'wait', ms: 20 }, { action: 'read' }], { audit: { success: true, stepCount: 3, effectiveCount: 3, hasMutation: false } }),
    input([{ action: 'click', ref: 'anonymous' }, ...steps().slice(1)]),
    input(steps().slice(0, 2), { audit: { success: true, stepCount: 3, effectiveCount: 3, hasMutation: true, trace: [
      { action: 'click', ok: true }, { action: 'type', ok: true }, { action: 'click', ok: true },
    ] } }),
    input(steps(), { audit: { success: true, stepCount: 3, effectiveCount: 3, hasMutation: true, trace: [
      { action: 'read', ok: true }, { action: 'click', ok: true }, { action: 'type', ok: true },
    ] } }),
    input([{ action: 'click', find: { role: 'button', name: '' } }, ...steps().slice(1)]),
    input([...steps().slice(0, 2), { action: 'read' }]),
    input([...steps().slice(0, 2), { action: 'wait', find: { role: 'textbox', name: 'Email address' }, for: 'selector' }]),
    input(steps('Email address')),
  ];
  for (const payload of cases) assert.equal((await recordSuccessfulActDraft(payload)).draftId, null);
  assert.equal((await listActDrafts('shop.example.com')).length, before);
});

// If adoption remains only in draft storage or builtins are overwritten, this test fails.
test('adoption puts draft first in local site experience and preserves builtins', async () => {
  const first = await recordSuccessfulActDraft(input(steps('private-to-remove')));
  const secondSteps = steps('other-private');
  secondSteps[0].find.name = 'Open account';
  const second = await recordSuccessfulActDraft(input(secondSteps));
  await adoptActDraft({ draftId: first.draftId, tabId: 77 });
  await adoptActDraft({ draftId: second.draftId, tabId: 77 });
  const builtin = { version: 1, domains: { 'shop.example.com': {
    selectors: { '#builtin': { actions: { click: { attempts: 1, successes: 1, successRate: 1 } }, requiredPreconditions: [] } },
    failureReasons: {},

  } } };
  const layers = await readSiteExperience(builtin, 'https://shop.example.com/private?q=secret');
  assert.deepEqual(layers.local.domains['shop.example.com'].drafts.map(d => d.id), [second.draftId, first.draftId]);
  assert.deepEqual(layers.merged.domains['shop.example.com'].drafts.map(d => d.id), [second.draftId, first.draftId]);
  assert.equal(layers.merged.domains['shop.example.com'].selectors['#builtin'].actions.click.successes, 1);
  assert.equal(layers.builtin.domains['shop.example.com'].drafts, undefined);

  assert.doesNotMatch(JSON.stringify(state), /private-to-remove|other-private/);
});
test('adoption cannot move a draft across site identities', async () => {
  const draft = await recordSuccessfulActDraft(input());
  const sameStepsElsewhere = await recordSuccessfulActDraft({ ...input(), tabId: 88 });
  assert.notEqual(sameStepsElsewhere.draftId, draft.draftId);
  assert.equal((await listActDrafts('other.example.com')).length, 1);
  await assert.rejects(adoptActDraft({ draftId: draft.draftId, tabId: 88 }), /not found for this site/);
  const other = await readSiteExperience(null, 'https://other.example.com/');
  assert.equal(other.local.domains['other.example.com'], undefined);
});

// Branch alternatives cannot be summed to manufacture three actually executed actions.
test('control-flow drafts require three successful executed atomic steps, not static branch totals', async () => {
  const before = (await listActDrafts('shop.example.com')).length;
  const branch = [{ action: 'if', cond: { find: { role: 'checkbox', name: 'Remember' }, checked: true },
    then: steps().slice(0, 2), else: steps().slice(1) }];
  const audit = { success: true, stepCount: 3, effectiveCount: 4, hasMutation: true,
    trace: [{ path: 'steps[0].then[0]', action: 'click', ok: true },
      { path: 'steps[0].then[1]', action: 'type', ok: true }, { path: 'steps[0]', action: 'if', ok: true }] };
  assert.equal((await recordSuccessfulActDraft(input(branch, { audit }))).draftId, null);
  assert.equal((await listActDrafts('shop.example.com')).length, before);
});
test('successful branch persists only executed atomic steps and rejects recovered failures', async () => {
  const before = (await listActDrafts('shop.example.com')).length;
  const executed = steps('nested-secret-address');
  const trace = executed.map((step, index) => ({ path: `steps[0].then[${index}]`, action: step.action, ok: true }));
  trace.push({ path: 'steps[0]', action: 'if', ok: true });
  const audit = { success: true, stepCount: 3, effectiveCount: 3, hasMutation: true, trace };
  const stored = await recordSuccessfulActDraft(input(executed, { audit }));
  assert.ok(stored.draftId);
  assert.equal((await listActDrafts('shop.example.com')).find(draft => draft.id === stored.draftId).steps.length, 3);
  assert.equal((await listActDrafts('shop.example.com')).length, before);
  assert.doesNotMatch(JSON.stringify(state), /nested-secret-address/);
  const failed = await recordSuccessfulActDraft(input(executed, { audit: { ...audit, trace: [...trace, { path: 'steps[0]', action: 'if', ok: false }] } }));
  assert.equal(failed.draftId, null);
});

test('draft storage survives background module reload', async () => {
  const first = await recordSuccessfulActDraft(input(steps('reload-only-secret')));
  const fresh = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}#reload`);
  const [persisted] = (await fresh.listActDrafts('https://shop.example.com/')).filter(draft => draft.id === first.draftId);
  assert.equal(persisted.successCount, first.successCount);
  assert.equal(persisted.steps[1].text, '${email_address}');
  assert.doesNotMatch(JSON.stringify(state), /reload-only-secret/);
});

test('successful three-step act returns persisted draft identity to caller', async () => {
  let handler;
  registerActTool({
    registerTool: (name, _definition, fn) => { if (name === 'actspan_act') handler = fn; },
    run: fn => fn,
    tabIdParam: {}, taskParams: {},
    callBridge: async (method, params) => {
      if (method === 'act.draft') return recordSuccessfulActDraft(params);
      if (method === 'page.read') return { url: 'https://shop.example.com/', content: 'done' };
      return { changed: true };
    },
  });
  const result = await handler({ tabId: 77, steps: steps('actual-act-typed-secret').map(({ ref, snapshotId, ...step }) => step) });
  assert.equal(result.success, true);
  assert.equal(result.draft.success, true);
  assert.ok(result.draft.draftId);
  assert.equal((await listActDrafts('shop.example.com')).some(draft => draft.id === result.draft.draftId), true);
  assert.doesNotMatch(JSON.stringify(state), /actual-act-typed-secret/);
});

test('successful ref-only act uses observed names instead of persisting volatile refs', async () => {
  let handler;
  registerActTool({
    registerTool: (name, _definition, fn) => { if (name === 'actspan_act') handler = fn; },
    run: fn => fn, tabIdParam: {}, taskParams: {},
    callBridge: async (method, params) => {
      if (method === 'act.draft') return recordSuccessfulActDraft(params);
      if (method === 'page.read') return { content: 'done', url: 'https://shop.example.com/' };
      const names = { 'r-signin': 'Sign in', 'r-email': 'Email address', 'r-continue': 'Continue' };
      return { changed: true, find: { role: params.ref === 'r-email' ? 'textbox' : 'button', name: names[params.ref] } };
    },
  });
  const result = await handler({ tabId: 77, steps: [
    { action: 'click', ref: 'r-signin', snapshotId: 's-current-page' },
    { action: 'type', ref: 'r-email', snapshotId: 's-current-page', text: 'ref-only-private-text' },
    { action: 'click', ref: 'r-continue', snapshotId: 's-current-page' },
  ] });
  assert.equal(result.success, true);
  assert.ok(result.draft?.draftId);
  const draft = (await listActDrafts('shop.example.com')).find(item => item.id === result.draft.draftId);
  assert.deepEqual(draft.steps[1], { action: 'type', find: { role: 'textbox', name: 'Email address' }, text: '${email_address}' });
  assert.doesNotMatch(JSON.stringify(state), /ref-only-private-text|r-signin|r-email|r-continue|s-current-page/);
});
