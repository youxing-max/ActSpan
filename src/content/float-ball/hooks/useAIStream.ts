/**
 * AI 流式事件 Hook
 * 监听 Channel __ai_stream 事件，分发到 ActspanContext 状态
 * 核心桥梁：Channel 事件 → React 状态更新
 *
 * 关键设计：
 * - 用 stateRef 保持对最新 state 的引用，避免闭包陈旧
 * - taskId 匹配放宽：只要有正在运行的任务就接受事件（同一时间只有一个活跃任务）
 * - callStack 通过 reducer 内追加，避免快速事件覆盖问题
 */

import { useEffect, useCallback, useRef } from 'react';
import Channel from '../../../lib/channel';
import { ArtifactStore } from '../../../lib/artifact-store';
import { useActspan } from '../context/useActspan';
import { buildToolIntentText, buildUserFacingActionSummary } from '../text-utils';
import { reconcileSessionSyncTask, isSessionVisibleInTab } from '../session-sync';
import { FUNCTION_ICONS, FUNCTION_LABELS } from '../icons';

/** 流式告警是内部诊断数据，不能把原始 JSON 直接当成进度文案展示。 */
const toUserFacingStreamWarning = (raw: unknown): string => {
  const text = String(raw ?? '').trim();
  try {
    const parsed = JSON.parse(text);
    if (parsed?.code === 'E_SSE_UNRECOGNIZED') {
      return '模型流式响应中有少量数据未能解析，已跳过并继续处理。';
    }
    if (typeof parsed?.message === 'string' && parsed.message.trim()) return parsed.message.trim();
  } catch { /* 普通文本告警原样展示 */ }
  return text;
};

