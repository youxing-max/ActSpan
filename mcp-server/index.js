#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ExtensionHub, log } from './bridge.js';
import {
    RegistryCatalog,
    createRequestContext,
    normalizeTaskHandle,
    validateConfig,
} from './catalog.js';

const checked = validateConfig();

const safeError = (error) => {
    const message = String(error?.message || error || 'unknown error');
    return checked.config?.apiKey ? message.replaceAll(checked.config.apiKey, '[redacted]') : message;
};

const ok = (data) => ({
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
});
const fail = (error) => ({
    content: [{ type: 'text', text: `Actspan error: ${safeError(error)}` }],
    isError: true,
});

async function main(config) {
    const hub = new ExtensionHub(undefined, {
        port: config.bridgePort,
        pairOrigins: config.pairOrigins,
    });
    try {
        await hub.start();
    } catch (error) {
        process.stderr.write(`[actspan-mcp] Bridge startup failed: ${safeError(error)}\n`);
        process.exitCode = 1;
        return;
    }

    const clientId = randomUUID();
    const sessionId = randomUUID();
    const defaultTaskId = randomUUID();
    const catalog = new RegistryCatalog(hub);

    const callBridge = (method, params = {}, timeoutMs = 60000, task = {}) => {
        const taskId = task.taskId || params.taskId || defaultTaskId;
        const requestSessionId = task.sessionId || params.sessionId || sessionId;
        return hub.call(method, params, timeoutMs, createRequestContext({ clientId, taskId, sessionId: requestSessionId }));
    };

    const run = (fn) => async (args) => {
        try {
            const result = await fn(args || {});
            if (result && typeof result === 'object' && result.success === false) {
                return fail(result.error || result.message || result.data?.message || '操作失败');
            }
            return ok(result);
        } catch (error) {
            return fail(error);
        }
    };

    const tabIdParam = z.number().int().optional()
        .describe('Optional tab id. Mutating operations must use a tab leased to the current task.');
    const taskParams = {
        taskId: z.string().min(1).optional(),
        sessionId: z.string().min(1).optional(),
    };

    const server = new McpServer({ name: 'actspan-mcp', version: '1.0.0' });
    const registerTool = (name, definition, handler) => {
        if (typeof server.registerTool === 'function') {
            server.registerTool(name, definition, handler);
            return;
        }
        server.tool(name, definition.description, definition.inputSchema, handler);
    };


    registerTool('actspan_status', {
        title: 'Actspan bridge status',
        description: 'Check whether the local Actspan browser extension Bridge is connected.',
        inputSchema: {},
    }, run(async () => {
        const owner = {
            connectedAt: hub.connectedAt,
            ownerOrigin: hub.clientOrigin || null,
            lastReplacementReason: hub.lastReplacementReason || null,
        };
        if (!hub.isConnected()) {
            return {
                connected: false,
                hub_listening: hub.listening,
                port: hub.port,
                ...owner,
                lastError: hub.lastError || null,
                hint: hub.listening
                    ? 'Bridge is listening but the allowlisted Actspan extension is not connected.'
                    : `Bridge could not listen on port ${hub.port}: ${hub.lastError || 'not listening'}`,
            };
        }
        return { ...await callBridge('ping', {}, 5000), connected: true, ...owner };
    }));
    registerTool('actspan_feishu_push', {
        title: 'Push Feishu notification',
        description: 'Send a notification through enabled Feishu/Lark bot webhooks configured in the extension. Optional webhookName must match exactly; omit it to send to all enabled Feishu webhooks. No browser tab or confirmation prompt is required.',
        inputSchema: {
            title: z.string().min(1),
            message: z.string(),
            webhookName: z.string().min(1).optional().describe('Exact configured webhook name; omit to target all enabled Feishu webhooks.'),
        },
    }, run((args) => callBridge('feishu.push', args, 30000)));

    registerTool('actspan_tabs_list', {
        title: 'List browser tabs', description: 'List browser tabs visible to the current Actspan task.', inputSchema: {},
    }, run((args) => callBridge('tabs.list', args)));

    registerTool('actspan_tab_open', {
        title: 'Open tab', description: 'Open a browser tab for the current task.',
        inputSchema: {
            ...taskParams,
            url: z.string().url(),
            active: z.boolean().default(false),
        },
    }, run((args) => callBridge('tab.open', args, 30000, args)));

    registerTool('actspan_tab_close', {
        title: 'Close tab', description: 'Close a tab owned by the current task.',
        inputSchema: { ...taskParams, tabId: z.number().int() },
    }, run((args) => callBridge('tab.close', args, 10000, args)));

    registerTool('actspan_tab_navigate', {
        title: 'Navigate tab', description: 'Navigate a tab owned by the current task.',
        inputSchema: { ...taskParams, tabId: tabIdParam, url: z.string().url() },
    }, run((args) => callBridge('tab.navigate', args, 30000, args)));

    registerTool('actspan_page_read', {
        title: 'Read page', description: 'Read text or HTML from a task-owned tab; when tabId is omitted, read the active tab.',
        inputSchema: {
            ...taskParams,
            tabId: tabIdParam,
            format: z.enum(['text', 'html']).default('text'),
            maxChars: z.number().int().min(1000).max(200000).default(20000),
        },
    }, run((args) => callBridge('page.read', args, 30000, args)));

    registerTool('actspan_page_click', {
        title: 'Click page element', description: 'Click a DOM element in a tab owned by the current task.',
        inputSchema: { ...taskParams, tabId: tabIdParam, selector: z.string().min(1) },
    }, run((args) => callBridge('page.click', args, 30000, args)));

    registerTool('actspan_page_type', {
        title: 'Type into page', description: 'Type into a DOM input in a tab owned by the current task.',
        inputSchema: {
            ...taskParams,
            tabId: tabIdParam,
            selector: z.string().min(1),
            text: z.string(),
            submit: z.boolean().default(false),
        },
    }, run((args) => callBridge('page.type', args, 30000, args)));

    registerTool('actspan_page_eval', {
        title: 'Evaluate page expression', description: 'Evaluate a page expression; policy approval remains enforced by the extension.',
        inputSchema: { ...taskParams, tabId: tabIdParam, expression: z.string().min(1) },
    }, run((args) => callBridge('page.eval', args, 30000, args)));

    registerTool('actspan_screenshot', {
        title: 'Capture screenshot', description: 'Capture a screenshot from a task-owned tab; when tabId is omitted, capture the active tab.',
        inputSchema: { ...taskParams, tabId: tabIdParam },
    }, async (args) => {
        try {
            const result = await callBridge('page.screenshot', args || {}, 30000, args || {});
            return { content: [{ type: 'image', data: result.data, mimeType: 'image/png' }] };
        } catch (error) {
            return fail(error);
        }
    });

    registerTool('actspan_skills_list', {
        title: 'List skills and workflows', description: 'Read the current Actspan registry revision and skill summaries.', inputSchema: {},
    }, run(() => catalog.list(createRequestContext({ clientId, taskId: defaultTaskId, sessionId }))));

    registerTool('actspan_skill_detail', {
        title: 'Get skill detail', description: 'Read a complete skill and its structured workflow contracts.',
        inputSchema: { name: z.string().min(1) },
    }, run((args) => catalog.detail(args.name, createRequestContext({ clientId, taskId: defaultTaskId, sessionId }))));

    const workflowRun = run(async (args) => {
        const taskId = args.taskId || randomUUID();
        const taskSessionId = args.sessionId || taskId;
        const params = { ...args, taskId, sessionId: taskSessionId };
        const result = await callBridge('workflow.run', params, 60000, { taskId, sessionId: taskSessionId });
        return normalizeTaskHandle(result, { taskId, sessionId: taskSessionId });
    });
    registerTool('actspan_workflow_run', {
        title: 'Run workflow', description: 'Start a structured workflow and return an asynchronous task handle.',
        inputSchema: {
            ...taskParams,
            name: z.string().min(1),
            input: z.record(z.unknown()).default({}),
        },
    }, workflowRun);

    const agentSubmit = run(async (args) => {
        const taskId = args.taskId || randomUUID();
        const taskSessionId = args.sessionId || taskId;
        const params = { ...args, ...args.input, taskId, sessionId: taskSessionId };
        const result = await callBridge('task.submit', params, 60000, { taskId, sessionId: taskSessionId });
        return normalizeTaskHandle(result, { taskId, sessionId: taskSessionId });
    });
    registerTool('actspan_agent_submit', {
        title: 'Submit agent task', description: 'Start an open-ended browser task and return an asynchronous task handle.',
        inputSchema: { ...taskParams, input: z.record(z.unknown()).default({}), query: z.string().optional() },
    }, agentSubmit);

    const taskCall = (method) => run(async (args) => {
        const taskId = String(args.taskId || '').trim();
        if (!taskId) throw new Error('taskId is required');
        const taskSessionId = args.sessionId || taskId;
        return await callBridge(method, { ...args, taskId, sessionId: taskSessionId }, 30000, {
            taskId,
            sessionId: taskSessionId,
        });
    });
    registerTool('actspan_agent_status', {
        title: 'Get agent task status', description: 'Read an agent task state by taskId.', inputSchema: taskParams,
    }, taskCall('task.status'));
    registerTool('actspan_agent_result', {
        title: 'Get agent task result', description: 'Read the retained result of an agent task by taskId.', inputSchema: taskParams,
    }, taskCall('task.result'));
    registerTool('actspan_agent_cancel', {
        title: 'Cancel agent task', description: 'Cancel an agent task by taskId.', inputSchema: taskParams,
    }, taskCall('task.cancel'));

    await server.connect(new StdioServerTransport());
    log('Actspan stdio MCP server ready');
}

if (!checked.valid) {
    process.stderr.write(`[actspan-mcp] Invalid configuration:\n${checked.errors.map(error => `- ${error}`).join('\n')}\n`);
    process.exitCode = 1;
} else {
    await main(checked.config);
}
