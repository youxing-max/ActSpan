/**
 * 输入框组件
 * 功能：文字输入、Enter 提交、上下键历史浏览、状态按钮（终止/新对话/重试）
 */

import React, { useRef, useCallback, useEffect } from 'react';
import Channel from '../../../lib/channel';
import { useActspan } from '../context/useActspan';
import { buildTaskTitle } from '../text-utils';
import type { TaskItem } from '../context/types';

interface InputBarProps {
  resultRef: React.RefObject<HTMLDivElement | null>;
}

/** 创建新任务的默认状态 */
const createNewTask = (query: string, originTabId?: number, id?: string): TaskItem => ({
  id: id || Date.now().toString(),
  pendingSession: true,
  originTabId,
  query,
  title: buildTaskTitle(query),
  status: 'running',
  resultHtml: '',
  callStack: [],
  errorMsg: '',
  lastAIText: '',
  agentPhase: 'plan',
  agentRound: 0,
  failureCode: '',
  startedAt: Date.now(),
  endedAt: null,
  durationMs: null,
  taskKind: 'regular',
});

export const InputBar: React.FC<InputBarProps> = ({ resultRef: _resultRef }) => {
  const { state, dispatch } = useActspan();
  const inputRef = useRef<HTMLInputElement>(null);
  const stopFallbackRef = useRef<number | null>(null);
  const task = state.currentTask;
  const isRunning = task?.status === 'running';
  const isAuditing = state.isRecorderAuditing;
  // 兜底定时器回调晚于渲染执行，需要读取最新的任务状态，避免闭包拿到旧值
  const taskRef = useRef<TaskItem | null>(task);
  useEffect(() => {
    taskRef.current = task;
  }, [task]);

  useEffect(() => () => {
    if (stopFallbackRef.current !== null) window.clearTimeout(stopFallbackRef.current);
  }, []);

  // 面板打开时自动聚焦
  useEffect(() => {
    if (state.isOpen) {
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (el && !el.disabled) el.focus();
      });
    }
  }, [state.isOpen]);

  // 提交新任务
  const submitNewTask = useCallback((value: string) => {
    const tempTask = createNewTask(value, state.selfTabId ?? undefined);
    dispatch({ type: 'SET_TASK', payload: tempTask });
    dispatch({ type: 'PUSH_INPUT_HISTORY', payload: value });

    Channel.send('__session_create', { query: value, tabId: state.selfTabId ?? undefined }, (response: any) => {
      if (response?.sessionId) {
        dispatch({
          type: 'UPDATE_TASK',
          payload: {
            id: response.sessionId,
            pendingSession: false,
            ...(response.summary ? { title: buildTaskTitle(response.summary) } : {}),
          },
        });
        return;
      }
      if (response?.accepted === false) {
        const message = response?.message?.trim() || '创建会话失败';
        dispatch({
          type: 'UPDATE_TASK',
          payload: {
            status: 'error',
            errorMsg: message,
            failureCode: response?.code || '',
          },
        });
      }
    });
  }, [dispatch, state.selfTabId]);

  // 继续对话
  const continueTask = useCallback((value: string) => {
    if (!task) return;
    // 保存当前轮次到历史
    dispatch({ type: 'SAVE_ROUND' });
    dispatch({
      type: 'UPDATE_TASK',
      payload: {
        query: value,
        title: buildTaskTitle(value),
        status: 'running',
        callStack: [],
        lastAIText: '',
        agentPhase: 'plan',
        agentRound: 0,
        failureCode: '',
        errorMsg: '',
        startedAt: Date.now(),
        endedAt: null,
        durationMs: null,
      },
    });
    dispatch({ type: 'PUSH_INPUT_HISTORY', payload: value });

    Channel.send(
      '__session_continue',
      { sessionId: task.id, query: value, tabId: state.selfTabId ?? undefined },
      (response: any) => {
        if (response?.accepted === false) {
          const message = response?.message?.trim() || '继续对话失败';
          dispatch({
            type: 'UPDATE_TASK',
            payload: {
              status: 'error',
              errorMsg: message,
              failureCode: response?.code || '',
            },
          });
        } else if (response?.accepted === true && response?.sessionId) {
          dispatch({ type: 'UPDATE_TASK', payload: { id: response.sessionId } });
        }
      },
    );
  }, [task, dispatch, state.selfTabId]);

  // 任务运行中追加指令：不结束当前轮次，交给 background 注入到运行中的上下文
  const injectInstruction = useCallback((value: string) => {
    if (!task) return;
    dispatch({ type: 'PUSH_INPUT_HISTORY', payload: value });
    dispatch({
      type: 'UPDATE_TASK',
      payload: { liveStatusText: `已追加指令：${value.length > 24 ? `${value.slice(0, 24)}…` : value}` },
    });

    Channel.send(
      '__session_continue',
      { sessionId: task.id, query: value, tabId: state.selfTabId ?? undefined },
      (response: any) => {
        if (response?.accepted === false) {
          dispatch({
            type: 'UPDATE_TASK',
            payload: { liveStatusText: `追加指令失败：${response?.message || '未知原因'}` },
          });
        }
      },
    );
  }, [task, dispatch, state.selfTabId]);

  // 键盘事件
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    const el = inputRef.current;
    if (!el) return;

    // 上下键历史浏览
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.nativeEvent.isComposing && state.inputHistory.length > 0) {
      e.preventDefault();
      if (e.key === 'ArrowUp') {
        if (state.inputHistoryCursor === -1) {
          dispatch({ type: 'SET_INPUT_CURSOR', payload: { cursor: state.inputHistory.length - 1, draft: el.value } });
        } else if (state.inputHistoryCursor > 0) {
          dispatch({ type: 'SET_INPUT_CURSOR', payload: { cursor: state.inputHistoryCursor - 1, draft: state.inputHistoryDraft } });
        }
      } else {
        if (state.inputHistoryCursor === -1) return;
        if (state.inputHistoryCursor < state.inputHistory.length - 1) {
          dispatch({ type: 'SET_INPUT_CURSOR', payload: { cursor: state.inputHistoryCursor + 1, draft: state.inputHistoryDraft } });
        } else {
          dispatch({ type: 'SET_INPUT_CURSOR', payload: { cursor: -1, draft: '' } });
          el.value = state.inputHistoryDraft;
          return;
        }
      }
      el.value = state.inputHistory[state.inputHistoryCursor === -1 ? state.inputHistory.length - 1 : state.inputHistoryCursor] ?? '';
      return;
    }

    // Enter 提交
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      const value = el.value.trim();
      if (!value) return;

      el.value = '';

      // 运行中允许继续输入：作为补充指令注入当前任务，而不是被禁用
      if (isRunning) {
        injectInstruction(value);
        return;
      }

      // 用户主动停止的轮次仍属于同一段对话：继续在原有上下文里对话，
      // 而不是另起新会话，否则刚保留的记录又会被新会话覆盖。
      const continuesExistingSession = !!task
        && (task.status !== 'error' || task.failureCode === 'E_CANCELLED');
      if (continuesExistingSession) {
        continueTask(value);
      } else {
        submitNewTask(value);
      }
    }
  }, [state, task, isRunning, dispatch, submitNewTask, continueTask, injectInstruction]);

  // 终止任务：只结束当前轮次，保留面板上的对话记录（历史轮次 + 本轮进展）。
  // 这里不能清空 currentTask —— 那会让用户点“停止”后整段对话凭空消失，
  // 与 background 把 E_CANCELLED 视为可恢复失败的设计也相悖。
  const handleStop = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!task || task.status !== 'running') return;

    const sessionId = task.id;
    dispatch({
      type: 'UPDATE_TASK',
      payload: { liveStatusText: '正在终止任务…' },
    });
    Channel.send('__ai_cancel', { sessionId });

    // 兜底：Service Worker 被回收等极端情况下可能收不到 turn_aborted，
    // 避免界面一直停在“运行中”。
    if (stopFallbackRef.current !== null) window.clearTimeout(stopFallbackRef.current);
    stopFallbackRef.current = window.setTimeout(() => {
      stopFallbackRef.current = null;
      const current = taskRef.current;
      if (!current || current.id !== sessionId || current.status !== 'running') return;
      dispatch({
        type: 'UPDATE_TASK',
        payload: {
          status: 'error',
          failureCode: 'E_CANCELLED',
          errorMsg: '任务已停止',
          endedAt: Date.now(),
        },
      });
    }, 5000);
  }, [task, dispatch]);

  // 新对话
  const handleNew = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (task) {
      Channel.send('__session_clear', { sessionId: task.id });
    }
    dispatch({ type: 'SET_TASK', payload: null });
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [task, dispatch]);

  // 重试（断点恢复）
  const handleRetry = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!task || task.status !== 'error') return;
    Channel.send('__session_resume', { sessionId: task.id }, (response: any) => {
      if (response?.accepted === false) {
        dispatch({
          type: 'UPDATE_TASK',
          payload: { errorMsg: response?.message || '恢复失败' },
        });
      }
    });
  }, [task, dispatch]);

  // 状态相关的 UI
  const placeholder = (() => {
    if (isAuditing) return '正在整理录制的工作流...';
    if (!task) return '有什么想让我做的？';
    if (isRunning) return '处理中，可继续输入补充指令…';
    return '继续对话...';
  })();

  const canResume = task?.status === 'error' && task.hasContext === true && !!task.failureCode;
  const logoUrl = chrome.runtime.getURL('actspan-logo.svg');

  return (
    <div className="actspan-input-row">
      <img className="actspan-input-icon" src={logoUrl} alt="" />
      <input
        ref={inputRef}
        className="actspan-input"
        type="text"
        placeholder={placeholder}
        autoComplete="off"
        disabled={isAuditing}
        onKeyDown={handleKeyDown}
      />
      <span className="actspan-input-hint" style={{ display: isRunning ? 'none' : '' }}>ESC</span>
      <button
        className={`actspan-new-btn${task && !isRunning ? ' visible' : ''}`}
        title="新对话"
        onClick={handleNew}
      >
        +
      </button>
      <button
        className={`actspan-retry-btn${canResume ? ' visible' : ''}`}
        title="重试"
        onClick={handleRetry}
      >
        ↻
      </button>
      <button
        className={`actspan-stop-btn${isRunning ? ' visible' : ''}`}
        title="终止任务"
        onClick={handleStop}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
          <rect x="0" y="0" width="10" height="10" rx="1.5" />
        </svg>
      </button>
    </div>
  );
};
