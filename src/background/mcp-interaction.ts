import { PolicyError } from './policy-executor';
import { tabLeaseManager } from './tab-lease-manager';
import type { TaskContext } from './task-types';

const assertValid = (method: string, p: Record<string, unknown>) => {
    const fields: Record<string, string[]> = {
        'page.select': ['selector', 'value'], 'page.upload': ['selector', 'dropSelector', 'filename', 'base64', 'mimeType'],
        'page.key': ['keys', 'repeat', 'selector', 'ref', 'snapshotId'],
        'page.wait': ['for', 'selector', 'text', 'timeoutMs'],
        'page.scroll': ['selector', 'deltaX', 'deltaY'],
    };
    for (const field of Object.keys(p)) if (!fields[method].includes(field) &&
        !['tabId', 'tab_id', 'taskId', 'sessionId'].includes(field)) throw new Error(`不支持的操作参数: ${field}`);
    const valid = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 2000;
    const selector = valid(p.selector);
    if (method === 'page.select' && (!selector || !valid(p.value))) throw new Error('select requires selector and value');
    if (method === 'page.upload' && (selector === valid(p.dropSelector) || !valid(p.filename) ||
        typeof p.base64 !== 'string' || p.base64.length > 12_000_000 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.base64))) {
        throw new Error('upload requires exactly one file input selector or dropSelector, filename and valid base64 (up to 9MB)');
    }
    if (method === 'page.key' && (!Array.isArray(p.keys) || p.keys.length < 1 || p.keys.length > 50 ||
        !p.keys.every((key) => valid(key) && key.length <= 60) ||
        !Number.isInteger(p.repeat ?? 1) || Number(p.repeat ?? 1) < 1 || Number(p.repeat ?? 1) > 50 ||
        (p.selector !== undefined && !selector) || (p.snapshotId !== undefined && !p.ref) ||
        (p.ref !== undefined && (!valid(p.ref) || !valid(p.snapshotId))) || (p.ref && p.selector))) {
        throw new Error('key requires 1–50 keys, repeat 1–50, and ref with snapshotId or selector');
    }
    if (method === 'page.wait' && (!['selector', 'text', 'idle'].includes(String(p.for)) ||
        (p.for === 'selector' && !selector) || (p.for === 'text' && !valid(p.text)) ||
        (p.for === 'idle' && (p.selector || p.text)) ||
        (p.for === 'selector' && p.text !== undefined) || (p.for === 'text' && p.selector !== undefined) ||
        !Number.isInteger(p.timeoutMs ?? 10000) || Number(p.timeoutMs ?? 10000) < 100 || Number(p.timeoutMs ?? 10000) > 30000)) {
        throw new Error('wait requires for: selector/text/idle, its matching condition, and timeoutMs 100–30000');
    }
    if (method === 'page.scroll' && ((p.selector !== undefined && !selector) ||
        ![p.deltaX ?? 0, p.deltaY ?? 0].every((value) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 100000))) {
        throw new Error('scroll requires finite offsets within 100000 pixels');
    }
};

/**
 * executeScript 会把页面侧的 throw 吞成 {result:null}，且**不带 error 字段**，调用方无法分辨
 * 「函数返回 null」与「函数抛错」。注入函数因此自己把结果装进信封，由调用方还原真实原因。
 * 注入函数必须自包含，键名在函数体里是字面量：改这里要同步 interactOnPage 与 pageAction。
 */
export const PAGE_RESULT_ENVELOPE = '__actspan_page_result';
export type PageResultEnvelope = { [PAGE_RESULT_ENVELOPE]: true; ok: boolean; value?: unknown; error?: string };
export function isPageResultEnvelope(value: unknown): value is PageResultEnvelope {
    if (typeof value !== 'object' || value === null) return false;
    const record: Record<string, unknown> = value as Record<string, unknown>;
    return record[PAGE_RESULT_ENVELOPE] === true;
}

