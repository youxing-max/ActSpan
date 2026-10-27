/**
 * Side Panel 根组件
 * 复用悬浮球的 Context、Hooks 和 UI 组件，适配侧边栏布局
 */

import React, { useRef, useEffect, useCallback, useState } from 'react';
import { CommentOutlined, TranslationOutlined } from '@ant-design/icons';
import { ActspanProvider } from '../content/float-ball/context/ActspanContext';
import { useActspan } from '../content/float-ball/context/useActspan';
import { useAIStream } from '../content/float-ball/hooks/useAIStream';
import { useSecondTick } from '../content/float-ball/hooks/useGlobalEvents';
import { InputBar } from '../content/float-ball/components/InputBar';
import { ResultView } from '../content/float-ball/components/ResultView';
import { ApprovalCard } from '../content/float-ball/components/ApprovalCard';
import { AskUserCard } from '../content/float-ball/components/AskUserCard';
import { RecorderBar } from '../content/float-ball/components/RecorderBar';
import { BgTasksPanel } from '../content/float-ball/components/BgTasksPanel';
import { ImageViewer } from '../content/float-ball/components/ImageViewer';
import { TranslatePanel } from './TranslatePanel';
import Channel from '../lib/channel';
import { formatClock, formatDuration } from '../content/float-ball/text-utils';

/** Tab 感知 hook：追踪当前活跃标签页，并同步到 ActspanContext.selfTabId */
const useActiveTab = () => {
    const { dispatch } = useActspan();

    useEffect(() => {
        const updateTabId = (tabId: number) => {
            dispatch({ type: 'SET_SELF_TAB_ID', payload: tabId });
        };

        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]?.id) updateTabId(tabs[0].id);
        });

        const handleActivated = (info: chrome.tabs.TabActiveInfo) => {
            updateTabId(info.tabId);
        };
        chrome.tabs.onActivated.addListener(handleActivated);
        return () => chrome.tabs.onActivated.removeListener(handleActivated);
    }, [dispatch]);
};

/** Side Panel 键盘事件 hook */
const useSidePanelEvents = () => {
    const { state, dispatch } = useActspan();
    const stateRef = useRef(state);
    stateRef.current = state;

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            const s = stateRef.current;

            if (s.screenshotPreviewList.length > 0) {
                dispatch({ type: 'SET_SCREENSHOT_PREVIEW', payload: { list: [], index: 0 } });
                return;
            }

            if (s.currentTask) {
                Channel.send('__session_clear', { sessionId: s.currentTask.id });
                dispatch({ type: 'SET_TASK', payload: null });
                return;
            }

            // 无会话时关闭侧边栏
            window.close();
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [dispatch]);
};

