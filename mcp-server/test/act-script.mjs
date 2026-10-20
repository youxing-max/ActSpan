import assert from 'node:assert/strict';
import test from 'node:test';
import { executeActScript, parseActScript } from '../act-script.js';

test('rejects nested repeat and ref targets inside repeat', () => {
    const nested = parseActScript({ steps: [{ repeat: { max: 2, steps: [{ repeat: { max: 2, steps: [{ action: 'click', selector: '#x' }] } }] } }] });
    assert.equal(nested.ok, false);
    assert.equal(nested.error.code, 'INVALID_NESTING');

    const ref = parseActScript({ steps: [{ repeat: { max: 2, steps: [{ action: 'click', ref: 'e1' }] } }] });
    assert.equal(ref.ok, false);
    assert.equal(ref.error.code, 'REPEAT_REF_FORBIDDEN');
});

test('normalizes flatCount and human-readable condText', () => {
    const parsed = parseActScript({
        steps: [
            { action: 'click', selector: '#go' },
            { if: { cond: { not: true, textContains: 'ready' }, then: [{ action: 'wait', ms: 1 }], else: [{ action: 'scroll', y: 20 }] } },
            { repeat: { max: 3, until: { selectorExists: '.done' }, steps: [{ action: 'type', selector: '#q', text: 'x' }] } },
        ],
    });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.flatCount, 5);
    assert.equal(parsed.steps[0].condText, '');
    assert.match(parsed.steps[1].condText, /not/i);
    assert.equal(parsed.steps[2].steps[0].condText, '');
});
test('caps expanded atomic execution at twenty steps even when caller raises option', () => {
    const steps = Array.from({ length: 21 }, (_, index) => ({ action: 'click', selector: `#${index}` }));
    const parsed = parseActScript({ steps }, { maxFlatSteps: 999 });
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, 'BUDGET_EXCEEDED');
});

test('returns structured errors for flat step, timeout, and concurrency budgets', () => {
    assert.equal(parseActScript({ steps: [{ action: 'click', selector: '#a' }, { action: 'click', selector: '#b' }] }, { maxFlatSteps: 1 }).error.code, 'BUDGET_EXCEEDED');
    assert.equal(parseActScript({ steps: [{ action: 'wait', ms: 20 }] }, { maxTimeoutMs: 10 }).error.code, 'TIMEOUT_BUDGET');
    assert.equal(parseActScript({ steps: [{ parallel: [[{ action: 'click', selector: '#a' }], [{ action: 'click', selector: '#b' }]] }] }, { maxConcurrency: 1 }).error.code, 'CONCURRENCY_BUDGET');
});

test('executes try/catch/always and does not run invalid scripts', async () => {
    const calls = [];
    const handlers = {
        click: async (step) => { calls.push(step.selector); if (step.selector === '#bad') throw new Error('no'); },
    };
    const parsed = parseActScript({ steps: [{ try: { steps: [{ action: 'click', selector: '#bad' }], catch: [{ action: 'click', selector: '#recover' }], always: [{ action: 'click', selector: '#cleanup' }] } }] });
    const result = await executeActScript(parsed, handlers);
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ['#bad', '#recover', '#cleanup']);

    const invalid = parseActScript({ steps: [{ action: 'wat', selector: '#danger' }] });
    const untouched = [];
    const invalidResult = await executeActScript(invalid, { wat: () => untouched.push('ran') });
    assert.equal(invalidResult.ok, false);
    assert.equal(untouched.length, 0);
});

test('enforces stop_on_error and parallel execution budget', async () => {
    const calls = [];
    const parsed = parseActScript({ stop_on_error: true, steps: [{ action: 'click', selector: '#bad' }, { action: 'click', selector: '#never' }] });
    const result = await executeActScript(parsed, {
        click: async (step) => { calls.push(step.selector); if (step.selector === '#bad') throw new Error('failed'); },
    });
    assert.equal(result.ok, false);
    assert.deepEqual(calls, ['#bad']);

    let active = 0;
    let peak = 0;
    // 默认只允许控制块嵌一层（P4），嵌套 parallel 要显式放宽 maxDepth。
    const parallel = parseActScript({ steps: [{ parallel: [[{ parallel: [[{ action: 'wait', ms: 1 }], [{ action: 'wait', ms: 1 }]] }], [{ action: 'wait', ms: 1 }]] }] }, { maxDepth: 2 });
    const limited = await executeActScript(parallel, {
        wait: async () => { active += 1; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 3)); active -= 1; },
    }, { maxConcurrency: 2, maxDepth: 2 });
    assert.equal(limited.ok, true);
    assert.equal(peak, 2);
});