// Chrome serializes this function into an isolated script world. No module references may be captured.
export async function interactOnPage(method: string, params: Record<string, unknown>, ref?: string, snapshotId?: string): Promise<Record<string, unknown>> {
    // 注入函数必须自包含：executeScript 把页面侧 throw 吞成 {result:null} 且不带 error 字段，
    // 桥侧无法分辨「返回 null」与「抛错」，所以动作体自己把结果装进信封，由调用方还原。
    const body = async (): Promise<Record<string, unknown>> => {
        const selector = String(params.selector || '');
        // ref 只在扩展隔离世界里解析：页面无法用公开属性把句柄重定向到别的元素。
        const target = () => {
            if (ref) {
                const resolve = globalThis.__actspan_resolve_element_handle;
                const resolved = typeof resolve === 'function' ? resolve(ref, snapshotId) : undefined;
                if (!resolved?.target) throw new Error(resolved?.error || `元素未找到或句柄已失效: ${ref}`);
                return resolved.target as HTMLElement;
            }
            const found = document.querySelector(selector);
            if (!found) throw new Error(`元素未找到或句柄已失效: ${selector}`);
            return found as HTMLElement;
        };
        const denyPayment = (el: HTMLElement) => {
            const form = (el as HTMLInputElement).form;
            const submit = form?.querySelector('button[type="submit"],input[type="submit"],button:not([type])');
            const label = [el.getAttribute?.('aria-label'), el.getAttribute?.('value'), el.textContent,
                submit?.getAttribute('aria-label'), submit?.getAttribute('value'), submit?.textContent].filter(Boolean).join(' ').slice(0, 500);
            const nearby = (form?.innerText || el.parentElement?.innerText || '').slice(0, 1000);
            const amount = (nearby.match(/(?:[$€£¥]\s*\d[\d,.]*|\d[\d,.]*\s*(?:元|円|美元|欧元|USD|CNY|EUR|GBP))/i) || [])[0] || '';
            if (/(?:支付|付款|购买|结算|下单|充值|订阅|捐赠|pay\b|checkout\b|purchase\b|place order\b|subscribe\b|donate\b)/i.test(label) ||
                amount && /(?:确认|确定|继续|提交|完成|confirm\b|continue\b|proceed\b|submit\b|complete\b)/i.test(label)) {
                throw new Error(`支付动作未经确认${amount ? `：${amount}` : ''}；请使用需要用户确认的 page.click 或 page.type 提交路径`);
            }
        };
        if (method === 'page.select') {
            const select = target();
            if (select.tagName !== 'SELECT') throw new Error('目标不是原生 select；请定位真实 select 元素');
            denyPayment(select);
            const control = select as HTMLSelectElement;
            const requested = String(params.value);
            const option = Array.from(control.options).find((item) => item.value === requested)
                || Array.from(control.options).find((item) => item.textContent?.trim() === requested);
            if (!option) throw new Error(`选项未找到: ${requested}；可用值: ${Array.from(control.options).map((item) => item.value).join(', ')}`);
            if (option.disabled) throw new Error(`选项已禁用: ${requested}`);
            const before = control.value;
            control.value = option.value;
            control.dispatchEvent(new Event('change', { bubbles: true }));
            return { selectedValue: control.value, selectedText: option.textContent?.trim() || '', changed: control.value !== before };
        }
        if (method === 'page.upload') {
            const drop = typeof params.dropSelector === 'string';
            const destination = drop ? document.querySelector(params.dropSelector as string) as HTMLElement | null : target();
            if (!destination) throw new Error(`拖放目标未找到: ${params.dropSelector}`);
            if (!drop && (destination.tagName !== 'INPUT' || (destination as HTMLInputElement).type !== 'file')) throw new Error('上传目标必须是 file input');
            denyPayment(destination);
            const bytes = atob(String(params.base64));
            const data = new Uint8Array(bytes.length);
            for (let i = 0; i < bytes.length; i++) data[i] = bytes.charCodeAt(i);
            const file = new File([data], String(params.filename), { type: String(params.mimeType || 'application/octet-stream') });
            const transfer = new DataTransfer();
            transfer.items.add(file);
            if (drop) {
                for (const type of ['dragenter', 'dragover', 'drop']) {
                    destination.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
                }
            } else {
                (destination as HTMLInputElement).files = transfer.files;
                destination.dispatchEvent(new Event('input', { bubbles: true }));
                destination.dispatchEvent(new Event('change', { bubbles: true }));
            }
            return { uploaded: true, filename: file.name, bytes: file.size ?? data.length, via: drop ? 'drop' : 'input' };
        }
        if (method === 'page.key') {
            if (selector || ref) target().focus();
            const keys = params.keys as string[];
            const repeat = Number(params.repeat ?? 1);
            let pressed = 0;
            for (let i = 0; i < repeat; i++) for (const sequenceKey of keys) {
                const parts = sequenceKey.split('+');
                const key = parts.pop()!;
                const modifiers = parts.map((part) => part.toLowerCase());
                if (modifiers.some((part) => !['ctrl', 'control', 'shift', 'alt', 'meta', 'cmd'].includes(part))) throw new Error(`不支持的修饰键: ${sequenceKey}`);
                const current = document.activeElement as HTMLElement | null;
                const eventOptions = { key, bubbles: true, cancelable: true,
                    ctrlKey: modifiers.includes('ctrl') || modifiers.includes('control'), shiftKey: modifiers.includes('shift'),
                    altKey: modifiers.includes('alt'), metaKey: modifiers.includes('meta') || modifiers.includes('cmd') };
                if (!current) throw new Error('页面无聚焦元素；请传 selector 或 ref');
                const activation = key === 'Enter' || key === ' ' || key === 'Space';
                if (activation && !modifiers.length) denyPayment(current);
                const proceed = current.dispatchEvent(new KeyboardEvent('keydown', eventOptions));
                if (proceed && !modifiers.length && key === 'Tab') {
                    const focusable = Array.from(document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')) as HTMLElement[];
                    const eligible = focusable.filter((el) => !el.hasAttribute?.('disabled') && el.getAttribute?.('tabindex') !== '-1');
                    const from = eligible.indexOf(current);
                    if (eligible.length) eligible[(from + (eventOptions.shiftKey ? eligible.length - 1 : 1)) % eligible.length].focus();
                } else if (proceed && activation && !modifiers.length && (current.matches?.('button,a,[role="button"],[role="link"],input[type="submit"]') ||
                    key === 'Enter' && current.tagName === 'INPUT' && (current as HTMLInputElement).form)) {
                    if (current.matches?.('button,a,[role="button"],[role="link"],input[type="submit"]')) current.click();
                    else if (key === 'Enter' && (current as HTMLInputElement).form) {
                        const form = (current as HTMLInputElement).form!;
                        denyPayment(current);
                        form.requestSubmit();
                    }
                } else if (proceed && (current.tagName === 'INPUT' || current.tagName === 'TEXTAREA') &&
                    !(current as HTMLInputElement).disabled && !(current as HTMLInputElement).readOnly &&
                    (current.tagName !== 'INPUT' || /^(?:text|search|url|tel|email|password)$/i.test((current as HTMLInputElement).type))) {
                    const input = current as HTMLInputElement | HTMLTextAreaElement;
                    if ((eventOptions.ctrlKey || eventOptions.metaKey) && key.toLowerCase() === 'a') {
                        input.select();
                    } else if (!eventOptions.ctrlKey && !eventOptions.metaKey && !eventOptions.altKey) {
                        const start = input.selectionStart ?? input.value.length;
                        const end = input.selectionEnd ?? start;
                        const text = key === 'Space' ? ' ' : key.length === 1 ? key : key === 'Enter' && current.tagName === 'TEXTAREA' ? '\n' : '';
                        if (text || key === 'Backspace' || key === 'Delete') {
                            const left = key === 'Backspace' && start === end ? Math.max(0, start - 1) : start;
                            const right = key === 'Delete' && start === end ? Math.min(input.value.length, end + 1) : end;
                            const change = new InputEvent('beforeinput', { bubbles: true, cancelable: true,
                                inputType: text ? 'insertText' : 'deleteContentBackward', data: text || null });
                            if (input.dispatchEvent(change)) {
                                input.setRangeText(text, left, right, 'end');
                                input.dispatchEvent(new InputEvent('input', { bubbles: true,
                                    inputType: text ? 'insertText' : 'deleteContentBackward', data: text || null }));
                            }
                        }
                    }
                }
                current.dispatchEvent(new KeyboardEvent('keyup', eventOptions));
                pressed++;
            }
            return { pressed, focused: (document.activeElement as HTMLElement | null)?.tagName || null };
        }
        if (method === 'page.scroll') {
            const el = selector ? target() : null;
            const beforeX = el ? el.scrollLeft : window.scrollX;
            const beforeY = el ? el.scrollTop : window.scrollY;
            const x = Number(params.deltaX ?? 0), y = Number(params.deltaY ?? 0);
            if (el) el.scrollBy(x, y); else window.scrollBy(x, y);
            const afterX = el ? el.scrollLeft : window.scrollX;
            const afterY = el ? el.scrollTop : window.scrollY;
            const changed = afterX !== beforeX || afterY !== beforeY;
            // 真正被滚动的是目标元素或文档滚动元素。scrollBy 只改 scrollLeft/Top，只监听 wheel 的
            // 懒加载与自定义滚动容器不会响应，所以滚动后向该元素补发一条语义与真实事件一致的合成 wheel。
            const scrolled = el || document.scrollingElement || document.documentElement;
            scrolled.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: x, deltaY: y, deltaMode: 0 }));
            const result: Record<string, unknown> = { requested: { deltaX: x, deltaY: y },
                before: { x: beforeX, y: beforeY }, after: { x: afterX, y: afterY }, changed };
            if (!changed) {
                // 位置没动有三种常见成因，并列报出而不是替调用方猜一个：三者下一步动作各不相同。
                // 余量必须是「还能再滚多少」，不是「总共能滚多少」：scrollHeight-clientHeight 是总量，
                // 减去当前偏移才是剩余。用总量会让已到边界的调用方看到非零余量而误判成「还能滚」。
                const slackX = Math.max(0, scrolled.scrollWidth - scrolled.clientWidth - Math.abs(afterX));
                const slackY = Math.max(0, scrolled.scrollHeight - scrolled.clientHeight - Math.abs(afterY));
                result.diagnostic = `滚动位置未变化（x ${beforeX}→${afterX}，y ${beforeY}→${afterY}）。三种可能并列：`
                    + `① 目标不可滚动——可滚动余量 x=${slackX} y=${slackY}，为 0 说明已到边界或该元素没有溢出内容；`
                    + `② 需要焦点——部分页面只在窗口或元素获得焦点后才响应滚动，可先聚焦目标（focus:true）再滚动；`
                    + `③ 懒加载——只监听 wheel 的容器或 IntersectionObserver 懒加载需要一次交互或回调，可重试本操作，或先 page.wait 等页面稳定。`;
            }
            return result;
        }
        if (method === 'page.wait') {
            if (params.for === 'selector') return { found: Boolean(document.querySelector(String(params.selector))) };
            if (params.for === 'text') return { found: Boolean(document.body?.innerText.includes(String(params.text))) };
            if (document.readyState !== 'complete') return { found: false };
            return new Promise<Record<string, unknown>>((resolve) => {
                const done = (found: boolean) => {
                    observer.disconnect();
                    clearTimeout(timer);
                    clearTimeout(deadline);
                    resolve({ found, ...(found ? { idleMs: 500 } : {}) });
                };
                const observer = new MutationObserver(() => {
                    clearTimeout(timer);
                    timer = setTimeout(() => done(true), 500);
                });
                let timer = setTimeout(() => done(true), 500);
                const deadline = setTimeout(() => done(false), Number(params.timeoutMs ?? 10000));
                observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
            });
        }
        throw new Error(`不支持的页面操作: ${method}`);
    };
    try {
        return { __actspan_page_result: true, ok: true, value: await body() };
    } catch (error) {
        return { __actspan_page_result: true, ok: false, error: String((error as Error)?.message ?? error) };
    }
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Bridge 请求已取消')); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(new Error('Bridge 请求已取消')); };
    signal?.addEventListener('abort', abort, { once: true });
});

