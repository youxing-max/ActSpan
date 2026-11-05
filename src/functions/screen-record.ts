/**
 * screen_record 工具：标签页视频录屏（tabCapture + offscreen MediaRecorder）
 *
 * 动作：
 *   start   对指定标签页开始录制（默认当前活动页），返回录制句柄
 *   stop    停止录制，产出 webm：默认保存到浏览器下载目录，或按需 base64 内联回传
 *   state   查询当前录制状态
 *   cancel  放弃录制（不产出文件）
 *
 * 链路（云端 MCP 全可达）：
 *   IDE agent → 云端 /mcp → ws → 扩展 screen_record(start)
 *   → SW 取 tabCapture streamId → offscreen 文档 getUserMedia + MediaRecorder
 *   → screen_record(stop) → webm → 存 Downloads（save_mode=download）或回传云端（save_mode=inline）
 *
 * 说明：
 *   - 录的是「单个标签页」画面（tabCapture），不是整块屏幕
 *   - 默认 1280x720@15fps 以控制体积；可传 max_duration_seconds 限时（默认 60）
 *   - 部分 Chrome 版本首次调用可能要求一次用户手势（扩展悬浮球）授权
 */

import type { FunctionDefinition, FunctionResult, ToolExecutionContext } from './types';
import { CDPSessionManager } from '../lib/cdp-session';
import { acquireServiceWorkerKeepAlive } from '../background/service-worker-keepalive';

const RECORDING_SESSION_KEY = 'actspan_screen_record_state';

interface RecordState {
    active: boolean;
    ready?: boolean;
    tabId?: number;
    startedAt?: number;
    /** tabcapture=人手已授权(activeTab)走 tabCapture；screencast=无人值守走 debugger 截帧 */
    mode?: 'tabcapture' | 'screencast';
}

const readState = async (): Promise<RecordState> => {
    try {
        const raw = await chrome.storage.session.get(RECORDING_SESSION_KEY);
        const value = raw?.[RECORDING_SESSION_KEY];
        if (!value || typeof value !== 'object') return { active: false };
        return value as RecordState;
    } catch {
        return { active: false };
    }
};

const writeState = async (state: RecordState): Promise<void> => {
    await chrome.storage.session.set({ [RECORDING_SESSION_KEY]: state });
};

const ensureOffscreen = async (): Promise<void> => {
    if (!chrome.offscreen?.hasDocument || !chrome.offscreen?.createDocument) {
        throw new Error('当前浏览器不支持 offscreen 文档，无法录屏');
    }

    const createAndAwaitReady = async (): Promise<void> => {
        await chrome.offscreen.createDocument({
            url: 'mcp.html',
            reasons: ['WORKERS', 'USER_MEDIA'],
            justification: 'Tab screen recording (MediaRecorder) plus local MCP WebSocket transport.',
        });
        // 刚创建的文档需要时间加载 mcp.js（含 screen-capture 模块）
        for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 250));
            try {
                await sendToOffscreen({ type: 'screen_record_ping' }, 1000);
                return; // 有人响应了
            } catch { /* 还没 ready，继续等 */ }
        }
        console.warn('[screen-record] offscreen 文档 5 秒内未就绪');
    };

    if (!(await chrome.offscreen.hasDocument())) {
        await createAndAwaitReady();
        return;
    }

    // 文档已存在——检查它是否包含 screen-capture 模块（旧版文档没有）
    try {
        await sendToOffscreen({ type: 'screen_record_ping' }, 2000);
        return; // 新版文档，正常
    } catch {
        // 旧版文档不响应 ping——关闭重建
        console.warn('[screen-record] 检测到旧版 offscreen 文档（无 screen-capture），重建中...');
        try { await chrome.offscreen.closeDocument(); } catch { /* 忽略 */ }
        await createAndAwaitReady();
    }
};

const sendToOffscreen = (message: unknown, timeoutMs = 30_000): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                reject(new Error(`offscreen 响应超时（${timeoutMs}ms）——offscreen 文档可能未加载 screen-capture 模块，尝试重新加载扩展后重试`));
            }
        }, timeoutMs);
        chrome.runtime.sendMessage(message, (response: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            resolve((response as Record<string, unknown>) || {});
        });
    });

const getStreamId = (tabId: number): Promise<string> =>
    new Promise((resolve, reject) => {
        chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId: string) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            if (!streamId) {
                reject(new Error('获取录屏流 ID 失败'));
                return;
            }
            resolve(streamId);
        });
    });

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

// ============ 无人值守回退：chrome.debugger Page.startScreencast ============
// tabCapture 需要 activeTab 用户手势；云端 agent 无人值守时拿不到，
// 故回退到 debugger 截帧（无需手势、可录任意标签页），帧流交 offscreen 编成 webm。

