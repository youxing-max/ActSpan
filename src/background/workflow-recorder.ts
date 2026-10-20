/**
 * 工作流录制模块
 * 从 background.ts 提取，负责工作流录制的状态管理、导航监听和 AI 审计提交
 */

import Channel from '../lib/channel';
import { chatComplete } from '../ai/llm-client';
import { buildSessionSyncPayload, createSession, createSessionPushEvent, flushFeishuCompletionNotifications, persistRuntimeSessions } from './session-manager';
import { readMigratedStorage } from '../lib/legacy-storage';
import { ArtifactStore } from '../lib/artifact-store';
import { isPlainObject } from '../lib/guards';
import { isRecorderOwnerTab, isRecorderStateForTab, shouldTransferRecorderToTab } from './recorder-state';
import { saveAuditedWorkflow } from './workflow-recorder-save';
import { buildRecorderAuditPrompt } from './workflow-recorder-prompt';
import type { InputItem } from '../ai/types';

const RECORDER_STATE_KEY = 'actspan_recorder_state';
const LEGACY_RECORDER_STATE_KEY = 'mole_recorder_state';

// ============ 类型定义 ============


/** 录制步骤 */
export interface RecorderStep {
    seq: number;
    action: 'click' | 'type' | 'select' | 'submit' | 'navigate';
    selector: string;
    selectorCandidates: string[];
    semanticHint: string;
    tag: string;
    value?: string;
    url: string;
    timestamp: number;
    /** 该步骤对应的截图 artifact ID */
    screenshotArtifactId?: string;
}

/** 录制状态 */
export interface RecorderState {
    active: boolean;
    tabId: number;
    startedAt: number;
    steps: RecorderStep[];
    startUrl: string;
}

// ============ 模块内部状态 ============

/** 当前录制状态（内存中） */
let recorderState: RecorderState | null = null;

/** 导航监听器引用，用于注销 */
let recorderNavListener: ((details: chrome.webNavigation.WebNavigationFramedCallbackDetails) => void) | null = null;
let recorderTargetListener: ((details: chrome.webNavigation.WebNavigationSourceCallbackDetails) => void) | null = null;

// ============ Session Storage 辅助函数 ============

/** 持久化录制状态到 session storage */
const saveRecorderState = async (): Promise<void> => {
    if (!recorderState) {
        await chrome.storage.session.remove(RECORDER_STATE_KEY);
        return;
    }
    await chrome.storage.session.set({ [RECORDER_STATE_KEY]: recorderState });
};

/** 从 session storage 加载录制状态 */
const loadRecorderState = async (): Promise<RecorderState | null> => {
    const state = await readMigratedStorage<RecorderState>(
        chrome.storage.session,
        RECORDER_STATE_KEY,
        LEGACY_RECORDER_STATE_KEY,
    );
    return state || null;
};

// ============ 导航监听 ============

/** 注册录制期间的导航监听器 */
const registerRecorderNavListener = (): void => {
    if (recorderNavListener || recorderTargetListener) return; // 防止重复注册

    recorderTargetListener = (details: chrome.webNavigation.WebNavigationSourceCallbackDetails) => {
        if (!shouldTransferRecorderToTab(recorderState, details.sourceTabId, details.tabId)) return;
        if (details.sourceFrameId !== 0) return;

        const previousTabId = recorderState!.tabId;
        recorderState!.tabId = details.tabId;
        void saveRecorderState();

        // 原页面不再拥有录制权，只清理本地捕获和 UI；录制步骤继续保留。
        Channel.sendToTab(previousTabId, '__recorder_transfer', { tabId: details.tabId });
    };

    recorderNavListener = (details: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
        // 只监听录制中的 tab 的主 frame
        if (!recorderState?.active) return;
        if (details.tabId !== recorderState.tabId) return;
        if (details.frameId !== 0) return;

        // 追加 navigate 步骤
        const step: RecorderStep = {
            seq: recorderState.steps.length + 1,
            action: 'navigate',
            selector: '',
            selectorCandidates: [],
            semanticHint: '',
            tag: '',
            url: details.url,
            timestamp: Date.now(),
        };
        recorderState.steps.push(step);
        void saveRecorderState();

        // 通知 content 脚本导航已完成
        Channel.sendToTab(recorderState.tabId, '__recorder_navigate', { url: details.url });
    };

    chrome.webNavigation.onCreatedNavigationTarget.addListener(recorderTargetListener);
    chrome.webNavigation.onCompleted.addListener(recorderNavListener);
};

