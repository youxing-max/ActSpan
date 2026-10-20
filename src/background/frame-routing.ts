/**
 * G5：跨源 iframe 的 frame 枚举与 ref 路由。
 *
 * 契约：agent 面对的协议不变（content script 不知道框架存在）。
 * - 子框架元素的 ref 写成 `<baseRef>@f<chromeFrameId>`；主框架不带后缀。
 * - 每个框架用自己的 snapshotId（`<tabSnapshotId>@f<frameId>`），由 tab 级 id 无状态推导，
 *   因此不需要路由表，service worker 被挂起后依然能还原。
 * - 解析失败（带 '@' 但不是 `@f<数字>`）一律拒绝，绝不回退到父框架执行。
 */

export interface TabFrame {
    frameId: number;
    parentFrameId: number;
    url: string;
}

export interface QualifiedRef {
    baseRef: string;
    frameId: number;
}

// 基 ref 自身不含 '@'，因此 `a@f2@f3` 这类嵌套后缀一律判为非法，不会被解析成跨框架跳转。
const FRAME_SUFFIX = /^([^@]+)@f(\d+)$/;

/** 主框架 frameId，Chrome 固定为 0。 */
export const MAIN_FRAME_ID = 0;

/**
 * 解析带框架归属的 ref。
 * 返回 null 表示 ref 形如 `x@y` 但后缀不是合法 `@f<数字>`——伪造或损坏，调用方必须报错。
 */
export const parseQualifiedRef = (ref: unknown): QualifiedRef | null => {
    const raw = String(ref ?? '').trim();
    if (!raw) return null;
    if (!raw.includes('@')) return { baseRef: raw, frameId: MAIN_FRAME_ID };
    const match = FRAME_SUFFIX.exec(raw);
    if (!match) return null;
    const frameId = Number(match[2]);
    if (!Number.isSafeInteger(frameId) || frameId < 0) return null;
    return { baseRef: match[1], frameId };
};

/** 该框架自己的 snapshotId：主框架沿用 tab 级 id，子框架加 `@f<frameId>`。 */
export const frameSnapshotId = (tabSnapshotId: string, frameId: number): string =>
    frameId === MAIN_FRAME_ID ? tabSnapshotId : `${tabSnapshotId}@f${frameId}`;

/** 把框架内的 ref 提升为 agent 可见的全局 ref。 */
export const qualifyRef = (baseRef: string, frameId: number): string =>
    frameId === MAIN_FRAME_ID ? baseRef : `${baseRef}@f${frameId}`;

export interface FrameRefRoute {
    baseRef: string;
    frameId: number;
    /** 目标框架自己的 snapshotId，可直接交给该框架的 content script 校验 */
    snapshotId: string;
}

/**
 * 把 agent 回传的 ref 路由到确切框架。
 * - 主框架：只剥掉可能被重复带上的 `@f0` 后缀。
 * - 子框架：基 ref + 该框架自己的 snapshotId。
 * - 后缀非法（`@` 存在但不是 `@f<数字>`）：返回 null，绝不回退到父框架执行。
 */
export const routeFrameRef = (ref: unknown, snapshotId: unknown): FrameRefRoute | null => {
    const parsed = parseQualifiedRef(ref);
    if (!parsed) return null;
    const tabSnapshotId = String(snapshotId ?? '').trim().replace(/@f\d+$/, '');
    return { baseRef: parsed.baseRef, frameId: parsed.frameId, snapshotId: frameSnapshotId(tabSnapshotId, parsed.frameId) };
};

/**
 * 按主框架优先、同级 frameId 升序的确定性顺序枚举 tab 内所有框架。
 * 无法枚举时退化为只有主框架，调用方仍能对主框架工作。
 */
export const listTabFrames = async (tabId: number): Promise<TabFrame[]> => {
  let frames: chrome.webNavigation.GetAllFrameResultDetails[] | null | undefined;
    try {
        frames = await chrome.webNavigation.getAllFrames({ tabId });
    } catch {
        frames = undefined;
    }
    const known = (frames || [])
        .filter((frame): frame is chrome.webNavigation.GetAllFrameResultDetails => typeof frame?.frameId === 'number')
        .map((frame) => ({ frameId: frame.frameId, parentFrameId: frame.parentFrameId, url: frame.url || '' }));
    if (!known.some((frame) => frame.frameId === MAIN_FRAME_ID)) {
        known.unshift({ frameId: MAIN_FRAME_ID, parentFrameId: -1, url: '' });
    }
    const children = new Map<number, TabFrame[]>();
    for (const frame of known) {
        if (frame.frameId === MAIN_FRAME_ID) continue;
        const siblings = children.get(frame.parentFrameId) || [];
        siblings.push(frame);
        children.set(frame.parentFrameId, siblings);
    }
    const ordered: TabFrame[] = [];
    const queue: number[] = [MAIN_FRAME_ID];
    const seen = new Set<number>();
    while (queue.length > 0) {
        const parent = queue.shift()!;
        if (seen.has(parent)) continue;
        seen.add(parent);
        const self = known.find((frame) => frame.frameId === parent);
        if (self) ordered.push(self);
        const siblings = (children.get(parent) || []).slice().sort((left, right) => left.frameId - right.frameId);
        for (const child of siblings) {
            queue.push(child.frameId);
        }
    }
    return ordered;
};
