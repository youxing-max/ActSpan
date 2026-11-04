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

const RECORDING_SESSION_KEY = 'actspan_screen_record_state';

interface RecordState {
    active: boolean;
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

interface ScreencastState { tabId: number; frames: Array<{ data: string; ts: number }>; }
let screencast: ScreencastState | null = null;

const onScreencastFrame = (source: chrome.debugger.Debuggee, method: string, params: any): void => {
    if (method !== 'Page.screencastFrame') return;
    if (!screencast || source.tabId !== screencast.tabId) return;
    screencast.frames.push({
        data: params?.data as string,
        ts: typeof params?.metadata?.timestamp === 'number' ? params.metadata.timestamp * 1000 : Date.now(),
    });
    // 必须 ack，否则 Chrome 不再推送后续帧
    chrome.debugger.sendCommand(source, 'Page.screencastFrameAck', { sessionId: params?.sessionId }).catch(() => undefined);
};

const startScreencast = async (tabId: number): Promise<void> => {
    // Page.startScreencast 只对有合成输出的可见标签页产帧：录制前把目标页切到前台
    try {
        await chrome.tabs.update(tabId, { active: true });
        const tab = await chrome.tabs.get(tabId);
        if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
    } catch { /* 聚焦失败不阻断录制尝试 */ }
    screencast = { tabId, frames: [] };
    chrome.debugger.onEvent.addListener(onScreencastFrame);
    await chrome.debugger.attach({ tabId }, '1.3');
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
    await chrome.debugger.sendCommand({ tabId }, 'Page.startScreencast', {
        format: 'jpeg',
        quality: 60,
        maxWidth: 1280,
        maxHeight: 720,
        everyNthFrame: 4, // 每 4 个合成帧取 1 帧（约 15fps，防止帧爆炸导致编码慢/内存高）
    });
};

const stopScreencast = async (): Promise<Array<{ data: string; ts: number }>> => {
    if (!screencast) return [];
    const { tabId, frames } = screencast;
    try { await chrome.debugger.sendCommand({ tabId }, 'Page.stopScreencast'); } catch { /* 忽略 */ }
    try { await chrome.debugger.detach({ tabId }); } catch { /* 忽略 */ }
    chrome.debugger.onEvent.removeListener(onScreencastFrame);
    screencast = null;
    return frames;
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
    execute: async (params: any, context?: ToolExecutionContext): Promise<FunctionResult> => {
        const action = params?.action as 'start' | 'stop' | 'state' | 'cancel' | undefined;

        try {
            switch (action) {
                case 'start': {
                    const current = await readState();
                    if (current.active) {
                        return fail(`已有进行中的录制（tab ${current.tabId}），先 stop 或 cancel`);
                    }
                    const tabId = await resolveTabId(params, context);
                    if (!tabId) return fail('无法确定录制标签页：请传 tab_id');

                    const maxSeconds = Math.min(
                        600,
                        Math.max(0, typeof params.max_duration_seconds === 'number' ? params.max_duration_seconds : 60),
                    );
                    let mode: 'tabcapture' | 'screencast' = 'tabcapture';
                    try {
                        await ensureOffscreen();
                        const streamId = await getStreamId(tabId);
                        const resp = await sendToOffscreen({
                            type: 'screen_record_start',
                            streamId,
                            maxDurationMs: maxSeconds * 1000,
                        });
                        if (!resp.success) return fail((resp.error as string) || '开始录屏失败');
                    } catch {
                        // tabCapture 被 activeTab 手势拒绝 → 无人值守回退到 debugger 截帧
                        mode = 'screencast';
                        await startScreencast(tabId);
                    }

                    const state: RecordState = { active: true, tabId, startedAt: Date.now(), mode };
                    await writeState(state);
                    return ok({
                        recording: true,
                        tab_id: tabId,
                        mode,
                        started_at: state.startedAt,
                        max_duration_seconds: maxSeconds,
                        hint: mode === 'screencast'
                            ? '无人值守录屏（debugger 截帧），录制期该页顶部有调试提示条；完成后 stop 产出视频'
                            : '录制进行中；完成后调用 screen_record(action=stop) 产出视频',
                    });
                }
                case 'stop': {
                    const current = await readState();
                    if (!current.active) return fail('没有进行中的录制');

                    let dataUrl = '';
                    let sizeBytes = 0;
                    if (current.mode === 'screencast') {
                        const frames = await stopScreencast();
                        await writeState({ active: false });
                        if (!frames.length) return fail('无人值守录屏未采集到任何帧');
                        const framesKB = Math.round(frames.reduce((s, f) => s + f.data.length, 0) * 3 / 4 / 1024);

                        // 方案 A（优先）：offscreen 编码成 webm 视频
                        try {
                            await ensureOffscreen();
                            const enc = await sendToOffscreen({ type: 'screen_record_encode', frames, fps: 2 }, 30_000);
                            if (enc.success && enc.dataUrl) {
                                dataUrl = enc.dataUrl as string;
                                sizeBytes = Number(enc.sizeBytes) || 0;
                            }
                        } catch { /* offscreen 编码失败，降级到方案 B */ }

                        // 方案 B（降级）：offscreen 不可用时，返回自包含可播放的 HTML 帧序列
                        if (!dataUrl) {
                            const html = `<!doctype html><title>Actspan 录屏 ${frames.length} 帧</title><body style="background:#000;text-align:center"><h2 style="color:#fff">录屏：${frames.length} 帧 / ${framesKB}KB</h2><div id="p" style="min-height:200px;color:#888">点击开始播放</div><script>
const F=${JSON.stringify(frames.map(f=>f.data))};
let i=0,timer=null;
document.body.onclick=()=>{if(timer){clearInterval(timer);timer=null;document.getElementById('p').innerHTML='暂停在第 '+i+' 帧';return;}
timer=setInterval(()=>{if(i>=F.length){clearInterval(timer);timer=null;document.getElementById('p').innerHTML='播放完毕';return;}
document.getElementById('p').innerHTML='<img src="data:image/jpeg;base64,'+F[i++]+'" style="max-width:100%">';},500);};</script></body>`;
                            dataUrl = `data:text/html;base64,${btoa(unescape(encodeURIComponent(html)))}`;
                            sizeBytes = html.length;
                        }
                    } else {
                        await ensureOffscreen();
                        const resp = await sendToOffscreen({ type: 'screen_record_stop' });
                        await writeState({ active: false });
                        if (!resp.success) return fail((resp.error as string) || '停止录屏失败');
                        dataUrl = resp.dataUrl as string;
                        sizeBytes = Number(resp.sizeBytes) || 0;
                    }
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
                        tab_id: current.tabId,
                        started_at: current.startedAt,
                    });
                }
                case 'cancel': {
                    await ensureOffscreen();
                    const resp = await sendToOffscreen({ type: 'screen_record_cancel' });
                    await writeState({ active: false });
                    return resp.success ? ok({ cancelled: true }) : fail((resp.error as string) || '取消录屏失败');
                }
                default:
                    return fail(`未知 action: ${String(action)}`);
            }
        } catch (err: any) {
            return fail(err?.message || 'screen_record 执行失败');
        }
    },
};