/** 注销录制导航监听器 */
const unregisterRecorderNavListener = (): void => {
    if (recorderNavListener) {
        chrome.webNavigation.onCompleted.removeListener(recorderNavListener);
        recorderNavListener = null;
    }
    if (recorderTargetListener) {
        chrome.webNavigation.onCreatedNavigationTarget.removeListener(recorderTargetListener);
        recorderTargetListener = null;
    }
};


// ============ Channel 消息处理器 ============

/** 截图串行队列，防止并发截图冲突 */
let screenshotQueue: Promise<void> = Promise.resolve();

/** 对指定步骤执行截图并关联 artifact */
const captureStepScreenshot = async (step: RecorderStep, tabId: number): Promise<void> => {
    try {
        // 等待 DOM 稳定
        await new Promise(r => setTimeout(r, 500));

        // 隐藏悬浮球和录制 overlay
        await new Promise<void>((resolve) => {
            Channel.sendToTab(tabId, '__screenshot_hide', {}, () => resolve());
            setTimeout(resolve, 150); // 超时兜底
        });

        // 截图
        // captureVisibleTab 只能截取窗口当前可见页，因此必须以录制 Tab 的窗口为目标，
        // 不能再查询用户当前活动的其他 Tab。
        const recorderTab = await chrome.tabs.get(tabId);
        const windowId = recorderTab.windowId;
        if (windowId !== undefined && recorderTab.active) {
            const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
                format: 'jpeg',
                quality: 70,
            });
            const base64 = dataUrl.split(',')[1] || '';
            const sizeKB = Math.round((base64.length * 3) / 4 / 1024);
            const artifact = await ArtifactStore.saveScreenshot(dataUrl, 'jpeg', sizeKB);

            // 关联截图到步骤
            step.screenshotArtifactId = artifact.id;
            void saveRecorderState();
        }

        // 恢复悬浮球和录制 overlay
        Channel.sendToTab(tabId, '__screenshot_show', {});
    } catch (err) {
        console.warn('[Actspan] 录制步骤截图失败:', err);
        // 确保恢复显示
        try { Channel.sendToTab(tabId, '__screenshot_show', {}); } catch { /* 忽略 */ }
    }
};
const isRecorderOwner = (sender?: chrome.runtime.MessageSender): boolean => (
    isRecorderOwnerTab(recorderState, sender?.tab?.id)
);

/** 开始录制 */
Channel.on('__recorder_start', (data, sender, sendResponse) => {
    const tabId = sender?.tab?.id || (data?.tabId as number);
    const url = String(data?.url || '');

    if (!tabId) {
        sendResponse?.({ success: false, error: '缺少 tabId' });
        return true;
    }

    recorderState = {
        active: true,
        tabId,
        startedAt: Date.now(),
        steps: [],
        startUrl: url,
    };

    void saveRecorderState();
    registerRecorderNavListener();

    console.log(`[Actspan] 工作流录制已开始, tab: ${tabId}, url: ${url}`);
    sendResponse?.({ success: true });
    return true;
});

/** 停止录制 */
Channel.on('__recorder_stop', (_data, sender, sendResponse) => {
    if (!recorderState) {
        sendResponse?.({ success: false, error: '当前没有进行中的录制' });
        return true;
    }
    if (!isRecorderOwner(sender)) {
        sendResponse?.({ success: false, error: '当前 Tab 没有录制权限' });
        return true;
    }

    recorderState.active = false;
    void saveRecorderState();
    unregisterRecorderNavListener();

    console.log(`[Actspan] 工作流录制已停止, 共 ${recorderState.steps.length} 步`);
    sendResponse?.({ success: true, steps: recorderState.steps });
    return true;
});