let screencastTabId: number | null = null;
let autoStopTimer: ReturnType<typeof setTimeout> | null = null;
let releaseKeepAlive: (() => void) | null = null;
let operation: Promise<unknown> = Promise.resolve();
const serialize = <T>(run: () => Promise<T>): Promise<T> => {
    const next = operation.then(run, run);
    operation = next.catch(() => undefined);
    return next;
};

const releaseRecording = (): void => {
    if (autoStopTimer !== null) clearTimeout(autoStopTimer);
    autoStopTimer = null;
    releaseKeepAlive?.();
    releaseKeepAlive = null;
};

const onScreencastFrame = (source: chrome.debugger.Debuggee, method: string, params: any): void => {
    if (method !== 'Page.screencastFrame') return;
    if (source.tabId !== screencastTabId || (source as chrome.debugger.Debuggee & { sessionId?: string }).sessionId) return;
    // 编码完成后再 ack，限制在途帧；隐藏 offscreen 不依赖 requestAnimationFrame。
    void sendToOffscreen({ type: 'screen_record_frame', data: params?.data }).finally(() => {
        if (source.tabId === screencastTabId) {
            void chrome.debugger.sendCommand(source, 'Page.screencastFrameAck', { sessionId: params?.sessionId }).catch(() => undefined);
        }
    }).catch(() => undefined);
};

const startScreencast = async (tabId: number): Promise<void> => {
    // Page.startScreencast 只对有合成输出的可见标签页产帧：录制前把目标页切到前台
    try {
        await chrome.tabs.update(tabId, { active: true });
        const tab = await chrome.tabs.get(tabId);
        if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
    } catch { /* 聚焦失败不阻断录制尝试 */ }
    // 先用可安全重连的只读请求确认连接，处理 detach 事件尚未更新缓存的情况。
    const connected = await CDPSessionManager.sendCommand(tabId, 'Page.getFrameTree');
    if (!connected.success) throw new Error(connected.error || '无法附加录屏调试器');
    screencastTabId = tabId;
    chrome.debugger.onEvent.addListener(onScreencastFrame);
    const started = await CDPSessionManager.sendCommand(tabId, 'Page.startScreencast', {
        format: 'jpeg',
        quality: 60,
        maxWidth: 1280,
        maxHeight: 720,
        everyNthFrame: 4, // 每 4 个合成帧取 1 帧（约 15fps，防止帧爆炸导致编码慢/内存高）
    });
    if (!started.success) throw new Error(started.error || '开始截帧失败');
};

const stopScreencast = async (): Promise<void> => {
    const tabId = screencastTabId;
    screencastTabId = null;
    chrome.debugger.onEvent.removeListener(onScreencastFrame);
    if (tabId === null) return;
    await CDPSessionManager.sendCommand(tabId, 'Page.stopScreencast');
    await CDPSessionManager.detach(tabId);
};

const finishRecording = async (): Promise<void> => {
    const current = await readState();
    if (!current.active) return;
    try {
        await stopScreencast();
        const result = await sendToOffscreen({ type: 'screen_record_finish' });
        if (!result.success) throw new Error(String(result.error || '结束录屏失败'));
        await writeState({ ...current, active: false, ready: true });
    } finally { releaseRecording(); }
};

const ok = (data: unknown): FunctionResult => ({ success: true, data });
const fail = (error: string): FunctionResult => ({ success: false, error });

