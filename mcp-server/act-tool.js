import { z } from 'zod';
import { executeActScript, parseActScript } from './act-script.js';
const ACTION_KEYS = new Set(['action', 'condText']);
const MUTATIONS = new Set(['click', 'type', 'select', 'scroll']);
const SENSITIVE = /(?:submit|pay(?:ment)?|delete|remove|purchase|checkout|支付|付款|购买|删除|移除|提交|结算|下单)/i;

function cleanStep(step) {
    return Object.fromEntries(Object.entries(step).filter(([key]) => !ACTION_KEYS.has(key)));
}

function effectChanged(result) {
    const effect = result?.effect || result?.data?.effect;
    return effect?.changed ?? result?.changed ?? result?.data?.changed;
}

function sensitiveStep(step) {
    if (!MUTATIONS.has(step.action) && step.submit !== true) return false;
    // 目标可能藏在 find/value/name 里，只看顶层字段会整类漏判（例如
    // {action:'click', find:{role:'button', name:'删除账户'}}），所以按整个步骤判定。
    return SENSITIVE.test(JSON.stringify(cleanStep(step)));
}

function bridgeError(result, fallback = 'Bridge action failed') {
    if (!result || typeof result !== 'object') return null;
    if (result.success === false || result.ok === false) {
        return { code: 'ACTION_FAILED', message: String(result.error || result.message || fallback) };
    }
    return null;
}

/**
 * 条件谓词只回报观测到的证据：缺失或未知一律视为未命中。
 * 取反由 act-script 在唯一的判定点施加一次，这里绝不自行取反。
 */
function conditionMatch(results, cond) {
    const observed = Array.isArray(results) ? results : [results];
    const any = (predicate) => observed.some((entry) => predicate(entry && typeof entry === 'object' ? entry : {}));
    const checks = [];
    if (Object.hasOwn(cond, 'urlContains')) checks.push(any((entry) => String(entry.url || '').includes(String(cond.urlContains))));
    if (Object.hasOwn(cond, 'selectorExists')) checks.push(any((entry) => entry.exists === true));
    if (Object.hasOwn(cond, 'textContains')) checks.push(any((entry) => entry.matched === true || String(entry.content || '').includes(String(cond.textContains))));
    for (const key of ['checked', 'value', 'text']) {
        if (Object.hasOwn(cond, key)) checks.push(any((entry) => entry.matched === true));
    }
    return checks.some(Boolean);
}

function snapshotOf(step) {
    return { action: step.action, ...cleanStep(step) };
}

