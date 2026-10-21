#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { log } from './bridge.js';
import { createLazyBridgeDaemonClient } from './daemon-rpc.js';
import { ensureBridgeDaemon } from './bridge-lock.js';
import { createStableSessionId, normalizeHostIdentity } from './identity.js';
import { readUsage } from './usage.js';
import registerActTool from './act-tool.js';
import { registerInteractionTools } from './interaction-tools.js';
import registerNetworkTools from './network-tool.js';
import registerDataTools from './data-tools.js';
import { registerStatusTool } from './status-tool.js';
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
    const clientId = randomUUID();
    const fallbackIndex = process.argv.indexOf('--client');
    const fallbackClient = fallbackIndex < 0 ? '' : process.argv[fallbackIndex + 1] || '';
    let host = normalizeHostIdentity('', fallbackClient);
    let sessionId = createStableSessionId(host.slug, process.pid);
    // 零环境契约：daemon 与元数据在任何 MCP 握手之前就位，`actspan_status` 才有真状态可报。
    try {
        await ensureBridgeDaemon({ port: config.bridgePort, pairOrigins: config.pairOrigins });
    } catch (error) {
        process.stderr.write(`[actspan-mcp] Bridge startup failed: ${safeError(error)}\n`);
        process.exitCode = 1;
        return;
    }
    // K2：label 连上就冻结，所以 IPC 连接推迟到 `oninitialized` 之后——那时自报身份已压过 --client。
    const hub = createLazyBridgeDaemonClient({ port: config.bridgePort, pairOrigins: config.pairOrigins,
        clientId, sessionId, label: host.slug });
    const defaultTaskId = randomUUID();
    const usageForHost = (slug) => {
        const entry = readUsage().hosts[slug];
        return entry
            ? { host: slug, calls: entry.calls, firstAt: entry.firstAt, lastAt: entry.lastAt, tools: { ...entry.tools } }
            : { host: slug, calls: 0, firstAt: null, lastAt: null, tools: {} };
    };

    const catalog = new RegistryCatalog(hub);

    const callBridge = (method, params = {}, timeoutMs = 60000, task = {}) => {
        const taskId = task.taskId || params.taskId || defaultTaskId;
        const requestSessionId = task.sessionId || params.sessionId || sessionId;
        return hub.call(method, params, timeoutMs, createRequestContext({ clientId, taskId, sessionId: requestSessionId, host: host.slug }));
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
    server.server.oninitialized = () => {
        host = normalizeHostIdentity(server.server.getClientVersion()?.name, fallbackClient);
        sessionId = createStableSessionId(host.slug, process.pid);
        hub.label = host.slug;
        hub.sessionId = sessionId;
        void hub.connect().catch((error) => log(`bridge connect failed: ${safeError(error)}`));
        log(`host initialized slug=${host.slug} source=${host.source}`);
    };
    // SDK 1.11 没有 registerTool：legacy tool() 只认 raw shape，把 ZodObject 直接传进去会被
    // 当成 annotations，参数表退化成空对象（模型看不到任何参数）。这里两种形态都归一成 shape。
    const registerTool = (name, definition, handler) => {
        if (typeof server.registerTool === 'function') {
            server.registerTool(name, definition, handler);
            return;
        }
        const schema = definition.inputSchema;
        const shape = schema && typeof schema.shape === 'object' ? schema.shape : schema;
        server.tool(name, definition.description, shape, handler);
    };


    registerTool('actspan_status', {
        title: 'Actspan bridge status',
        description: 'Check whether the local Actspan browser extension Bridge is connected.',
        inputSchema: {},
    }, run(async () => {
        // The daemon pushes events but not status frames, so pull the authoritative snapshot before
        // deciding whether an extension is actually paired.
        await hub.status();
        const owner = {
            connectedAt: hub.connectedAt,
            ownerOrigin: hub.clientOrigin || null,
            lastReplacementReason: hub.lastReplacementReason || null,
            compatibility: hub.compatibility || null,
            appVersion: hub.compatibility?.localVersion || null,
            protocolVersion: hub.compatibility?.localProtocol || null,
            host: { slug: host.slug, display: host.display, source: host.source },
            // K3：宿主身份不只进日志——配额/积分系统按同一个 slug 取数。
            usage: usageForHost(host.slug),
        };
        // Startup (this process + the local Bridge daemon) is independent from an authenticated browser
        // pairing: zero-env runs must answer here instead of failing, and browser capabilities stay
        // unavailable until an allowlisted extension completes the pairing handshake.
        if (!hub.extensionConnected) {
            return {
                connected: false,
                loop_mode: 'disabled',
                pairing_required: Boolean(config.pairingRequired),
                hub_listening: hub.listening,
                port: hub.port,
                ...owner,
                lastError: hub.lastError || null,
                hint: config.pairingRequired
                    ? 'No ACTSPAN_EXTENSION_IDS allowlist is configured; the Bridge accepts no extension until `actspan-install` records the exact ID from the pairing page.'
                    : hub.listening
                        ? 'Bridge is listening but the allowlisted Actspan extension is not connected.'
                        : `Bridge could not listen on port ${hub.port}: ${hub.lastError || 'not listening'}`,
            };
        }
        return { ...await callBridge('ping', {}, 5000), connected: true, loop_mode: 'enabled', pairing_required: false, ...owner };
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
        title: 'List browser tabs', description: 'List browser tabs visible to the current Actspan task.', inputSchema: taskParams,
    }, run((args) => callBridge('tabs.list', args, 10000, args)));

    registerTool('actspan_tab_open', {
        title: 'Open tab',
        // D10：默认后台打开，受控≠前台。唯一的显式前台通道是 focus:true，且必须写明代价。
        description: 'Open a browser tab for the current task. The tab opens in the background by default, so the user\'s current tab keeps the foreground and every other tool still works on it. Set focus:true only when the user asked to see the page: it brings the tab to the foreground and interrupts whatever the user is doing.',
        inputSchema: {
            ...taskParams,
            url: z.string().url(),
            focus: z.boolean().default(false).describe('Leave false (default) to open behind the user\'s current tab. true is the explicit foreground escape hatch: the tab is brought to the front and the user is interrupted.'),
            label: z.string().trim().min(1).max(80).optional(),
        },
    }, run(({ focus = false, ...args }) => callBridge('tab.open', { ...args, active: focus === true }, 30000, args)));

    registerTool('actspan_tabs_select', {
        title: 'Select active tab', description: 'Select a task-owned tab as the active browser tab.',
        inputSchema: { ...taskParams, tabId: z.number().int().nonnegative() },
    }, run((args) => callBridge('tabs.select', args, 10000, args)));


    registerTool('actspan_tab_close', {
        title: 'Close tab', description: 'Close a tab owned by the current task.',
        inputSchema: { ...taskParams, tabId: z.number().int() },
    }, run((args) => callBridge('tab.close', args, 30000, args)));
    // tab.close 是 sensitive 能力，必然走审批；审批窗口本身就有 25s。客户端只等 10s 会在用户
    // 还在看确认卡片时就报 "Bridge request timed out"，把可完成的操作变成必然失败。

    registerTool('actspan_tab_navigate', {
        title: 'Navigate tab', description: 'Navigate a tab owned by the current task.',
        inputSchema: { ...taskParams, tabId: tabIdParam, url: z.string().url() },
    }, run((args) => callBridge('tab.navigate', args, 30000, args)));

    const findParam = z.object({
        role: z.string().trim().min(1).max(80).optional(),
        name: z.string().trim().min(1).max(200).optional(),
        nth: z.number().int().nonnegative().optional(),
    }).strict().describe('Locate by accessible role and/or name without a snapshot. Exact name match wins; multiple matches error instead of guessing, so pass nth (0-based) or use a selector.');
    const targetFields = {
        selector: z.string().trim().min(1).max(2000).optional(),
        ref: z.string().trim().min(1).max(200).optional(),
        snapshotId: z.string().trim().min(1).max(200).optional(),
        find: findParam.optional(),
    };
    // `.superRefine()` 返回 ZodEffects，而 SDK 的 normalizeObjectSchema 认不出 ZodEffects：
    // 直接把它当 inputSchema，tools/list 里这个工具的参数表会变成空对象，模型看不到任何参数。
    // 所以发布用 ZodObject，交叉字段校验挂在 parse 用的副本上。
    const targetSchema = (fields, required) => {
        const schema = z.object({ ...taskParams, tabId: tabIdParam, ...targetFields, ...fields }).strict();
        const validate = schema.superRefine((args, ctx) => {
            const provided = [args.selector, args.ref, args.find].filter(Boolean).length;
            if (required && provided === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide exactly one of selector, ref+snapshotId, or find' });
            if (provided > 1) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'selector, ref, and find are mutually exclusive' });
            if (Boolean(args.ref) !== Boolean(args.snapshotId)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ref requires snapshotId and snapshotId requires ref' });
            if (args.find && !args.find.role && !args.find.name) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'find requires role or name' });
        });
        return { schema, validate };
    };
    // ZodError 默认的 message 是一串 JSON；交叉字段校验的错误必须能直接读。
    const parseTarget = (validate, args) => {
        const parsed = validate.safeParse(args);
        if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => issue.message).join('; '));
        return parsed.data;
    };
    const readTarget = targetSchema({
        format: z.enum(['text', 'html']).default('text'),
        maxChars: z.number().int().min(1000).max(200000).default(20000),
    }, false);
    const realParam = z.boolean().default(false).describe('Force real CDP input events instead of synthetic DOM events. Use when the synthetic click or type produced no observable effect; sensitive submit/payment/delete targets never auto-escalate and require this flag.');
    const clickTarget = targetSchema({ real: realParam }, true);
    const typeTarget = targetSchema({ text: z.string(), submit: z.boolean().default(false), real: realParam }, true);
    const snapshotSchema = z.object({
        ...taskParams,
        tabId: tabIdParam,
        query: z.string().trim().min(1).max(200).optional(),
        scope_selector: z.string().trim().min(1).max(2000).optional(),
        include_non_interactive: z.boolean().default(false),
        include_hidden: z.boolean().default(false),
        only_viewport: z.boolean().default(false),
        limit: z.number().int().min(1).max(60).default(20),
    }).strict();

    registerTool('actspan_page_snapshot', {
        title: 'Snapshot page elements',
        description: 'Return a deterministic semantic snapshot of a task-owned tab: interactive elements with refs. Elements inside open shadow roots are included. Elements inside child frames (including cross-origin iframes) are included with a frame-qualified ref ending in @fN; pass that ref back verbatim with the returned snapshotId to act or read inside that exact frame.',
        inputSchema: snapshotSchema,
    }, run((args) => {
        const checked = snapshotSchema.parse(args);
        return callBridge('page.snapshot', checked, 30000, checked);
    }));


    registerTool('actspan_page_read', {
        title: 'Read page', description: 'Read text or HTML from a task-owned tab; when tabId is omitted, read the active tab. Pass selector, ref+snapshotId, or find to read one element instead of the whole page.',
        inputSchema: readTarget.schema,
    }, run((args) => {
        const checked = parseTarget(readTarget.validate, args);
        return callBridge('page.read', checked, 30000, checked);
    }));

    registerTool('actspan_page_click', {
        title: 'Click page element', description: 'Click a DOM element in a tab owned by the current task. Locate it by exactly one of selector, ref+snapshotId (from a snapshot), or find {role, name, nth}. Synthetic DOM events are used first; when they produce no observable effect the click is automatically replayed as real CDP input events. Submit/payment/delete targets never auto-escalate; pass real:true to force real events (recorded in the audit trail).',
        inputSchema: clickTarget.schema,
    }, run((args) => {
        const checked = parseTarget(clickTarget.validate, args);
        return callBridge('page.click', checked, 30000, checked);
    }));

    registerTool('actspan_page_type', {
        title: 'Type into page', description: 'Type into a DOM input in a tab owned by the current task. Locate it by exactly one of selector, ref+snapshotId (from a snapshot), or find {role, name, nth}. Synthetic DOM events are used first; when they produce no observable effect the input is automatically replayed as real CDP input events. Submit/payment/delete targets never auto-escalate; pass real:true to force real events (recorded in the audit trail).',
        inputSchema: typeTarget.schema,
    }, run((args) => {
        const checked = parseTarget(typeTarget.validate, args);
        return callBridge('page.type', checked, 30000, checked);
    }));

    registerTool('actspan_page_eval', {
        title: 'Evaluate page expression',
        // V8 的 throwOnSideEffect 会把 DOM 属性读（如 input.value）也判成潜在副作用，
        // 所以「读取页面状态」不能靠 eval；在描述里点名替代工具，避免 agent 反复试错。
        description: 'Evaluate a page expression. The expression must be provably side-effect free: mutating JS is rejected even after approval, and DOM property reads such as input.value may be rejected by the V8 side-effect check. Use page_read with attr "value"/"text"/"checked" or page_snapshot to observe page state.',
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
    }, run(() => catalog.list(createRequestContext({ clientId, taskId: defaultTaskId, sessionId, host: host.slug }))));

    registerTool('actspan_skill_detail', {
        title: 'Get skill detail', description: 'Read a complete skill and its structured workflow contracts.',
        inputSchema: { name: z.string().min(1) },
    }, run((args) => catalog.detail(args.name, createRequestContext({ clientId, taskId: defaultTaskId, sessionId, host: host.slug }))));

    // 任务→会话映射：本进程新建的任务可能自带合成 session；外部（如 tab.open）建的任务属于当前 session。
    // 后续只带 taskId 的调用必须复用它，不能把 taskId 当成 sessionId。
    const taskSessions = new Map();
    const adoptTask = (taskId, taskSessionId) => {
        taskSessions.set(taskId, taskSessionId);
        return taskSessionId;
    };

    const workflowRun = run(async (args) => {
        const taskId = args.taskId || randomUUID();
        const taskSessionId = args.sessionId || taskSessions.get(taskId) || (args.taskId ? sessionId : taskId);
        adoptTask(taskId, taskSessionId);
        const params = { ...args, taskId, sessionId: taskSessionId };
        const result = await callBridge('workflow.run', params, 60000, { taskId, sessionId: taskSessionId });
        return normalizeTaskHandle(result, { taskId, sessionId: taskSessionId });
    });
    registerTool('actspan_workflow_run', {
        title: 'Run workflow', description: 'Start a structured workflow and return an asynchronous task handle.',
        inputSchema: {
            ...taskParams,
            mode: z.enum(['independent', 'continue', 'replace']).default('independent'),
            name: z.string().min(1),
            input: z.record(z.unknown()).default({}),
        },
    }, workflowRun);

    const agentSubmit = run(async (args) => {
        const taskId = args.taskId || randomUUID();
        const taskSessionId = args.sessionId || taskSessions.get(taskId) || (args.taskId ? sessionId : taskId);
        adoptTask(taskId, taskSessionId);
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
        const taskSessionId = args.sessionId || taskSessions.get(taskId) || sessionId;
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

    registerActTool({ registerTool, callBridge, run, tabIdParam, taskParams });
    registerInteractionTools({ registerTool, callBridge, run, tabIdParam, taskParams });
    registerNetworkTools({ registerTool, callBridge, run, tabIdParam, taskParams });
    registerDataTools({ registerTool, callBridge, run, tabIdParam, taskParams });
    registerStatusTool({ registerTool, callBridge, run, tabIdParam, taskParams });

    const transport = new StdioServerTransport();
    server.server.onclose = () => { void hub.stop(); };
    const onStdioClose = () => { void server.close().finally(() => process.exit(0)); };
    process.stdin.once('end', onStdioClose);
    process.stdin.once('close', onStdioClose);
    process.once('exit', () => { hub.stop(); });
    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.once(signal, () => { void server.close().finally(() => process.exit(0)); });
    }
    await server.connect(transport);
    log('Actspan stdio MCP server ready');
}

if (!checked.valid) {
    process.stderr.write(`[actspan-mcp] Invalid configuration:\n${checked.errors.map(error => `- ${error}`).join('\n')}\n`);
    process.exitCode = 1;
} else {
    await main(checked.config);
}
