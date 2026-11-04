/**
 * agent_task 工具：把扩展内置的异步 Agent 任务能力暴露为 MCP 工具
 *
 * 动作：
 *   submit        提交一个开放式浏览器任务，立即返回 task_id（异步执行）
 *   status        查询任务状态（queued/running/waiting_user/succeeded/failed/cancelled）
 *   result        读取任务终态结果
 *   cancel        取消任务
 *   workflow_run  按名称运行已启用技能中的结构化工作流（异步任务句柄）
 *
 * 任务本体由扩展内置 Phase Orchestrator + Agentic Loop 执行，
 * 模型使用用户在扩展 Options「模型与连接」中配置的 LLM（endpoint/apiKey/model）。
 * 云端/本地桥接只负责递交指令与读取状态，不参与执行。
 *
 * 内部复用 policy-executor 的 capability 处理器（task.submit/task.status/
 * task.result/task.cancel/workflow.run），与本地 mcp-bridge 走同一套实现。
 */

import type { FunctionDefinition, FunctionResult, ToolExecutionContext } from './types';
import type { TaskContext } from '../background/task-types';

/** 远程代理提交的任务归属标记 */
const TASK_OWNER = 'ide-agent' as const;
/** 客户端标识：经 MCP 工具总线进入的任务 */
const CLIENT_ID = 'tool-bus';

type AgentTaskAction = 'submit' | 'status' | 'result' | 'cancel' | 'workflow_run';

const newId = (): string =>
    (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

/** 构造 policy-executor 需要的绑定上下文（clientId/requestId/taskId/sessionId 四元组必填） */
const buildContext = (
    params: Record<string, any>,
    context: ToolExecutionContext | undefined,
): TaskContext => {
    const taskId = typeof params.task_id === 'string' && params.task_id.trim()
        ? params.task_id.trim()
        : newId();
    return {
        clientId: CLIENT_ID,
        requestId: newId(),
        taskId,
        // 与本地桥接约定一致：未显式指定 session 时，任务自成一会话
        sessionId: taskId,
        owner: TASK_OWNER,
        tabId: context?.tabId,
        signal: context?.signal,
    };
};

const ok = (data: unknown): FunctionResult => ({ success: true, data });
const fail = (error: string): FunctionResult => ({ success: false, error });

export const agentTaskFunction: FunctionDefinition = {
    name: 'agent_task',
    description: [
        '异步 Agent 任务管理：提交开放式浏览器任务并轮询结果，或按名称运行结构化工作流。',
        '任务在扩展内置 Agent 循环中异步执行（使用扩展已配置的 LLM），提交后立即返回 task_id，',
        '不阻塞当前调用；用 status 轮询状态，succeeded/failed 后用 result 取结果。',
        '动作：submit（需 query）/ status / result / cancel（需 task_id）/ workflow_run（需 name）。',
        '⚠️ 不要用此工具来：执行单步页面操作（用 page / cdp_input 等同步工具更快）；',
        '查询工具列表或连接状态（用 cloud_status / status）。',
    ].join(''),
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['submit', 'status', 'result', 'cancel', 'workflow_run'],
                description: '操作类型',
            },
            query: {
                type: 'string',
                description: '任务目标的自然语言描述（submit 必填）',
            },
            task_id: {
                type: 'string',
                description: '任务 ID（status/result/cancel 必填；submit 可选，用于指定 ID）',
            },
            name: {
                type: 'string',
                description: '工作流名称（workflow_run 必填，须为已启用技能中的唯一工作流名）',
            },
            input: {
                type: 'object',
                description: '工作流参数键值对（workflow_run 可选）',
            },
            mode: {
                type: 'string',
                enum: ['independent', 'continue', 'replace'],
                description: '会话模式，默认 independent',
            },
        },
        required: ['action'],
    },
    supportsParallel: false,
    permissionLevel: 'interact',
    actionPermissions: {
        status: 'read',
        result: 'read',
    },
    validate: (params: any): string | null => {
        const action = params?.action as AgentTaskAction | undefined;
        if (!action) return '缺少 action';
        if (action === 'submit' && !(typeof params.query === 'string' && params.query.trim())) {
            return 'submit 需要非空 query';
        }
        if ((action === 'status' || action === 'result' || action === 'cancel')
            && !(typeof params.task_id === 'string' && params.task_id.trim())) {
            return `${action} 需要 task_id`;
        }
        if (action === 'workflow_run' && !(typeof params.name === 'string' && params.name.trim())) {
            return 'workflow_run 需要 name';
        }
        return null;
    },
    execute: async (params: any, context?: ToolExecutionContext): Promise<FunctionResult> => {
        const action = params.action as AgentTaskAction;
        // 延迟加载：避免把 policy-executor（及其 background 依赖）静态拽进工具总线的模块图，
        // 否则测试环境在模块加载后会产生异步副作用（unhandled rejection）。
        const { getTaskExecutor } = await import('../background/policy-executor');
        const executor = getTaskExecutor();
        const ctx = buildContext(params, context);

        try {
            switch (action) {
                case 'submit': {
                    const handle = await executor.execute(ctx, 'task.submit', {
                        query: params.query,
                        ...(typeof params.mode === 'string' ? { mode: params.mode } : {}),
                    }) as Record<string, unknown>;
                    return ok({
                        task_id: handle?.taskId ?? ctx.taskId,
                        session_id: handle?.sessionId ?? ctx.sessionId,
                        state: handle?.state ?? 'queued',
                        hint: '任务已异步提交；稍后用 agent_task(action=status) 轮询，终态后用 action=result 取结果',
                    });
                }
                case 'status': {
                    const task = await executor.execute(ctx, 'task.status', {}) as Record<string, unknown> | undefined;
                    if (!task) return fail(`任务不存在: ${ctx.taskId}`);
                    return ok(task);
                }
                case 'result': {
                    const result = await executor.execute(ctx, 'task.result', {}) as Record<string, unknown> | undefined;
                    if (!result) return fail(`任务不存在: ${ctx.taskId}`);
                    return ok(result);
                }
                case 'cancel': {
                    const result = await executor.execute(ctx, 'task.cancel', {}) as Record<string, unknown>;
                    return ok(result);
                }
                case 'workflow_run': {
                    const handle = await executor.execute(ctx, 'workflow.run', {
                        name: params.name,
                        input: params.input && typeof params.input === 'object' ? params.input : {},
                        ...(typeof params.mode === 'string' ? { mode: params.mode } : {}),
                    }) as Record<string, unknown>;
                    return ok({
                        task_id: handle?.taskId ?? ctx.taskId,
                        session_id: handle?.sessionId ?? ctx.sessionId,
                        state: handle?.state ?? 'queued',
                    });
                }
                default:
                    return fail(`未知 action: ${String(action)}`);
            }
        } catch (err: any) {
            return fail(err?.message || 'agent_task 执行失败');
        }
    },
};
