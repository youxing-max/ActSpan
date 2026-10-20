import { adoptActDraft } from '../background/act-drafts';
import { tabLeaseManager } from '../background/tab-lease-manager';
import type { TaskContext } from '../background/task-types';
import type { FunctionDefinition, ToolExecutionContext } from './types';

const ownedContext = (context?: ToolExecutionContext): TaskContext | null => {
  if (!context?.clientId || !context.requestId || !context.taskId || !context.sessionId || !context.owner) return null;
  return {
    clientId: context.clientId,
    requestId: context.requestId,
    taskId: context.taskId,
    sessionId: context.sessionId,
    owner: context.owner,
    tabId: context.tabId,
    signal: context.signal,
  };
};

export const adoptFunction: FunctionDefinition = {
  name: 'adopt',
  description: 'Promote a successful act draft into local site experience. This is explicit and site-bound: the draft must belong to the current task-owned tab.',
  supportsParallel: false,
  permissionLevel: 'sensitive',
  approvalMessageTemplate: 'AI 正在将成功操作草稿写入当前站点的本地经验',
  parameters: {
    type: 'object',
    properties: {
      draft_id: { type: 'string', description: 'Draft ID returned by a successful act run' },
      tab_id: { type: 'number', description: 'Task-owned site tab; defaults to the task context tab' },
    },
    required: ['draft_id'],
  },
  validate: (params: { draft_id?: unknown }) => typeof params?.draft_id === 'string' && params.draft_id.trim()
    ? null : 'draft_id is required',
  execute: async (params: { draft_id: string; tab_id?: number }, context?: ToolExecutionContext) => {
    const taskContext = ownedContext(context);
    if (!taskContext) {
      return { success: false, error: 'adopt is unavailable without clientId, requestId, taskId, sessionId, and owner context' };
    }
    const tabId = params.tab_id ?? context?.tabId;
    if (typeof tabId !== 'number') return { success: false, error: 'adopt requires a task-owned tab' };
    try {
      tabLeaseManager.authorizeWrite(taskContext, tabId);
      return { success: true, data: await adoptActDraft({ draftId: params.draft_id, tabId }) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'draft adoption failed' };
    }
  },
};
