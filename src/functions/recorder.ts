/**
 * recorder 工具：工作流录制控制（录屏式操作录制）
 *
 * 动作：
 *   start   在指定标签页开始录制用户/Agent 的操作流（点击、输入、导航等）
 *   stop    停止录制并返回全部步骤（含每步截图工件 ID）
 *   state   查询当前录制状态（active/tabId/startedAt/steps 数）
 *   cancel  放弃本次录制，清空状态
 *
 * 闭环用法（云端 Agent 录制→复用）：
 *   1. recorder(start) → 2. 用 cdp_input/tab_navigate 等执行操作（或让用户手动操作）
 *   3. recorder(stop) 拿到 steps → 4. 自行整理为工作流 JSON → 5. save_workflow 持久化
 *   6. 之后用 skill(action=run, name=<工作流名>) 复用
 *
 * 内部直接调用 workflow-recorder.ts 导出的核心函数，与扩展 UI 的录制按钮走同一套实现。
 */

import type { FunctionDefinition, FunctionResult, ToolExecutionContext } from './types';

const ok = (data: unknown): FunctionResult => ({ success: true, data });
const fail = (error: string): FunctionResult => ({ success: false, error });

/** 取目标标签页：参数 > 上下文 > 当前活动页 */
const resolveTabId = async (params: Record<string, any>, context?: ToolExecutionContext): Promise<number | undefined> => {
    if (typeof params.tab_id === 'number' && params.tab_id > 0) return params.tab_id;
    if (typeof context?.tabId === 'number' && context.tabId > 0) return context.tabId;
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        return tab?.id;
    } catch {
        return undefined;
    }
};

const resolveUrl = async (params: Record<string, any>, tabId?: number): Promise<string> => {
    if (typeof params.url === 'string' && params.url) return params.url;
    if (!tabId) return '';
    try {
        const tab = await chrome.tabs.get(tabId);
        return tab.url || '';
    } catch {
        return '';
    }
};

export const recorderFunction: FunctionDefinition = {
    name: 'recorder',
    description: [
        '工作流录制控制：把标签页上的操作流录制成步骤序列（每步自动截图），用于沉淀为可复用工作流。',
        '动作：start（开始，需 tab_id 或默认当前活动页）/ stop（停止并返回 steps）/ state（查询）/ cancel（放弃）。',
        '录制期间该标签页上的点击、输入、导航会被自动捕获；stop 返回的 steps 可整理后交给 save_workflow 保存，',
        '之后用 skill(action=run) 复用，实现"录制一次、处处复用"。',
        '⚠️ 不要用此工具来：直接执行页面操作（用 cdp_input / tab_navigate）；保存工作流（用 save_workflow）。',
    ].join(''),
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['start', 'stop', 'state', 'cancel'],
                description: '操作类型',
            },
            tab_id: {
                type: 'number',
                description: '录制的目标标签页 ID（start 可选，默认当前活动页）',
            },
            url: {
                type: 'string',
                description: '起始 URL 记录（start 可选，默认取标签页当前 URL）',
            },
        },
        required: ['action'],
    },
    supportsParallel: false,
    permissionLevel: 'interact',
    actionPermissions: {
        state: 'read',
    },
    execute: async (params: any, context?: ToolExecutionContext): Promise<FunctionResult> => {
        const action = params?.action as 'start' | 'stop' | 'state' | 'cancel' | undefined;
        // 延迟加载：避免把 workflow-recorder（及其 background 依赖）静态拽进工具总线模块图
        const { recorderStart, recorderStop, recorderGetState, recorderCancel } =
            await import('../background/workflow-recorder');

        try {
            switch (action) {
                case 'start': {
                    const state = await recorderGetState();
                    if (state?.active) {
                        return fail(`已有进行中的录制（tab ${state.tabId}），先 stop 或 cancel`);
                    }
                    const tabId = await resolveTabId(params, context);
                    if (!tabId) return fail('无法确定录制标签页：请传 tab_id');
                    const url = await resolveUrl(params, tabId);
                    const result = recorderStart(tabId, url);
                    return result.success
                        ? ok({ tab_id: tabId, url, hint: '录制已开始；操作完成后调用 recorder(action=stop) 取步骤' })
                        : fail(result.error || '开始录制失败');
                }
                case 'stop': {
                    const state = await recorderGetState();
                    if (state?.active && context?.tabId && state.tabId !== context.tabId) {
                        return fail(`录制属于标签页 ${state.tabId}，当前上下文无权停止`);
                    }
                    const result = await recorderStop();
                    if (!result.success) return fail(result.error || '停止录制失败');
                    const steps = (result as { steps?: unknown[] }).steps || [];
                    return ok({
                        step_count: steps.length,
                        steps,
                        hint: steps.length
                            ? '可把 steps 整理为工作流 JSON 后调用 save_workflow 保存，再用 skill(action=run) 复用'
                            : '本次录制没有捕获到步骤',
                    });
                }
                case 'state': {
                    const state = await recorderGetState();
                    if (!state) return ok({ active: false });
                    return ok({
                        active: state.active,
                        tab_id: state.tabId,
                        started_at: state.startedAt,
                        start_url: state.startUrl,
                        step_count: state.steps.length,
                    });
                }
                case 'cancel': {
                    const result = recorderCancel();
                    return result.success ? ok({ cancelled: true }) : fail('取消录制失败');
                }
                default:
                    return fail(`未知 action: ${String(action)}`);
            }
        } catch (err: any) {
            return fail(err?.message || 'recorder 执行失败');
        }
    },
};