export const useAIStream = (_resultRef: React.RefObject<HTMLDivElement | null>) => {
  const { state, dispatch } = useActspan();
  const stateRef = useRef(state);
  stateRef.current = state;

  // 流式事件处理器
  const handleStream = useCallback((data: any) => {
    if (!data || typeof data !== 'object') return;
    const { taskId, type, content } = data;
    const currentTask = stateRef.current.currentTask;

    if (!currentTask) return;
    if (currentTask.id !== taskId) {
      // 只有本地刚提交、尚未拿到真实 sessionId 的临时任务才允许自动绑定；
      // 且必须来自同一个标签页，避免把其他标签页的运行中会话绑过来。
      if (!currentTask.pendingSession) return;
      if (!isSessionVisibleInTab(data.originTabId, currentTask.originTabId ?? stateRef.current.selfTabId)) return;
      dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, pendingSession: false, originTabId: data.originTabId } });
    } else if (currentTask.pendingSession) {
      dispatch({ type: 'UPDATE_TASK', payload: { pendingSession: false } });
    }

    switch (type) {
      case 'turn_started':
        try {
          const parsed = JSON.parse(content);
          dispatch({
            type: 'UPDATE_TASK',
            payload: {
              status: 'running',
              activeRunId: parsed?.runId || currentTask.activeRunId,
              startedAt: parsed?.startedAt || currentTask.startedAt,
            },
          });
        } catch { /* 忽略 */ }
        break;

      case 'thinking':
        dispatch({
          type: 'UPDATE_TASK',
          payload: { callStack: [], liveStatusText: content },
        });
        break;

      case 'function_call':
        try {
          const parsed = JSON.parse(content || '{}');
          const funcName = parsed?.name || '';
          const icon = FUNCTION_ICONS[funcName] || '';
          let label = FUNCTION_LABELS[funcName] || funcName || '操作执行';
          // 从 arguments 中提取具体描述，让执行过程更直观
          if (parsed?.arguments) {
            try {
              const args = typeof parsed.arguments === 'string' ? JSON.parse(parsed.arguments) : parsed.arguments;
              if (funcName === 'skill') {
                if (args?.name) label = `${label}：${args.name}`;
              } else if (funcName === 'todo') {
                const action = args?.action;
                if (action === 'create' && Array.isArray(args.items)) {
                  label = `${label}：创建 ${args.items.length} 步计划`;
                } else if (action === 'update' && args.status === 'in_progress') {
                  label = `${label}：开始「${args.title || `#${args.id}`}」`;
                } else if (action === 'update' && args.status === 'completed') {
                  label = `${label}：完成「${args.title || `#${args.id}`}」`;
                } else if (action === 'add' && args.title) {
                  label = `${label}：追加「${args.title}」`;
                }
              }
            } catch { /* 忽略 */ }
          }
          const intentText = buildToolIntentText(funcName, parsed?.summary || '');
          const userSummary = buildUserFacingActionSummary(funcName, parsed?.summary || '', label);
          dispatch({
            type: 'APPEND_CALL_STACK',
            payload: {
              funcName,
              icon,
              text: label,
              userSummary: userSummary || label,
            },
          });
          dispatch({
            type: 'UPDATE_TASK',
            payload: { liveStatusText: intentText || `正在调用 ${label}` },
          });
        } catch { /* 忽略 */ }
        break;

      case 'function_result': {
        dispatch({
          type: 'UPDATE_TASK',
          payload: { liveStatusText: '处理中...' },
        });
        let artifactId = '';
        try {
          artifactId = JSON.parse(content || '{}')?.artifactId || '';
        } catch { /* 忽略 */ }
        if (artifactId) {
          ArtifactStore.getScreenshot(artifactId).then((record) => {
            if (!record) return;
            const task = stateRef.current.currentTask;
            if (!task || task.screenshotArtifacts?.some((s) => s.id === record.id)) return;
            dispatch({
              type: 'UPDATE_TASK',
              payload: {
                screenshotArtifacts: [
                  ...(task.screenshotArtifacts || []),
                  { id: record.id, dataUrl: record.dataUrl, format: record.format, sizeKB: record.sizeKB },
                ],
              },
            });
          }).catch(() => { /* 图片读取失败不影响任务 */ });
        }
        break;
      }

      case 'text':
        dispatch({
          type: 'UPDATE_TASK',
          payload: { lastAIText: content },
        });
        break;

      case 'turn_completed':
        try {
          const parsed = JSON.parse(content || '{}');
          const status = parsed?.status === 'error' ? 'error' as const : 'done' as const;
          dispatch({
            type: 'UPDATE_TASK',
            payload: {
              status,
              endedAt: parsed?.endedAt || Date.now(),
              durationMs: parsed?.durationMs || null,
              failureCode: parsed?.failureCode || '',
              errorMsg: parsed?.reason || '',
            },
          });
        } catch {
          dispatch({
            type: 'UPDATE_TASK',
            payload: { status: 'done', endedAt: Date.now() },
          });
        }
        break;

      case 'turn_aborted':
        try {
          const parsed = JSON.parse(content || '{}');
          dispatch({
            type: 'UPDATE_TASK',
            payload: {
              status: 'error',
              endedAt: parsed?.endedAt || Date.now(),
              errorMsg: parsed?.reason || '任务已中断',
              failureCode: parsed?.failureCode || 'E_ABORTED',
            },
          });
        } catch {
          dispatch({
            type: 'UPDATE_TASK',
            payload: { status: 'error', errorMsg: '任务已中断' },
          });
        }
        break;

      case 'error':
        try {
          const parsed = JSON.parse(content || '{}');
          dispatch({
            type: 'UPDATE_TASK',
            payload: {
              status: 'error',
              errorMsg: parsed?.message || content,
              failureCode: parsed?.code || 'E_UNKNOWN',
              endedAt: Date.now(),
            },
          });
        } catch {
          dispatch({
            type: 'UPDATE_TASK',
            payload: {
              status: 'error',
              errorMsg: content || '未知错误',
              endedAt: Date.now(),
            },
          });
        }
        break;

      case 'agent_state':
        try {
          const parsed = JSON.parse(content);
          dispatch({
            type: 'UPDATE_TASK',
            payload: {
              agentPhase: parsed?.to || currentTask.agentPhase,
              agentRound: typeof parsed?.round === 'number' ? parsed.round : currentTask.agentRound,
            },
          });
        } catch { /* 忽略 */ }
        break;

      case 'planning':
        dispatch({
          type: 'UPDATE_TASK',
          payload: { liveStatusText: content },
        });
        break;

      case 'warning': {
        const warningText = toUserFacingStreamWarning(content);
        if (warningText) {
          dispatch({
            type: 'UPDATE_TASK',
            payload: { liveStatusText: warningText },
          });
        }
        break;
      }

      case 'task_lifecycle':
        // 任务生命周期事件
        try {
          const parsed = JSON.parse(content || '{}');
          if (parsed?.status === 'done' || parsed?.status === 'error') {
            dispatch({
              type: 'UPDATE_TASK',
              payload: {
                status: parsed.status,
                endedAt: parsed?.endedAt || Date.now(),
                durationMs: parsed?.durationMs || null,
                errorMsg: parsed?.message || '',
              },
            });
          } else if (parsed?.message) {
            dispatch({
              type: 'UPDATE_TASK',
              payload: { liveStatusText: parsed.message },
            });
          }
        } catch { /* 忽略 */ }
        break;

      default:
        break;
    }
  }, [dispatch]);

  // 注册 Channel 监听
  useEffect(() => {
    Channel.on('__ai_stream', handleStream);
    return () => {
      Channel.off('__ai_stream', handleStream);
    };
  }, [handleStream]);

  // content script 没有 chrome.tabs 权限，向 background 询问自身标签页 ID，
  // 用于过滤其他标签页广播过来的会话事件。
  useEffect(() => {
    if (stateRef.current.selfTabId !== null) return;
    Channel.send('__get_self_tab_id', {}, (response: { tabId?: number } | undefined) => {
      if (typeof response?.tabId === 'number') {
        dispatch({ type: 'SET_SELF_TAB_ID', payload: response.tabId });
      }
    });
  }, [dispatch]);

  // 监听会话同步
  const applySessionSync = useCallback((data: any) => {
      if (!data || typeof data !== 'object' || typeof data.sessionId !== 'string') return;

      const currentTask = stateRef.current.currentTask;
      if (currentTask) {
        if (currentTask.id !== data.sessionId) {
          // 非本地临时任务不允许被其他会话的同步事件替换
          if (!currentTask.pendingSession) return;
          if (!isSessionVisibleInTab(data.originTabId, currentTask.originTabId ?? stateRef.current.selfTabId)) return;
        }
      } else if (!isSessionVisibleInTab(data.originTabId, stateRef.current.selfTabId)) {
        // 没有本地任务时，只接受当前标签页的会话
        return;
      }

      if (data.originTabId !== undefined) {
        dispatch({ type: 'SET_SESSION_ORIGIN_TAB', payload: data.originTabId });
      }

      const result = reconcileSessionSyncTask(stateRef.current.currentTask, data);
      if (result.kind === 'set') {
        dispatch({ type: 'SET_TASK', payload: result.task });
      } else if (result.kind === 'update') {
        dispatch({ type: 'UPDATE_TASK', payload: result.update });
      } else if (result.kind === 'clear') {
        dispatch({ type: 'SET_TASK', payload: null });
      }
  }, [dispatch]);

  useEffect(() => {
    Channel.on('__session_sync', applySessionSync);
    return () => {
      Channel.off('__session_sync', applySessionSync);
    };
  }, [applySessionSync]);

  // background 重启后重新注册成功时，主动拉一次当前会话，
  // 避免后台休眠期间错过 turn_completed 后页面一直显示“正在执行”。
  useEffect(() => {
    const handleReconnected = () => {
      Channel.send('__session_get_active', {}, (response: any) => {
        if (!response?.sessionId) return;
        const currentTask = stateRef.current.currentTask;
        if (currentTask && !currentTask.pendingSession && currentTask.id !== response.sessionId) return;
        applySessionSync(response);
      });
    };
    Channel.on('__channel_tab_reconnected', handleReconnected);
    return () => {
      Channel.off('__channel_tab_reconnected', handleReconnected);
    };
  }, [applySessionSync]);
  // 侧栏作为 extension page 没有 sender.tab，恢复会话时需要自行消费回放事件。
  useEffect(() => {
    const handleSessionReplay = (data: any) => {
      if (!data || typeof data !== 'object' || typeof data.sessionId !== 'string' || !Array.isArray(data.events)) return;
      const currentTask = stateRef.current.currentTask;
      if (!currentTask || currentTask.id !== data.sessionId) return;

      for (const event of data.events) {
        if (!event || typeof event.type !== 'string') continue;
        handleStream({
          ...event,
          taskId: data.sessionId,
          sessionId: data.sessionId,
        });
      }
    };

    Channel.on('__session_replay', handleSessionReplay);
    return () => {
      Channel.off('__session_replay', handleSessionReplay);
    };
  }, [handleStream]);


  // 监听审批请求/取消
  useEffect(() => {
    const handleRequest = (data: any) => {
      if (data?.requestId && data?.message) {
        dispatch({ type: 'SET_APPROVAL_REQUEST', payload: { requestId: data.requestId, message: data.message } });
        // 自动展开面板
        dispatch({ type: 'TOGGLE_OPEN', payload: true });
      }
    };
    const handleCancel = (data: any) => {
      const s = stateRef.current;
      if (s.approvalRequest?.requestId === data?.requestId) {
        dispatch({ type: 'SET_APPROVAL_REQUEST', payload: null });
      }
    };
    const handleSettled = (data: any) => {
      const s = stateRef.current;
      if (s.approvalRequest?.requestId === data?.requestId) {
        dispatch({ type: 'SET_APPROVAL_REQUEST', payload: null });
      }
    };
    Channel.on('__approval_request', handleRequest);
    Channel.on('__approval_cancel', handleCancel);
    Channel.on('__approval_settled', handleSettled);
    return () => {
      Channel.off('__approval_request', handleRequest);
      Channel.off('__approval_cancel', handleCancel);
      Channel.off('__approval_settled', handleSettled);
    };
  }, [dispatch]);

  // 监听提问请求/取消
  useEffect(() => {
    const handleRequest = (data: any) => {
      if (data?.requestId && data?.question) {
        dispatch({
          type: 'SET_ASK_USER_REQUEST',
          payload: {
            requestId: data.requestId,
            question: data.question,
            options: data.options,
            allowFreeText: data.allowFreeText,
          },
        });
        dispatch({ type: 'TOGGLE_OPEN', payload: true });
      }
    };
    const handleCancel = (data: any) => {
      const s = stateRef.current;
      if (s.askUserRequest?.requestId === data?.requestId) {
        dispatch({ type: 'SET_ASK_USER_REQUEST', payload: null });
      }
    };
    const handleSettled = (data: any) => {
      const s = stateRef.current;
      if (s.askUserRequest?.requestId === data?.requestId) {
        dispatch({ type: 'SET_ASK_USER_REQUEST', payload: null });
      }
    };
    Channel.on('__ask_user_request', handleRequest);
    Channel.on('__ask_user_cancel', handleCancel);
    Channel.on('__ask_user_settled', handleSettled);
    return () => {
      Channel.off('__ask_user_request', handleRequest);
      Channel.off('__ask_user_cancel', handleCancel);
      Channel.off('__ask_user_settled', handleSettled);
    };
  }, [dispatch]);
};
