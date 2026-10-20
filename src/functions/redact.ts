const SENSITIVE_KEYS = /^(?:text|value|token|password|passwd|passcode|cookie|authorization|auth|secret|api[-_]?key|access[-_]?token|refresh[-_]?token)$/i;
const LOCATION_KEYS = /^(?:url|path|selector|code|expression)$/i;
const BASE64 = /^[A-Za-z0-9+/\r\n]+={0,2}$/;
const DEFAULT_EVAL_LIMIT = 400;
const QUERY_SENSITIVE = /^(?:token|access[-_]?token|refresh[-_]?token|password|passwd|passcode|secret|key|api[_-]?key|auth|authorization|cookie|code)$/i;

const summarizeBase64 = (text: string): string | null => {
    const dataUri = text.match(/^data:[^;,]+;base64,([A-Za-z0-9+/\r\n]+={0,2})$/i);
    const compact = (dataUri ? dataUri[1] : text).replace(/\s+/g, '');
    if (compact.length < 128 || !BASE64.test(compact)) return null;
    return `[base64 ${Math.floor(compact.length * 3 / 4)} bytes]`;
};

const redactUrl = (text: string): string => {
    try {
        const url = new URL(text);
        for (const key of [...url.searchParams.keys()]) if (QUERY_SENSITIVE.test(key)) url.searchParams.set(key, '[REDACTED]');
        const fragment = url.hash.replace(/^#/, '');
        if (fragment.includes('=')) {
            const hashParams = new URLSearchParams(fragment);
            let changed = false;
            for (const key of [...hashParams.keys()]) if (QUERY_SENSITIVE.test(key)) { hashParams.set(key, '[REDACTED]'); changed = true; }
            if (changed) url.hash = hashParams.toString();
        }
        return url.toString();
    } catch { return text; }
};

const redactCredentialGroups = (text: string): string => {
    const lines = text.split('\n');
    const candidates = lines.map((line) => /^[ \t]*[A-Za-z0-9][A-Za-z0-9._-]{11,}[ \t]*$/.test(line) && /[A-Za-z]/.test(line) && /\d/.test(line));
    for (let i = 0; i < lines.length;) {
        if (!candidates[i]) { i++; continue; }
        let end = i;
        while (end + 1 < lines.length && (candidates[end + 1] || lines[end + 1].trim() === '')) end++;
        const count = candidates.slice(i, end + 1).filter(Boolean).length;
        if (count >= 3) for (let j = i; j <= end; j++) if (candidates[j]) lines[j] = lines[j].replace(/\S+/g, '[REDACTED]');
        i = end + 1;
    }
    return lines.join('\n');
};

const JSON_TEXT_MAX_DEPTH = 4;
let jsonTextDepth = 0;

/** 结构化 JSON 字符串按 key 递归脱敏；普通文本解析失败即原样返回，不误伤正文。 */
const redactJsonText = (text: string): string | null => {
    if (jsonTextDepth >= JSON_TEXT_MAX_DEPTH) return null;
    const trimmed = text.trim();
    if (trimmed.length < 2 || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { return null; }
    if (parsed === null || typeof parsed !== 'object') return null;
    jsonTextDepth += 1;
    let redacted: unknown;
    try { redacted = redactSensitive(parsed); } finally { jsonTextDepth -= 1; }
    const serialized = JSON.stringify(redacted);
    return serialized === JSON.stringify(parsed) ? text : serialized;
};

const redactText = (text: string): string => {
    const base64 = summarizeBase64(text);
    if (base64) return base64;
    const json = redactJsonText(text);
    if (json !== null) return json;
    return redactCredentialGroups(text)
        .replace(/((?:(?:new|新)\s*)?(?:password|passwd|密码))(\s*[=:：]\s*)[^\s,;]+/gi, '$1$2[REDACTED]')
        .replace(/(authorization\s*:\s*bearer\s+)\S+/gi, '$1[REDACTED]')
        .replace(/(password|passwd|token|api[-_]?key|secret)(\s*[=:：]\s*)[^\s,;]+/gi, '$1$2[REDACTED]')
        .replace(/(?<!\d)(?:(?:\+?86[- ]?)?1[3-9]\d{9})(?!\d)/g, '[REDACTED PHONE]');
};

export function isCredentialUrl(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    try {
        const url = new URL(value);
        const parts = url.pathname.toLowerCase().split('/').filter(Boolean);
        return /^(?:credentials?|secrets?)\./i.test(url.hostname) || parts.some((part) => /^(?:credentials?|password|passwd|reset-password|password-reset|recovery(?:-codes?)?|secrets?|tokens?)$/.test(part));
    } catch { return false; }
}

const MASKED_PAGE_CONTENT = '[凭据页面已掩码]';
const MASKED_PAGE_WARNING = '凭据页面内容不要转述';

export function redactPageContent(content: unknown, url?: unknown): unknown {
    if (isCredentialUrl(url)) return { content: MASKED_PAGE_CONTENT, warning: MASKED_PAGE_WARNING };
    return typeof content === 'string' ? redactText(content) : redactSensitive(content);
}

/** 数据工具统一出口：凭据 URL 的页面载荷整页降级为掩码，其余沿用既有页面脱敏规则。 */
export function redactDataPayload<T>(payload: T, url?: unknown): T {
    if (isCredentialUrl(url)) return { content: MASKED_PAGE_CONTENT, warning: MASKED_PAGE_WARNING } as T;
    return redactSensitive(payload);
}

export type RedactOptions = { evalLimit?: number };

/** 按字段名递归脱敏；定位字段保留，循环引用与异常值不抛。 */
export function redactSensitive<T>(input: T, options: RedactOptions = {}): T {
    const seen = new WeakSet<object>();
    const evalLimit = Math.max(80, options.evalLimit ?? DEFAULT_EVAL_LIMIT);
    const visit = (value: unknown, key = ''): unknown => {
        const sensitive = SENSITIVE_KEYS.test(key) && !/^(?:text)$/i.test(key);
        if (typeof value === 'string') {
            if (/^(?:eval|expression)$/i.test(key) && value.length > evalLimit) return `${value.slice(0, evalLimit)}…[截断]`;
            if (/^url$/i.test(key)) return redactUrl(value);
            if (LOCATION_KEYS.test(key)) return value;
            if (sensitive) return '[REDACTED]';
            const base64 = summarizeBase64(value);
            if (base64) return base64;
            return redactText(value);
        }
        if (typeof value === 'number' || typeof value === 'boolean') return sensitive ? '[REDACTED]' : value;
        if (value === null || typeof value !== 'object') return value;
        if (sensitive) return '[REDACTED]';
        if (seen.has(value as object)) return '[循环引用]';
        seen.add(value as object);
        if (Array.isArray(value)) return value.map((entry) => visit(entry, key));
        const output: Record<string, unknown> = {};
        for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
            output[childKey] = visit(childValue, childKey);
        }
        return output;
    };
    return visit(input) as T;
}

export const redactAuditParams = redactSensitive;
export const summarizeAuditParams = redactSensitive;
