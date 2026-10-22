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
import { useActspan } from '../context/useActspan';
import { buildToolIntentText, buildUserFacingActionSummary } from '../text-utils';
import { reconcileSessionSyncTask } from '../session-sync';
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

    // 放宽匹配：只要有活跃任务就接受事件
    // 原因：submitNewTask 先用临时 ID 创建任务，background 稍后返回真实 sessionId
    // 流式事件在 sessionId 更新前就可能到达，严格匹配会丢弃这些事件
    if (!currentTask) return;
    if (currentTask.id !== taskId) {
      // 如果任务正在运行，自动绑定到正确的 sessionId
      if (currentTask.status === 'running') {
        dispatch({ type: 'UPDATE_TASK', payload: { id: taskId } });
      } else {
        return;
      }
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

      case 'function_result':
        dispatch({
          type: 'UPDATE_TASK',
          payload: { liveStatusText: '处理中...' },
        });
        break;

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

  // 监听会话同步
  useEffect(() => {
    const handleSessionSync = (data: any) => {
      if (!data || typeof data !== 'object' || typeof data.sessionId !== 'string') return;

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
    };

    Channel.on('__session_sync', handleSessionSync);
    return () => {
      Channel.off('__session_sync', handleSessionSync);
    };
  }, [dispatch]);
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
