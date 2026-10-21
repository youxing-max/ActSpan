import { z } from 'zod';

const DEFAULT_DESCRIPTION = 'One short sentence telling the user what you are about to do (not what you are doing). Call before a multi-step task and whenever the plan changes. Instant, never blocks. Use the user\'s language. ≤80 chars. Requires a tab leased to this task: call tab_open first, otherwise the update is rejected.';

/** Register the user-facing explicit status operation without coupling to MCP SDK. */
export function registerStatusTool({ registerTool, callBridge, run, tabIdParam, taskParams }) {
    if (typeof registerTool !== 'function') throw new TypeError('registerTool is required');
    if (typeof callBridge !== 'function') throw new TypeError('callBridge is required');
    if (typeof run !== 'function') throw new TypeError('run is required');
    registerTool('actspan_status_update', {
        title: 'Update task status',
        description: DEFAULT_DESCRIPTION,
        inputSchema: {
            ...(taskParams || {}),
            tabId: tabIdParam || z.number().int().nonnegative().optional().describe('Optional session-owned tab id.'),
            text: z.string().trim().min(1).max(80).describe('One short sentence in the user\'s language.'),
            language: z.string().trim().min(1).max(32).optional().describe('Optional language tag, preserved as supplied.'),
            userInputs: z.array(z.string().trim().min(1)).max(20).optional().describe('Optional declared user inputs to mask out of the status copy.'),
        },
    }, run((args) => callBridge('page.status_update', args, 5000, args)));
}

export { DEFAULT_DESCRIPTION as STATUS_UPDATE_DESCRIPTION };