/** 接收录制步骤 + 异步截图 */
Channel.on('__recorder_step', (data, sender) => {
    if (!recorderState?.active || !isRecorderOwner(sender) || !data) return;

    const step: RecorderStep = {
        seq: data.seq ?? (recorderState.steps.length + 1),
        action: data.action,
        selector: data.selector || '',
        selectorCandidates: data.selectorCandidates || [],
        semanticHint: data.semanticHint || '',
        tag: data.tag || '',
        value: data.value,
        url: data.url || '',
        timestamp: data.timestamp || Date.now(),
    };

    recorderState.steps.push(step);
    void saveRecorderState();


    // 串行队列截图（不阻塞消息处理）
    const tabId = recorderState.tabId;
    screenshotQueue = screenshotQueue.then(() => captureStepScreenshot(step, tabId));
});

/** 查询当前录制状态 */
Channel.on('__recorder_state', async (_data, sender, sendResponse) => {
    // Service Worker 可能刚被唤醒，先从 session storage 恢复再响应 content。
    if (!recorderState) {
        recorderState = await loadRecorderState();
        if (recorderState?.active) registerRecorderNavListener();
    }
    const tabId = sender?.tab?.id;
    sendResponse?.(isRecorderStateForTab(recorderState, tabId) ? recorderState : null);
    return true;
});

/** 取消审计：清理录制状态，释放 AI 处理 */
let auditCancelled = false;
Channel.on('__recorder_cancel_audit', (_data, sender, sendResponse) => {
    if (recorderState && !isRecorderOwner(sender)) {
        sendResponse?.({ success: false, error: '当前 Tab 没有录制权限' });
        return true;
    }
    auditCancelled = true;
    recorderState = null;
    void saveRecorderState();
    unregisterRecorderNavListener();
    console.log('[Actspan] 工作流录制审计已取消');
    sendResponse?.({ success: true });
    return true;
});

