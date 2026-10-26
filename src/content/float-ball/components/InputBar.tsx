/**
 * 输入框组件
 * 功能：文字输入、Enter 提交、上下键历史浏览、状态按钮（终止/新对话/重试）
 */

import React, { useRef, useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ClockCircleOutlined, PaperClipOutlined, GlobalOutlined } from '@ant-design/icons';
import Channel from '../../../lib/channel';
import { useActspan } from '../context/useActspan';
import { buildTaskTitle, formatClock } from '../text-utils';
import type { TaskItem, RoundItem } from '../context/types';
import { SESSION_HISTORY_STORAGE_KEY } from '../../../session-history/constants';
import type { SessionHistoryRecord } from '../../../session-history/types';

interface InputBarProps {
  resultRef: React.RefObject<HTMLDivElement | null>;
}

/** 随消息附带的图片附件 */
interface ImageAttachment {
  id: string;
  dataUrl: string;
  name: string;
  sizeKB: number;
}

/** 附件上限：与 background 的 normalizeQueryImages 保持一致 */
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

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

  // ── 附件（图片）/ 联网搜索 / 历史记录 ──
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [webSearch, setWebSearch] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyRecords, setHistoryRecords] = useState<SessionHistoryRecord[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const readAsDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });

  /** 把一批文件转成附件预览（选择与粘贴共用） */
  const addAttachmentFiles = useCallback(async (picked: File[]) => {
    if (picked.length === 0) return;
    const accepted: ImageAttachment[] = [];
    for (const file of picked) {
      if (attachments.length + accepted.length >= MAX_ATTACHMENTS) break;
      if (!file.type.startsWith('image/')) continue;
      if (file.size > MAX_ATTACHMENT_BYTES) continue;
      try {
        const dataUrl = await readAsDataUrl(file);
        accepted.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          dataUrl,
          name: file.name || '粘贴的图片',
          sizeKB: Math.max(1, Math.round(file.size / 1024)),
        });
      } catch { /* 单张失败不影响其他 */ }
    }
    if (accepted.length > 0) {
      setAttachments((prev) => [...prev, ...accepted].slice(0, MAX_ATTACHMENTS));
    }
  }, [attachments.length]);

  const handleFilesSelected = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files || []);
    event.target.value = '';
    await addAttachmentFiles(picked);
  }, [addAttachmentFiles]);

  /** 直接在输入框粘贴截图/图片文件 */
  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLInputElement>) => {
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    const files: File[] = [];
    for (const item of Array.from(clipboard.items || [])) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    // 也兼容 clipboardData.files（部分环境只填这里）
    for (const file of Array.from(clipboard.files || [])) {
      if (!files.includes(file)) files.push(file);
    }
    if (files.length === 0) return;
    // 阻止图片被当成路径/空白字符粘进输入框
    event.preventDefault();
    if (isRunning || isAuditing) return;
    void addAttachmentFiles(files);
  }, [addAttachmentFiles, isRunning, isAuditing]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((item) => item.id !== id));
  }, []);

  // 底部弹窗打开时，ESC 先收起弹窗，而不是清空会话
  useEffect(() => {
    if (!historyOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopImmediatePropagation();
      setHistoryOpen(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [historyOpen]);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const stored = await new Promise<Record<string, unknown>>((resolve) => {
        chrome.storage.local.get<Record<string, unknown>>(SESSION_HISTORY_STORAGE_KEY, resolve);
      });
      const raw = stored?.[SESSION_HISTORY_STORAGE_KEY];
      const list = Array.isArray(raw) ? (raw as SessionHistoryRecord[]) : [];
      setHistoryRecords([...list].sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0)));
    } catch {
      setHistoryRecords([]);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const handleToggleHistory = useCallback(() => {
    setHistoryOpen((open) => {
      const next = !open;
      if (next) void loadHistory();
      return next;
    });
  }, [loadHistory]);

  // 从历史记录恢复会话：先在面板回显轮次，再让 background 装载，便于继续对话
  const handleRestoreHistory = useCallback((record: SessionHistoryRecord) => {
    setHistoryOpen(false);
    const turns = Array.isArray(record.turns) ? record.turns : [];
    const rounds: RoundItem[] = turns.map((turn) => ({
      query: String(turn.query || ''),
      aiText: String(turn.reply || ''),
      callStack: [],
      status: turn.status === 'error' ? 'error' : 'done',
      errorMsg: turn.error,
      durationMs: turn.durationMs ?? null,
    }));
    dispatch({
      type: 'SET_TASK',
      payload: {
        id: record.sessionId,
        pendingSession: false,
        query: '',
        title: record.summary || '历史会话',
        status: record.status === 'done' ? 'done' : 'error',
        resultHtml: '',
        callStack: [],
        errorMsg: record.lastError || '',
        lastAIText: '',
        agentPhase: 'finalize',
        agentRound: turns.length,
        failureCode: record.failureCode || '',
        startedAt: record.startedAt || Date.now(),
        endedAt: record.endedAt ?? record.updatedAt ?? null,
        durationMs: record.durationMs ?? null,
        rounds,
      },
    });
    Channel.send('__session_restore', { sessionId: record.sessionId }, (response: any) => {
      if (response?.success === false) {
        dispatch({
          type: 'UPDATE_TASK',
          payload: { errorMsg: response?.message || '恢复该历史会话失败' },
        });
      }
    });
  }, [dispatch]);

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
    const images = attachments.map((item) => item.dataUrl);
    const withWebSearch = webSearch;
    const tempTask = createNewTask(value, state.selfTabId ?? undefined);
    dispatch({ type: 'SET_TASK', payload: tempTask });
    dispatch({ type: 'PUSH_INPUT_HISTORY', payload: value });
    // 附件已随本条消息发出，清空预览避免下一轮重复带上
    if (images.length > 0) setAttachments([]);

    Channel.send('__session_create', {
      query: value,
      tabId: state.selfTabId ?? undefined,
      ...(images.length > 0 ? { images } : {}),
      ...(withWebSearch ? { webSearch: true } : {}),
    }, (response: any) => {
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
  }, [dispatch, state.selfTabId, attachments, webSearch]);

  // 继续对话
  const continueTask = useCallback((value: string) => {
    if (!task) return;
    const images = attachments.map((item) => item.dataUrl);
    const withWebSearch = webSearch;
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
    if (images.length > 0) setAttachments([]);

    Channel.send(
      '__session_continue',
      {
        sessionId: task.id,
        query: value,
        tabId: state.selfTabId ?? undefined,
        ...(images.length > 0 ? { images } : {}),
        ...(withWebSearch ? { webSearch: true } : {}),
      },
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
  }, [task, dispatch, state.selfTabId, attachments, webSearch]);

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
    // 记下被终止这一轮的开始时间：同一会话里用户可能马上开始新一轮，
    // 兜底定时器只应该作用于「被终止的这一轮」。
    const stoppedRunStartedAt = task.startedAt;
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
      // 用户已经开始新一轮（startedAt 变了），不能把新一轮误判成「已停止」
      if (current.startedAt !== stoppedRunStartedAt) return;
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
    <div className="actspan-input-shell">
      {/* 工具行：附件 / 联网搜索 / 历史记录 */}
      <div className="actspan-tools-row">
        <button
          type="button"
          className={`actspan-tool-btn${attachments.length > 0 ? ' active' : ''}`}
          title={`上传图片附件（最多 ${MAX_ATTACHMENTS} 张，单张 ≤ 5MB）`}
          onClick={() => fileInputRef.current?.click()}
          disabled={isRunning || isAuditing}
        >
          <PaperClipOutlined className="actspan-tool-icon" />
          附件
          {attachments.length > 0 && <span className="actspan-tool-badge">{attachments.length}</span>}
        </button>
        <button
          type="button"
          className={`actspan-tool-btn${webSearch ? ' active' : ''}`}
          title="开启后本轮先联网检索再作答"
          aria-pressed={webSearch}
          onClick={() => setWebSearch((on) => !on)}
        >
          <GlobalOutlined className="actspan-tool-icon" />
          联网搜索
        </button>
        <button
          type="button"
          className={`actspan-tool-btn${historyOpen ? ' active' : ''}`}
          title="查看并恢复历史会话"
          onClick={handleToggleHistory}
        >
          <ClockCircleOutlined className="actspan-tool-icon" />
          历史记录
        </button>
      </div>

      {/* 附件预览 */}
      {attachments.length > 0 && (
        <div className="actspan-attachments">
          {attachments.map((item) => (
            <span className="actspan-attachment" key={item.id}>
              <img className="actspan-attachment-thumb" src={item.dataUrl} alt={item.name} title={`${item.name} · ${item.sizeKB}KB`} />
              <button
                type="button"
                className="actspan-attachment-remove"
                title="移除该图片"
                onClick={() => removeAttachment(item.id)}
              >
                ×
              </button>
            </span>
          ))}
          <span className="actspan-attachments-hint">随本条消息发送</span>
        </div>
      )}

      {/* 历史记录：从底部弹出（portal 到 body，避免祖先 transform 影响 fixed 定位） */}
      {historyOpen && createPortal(
        <div
          className="actspan-sheet-backdrop"
          role="presentation"
          onClick={() => setHistoryOpen(false)}
        >
          <div
            className="actspan-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="历史记录"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="actspan-sheet-handle" aria-hidden="true" />
            <div className="actspan-history-head">
              <span className="actspan-history-head-title">历史记录</span>
              <span className="actspan-history-head-actions">
                <button type="button" className="actspan-history-refresh" title="刷新" onClick={() => void loadHistory()}>↻</button>
                <button type="button" className="actspan-history-all" onClick={() => Channel.send('__open_options_page', {})}>查看全部</button>
                <button type="button" className="actspan-sheet-close" title="收起" onClick={() => setHistoryOpen(false)}>×</button>
              </span>
            </div>
            {historyLoading ? (
              <div className="actspan-history-empty">加载中…</div>
            ) : historyRecords.length === 0 ? (
              <div className="actspan-history-empty">还没有历史会话</div>
            ) : (
              <ul className="actspan-history-list">
                {historyRecords.slice(0, 20).map((record) => {
                  const turnCount = Array.isArray(record.turns) ? record.turns.length : 0;
                  const statusText = record.status === 'error' ? '失败' : record.status === 'cleared' ? '已清除' : '已完成';
                  return (
                    <li key={record.sessionId}>
                      <button
                        type="button"
                        className="actspan-history-item"
                        onClick={() => handleRestoreHistory(record)}
                        title={record.summary || record.sessionId}
                      >
                        <span className="actspan-history-item-title">{record.summary || '未命名会话'}</span>
                        <span className="actspan-history-item-meta">
                          {statusText} · {turnCount} 轮 · {formatClock(record.updatedAt || record.startedAt)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>,
        document.body,
      )}

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
          onPaste={handlePaste}
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

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={handleFilesSelected}
      />
    </div>
  );
};