test('hard timeout returns even when handler never resolves and always is invoked', async () => {
    const calls = [];
    const parsed = parseActScript({ steps: [{ try: { steps: [{ action: 'click', selector: '#hang' }], always: [{ action: 'click', selector: '#cleanup' }] } }] });
    const started = Date.now();
    const result = await executeActScript(parsed, {
        click: (step) => { calls.push(step.selector); return step.selector === '#hang' ? new Promise(() => {}) : undefined; },
    }, { maxTimeoutMs: 15 });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'TIMEOUT_BUDGET');
    assert.deepEqual(calls, ['#hang', '#cleanup']);
    assert.ok(Date.now() - started < 500);
});

test('stop_on_error false continues but reports failure', async () => {
    const calls = [];
    const parsed = parseActScript({ stop_on_error: false, steps: [{ action: 'click', selector: '#bad' }, { action: 'click', selector: '#next' }] });
    const result = await executeActScript(parsed, {
        click: (step) => { calls.push(step.selector); if (step.selector === '#bad') throw new Error('failed'); },
    });
    assert.equal(result.ok, false);
    assert.deepEqual(calls, ['#bad', '#next']);
});

test('JSON input executes if, repeat until, assert, and atomic actions', async () => {
    const actions = [];
    let rounds = 0;
    const parsed = parseActScript(JSON.stringify([{ if: { cond: { selectorExists: '.ready' }, then: [{ action: 'select', selector: '#choice', value: 'a' }] } }, { repeat: { max: 5, until: { textContains: 'done' }, steps: [{ action: 'scroll', y: 10 }] } }, { action: 'assert', cond: { not: true, urlContains: '/wrong' } }]));
    const result = await executeActScript(parsed, {
        condition: (cond) => cond.selectorExists ? true : cond.textContains ? rounds === 2 : false,
        select: (step) => actions.push(step.action),
        scroll: (step) => { actions.push(step.action); rounds += 1; },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(actions, ['select', 'scroll', 'scroll']);
    assert.equal(result.audit.every((entry) => typeof entry.condText === 'string'), true);
});

test('rejects repeat target interpolation, excessive repeat, excessive depth and late unknown action before running anything', async () => {
    const scripts = [
        [{ repeat: { max: 2, steps: [{ action: 'click', selector: '#${next}' }] } }],
        [{ repeat: { max: 26, steps: [{ action: 'click', selector: '#a' }] } }],
        [{ if: { cond: { textContains: 'a' }, then: [{ if: { cond: { textContains: 'b' }, then: [{ action: 'click', selector: '#a' }] } }] } }],
        [{ action: 'click', selector: '#danger' }, { action: 'unknown' }],
    ];
    const expected = ['DYNAMIC_TARGET_FORBIDDEN', 'REPEAT_BUDGET', 'INVALID_NESTING', 'UNKNOWN_ACTION'];
    for (let i = 0; i < scripts.length; i += 1) {
        // 不传 maxDepth：控制块只嵌一层是默认值（P4），嵌套 if 必须当场被拦下。
        const ast = parseActScript(scripts[i]);
        assert.equal(ast.error.code, expected[i]);
        const calls = [];
        assert.equal((await executeActScript(ast, { click: () => calls.push('ran') })).ok, false);
        assert.deepEqual(calls, []);
    }
});

test('always runs after catch failure and the catch failure is returned', async () => {
    const actions = [];
    const result = await executeActScript(parseActScript([{ try: { steps: [{ action: 'click', selector: 'fail' }], catch: [{ action: 'click', selector: 'fail-again' }], always: [{ action: 'click', selector: 'cleanup' }] } }]), {
        click: (step) => { actions.push(step.selector); if (step.selector !== 'cleanup') throw new Error(step.selector); },
    });
    assert.equal(result.ok, false);
    assert.match(result.error.message, /fail-again/);
    assert.deepEqual(actions, ['fail', 'fail-again', 'cleanup']);
});

test('negated condition inverts the observed predicate and failed assertion stops following actions', async () => {
    const calls = [];
    const skipped = parseActScript([{ if: { cond: { not: true, selectorExists: '.present' }, then: [{ action: 'click', selector: '#danger' }] } }]);
    assert.equal((await executeActScript(skipped, { condition: () => true, click: (step) => calls.push(step.selector) })).ok, true);
    assert.deepEqual(calls, []);

    const asserted = parseActScript([{ action: 'assert', cond: { textContains: 'ready' } }, { action: 'click', selector: '#never' }]);
    const result = await executeActScript(asserted, { assert: () => false, click: (step) => calls.push(step.selector) });
    assert.equal(result.error.code, 'ASSERT_FAILED');
    assert.deepEqual(calls, []);
});

test('rejects stale ref in repeat termination condition before acting', async () => {
    const ast = parseActScript([{ repeat: { max: 2, until: { ref: 'e1', checked: true }, steps: [{ action: 'click', selector: '#safe' }] } }]);
    assert.equal(ast.error.code, 'REPEAT_REF_FORBIDDEN');
    const calls = [];
    assert.equal((await executeActScript(ast, { click: () => calls.push('clicked') })).ok, false);
    assert.deepEqual(calls, []);
});

test('always receives a live cleanup signal after timeout', async () => {
    let cleaned = false;
    const ast = parseActScript([{ try: { steps: [{ action: 'click', selector: '#hang' }], always: [{ action: 'click', selector: '#cleanup' }] } }]);
    const result = await executeActScript(ast, { click: (step, context) => {
        if (step.selector === '#hang') return new Promise(() => {});
        cleaned = !context.signal.aborted;
    } }, { maxTimeoutMs: 10 });
    assert.equal(result.error.code, 'TIMEOUT_BUDGET');
    assert.equal(cleaned, true);
});

test('repeat snapshots its selector across iterations even if a handler mutates the received step', async () => {
    const targets = [];
    const script = parseActScript([{ repeat: { max: 2, steps: [{ action: 'click', selector: '#stable' }] } }]);
    const result = await executeActScript(script, { click: (step) => { targets.push(step.selector); step.selector = '#changed'; } });
    assert.equal(result.ok, true);
    assert.deepEqual(targets, ['#stable', '#stable']);
});

// ── P3：read 中途观察 ────────────────────────────────────────────────────

test('accepts read observation forms and rejects the ones it cannot honour', () => {
    assert.equal(parseActScript([{ action: 'read', selector: '#price', attr: 'text' }]).ok, true);
    assert.equal(parseActScript([{ action: 'read', selector: '#price', contains: '¥' }]).ok, true);
    assert.equal(parseActScript([{ action: 'read', contains: '¥' }]).ok, true);

    // 拼错的 attr 与空 contains 必须在解析期点名，不能被静默忽略。
    assert.equal(parseActScript([{ action: 'read', selector: '#a', attr: 'innerText' }]).error.code, 'INVALID_SCRIPT');
    assert.match(parseActScript([{ action: 'read', selector: '#a', attr: 'innerText' }]).error.message, /read\.attr must be one of/);
    assert.match(parseActScript([{ action: 'read', selector: '#a', contains: '' }]).error.message, /non-empty string/);
    assert.match(parseActScript([{ action: 'read', selector: '#a', contains: 7 }]).error.message, /non-empty string/);
    assert.match(parseActScript([{ action: 'read', selector: '#a', attr: 'text', contains: 'x' }]).error.message, /either attr or contains, not both/);
});

// ── P4：控制块只嵌一层 ───────────────────────────────────────────────────

test('nests control blocks one level by default and names the fix when it does not', () => {
    const nested = parseActScript([{ if: { cond: { textContains: 'a' }, then: [{ if: { cond: { textContains: 'b' }, then: [{ action: 'click', selector: '#a' }] } }] } }]);
    assert.equal(nested.error.code, 'INVALID_NESTING');
    assert.match(nested.error.message, /nest at most 1 level/);
    assert.match(nested.error.message, /move the inner control block outside the outer one/);

    // 一层是允许的：if 的 body 里放原子步。
    assert.equal(parseActScript([{ if: { cond: { textContains: 'a' }, then: [{ action: 'click', selector: '#a' }] } }]).ok, true);

    // repeat 里嵌控制块另有更贴切的说法。
    const insideRepeat = parseActScript([{ repeat: { max: 2, steps: [{ if: { cond: { textContains: 'a' }, then: [{ action: 'click', selector: '#a' }] } }] } }]);
    assert.equal(insideRepeat.error.code, 'INVALID_NESTING');
    assert.match(insideRepeat.error.message, /move the control block outside repeat/);
});

// ── P6：预算按展开后的原子步数算 ─────────────────────────────────────────

test('counts the budget on expanded atomic steps, not on the listed step count', () => {
    // 20 个原始步，其中一个是 repeat(max 3)：展开后 22 步，超预算。
    const expanded = Array.from({ length: 19 }, (_, index) => ({ action: 'click', selector: `#${index}` }));
    expanded.push({ repeat: { max: 3, steps: [{ action: 'click', selector: '#more' }] } });
    const over = parseActScript({ steps: expanded });
    assert.equal(over.ok, false);
    assert.equal(over.error.code, 'BUDGET_EXCEEDED');
    assert.match(over.error.message, /Expanded steps exceed 20/);
    assert.match(over.error.message, /lower repeat\.max/);

    // 同一批原始步数在预算内时必须放行——预算不能把合法剧本掐死。
    const legal = Array.from({ length: 19 }, (_, index) => ({ action: 'click', selector: `#${index}` }));
    legal.push({ repeat: { max: 1, steps: [{ action: 'click', selector: '#more' }] } });
    const within = parseActScript({ steps: legal });
    assert.equal(within.ok, true);
    assert.equal(within.flatCount, 20);

    // if 只算实际会走的那一支。
    const branch = parseActScript({ steps: [{ if: { cond: { textContains: 'a' }, then: [{ action: 'click', selector: '#a' }], else: [{ action: 'click', selector: '#b' }, { action: 'click', selector: '#c' }] } }] });
    assert.equal(branch.flatCount, 2);
});
