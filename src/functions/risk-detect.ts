export const CHALLENGE_MESSAGE = '检测到站点验证，需要用户完成';

const CHALLENGE_HOSTS = [
    /(?:^|\.)challenges\.cloudflare\.com$/i,
    /(?:^|\.)cloudflare\.com$/i,
    /(?:^|\.)hcaptcha\.com$/i,
    /(?:^|\.)recaptcha\.net$/i,
    /(?:^|\.)google\.com$/i,
];

export function hostOf(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) return '';
    try { return new URL(value).hostname.toLowerCase(); } catch { return ''; }
}

function challengeFrame(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    let parsed: URL;
    try { parsed = new URL(value); } catch { return false; }
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    return CHALLENGE_HOSTS.some((pattern) => pattern.test(host)) &&
        (host.includes('hcaptcha') || host.includes('recaptcha') || host.includes('cloudflare') || /recaptcha|challenge|turnstile/.test(pathname));
}

const overlaySentence = (value: unknown): boolean => {
    if (typeof value !== 'string') return false;
    const text = value.trim();
    if (!text || text.length < 4) return false;
    return /(?:请|需要|完成|通过|进行).{0,32}(?:验证|验证码|人机|安全检查)|(?:验证|验证码|人机|安全检查).{0,32}(?:继续|访问|完成|通过)|\b(?:verify|verification|security check|captcha|human)\b.{0,48}\b(?:continue|access|complete|proceed)\b|\b(?:continue|access)\b.{0,48}\b(?:verify|verification|security check|captcha|human)\b/i.test(text);
};

export type ChallengeEvidence = { frames?: unknown; overlays?: unknown };
export type ChallengeResult = { detected: boolean; source?: 'frame' | 'overlay'; message?: string; host?: string };

/** 识别挑战页但不读取或绕过 challenge 内容；结构证据优先于文案。 */
export function detectChallenge(evidence: ChallengeEvidence | null | undefined): ChallengeResult {
    const frames = Array.isArray(evidence?.frames) ? evidence.frames : [];
    for (const frame of frames) {
        const src = typeof frame === 'string' ? frame : (frame && typeof frame === 'object' ? (frame as { src?: unknown }).src : undefined);
        if (challengeFrame(src)) return { detected: true, source: 'frame', host: hostOf(src), message: CHALLENGE_MESSAGE };
    }
    const overlays = Array.isArray(evidence?.overlays) ? evidence.overlays : [];
    for (const overlay of overlays) {
        const text = typeof overlay === 'string' ? overlay : (overlay && typeof overlay === 'object' ? (overlay as { text?: unknown }).text : undefined);
        if (overlaySentence(text)) return { detected: true, source: 'overlay', message: CHALLENGE_MESSAGE };
    }
    return { detected: false };
}

export const identifyChallenge = detectChallenge;

export function normalizeNavigationUrl(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) return '';
    try { const url = new URL(value); url.search = ''; url.hash = ''; return url.toString(); } catch { return ''; }
}

export function detectReadDrift(baselineUrl: unknown, currentUrl: unknown, selfNavigated = false): boolean {
    if (selfNavigated) return false;
    const baseline = normalizeNavigationUrl(baselineUrl);
    const current = normalizeNavigationUrl(currentUrl);
    return Boolean(baseline && current && baseline !== current);
}

export function createReadDriftTracker() {
    const baselines = new Map<string, string>();
    const warned = new Set<string>();
    return {
        hasBaseline(sessionId: string) { return Boolean(sessionId && baselines.has(sessionId)); },
        setBaseline(sessionId: string, url: unknown) { const normalized = normalizeNavigationUrl(url); if (sessionId && normalized) baselines.set(sessionId, normalized); },
        check(sessionId: string, currentUrl: unknown, selfNavigated = false): boolean {
            const baseline = baselines.get(sessionId);
            if (!sessionId || warned.has(sessionId) || !detectReadDrift(baseline, currentUrl, selfNavigated)) return false;
            warned.add(sessionId);
            return true;
        },
        clear(sessionId: string) { baselines.delete(sessionId); warned.delete(sessionId); },
    };
}