/** Side Panel 内部组件 */
const SidePanelInner: React.FC = () => {
    const { state, dispatch } = useActspan();
    // 视图切换：对话（默认）/ 翻译
    const [view, setView] = useState<'chat' | 'translate'>('chat');
    const resultRef = useRef<HTMLDivElement>(null);
    const currentTaskRef = useRef(state.currentTask);
    currentTaskRef.current = state.currentTask;
    useActiveTab();

    // 注册 AI 流式事件监听
    useAIStream(resultRef);
    useSidePanelEvents();

    const task = state.currentTask;
    const isRunning = task?.status === 'running';
    useSecondTick(isRunning === true);

    // Side Panel 打开时自动标记为已打开状态
    useEffect(() => {
        dispatch({ type: 'TOGGLE_OPEN', payload: true });
    }, [dispatch]);

    // 恢复活跃会话（只恢复属于当前标签页的会话，避免侧栏串台）
    const syncActiveSession = useCallback(() => {
        if (state.selfTabId === null) return;
        Channel.send('__session_get_active', {}, (response: { sessionId?: string; status?: string; summary?: string; originTabId?: number; startedAt?: number; endedAt?: number; durationMs?: number; lastError?: string; failureCode?: string; agentState?: { phase?: string; round?: number }; taskKind?: string }) => {
            if (!response?.sessionId || (response.status !== 'running' && response.status !== 'done' && response.status !== 'error')) return;
            const currentTask = currentTaskRef.current;
            const isCurrentSession = currentTask?.id === response.sessionId;
            // 当前任务自身必须允许刷新，即使 Agent 运行期间切换了活动标签页；
            // 其他会话仍只接受属于当前标签页的。
            if (!isCurrentSession && typeof response.originTabId === 'number' && response.originTabId !== state.selfTabId) return;
            // 当前标签页已有运行中的任务时，不要被另一个标签页的活跃会话覆盖
            if (!isCurrentSession && currentTask?.status === 'running') return;
            const status = response.status === 'error' ? 'error' : response.status === 'done' ? 'done' : 'running';
            dispatch({
                type: 'SET_TASK',
                payload: {
                    id: response.sessionId,
                    pendingSession: false,
                    originTabId: response.originTabId,
                    query: response.summary || '',
                    title: response.summary || '',
                    status,
                    resultHtml: '',
                    callStack: [],
                    errorMsg: response.lastError || '',
                    lastAIText: '',
                    agentPhase: response.agentState?.phase || 'plan',
                    agentRound: response.agentState?.round || 0,
                    failureCode: response.failureCode || '',
                    liveStatusText: '',
                    startedAt: response.startedAt || Date.now(),
                    endedAt: response.endedAt || (status === 'running' ? null : Date.now()),
                    durationMs: response.durationMs ?? null,
                    taskKind: response.taskKind,
                },
            });

            // extension page 没有 sender.tab，background 不会自动回放；等任务状态落地后主动请求。
            window.setTimeout(() => {
                Channel.send('__session_replay_request', {
                    sessionId: response.sessionId,
                    scope: 'latest_turn',
                });
            }, 0);
        });
    }, [dispatch, state.selfTabId]);

    useEffect(() => {
        syncActiveSession();
    }, [syncActiveSession]);

    // background 被浏览器回收后 port 会断开；重连成功时补一次会话状态，
    // 否则页面会一直停留在断开前的“正在执行”。
    useEffect(() => {
        Channel.on('__channel_extension_reconnected', syncActiveSession);
        return () => {
            Channel.off('__channel_extension_reconnected', syncActiveSession);
        };
    }, [syncActiveSession]);

    // 搜索框状态 class
    const boxState = !task ? 'state-idle'
        : task.status === 'running' ? 'state-running'
        : task.status === 'error' ? 'state-error'
        : 'state-done';

    // Footer 时间
    const getFooterTime = () => {
        if (!task) return '';
        if (isRunning) {
            const elapsed = Math.max(0, Date.now() - task.startedAt);
            return `开始 ${formatClock(task.startedAt)} · 已运行 ${formatDuration(elapsed)}`;
        }
        const end = task.endedAt;
        const duration = task.durationMs ?? (end ? Math.max(0, end - task.startedAt) : null);
        const parts: string[] = [];
        if (end) parts.push(`结束 ${formatClock(end)}`);
        if (duration !== null) parts.push(`耗时 ${formatDuration(duration)}`);
        return parts.join(' · ');
    };

    // Footer 文本
    const getFooterText = () => {
        if (!task) return 'Actspan · AI 助手';
        if (isRunning) return task.liveStatusText || '我正在继续处理';
        if (task.status === 'error') return `处理失败 · ${task.title}`;
        return `已完成 · ${task.title}`;
    };

    // 录制操作（Side Panel 中暂不支持直接录制，保留接口）
    const handleStopRecording = useCallback(() => {
        Channel.send('__recorder_stop', {});
    }, []);
    const handleCancelAuditing = useCallback(() => {
        Channel.send('__recorder_cancel_audit', {});
    }, []);

    const logoUrl = chrome.runtime.getURL('actspan-logo.svg');

    // 新对话
    const handleNewChat = useCallback(() => {
        if (task) {
            Channel.send('__session_clear', { sessionId: task.id });
        }
        dispatch({ type: 'SET_TASK', payload: null });
    }, [task, dispatch]);

    // 打开设置
    const handleOpenSettings = useCallback(() => {
        Channel.send('__open_options_page', {});
    }, []);

    return (
        <div className={`sidepanel-root ${view === 'translate' ? 'state-idle view-translate' : boxState}`}>
            {/* 顶栏 */}
            <div className="sidepanel-header">
                <div className="sidepanel-header-left">
                    <img className="sidepanel-header-logo" src={logoUrl} alt="" />
                    <span className="sidepanel-header-title">Actspan</span>
                </div>
                <div className="sidepanel-header-actions">
                    {/* 视图切换：对话 / 翻译（固定在顶栏右侧） */}
                    <div className="sidepanel-header-tabs" role="tablist" aria-label="视图切换">
                        <button
                            type="button"
                            role="tab"
                            aria-selected={view === 'chat'}
                            className={`sidepanel-header-tab${view === 'chat' ? ' active' : ''}`}
                            title="对话"
                            onClick={() => setView('chat')}
                        >
                            <CommentOutlined />对话
                        </button>
                        <button
                            type="button"
                            role="tab"
                            aria-selected={view === 'translate'}
                            className={`sidepanel-header-tab${view === 'translate' ? ' active' : ''}`}
                            title="翻译"
                            onClick={() => setView('translate')}
                        >
                            <TranslationOutlined />翻译
                        </button>
                    </div>
                    {view === 'chat' && (
                        <button
                            className="sidepanel-header-btn"
                            title="新对话"
                            onClick={handleNewChat}
                        >
                            +
                        </button>
                    )}
                    <button
                        className="sidepanel-header-btn"
                        title="设置"
                        onClick={handleOpenSettings}
                    >
                        ⚙
                    </button>
                </div>
            </div>

            {view === 'translate' ? (
                <div className="sidepanel-content sidepanel-content-translate">
                    <TranslatePanel />
                </div>
            ) : (
                <>
                    {/* 内容区 */}
                    <div className="sidepanel-content">
                        {!task ? (
                            <div className="sidepanel-empty">
                                <img className="sidepanel-empty-logo" src={logoUrl} alt="" />
                                <p className="sidepanel-empty-text">有什么想让我做的？</p>
                            </div>
                        ) : (
                            <div ref={resultRef}>
                                <ResultView />
                            </div>
                        )}
                        {state.approvalRequest && (
                            <ApprovalCard
                                key={state.approvalRequest.requestId}
                                requestId={state.approvalRequest.requestId}
                                message={state.approvalRequest.message}
                            />
                        )}
                        {state.askUserRequest && (
                            <AskUserCard
                                key={state.askUserRequest.requestId}
                                requestId={state.askUserRequest.requestId}
                                question={state.askUserRequest.question}
                                options={state.askUserRequest.options}
                                allowFreeText={state.askUserRequest.allowFreeText}
                            />
                        )}
                        <RecorderBar onStop={handleStopRecording} onCancelAudit={handleCancelAuditing} />
                        <BgTasksPanel />
                    </div>

                    {/* 输入区 */}
                    <div className="sidepanel-input-area">
                        <InputBar resultRef={resultRef} />
                    </div>

                    {/* 底栏 */}
                    <div className="sidepanel-footer">
                        <span className="sidepanel-footer-icon">✦</span>
                        <span className="sidepanel-footer-text">{getFooterText()}</span>
                        <span className="sidepanel-footer-time">{getFooterTime()}</span>
                    </div>
                </>
            )}

            {/* 截图预览 */}
            <ImageViewer />
        </div>
    );
};

export const SidePanelApp: React.FC = () => {
    return (
        <ActspanProvider>
            <SidePanelInner />
        </ActspanProvider>
    );
};
