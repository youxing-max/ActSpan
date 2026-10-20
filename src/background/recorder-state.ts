export interface RecorderStateLike {
    active: boolean;
    tabId: number;
}

export const isRecorderStateForTab = (
    state: unknown,
    tabId: number | undefined,
): boolean => {
    if (state === null || typeof state !== 'object' || typeof tabId !== 'number') return false;
    const candidate = state as { tabId?: unknown };
    return candidate.tabId === tabId;
};

export const isRecorderOwnerTab = isRecorderStateForTab;

export const shouldTransferRecorderToTab = (
    state: unknown,
    sourceTabId: number | undefined,
    targetTabId: number | undefined,
): boolean => {
    if (!isRecorderStateForTab(state, sourceTabId) || typeof targetTabId !== 'number') return false;
    const candidate = state as { active?: unknown };
    return candidate.active === true && sourceTabId !== targetTabId;
};
