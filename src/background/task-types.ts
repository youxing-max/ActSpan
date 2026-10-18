export type BrowserTaskState =
  | 'queued'
  | 'running'
  | 'waiting_user'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type TaskOwner = 'ide-agent' | 'extension-agent' | 'user';

export interface BrowserTask {
  taskId: string;
  sessionId: string;
  owner: TaskOwner;
  clientId?: string;
  parentTaskId?: string;
  state: BrowserTaskState;
  ownedTabIds: number[];
  activeTabId?: number;
  registryRevision: number;
  createdAt: number;
  updatedAt: number;
  error?: { code: string; message: string };
  result?: unknown;
}

export interface TabLease {
  taskId: string;
  sessionId: string;
  clientId: string;
  tabId: number;
  creator: TaskOwner;
  createdAt: number;
  expiresAt: number;
  releasedAt?: number;
}

export interface TaskContext {
  clientId: string;
  requestId: string;
  taskId: string;
  sessionId: string;
  tabId?: number;
  owner: TaskOwner;
  creator?: string;
  approval?: boolean;
  workflowStep?: boolean;
  finalize?: boolean;
  signal?: AbortSignal;
}

export type CapabilityHandler = (
  input: Record<string, unknown>,
  context: TaskContext,
) => Promise<unknown>;

export type PermissionLevel = 'read' | 'interact' | 'sensitive' | 'dangerous';

export interface PolicyDecision {
  level: PermissionLevel;
  requiresApproval: boolean;
}

export interface PersistedTaskState {
  version: 1;
  tasks: BrowserTask[];
  leases: TabLease[];
  updatedAt: number;
}

export const TASK_STATES: readonly BrowserTaskState[] = [
  'queued', 'running', 'waiting_user', 'succeeded', 'failed', 'cancelled',
];

export const INTERRUPTED_TASK_ERROR = {
  code: 'E_TASK_RUNTIME_INTERRUPTED',
  message: '后台服务已重启，上一轮任务已中断。',
} as const;