export const screenRecordFunction: FunctionDefinition = {
    name: 'screen_record',
    description: [
        '标签页视频录屏：把指定标签页的画面录制为 webm 视频，保存到浏览器下载目录或回传云端。',
        '动作：start（开始，默认当前活动页）/ stop（停止并产出视频）/ state（查询）/ cancel（放弃）。',
        '默认 1280x720@15fps、最长 60 秒；用 max_duration_seconds 限时，save_mode=download（默认，存下载目录）',
        '或 save_mode=inline（base64 回传，仅适合短视频）。',
        '无人值守模式会将目标页切到前台并显示调试提示条；达到时限后停止采集，仍需 stop 取件或 cancel 丢弃。',
        '⚠️ 不要用此工具来：截取单张画面（用 screenshot）；录制操作步骤复用（用 recorder）。',
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
                description: '目标标签页 ID（start 可选，默认当前活动页）',
            },
            max_duration_seconds: {
                type: 'number',
                description: '最长录制时长（秒，默认 60，最大 600）',
            },
            save_mode: {
                type: 'string',
                enum: ['download', 'inline'],
                description: 'stop 时产出方式：download=保存到下载目录（默认）；inline=base64 回传（仅短视频）',
            },
        },
        required: ['action'],
    },
    supportsParallel: false,
    permissionLevel: 'interact',
    actionPermissions: {
        state: 'read',
    },
    execute: async (params: any, context?: ToolExecutionContext): Promise<FunctionResult> => serialize(async () => {
        const action = params?.action as 'start' | 'stop' | 'state' | 'cancel' | undefined;

        try {
            switch (action) {
                case 'start': {
                    const current = await readState();
                    if (current.active || current.ready) {
                        return fail(`已有进行中或待取件的录制（tab ${current.tabId}），先 stop 或 cancel`);
                    }
                    const tabId = await resolveTabId(params, context);
                    if (!tabId) return fail('无法确定录制标签页：请传 tab_id');

                    const maxSeconds = Math.min(
                        600,
                        Math.max(1, Number.isFinite(params.max_duration_seconds) ? params.max_duration_seconds : 60),
                    );
                    let mode: 'tabcapture' | 'screencast' = 'tabcapture';
                    await ensureOffscreen();
                    let streamId: string | undefined;
                    try { streamId = await getStreamId(tabId); } catch { mode = 'screencast'; }
                    releaseKeepAlive = acquireServiceWorkerKeepAlive();
                    try {
                        const resp = await sendToOffscreen({
                            type: mode === 'tabcapture' ? 'screen_record_start' : 'screen_record_canvas_start',
                            streamId,
                            maxDurationMs: maxSeconds * 1000,
                        });
                        if (!resp.success) throw new Error(String(resp.error || '开始录屏失败'));
                        if (mode === 'screencast') await startScreencast(tabId);
                        const state: RecordState = { active: true, tabId, startedAt: Date.now(), mode };
                        await writeState(state);
                        autoStopTimer = setTimeout(() => {
                            void serialize(finishRecording).catch(err => console.warn('[screen-record] 自动停止失败:', err));
                        }, maxSeconds * 1000);
                    } catch (err) {
                        await stopScreencast();
                        await sendToOffscreen({ type: 'screen_record_cancel' }).catch(() => undefined);
                        releaseRecording();
                        await writeState({ active: false });
                        throw err;
                    }

                    return ok({
                        recording: true,
                        tab_id: tabId,
                        mode,
                        started_at: (await readState()).startedAt,
                        max_duration_seconds: maxSeconds,
                        hint: mode === 'screencast'
                            ? '无人值守录屏（debugger 截帧），录制期该页顶部有调试提示条；完成后 stop 产出视频'
                            : '录制进行中；完成后调用 screen_record(action=stop) 产出视频',
                    });
                }
                case 'stop': {
                    const current = await readState();
                    if (!current.active && !current.ready) return fail('没有进行中或待取件的录制');
                    let resp: Record<string, unknown>;
                    try {
                        await stopScreencast();
                        resp = await sendToOffscreen({ type: 'screen_record_stop' });
                    } finally {
                        await writeState({ active: false });
                        releaseRecording();
                    }
                    if (!resp.success) return fail(String(resp.error || '停止录屏失败'));
                    const dataUrl = String(resp.dataUrl || '');
                    const sizeBytes = Number(resp.sizeBytes) || 0;
                    if (!dataUrl.startsWith('data:video/webm;base64,') || sizeBytes <= 0) return fail('录屏未生成有效 WebM');
                    const sizeKB = Math.round(sizeBytes / 1024);
                    const saveMode = params.save_mode === 'inline' ? 'inline' : 'download';

                    if (saveMode === 'inline') {
                        const maxInlineBytes = 8 * 1024 * 1024;
                        if (sizeBytes > maxInlineBytes) {
                            return fail(`视频 ${sizeKB}KB 过大，inline 上限 8MB，请用 save_mode=download`);
                        }
                        return ok({
                            format: 'webm',
                            size_kb: sizeKB,
                            data_url: dataUrl,
                            hint: 'base64 内联在 data_url 字段，可解码为 webm 文件',
                        });
                    }

                    const fileName = `actspan-record-${Date.now()}.webm`;
                    await chrome.downloads.download({ url: dataUrl, filename: fileName, saveAs: false });
                    return ok({
                        format: 'webm',
                        file_name: fileName,
                        size_kb: sizeKB,
                        saved_to: 'downloads',
                        hint: '视频已保存到浏览器下载目录',
                    });
                }
                case 'state': {
                    const current = await readState();
                    return ok({
                        active: current.active,
                        ready: current.ready === true,
                        mode: current.mode,
                        tab_id: current.tabId,
                        started_at: current.startedAt,
                    });
                }
                case 'cancel': {
                    try {
                        await stopScreencast();
                        if (await chrome.offscreen?.hasDocument()) {
                            const resp = await sendToOffscreen({ type: 'screen_record_cancel' });
                            if (!resp.success) return fail(String(resp.error || '取消录屏失败'));
                        }
                        return ok({ cancelled: true });
                    } finally {
                        await writeState({ active: false });
                        releaseRecording();
                    }
                }
                default:
                    return fail(`未知 action: ${String(action)}`);
            }
        } catch (err: any) {
            return fail(err?.message || 'screen_record 执行失败');
        }
    }),
};
