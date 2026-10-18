import type { SessionSyncPayload } from '../../ai/types';
import type { TaskItem } from './context/types';
import { buildTaskTitle } from './text-utils';

type SessionSyncData = Partial<SessionSyncPayload>
  & Pick<SessionSyncPayload, 'sessionId' | 'status'>
  & { query?: string };

type SessionSyncTaskResult =
  | { kind: 'ignore' }
  | { kind: 'clear' }
  | { kind: 'set'; task: TaskItem }
  | { kind: 'update'; update: Partial<TaskItem> };

const buildTaskFromSync = (sync: SessionSyncData, now: number): TaskItem => ({
  id: sync.sessionId,
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

  if (currentTask.id !== sync.sessionId) update.id = sync.sessionId;
  if (sync.summary) update.title = buildTaskTitle(sync.summary);
  if (sync.startedAt) update.startedAt = sync.startedAt;
  if (sync.taskKind) update.taskKind = sync.taskKind;
  if (sync.opQueue) update.opQueue = sync.opQueue;
  if (sync.hasContext !== undefined) update.hasContext = sync.hasContext;

  return { kind: 'update', update };
};
