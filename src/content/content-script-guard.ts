/** 防止同一标签页因静态注入与动态兜底重复执行内容脚本。 */
export interface ContentScriptScope {
    __actspanContentScriptClaimed?: boolean;
}

export const claimContentScript = (scope: ContentScriptScope): boolean => {
    if (scope.__actspanContentScriptClaimed) return false;
    scope.__actspanContentScriptClaimed = true;
    return true;
};
