const ATOMIC = new Set(['click', 'type', 'select', 'scroll', 'wait', 'assert', 'read']);
const CONTROL = new Set(['if', 'repeat', 'parallel', 'try']);
// 与页面侧 page.read 探针接受的 attr 保持一致，解析期就能拦住拼错的名字。
const READ_ATTRS = ['exists', 'checked', 'value', 'text', 'textContains'];
// maxDepth 1 = 控制块只嵌一层（P4）：控制块的 body 里不能再放控制块。
const DEFAULTS = { maxDepth: 1, maxFlatSteps: 20, maxRepeat: 25, maxConcurrency: 4, maxTimeoutMs: 60000 };

function problem(code, message, path = 'steps') {
    return { code, message, path };
}

function fail(error) {
    return { ok: false, error };
}

function limit(value, fallback) {
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** 条件否定只在这里施加一次：handler 只回报观测到的谓词，不自行取反。 */
export function matchesCondition(cond, observed) {
    return cond?.not ? !observed : Boolean(observed);
}

function describeCondition(cond) {
    if (!cond || typeof cond !== 'object' || Array.isArray(cond)) return '';
    const parts = ['urlContains', 'selectorExists', 'textContains', 'checked', 'value', 'text']
        .filter((key) => Object.hasOwn(cond, key))
        .map((key) => `${key} ${String(cond[key])}`);
    const target = cond.ref || cond.find || cond.selector;
    const targetText = typeof target === 'object' ? JSON.stringify(target) : target;
    const text = `${cond.not ? 'not ' : ''}${targetText ? `${targetText}: ` : ''}${parts.join(' or ')}`;
    return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function validCondition(cond) {
    if (!cond || typeof cond !== 'object' || Array.isArray(cond)) return false;
    const keys = ['urlContains', 'selectorExists', 'textContains', 'checked', 'value', 'text'];
    const target = cond.ref || cond.find || cond.selector;
    return keys.some((key) => Object.hasOwn(cond, key)) && (target === undefined || typeof target === 'string' || (typeof target === 'object' && target !== null));
}

/** Validate and normalize a JSON/object act script before any handler can run. */
export function parseActScript(text, options = {}) {
    const limits = Object.fromEntries(Object.entries(DEFAULTS).map(([key, value]) => [key, limit(options[key], value)]));
    limits.maxFlatSteps = Math.min(DEFAULTS.maxFlatSteps, limits.maxFlatSteps);
    let input = text;
    if (typeof text === 'string') {
        try { input = JSON.parse(text); } catch { return fail(problem('INVALID_SCRIPT', 'Act script must be valid JSON')); }
    }
    if (Array.isArray(input)) input = { steps: input };
    if (!input || typeof input !== 'object' || !Array.isArray(input.steps)) {
        return fail(problem('INVALID_SCRIPT', 'Act script must contain a steps array'));
    }
    if (input.stop_on_error !== undefined && typeof input.stop_on_error !== 'boolean') {
        return fail(problem('INVALID_SCRIPT', 'stop_on_error must be boolean'));
    }

    function block(steps, depth, repeat, path) {
        if (!Array.isArray(steps)) throw problem('INVALID_SCRIPT', 'Expected a steps array', path);
        if (depth > limits.maxDepth) throw problem('INVALID_NESTING', `Control blocks nest at most ${limits.maxDepth} level(s); move the inner control block outside the outer one or flatten it`, path);
        let count = 0;
        let duration = 0;
        const normalized = steps.map((step, index) => {
            const at = `${path}[${index}]`;
            if (!step || typeof step !== 'object' || Array.isArray(step)) throw problem('INVALID_SCRIPT', 'Expected a step object', at);
            const action = step.action || ['if', 'repeat', 'parallel', 'try'].find((key) => Object.hasOwn(step, key));
            if (!ATOMIC.has(action) && !CONTROL.has(action)) throw problem('UNKNOWN_ACTION', `Unknown action: ${String(action)}`, at);
            if (CONTROL.has(action) && repeat) {
                throw problem('INVALID_NESTING', 'Repeat cannot contain control blocks; move the control block outside repeat', at);
            }
            const body = Object.hasOwn(step, action) && typeof step[action] === 'object' ? step[action] : step;
            const node = { ...body, action, condText: '' };
            if (ATOMIC.has(action)) {
                if (repeat && (Object.hasOwn(step, 'ref') || Object.hasOwn(body, 'ref') || Object.hasOwn(step, 'element_id') || Object.hasOwn(body, 'element_id'))) {
                    throw problem('REPEAT_REF_FORBIDDEN', 'Repeat cannot use ref/element_id because page rerenders invalidate it; use a stable selector or find', at);
                }
                for (const target of ['ref', 'selector', 'find']) {
                    if (Object.hasOwn(node, target) && ((target === 'find' && (!node[target] || typeof node[target] !== 'object' || Array.isArray(node[target]))) || (target !== 'find' && (typeof node[target] !== 'string' || !node[target].trim() || /\$\{|{{/.test(node[target]) && repeat)))) {
                        throw problem(repeat ? 'DYNAMIC_TARGET_FORBIDDEN' : 'INVALID_SCRIPT', `Invalid or dynamic ${target}`, at);
                    }
                }
                if ([node.ref, node.selector, node.find].filter(Boolean).length > 1) throw problem('INVALID_SCRIPT', 'Use one target: ref, selector, or find', at);
                if (action === 'assert') {
                    if (!validCondition(node.cond)) throw problem('INVALID_CONDITION', 'assert requires a condition', at);
                    node.condText = describeCondition(node.cond);
                }
                if (action === 'wait' && node.ms !== undefined && (!Number.isSafeInteger(node.ms) || node.ms < 0)) {
                    throw problem('INVALID_SCRIPT', 'wait.ms must be a nonnegative integer', at);
                }
                // P3：read 是中途观察。attr 走布尔探针，contains 是它的糖衣；
                // 两者都必须在解析期点名，否则会被静默忽略。
                if (action === 'read') {
                    if (node.attr !== undefined && !READ_ATTRS.includes(String(node.attr))) {
                        throw problem('INVALID_SCRIPT', `read.attr must be one of ${READ_ATTRS.join(', ')}`, at);
                    }
                    if (node.contains !== undefined) {
                        if (typeof node.contains !== 'string' || !node.contains) throw problem('INVALID_SCRIPT', 'read.contains must be a non-empty string', at);
                        if (node.attr !== undefined) throw problem('INVALID_SCRIPT', 'read takes either attr or contains, not both', at);
                    }
                }
                count += 1;
                duration += action === 'wait' ? node.ms || 0 : 0;
            } else if (action === 'if') {
                if (!validCondition(body.cond)) throw problem('INVALID_CONDITION', 'if requires a condition', at);
                node.condText = describeCondition(body.cond);
                const yes = block(body.then, depth + 1, repeat, `${at}.then`);
                const no = block(body.else || [], depth + 1, repeat, `${at}.else`);
                node.then = yes.steps;
                node.else = no.steps;
                count += Math.max(yes.count, no.count);
                duration += Math.max(yes.duration, no.duration);
            } else if (action === 'repeat') {
                const max = body.max ?? 10;
                if (!Number.isSafeInteger(max) || max < 1 || max > limits.maxRepeat) {
                    throw problem('REPEAT_BUDGET', `Repeat max must be between 1 and ${limits.maxRepeat}`, at);
                }
                if (body.until !== undefined && !validCondition(body.until)) throw problem('INVALID_CONDITION', 'Invalid repeat.until condition', at);
                if (body.until && (Object.hasOwn(body.until, 'ref') || Object.hasOwn(body.until, 'element_id'))) {
                    throw problem('REPEAT_REF_FORBIDDEN', 'Repeat until cannot use ref/element_id because page rerenders invalidate it', at);
                }
                const child = block(body.steps, depth + 1, true, `${at}.steps`);
                node.max = max;
                node.steps = child.steps;
                node.condText = describeCondition(body.until);
                count += child.count * max;
                duration += child.duration * max;
            } else if (action === 'parallel') {
                const branches = Array.isArray(body) ? body : body.branches;
                if (!Array.isArray(branches) || !branches.length) throw problem('INVALID_SCRIPT', 'parallel requires branches', at);
                if (branches.length > limits.maxConcurrency) throw problem('CONCURRENCY_BUDGET', `Parallel branches exceed ${limits.maxConcurrency}`, at);
                const children = branches.map((branch, i) => block(branch, depth + 1, repeat, `${at}.branches[${i}]`));
                node.branches = children.map((child) => child.steps);
                count += children.reduce((sum, child) => sum + child.count, 0);
                duration += Math.max(...children.map((child) => child.duration));
            } else {
                const attempt = block(body.steps, depth + 1, repeat, `${at}.steps`);
                const rescue = block(body.catch || [], depth + 1, repeat, `${at}.catch`);
                const cleanup = block(body.always || [], depth + 1, repeat, `${at}.always`);
                node.steps = attempt.steps;
                node.catch = rescue.steps;
                node.always = cleanup.steps;
                count += attempt.count + rescue.count + cleanup.count;
                duration += attempt.duration + rescue.duration + cleanup.duration;
            }
            if (count > limits.maxFlatSteps) throw problem('BUDGET_EXCEEDED', `Expanded steps exceed ${limits.maxFlatSteps}: repeat/if count as the steps they actually run, so shorten the script or lower repeat.max`, at);
            if (duration > limits.maxTimeoutMs) throw problem('TIMEOUT_BUDGET', `Wait time exceeds ${limits.maxTimeoutMs}ms; lower wait.ms or repeat.max`, at);
            return node;
        });
        return { steps: normalized, count, duration };
    }
    try {
        const parsed = block(input.steps, 0, false, 'steps');
        return { ok: true, steps: parsed.steps, flatCount: parsed.count, stop_on_error: input.stop_on_error !== false };
    } catch (error) {
        return fail(error?.code ? error : problem('INVALID_SCRIPT', String(error?.message || error)));
    }
}

/** Execute validated steps with externally supplied, auditable action handlers. */
export async function executeActScript(ast, handlers = {}, options = {}) {
    if (ast?.ok === false) return fail(ast.error);
    const parsed = parseActScript(ast, options);
    if (!parsed.ok) return parsed;
    const maxConcurrency = limit(options.maxConcurrency, DEFAULTS.maxConcurrency);
    const timeoutMs = limit(options.maxTimeoutMs, DEFAULTS.maxTimeoutMs);
    const controller = new AbortController();
    const audit = [];
    const errors = [];
    let active = 0;
    const queue = [];
    const cleanupController = new AbortController();
    const hasCondition = typeof handlers.condition === 'function';
    const missing = (steps) => steps.flatMap((step) => {
        if (ATOMIC.has(step.action)) {
            return typeof handlers[step.action] !== 'function' && !(step.action === 'wait' && !step.cond) && !(step.action === 'assert' && hasCondition) ? [step.action] : [];
        }
        if (step.action === 'if') return [...(hasCondition ? [] : ['condition']), ...missing(step.then), ...missing(step.else)];
        if (step.action === 'repeat') return [...(step.until && !hasCondition ? ['condition'] : []), ...missing(step.steps)];
        if (step.action === 'parallel') return step.branches.flatMap(missing);
        return [...missing(step.steps), ...missing(step.catch), ...missing(step.always)];
    });
    const absent = missing(parsed.steps);
    if (absent.length) return fail(problem('HANDLER_MISSING', `Missing handler: ${absent[0]}`));

    const timeoutError = () => problem('TIMEOUT_BUDGET', `Execution exceeded ${timeoutMs}ms`);
    const guard = (cleanup = false) => { if (!cleanup && controller.signal.aborted) throw timeoutError(); };
    function bounded(promise, cleanup = false) {
        if (cleanup) {
            let timer;
            return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError()), timeoutMs); })])
                .finally(() => clearTimeout(timer));
        }
        if (controller.signal.aborted) return Promise.reject(timeoutError());
        return new Promise((resolve, reject) => {
            const onAbort = () => reject(timeoutError());
            controller.signal.addEventListener('abort', onAbort, { once: true });
            Promise.resolve(promise).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', onAbort));
        });
    }
    const condition = async (cond, step, cleanup = false) => {
        const observed = Boolean(await bounded(handlers.condition(cond, step, { signal: cleanup ? cleanupController.signal : controller.signal }), cleanup));
        return matchesCondition(cond, observed);
    };
    async function atom(step, path, cleanup = false) {
        guard(cleanup);
        if (step.action === 'assert' && !handlers.assert) {
            if (!await condition(step.cond, step, cleanup)) throw problem('ASSERT_FAILED', `Assertion failed: ${step.condText}`, path);
            return;
        }
        if (step.action === 'wait' && !handlers.wait) {
            await bounded(new Promise((resolve) => setTimeout(resolve, step.ms || 0)), cleanup);
            guard(cleanup);
            return;
        }
        if (active >= maxConcurrency) await bounded(new Promise((resolve) => queue.push(resolve)), cleanup);
        guard(cleanup);
        active += 1;
        try {
            const result = await bounded(handlers[step.action]({ ...step }, { signal: cleanup ? cleanupController.signal : controller.signal, path }), cleanup);
            if (step.action === 'assert' && result === false) throw problem('ASSERT_FAILED', `Assertion failed: ${step.condText}`, path);
            if (result?.success === false || result?.ok === false) throw problem('ACTION_FAILED', String(result.error || result.message || 'Action failed'), path);
            guard(cleanup);
        } finally {
            active -= 1;
            queue.shift()?.();
        }
    }
    async function run(steps, path, strict = false, cleanup = false) {
        for (let i = 0; i < steps.length; i += 1) {
            const step = steps[i];
            const at = `${path}[${i}]`;
            try {
                guard(cleanup);
                if (ATOMIC.has(step.action)) await atom(step, at, cleanup);
                else if (step.action === 'if') await run(await condition(step.cond, step, cleanup) ? step.then : step.else, at, strict, cleanup);
                else if (step.action === 'repeat') {
                    for (let round = 0; round < step.max; round += 1) {
                        await run(step.steps, `${at}.steps`, strict, cleanup);
                        if (step.until && await condition(step.until, step, cleanup)) break;
                    }
                } else if (step.action === 'parallel') {
                    const outcomes = await Promise.allSettled(step.branches.map((branch, index) => run(branch, `${at}.branches[${index}]`, true, cleanup)));
                    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
                    if (rejected) throw rejected.reason;
                } else {
                    let pending;
                    try { await run(step.steps, `${at}.steps`, true, cleanup); } catch (error) { pending = error; }
                    if (pending && step.catch.length && pending.code !== 'TIMEOUT_BUDGET') {
                        try { await run(step.catch, `${at}.catch`, true, cleanup); pending = undefined; } catch (error) { pending = error; }
                    }
                    try { await run(step.always, `${at}.always`, true, true); } catch (error) { pending = error; }
                    if (pending) throw pending;
                }
                audit.push({ path: at, action: step.action, condText: step.condText, ok: true });
            } catch (error) {
                const structured = error?.code ? error : problem('ACTION_FAILED', String(error?.message || error), at);
                audit.push({ path: at, action: step.action, condText: step.condText, ok: false, error: structured });
                if (strict || parsed.stop_on_error || structured.code === 'TIMEOUT_BUDGET') throw structured;
                errors.push(structured);
            }
        }
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        await run(parsed.steps, 'steps');
        return errors.length ? { ok: false, error: errors[0], errors, audit } : { ok: true, audit };
    } catch (error) {
        return { ok: false, error: error?.code ? error : problem('ACTION_FAILED', String(error?.message || error)), audit };
    } finally {
        clearTimeout(timer);
    }
}