/** Register the ActSpan compound action tool without owning daemon lifecycle. */
export default function registerActTool({ registerTool, callBridge, run, tabIdParam, taskParams }) {
    const inputSchema = {
        ...taskParams,
        tabId: tabIdParam,
        // P6：预算按展开后的原子步数算，所以这里不设原始步数上限——上限由 parseActScript 按
        // repeat/if 展开后的 flatCount 执行。schema 承诺一套、执行另一套会让 20 步带 repeat
        // 的合法剧本被掐死，所以只在描述里说清真正的预算。
        steps: z.array(z.record(z.unknown())).min(1).describe('Ordered predicted action steps. The budget counts expanded atomic steps: repeat/if count as the steps they actually run, and the whole script may run at most 20.'),
        allowSensitive: z.boolean().default(false).describe('Explicitly allow sensitive submit/payment/delete actions; extension approval still applies.'),
    };

    registerTool('actspan_act', {
        title: 'ActSpan compound action',
        description: 'Your DEFAULT way to act — batch every step you can predict. Every call you merge saves a full model turn. Steps run sequentially with an effect check per step, stop at the first failure, and one final snapshot returns at the end. Only steps located by find {role, name} are eligible for draft capture; selector-only steps still run but are never promoted into a reusable draft.',
        inputSchema,
    }, run(async (args = {}) => {
        const parsed = parseActScript({ steps: args.steps });
        if (!parsed.ok) return { success: false, error: `${parsed.error.code}: ${parsed.error.message}` };
        const state = { reads: [], effects: [], executed: [], sensitive: false };
        const tabId = args.tabId;
        const allowSensitive = args.allowSensitive === true;
        const base = { ...(tabId === undefined ? {} : { tabId }) };
        const invoke = async (method, params) => {
            const result = await callBridge(method, { ...base, ...params }, 60000, args);
            const error = bridgeError(result);
            if (error) throw error;
            return result;
        };
        const recordEffect = (step, result, requireChange = false) => {
            // 缺失或未知的变化证据同样算失败：只有明确观测到变化才算有变化。
            if (requireChange && effectChanged(result) !== true) throw { code: 'NO_EFFECT', message: `No effect from ${step.action}` };
            const recorded = snapshotOf(step);
            const observedFind = result?.find || result?.data?.find;
            if (step.ref && observedFind && typeof observedFind === 'object') {
                delete recorded.ref;
                recorded.find = observedFind;
            }
            state.executed.push(recorded);
            if (MUTATIONS.has(step.action)) state.effects.push({ action: step.action, result });
            return result;
        };
        // 所有会改页面的动作都走同一道闸：漏掉任何一个 handler 都等于开了后门。
        const guardSensitive = (step) => {
            if (!sensitiveStep(step)) return;
            state.sensitive = true;
            if (!allowSensitive) throw { code: 'SENSITIVE_BLOCKED', message: 'Sensitive submit/payment/delete action requires allowSensitive:true' };
        };
        const handlers = {
            click: async (step) => {
                guardSensitive(step);
                return recordEffect(step, await invoke('page.click', { ...cleanStep(step), ...(allowSensitive ? { allowSensitive: true } : {}) }), true);
            },
            type: async (step) => {
                guardSensitive(step);
                return recordEffect(step, await invoke('page.type', { ...cleanStep(step), ...(allowSensitive ? { allowSensitive: true } : {}) }), true);
            },
            select: async (step) => {
                guardSensitive(step);
                return recordEffect(step, await invoke('page.select', cleanStep(step)), true);
            },
            scroll: async (step) => {
                guardSensitive(step);
                return recordEffect(step, await invoke('page.scroll', cleanStep(step)), true);
            },
            wait: async (step) => {
                const result = await invoke('page.wait', { ...cleanStep(step), for: step.for || 'idle', timeoutMs: step.timeoutMs ?? step.ms ?? 10000 });
                if (result?.found === false) throw { code: 'NO_EFFECT', message: 'Wait condition was not observed' };
                return recordEffect(step, result);
            },
            assert: async (step) => {
                const matched = await handlers.condition(step.cond);
                if (!matched) return false;
                state.executed.push(snapshotOf(step));
                return true;
            },
            read: async (step) => {
                // P3：contains 是中途观察的糖衣——走同一条布尔探针，页面原文不回传。
                const params = cleanStep(step);
                delete params.contains;
                if (step.contains !== undefined) {
                    params.attr = 'textContains';
                    params.expect = String(step.contains);
                }
                const result = await invoke('page.read', params);
                state.executed.push(snapshotOf(step));
                state.reads.push(result);
                return result;
            },
            condition: async (cond) => {
                const target = cond.find ? { find: cond.find }
                    : cond.ref ? { ref: cond.ref, ...(cond.snapshotId ? { snapshotId: cond.snapshotId } : {}) }
                        : cond.selector ? { selector: cond.selector } : undefined;
                // 每个 DOM 谓词各发一次探针，页面内折算成布尔证据；原始 value 与页面文本不回传。
                const probes = [];
                for (const key of ['checked', 'value', 'text', 'textContains']) {
                    if (Object.hasOwn(cond, key)) probes.push({ attr: key, expect: String(cond[key]) });
                }
                if (typeof cond.selectorExists === 'string') probes.push({ attr: 'exists', selector: cond.selectorExists });
                else if (Object.hasOwn(cond, 'selectorExists') && target) probes.push({ attr: 'exists' });
                const reads = probes.length === 0
                    ? [await invoke('page.read', {})]
                    : await Promise.all(probes.map((probe) => invoke('page.read', {
                        ...(probe.selector ? { selector: probe.selector } : target || {}), attr: probe.attr, expect: probe.expect,
                    })));
                state.reads.push(...reads);
                return conditionMatch(reads, cond);
            },
        };
        const execution = await executeActScript(parsed, handlers);
        // error 走 run() → fail() 时只剩 message，所以把 code 拼进文案，别让 agent 丢掉诊断码。
        if (!execution.ok) return { success: false, error: `${execution.error.code}: ${execution.error.message}`, trace: execution.audit, reads: state.reads };
        const draft = await invoke('act.draft', {
            steps: state.executed,
            audit: {
                success: true,
                stepCount: state.executed.length,
                effectiveCount: state.executed.length,
                hasMutation: state.effects.length > 0,
                trace: execution.audit.map(({ path, action, ok }) => ({ path, action, ok })),
            },
        });
        const snapshot = await invoke('page.read', {});
        return {
            success: true,
            snapshot,
            observations: state.reads,
            trace: execution.audit,
            draft,
            effectiveCount: state.executed.length,
            sensitive: state.sensitive,
        };
    }));

    registerTool('actspan_adopt', {
        title: 'Adopt ActSpan draft',
        description: 'Adopt a successful ActSpan draft into the saved workflow registry.',
        inputSchema: { ...taskParams, tabId: tabIdParam, draftId: z.string().min(1) },
    }, run((args) => callBridge('act.adopt', args, 30000, args)));
}

export { conditionMatch, sensitiveStep };
