import type { SessionSyncPayload } from '../../ai/types';
import type { TaskItem } from './context/types';
import { buildTaskTitle } from './text-utils';

type SessionSyncData = Partial<SessionSyncPayload>
  & Pick<SessionSyncPayload, 'sessionId' | 'status'>
  & { query?: string };

/**
 * 判断会话事件是否属于当前标签页。
 *
 * background 会把所有会话事件广播给全部标签页；如果不过滤，其他标签页的
 * 运行中会话会被当前页“自动绑定”，导致聊天框串台、消息覆盖。
 * 缺少来源标记（旧版本/扩展页）时保持兼容，默认接受。
 */
export const isSessionVisibleInTab = (
  originTabId: unknown,
  selfTabId: unknown,
): boolean => {
  // 没有来源标记的旧事件保持兼容
  if (typeof originTabId !== 'number') return true;
  // 自身标签页尚未确定时先丢弃，避免把其他标签页的会话误绑过来
  if (typeof selfTabId !== 'number') return false;
  return originTabId === selfTabId;
};

type SessionSyncTaskResult =
  | { kind: 'ignore' }
  | { kind: 'clear' }
  | { kind: 'set'; task: TaskItem }
  | { kind: 'update'; update: Partial<TaskItem> };

const buildTaskFromSync = (sync: SessionSyncData, now: number): TaskItem => ({
  id: sync.sessionId,
  pendingSession: false,
  originTabId: sync.originTabId,
  activeRunId: sync.activeRunId,
  query: sync.query || '',
  title: buildTaskTitle(sync.summary || sync.query || ''),
  status: 'running',
  resultHtml: '',
  callStack: [],
  errorMsg: sync.lastError || '',
  lastAIText: '',
  agentPhase: sync.agentState?.phase || 'plan',
  agentRound: sync.agentState?.round || 0,
  failureCode: sync.failureCode || '',
  startedAt: sync.startedAt || now,
  endedAt: sync.endedAt ?? null,
  durationMs: sync.durationMs ?? null,
  taskKind: sync.taskKind,
  opQueue: sync.opQueue,
  hasContext: sync.hasContext,
});

export const reconcileSessionSyncTask = (
  currentTask: TaskItem | null,
  sync: SessionSyncData,
  now = Date.now(),
): SessionSyncTaskResult => {
  if (sync.status === 'cleared') {
    return currentTask?.id === sync.sessionId ? { kind: 'clear' } : { kind: 'ignore' };
  }

  const canBindSession = currentTask?.status === 'running';
  if (!currentTask || (currentTask.id !== sync.sessionId && !canBindSession)) {
    return sync.status === 'running'
      ? { kind: 'set', task: buildTaskFromSync(sync, now) }
      : { kind: 'ignore' };
  }

  const update: Partial<TaskItem> = {
    status: sync.status,
    activeRunId: sync.activeRunId,
    endedAt: sync.endedAt ?? (sync.status === 'running' ? null : now),
    durationMs: sync.durationMs ?? null,
    failureCode: sync.failureCode || '',
    errorMsg: sync.lastError || '',
    agentPhase: sync.agentState?.phase || currentTask.agentPhase,
    agentRound: sync.agentState?.round ?? currentTask.agentRound,
  };

  if (currentTask.id !== sync.sessionId) {
    update.id = sync.sessionId;
    update.pendingSession = false;
  }
  if (sync.originTabId !== undefined) update.originTabId = sync.originTabId;
  if (sync.summary) update.title = buildTaskTitle(sync.summary);
  if (sync.startedAt) update.startedAt = sync.startedAt;
  if (sync.taskKind) update.taskKind = sync.taskKind;
  if (sync.opQueue) update.opQueue = sync.opQueue;
  if (sync.hasContext !== undefined) update.hasContext = sync.hasContext;

  return { kind: 'update', update };
};