/** Called only inside an authenticated PolicyExecutor handler, with a task-resolved tab id. */
export async function handleMcpInteraction(method: string, params: Record<string, unknown>, context: TaskContext, tabId: number): Promise<unknown> {
    if (!['page.select', 'page.upload', 'page.key', 'page.wait', 'page.scroll'].includes(method)) throw new PolicyError('未知页面操作', 'E_CAPABILITY');
    assertValid(method, params);
    const mutate = method !== 'page.wait';
    const ref = params.ref ? String(params.ref) : undefined;
    // assertValid 保证 ref 必带 snapshotId；两者都没有时尾部参数必须整段省略。
    const snapshotId = ref && params.snapshotId !== undefined ? String(params.snapshotId) : undefined;
    const execute = async (actionParams: Record<string, unknown> = params, actionRef = ref): Promise<Record<string, unknown>> => {
        if (context.signal?.aborted) throw new Error('Bridge 请求已取消');
        if (mutate) tabLeaseManager.authorizeWrite(context, tabId);
        else tabLeaseManager.authorize(context, tabId, false);
        // 数组里出现 undefined 会让 executeScript 直接报 "Value is unserializable"，
        // 而无 ref 的 scroll/select/upload/key/wait 是常态：缺省时整段省略，不占位。
        const injectedArgs: [string, Record<string, unknown>, string?, string?] = actionRef === undefined || snapshotId === undefined
            ? [method, actionParams]
            : [method, actionParams, actionRef, snapshotId];
        const results = await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: interactOnPage,
            args: injectedArgs });
        if (context.signal?.aborted) throw new Error('Bridge 请求已取消');
        const raw: unknown = results?.[0]?.result;
        // InjectionResult 没有 error 字段：页面侧 throw 只会变成 result:null，真因由信封携带。
        if (raw === undefined || raw === null) throw new Error('页面操作失败: 无执行结果');
        if (isPageResultEnvelope(raw)) {
            if (raw.ok !== true) throw new Error(raw.error || '页面操作失败');
            return raw.value as Record<string, unknown>;
        }
        return raw as Record<string, unknown>;
    };
    if (method === 'page.key') {
        const keys = params.keys as string[];
        let last: Record<string, unknown> = {};
        // 每次按键都重新解析 ref 并聚焦：前一次按键可能触发重绘，焦点落到旧节点上就会打错目标。
        for (let i = 0; i < Number(params.repeat ?? 1); i++) for (const key of keys) {
            last = await execute({ keys: [key], ...(params.selector ? { selector: String(params.selector) } : {}) }, ref);
        }
        return { pressed: keys.length * Number(params.repeat ?? 1), focused: last.focused };
    }
    if (method !== 'page.wait') return execute();
    const started = Date.now(), timeout = Number(params.timeoutMs ?? 10000);
    while (Date.now() - started <= timeout) {
        const result = await execute();
        if (result.found) return { ...result, elapsedMs: Date.now() - started };
        await sleep(100, context.signal);
    }
    throw new Error(`等待 ${params.for} 超时 (${timeout}ms)；未观测到目标条件，请检查 selector/文本或页面是否仍在变化`);
}
