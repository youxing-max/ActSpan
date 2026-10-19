export interface RecorderStateLike {
    active: boolean;
    tabId: number;
}

export const isRecorderStateForTab = (
    state: RecorderStateLike | null | undefined,
    tabId: number | undefined,
): boolean => (
    state !== null
    && state !== undefined
    && typeof tabId === 'number'
    && state.tabId === tabId
);

export const isRecorderOwnerTab = isRecorderStateForTab;

export const shouldTransferRecorderToTab = (
    state: RecorderStateLike | null | undefined,
    sourceTabId: number | undefined,
    targetTabId: number | undefined,
): boolean => (
    state?.active === true
    && typeof sourceTabId === 'number'
    && typeof targetTabId === 'number'
    && state.tabId === sourceTabId
    && sourceTabId !== targetTabId
);