/** 提交录制结果给 AI 审计，审计后自动保存并通过对话展示结果 */
Channel.on('__recorder_submit', (_data, sender, sendResponse) => {
    if (!recorderState || recorderState.steps.length === 0) {
        sendResponse?.({ success: false, error: '没有可提交的录制步骤' });
        return true;
    }
    if (!isRecorderOwner(sender)) {
        sendResponse?.({ success: false, error: '当前 Tab 没有录制权限' });
        return true;
    }

    const steps = [...recorderState.steps];
    const startUrl = recorderState.startUrl;
    const tabId = recorderState.tabId;
    // 重置取消标志
    auditCancelled = false;

    // 异步执行 AI 审计
    void (async () => {
        try {
            // 构建 AI 审计 prompt
            // 审计时只传必要字段，去掉 screenshotArtifactId 等内部字段
            const cleanSteps = steps.map(({ seq, action, selector, semanticHint, tag, value, url }) => ({
                seq, action, selector, semanticHint, tag, ...(value !== undefined ? { value } : {}), url,
            }));

            const prompt = buildRecorderAuditPrompt(cleanSteps, startUrl);

            // 调用 AI 进行审计
            const input: InputItem[] = [
                { role: 'user', content: prompt },
            ];

            const result = await chatComplete(input);

            // 检查是否已取消
            if (auditCancelled) {
                console.log('[Actspan] 工作流审计已被用户取消，丢弃结果');
                sendResponse?.({ success: false, error: '用户已取消' });
                return;
            }

            // 从 AI 返回中提取 JSON
            let workflowJson: Record<string, unknown> | null = null;
            for (const item of result.output) {
                if (item.type === 'message' && Array.isArray(item.content)) {
                    for (const part of item.content) {
                        if (part.type === 'output_text' && part.text) {
                            // 尝试提取 JSON（可能被 markdown 代码块包裹）
                            const jsonMatch = part.text.match(/```(?:json)?\s*([\s\S]*?)```/) ||
                                              part.text.match(/(\{[\s\S]*\})/);
                            if (jsonMatch?.[1]) {
                                try {
                                    workflowJson = JSON.parse(jsonMatch[1].trim());
                                } catch {
                                    // JSON 解析失败，继续尝试
                                }
                            }
                        }
                    }
                }
            }

            if (!workflowJson) {
                sendResponse?.({ success: false, error: 'AI 返回的结果无法解析为有效 JSON' });
                Channel.broadcast('__recorder_audit_done', { error: 'AI 审计结果解析失败' });
                return;
            }

            const metadataPlaceholder = '无法从录制内容推断';
            const isValidWorkflowName = (value: unknown): value is string =>
                typeof value === 'string'
                && /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(value)
                && !/^(?:workflow|workflow_name|unnamed|untitled|name)$/i.test(value);
            const isValidChineseMetadata = (value: unknown): value is string =>
                typeof value === 'string'
                && value.trim().length > 0
                && /[\u3400-\u9fff]/.test(value)
                && !/(?:未命名|未填写|待补充|待 AI 根据步骤补全)/.test(value);
            const isValidTriggers = (value: unknown): value is string[] =>
                Array.isArray(value)
                && value.length >= 2
                && value.length <= 5
                && value.every((trigger: unknown) =>
                    typeof trigger === 'string'
                    && trigger.trim().length > 0
                    && /[\u3400-\u9fff]/.test(trigger));
            const saveResult = await saveAuditedWorkflow(workflowJson);
            const saveError = saveResult.success
                ? null
                : `工作流自动保存失败：${saveResult.error || '未知错误'}`;
            const metadataValid = {
                name: isValidWorkflowName(workflowJson.name),
                label: isValidChineseMetadata(workflowJson.label),
                description: isValidChineseMetadata(workflowJson.description),
                triggers: isValidTriggers(workflowJson.triggers),
            };
            const missingMetadata = (['name', 'label', 'description', 'triggers'] as const)
                .filter(field => !metadataValid[field]);
            const readableSteps = workflowJson.readable_steps || '（步骤解析中…）';
            const savedWorkflowName = typeof saveResult.data?.name === 'string'
                ? saveResult.data.name
                : workflowJson.name;
            // F4：剧本体检的逐条点名要当面转述，不能只留在工具返回值里。
            const saveWarnings = Array.isArray(saveResult.data?.warnings)
                ? saveResult.data.warnings.filter((warning: unknown): warning is string => typeof warning === 'string')
                : [];
            const sessionQuery = saveError ? '处理录制工作流保存失败' : '录制并保存的工作流';
            const session = createSession(sessionQuery, tabId);

            // 注入 system context：原始 workflow JSON 供 AI 后续修改或再次保存
            session.context.push({
                role: 'system',
                content: [
                    saveError
                        ? `以下是用户刚刚录制并经过审计的工作流 JSON。后台已尝试自动保存，但失败：${saveError}`
                        : `以下是用户刚刚录制并经过审计、已自动保存的工作流 JSON（注册表名称：${savedWorkflowName}）。`,
                    '若任一元数据缺失、空白或不符合规则，先根据录制步骤、起始 URL、页面语义和参数自动补全或修正；不能把“待 AI 根据步骤补全”等提示当作保存值。',
                    saveError
                        ? '请向用户说明保存失败原因；用户修正后若明确要求保存，直接调用 save_workflow。'
                        : '用户若提出修改，必须基于最新 JSON 更新并展示完整修订摘要；用户明确要求保存时直接调用 save_workflow，无需再次确认。',
                    '```json',
                    JSON.stringify(workflowJson, null, 2),
                    '```',
                ].join('\n'),
            });

            // 注入模拟用户请求 + AI 回复展示审计结果
            session.context.push({
                role: 'user',
                content: '我刚录制了一个操作流程，帮我整理一下。',
            } as InputItem);

            const parameters: Record<string, unknown> = isPlainObject(workflowJson.parameters) ? workflowJson.parameters : {};
            const parameterProperties: Record<string, unknown> = isPlainObject(parameters.properties) ? parameters.properties : {};
            const paramEntries = Object.entries(parameterProperties);
            const paramLine = paramEntries.length > 0
                ? `**参数**：${paramEntries.map(([k, v]) => {
                    const description = isPlainObject(v) ? v.description : undefined;
                    return `\`${k}\` — ${typeof description === 'string' && description ? description : k}`;
                }).join('、')}`
                : '**参数**：无';
            const triggerLine = isValidTriggers(workflowJson.triggers)
                ? workflowJson.triggers.map(trigger => `\`${trigger}\``).join('、')
                : metadataPlaceholder;

            const aiSummary = [
                saveError
                    ? '我已整理刚才录制的流程，但自动保存失败，请检查下面的结果。'
                    : '我已整理并自动保存刚才录制的流程。',
                saveError ? `**保存状态**：${saveError}` : `**保存状态**：已保存为 \`${savedWorkflowName}\``,
                `**名称**：机器名 \`${metadataValid.name ? workflowJson.name : metadataPlaceholder}\`；显示名 **${metadataValid.label ? workflowJson.label : metadataPlaceholder}**`,
                `**描述**：${metadataValid.description ? workflowJson.description : metadataPlaceholder}`,
                `**调用关键词**：${triggerLine}`,
                paramLine,
                '**步骤**：',
                readableSteps,
                '',
                ...(missingMetadata.length ? [`**待补充**：${missingMetadata.join('、')}。先根据录制步骤自动补全；只有确实无法推断时才请用户提供。`] : []),
                ...(saveWarnings.length ? [`**体检提示**：${saveWarnings.join('；')}。剧本已按现状保存，不阻塞使用。`] : []),
                saveError
                    ? '请修正缺失内容；你明确说保存工作流后，我会直接保存完整 JSON。'
                    : '你可以继续修改名称、描述、调用关键词、参数或步骤；明确说保存工作流后会直接保存完整修订 JSON。',
            ].join('\n');

            session.context.push({
                role: 'assistant',
                content: aiSummary,
            } as InputItem);

            // 清理录制状态
            recorderState = null;
            void saveRecorderState();

            // 通知悬浮球审计和自动保存完成
            Channel.broadcast('__recorder_audit_done', {
                sessionId: session.id,
                summary: aiSummary,
                ...(saveError ? { error: saveError } : {}),
            });

            // 广播会话同步 + AI 文本展示
            Channel.broadcast('__session_sync', buildSessionSyncPayload(session));
            const pushEvent = createSessionPushEvent(session);
            pushEvent({ type: 'text', content: aiSummary });

            // 标记会话为等待用户输入（done 状态，可继续对话）
            session.status = 'done';
            session.endedAt = Date.now();
            session.durationMs = Math.max(0, session.endedAt - session.startedAt);
            session.agentState = {
                phase: 'finalize',
                round: 0,
                reason: saveError ? '自动保存失败，等待用户修正' : '工作流已自动保存',
                updatedAt: Date.now(),
            };
            Channel.broadcast('__session_sync', buildSessionSyncPayload(session));
            pushEvent({
                type: 'turn_completed',
                content: JSON.stringify({
                    sessionId: session.id,
                    status: 'done',
                    endedAt: session.endedAt,
                    durationMs: session.durationMs,
                    taskKind: 'regular',
                    lastAgentMessage: aiSummary,
                }),
            });
            await flushFeishuCompletionNotifications(session);
            persistRuntimeSessions();

            sendResponse?.({ success: !saveError, ...(saveError ? { error: saveError } : {}) });
        } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : '提交处理失败';
            console.error('[Actspan] 工作流录制提交失败:', err);
            sendResponse?.({ success: false, error: errMsg });
            Channel.broadcast('__recorder_audit_done', { error: errMsg });
        }
    })();

    return true;
});

// ============ 录制状态恢复（Service Worker 重启后） ============

void loadRecorderState().then((state) => {
    if (state?.active) {
        recorderState = state;
        registerRecorderNavListener();
        console.log(`[Actspan] 录制状态已恢复, tab: ${state.tabId}, 已有 ${state.steps.length} 步`);
    }
});
