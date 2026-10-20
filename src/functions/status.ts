import { updateStatus } from '../background/status-bridge';
import type { FunctionDefinition, ToolExecutionContext } from './types';

const hasOwnedTaskContext = (context?: ToolExecutionContext): context is ToolExecutionContext & {
  clientId: string;
  requestId: string;
  taskId: string;
  sessionId: string;
  owner: 'ide-agent' | 'extension-agent' | 'user';
} => Boolean(context?.clientId && context.requestId && context.taskId && context.sessionId && context.owner);

export const statusFunction: FunctionDefinition = {
  name: 'status',
  description: 'Show one short sentence telling the user what you are about to do. Call before a multi-step task and whenever the plan changes. Instant and non-blocking. Use the user\'s language and keep text to 80 characters or fewer.',
  supportsParallel: false,
  permissionLevel: 'read',
  parameters: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        minLength: 1,
        maxLength: 80,
        description: 'Short user-visible status in the user\'s language (80 characters maximum)',
      },
      language: {
        type: 'string',
        description: 'Optional language tag such as zh-CN or en-US',
      },
      tab_id: {
        type: 'number',
        description: 'Task-owned target tab; defaults to the task context tab',
      },
    },
    required: ['text'],
  },
  validate: (params: { text?: unknown }) => {
    if (typeof params?.text !== 'string' || !params.text.trim()) return 'text is required';
    if (Array.from(params.text.trim()).length > 80) return 'text must be 80 characters or fewer';
    return null;
  },
  execute: async (
    params: { text: string; language?: string; tab_id?: number },
    context?: ToolExecutionContext,
  ) => {
    if (!hasOwnedTaskContext(context)) {
      return {
        success: false,
        error: 'status is unavailable without clientId, requestId, taskId, sessionId, and owner context',
      };
    }
    try {
      const data = await updateStatus({
        text: params.text,
        language: params.language,
        tabId: params.tab_id ?? context.tabId,
      }, context);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'status update failed' };
    }
  },
};
