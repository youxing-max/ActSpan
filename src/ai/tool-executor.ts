/**
 * 工具执行层
 * 职责：调用 MCP 工具、spawn_subtask 递归、结果截断、事件广播
 */

import type { InputItem, OutputFunctionCallItem, AIStreamEvent, ToolSchema, MessageInputItem } from './types';
import type { PermissionLevel, ToolExecutionContext } from '../functions/types';
import { mcpClient, getRegisteredFunction } from '../functions/registry';
import { requestConfirmationFunction } from '../functions/request-confirmation';
import { truncateToolResult, getTextContent } from './context-manager';
import { taskManager } from '../background/task-manager';
import { tabLeaseManager } from '../background/tab-lease-manager';

/** Agent 执行器类型（由 orchestrator 注入） */
export type AgentRunner = (params: {
  type?: string;
  goal: string;
  tab_id?: number;
}, signal?: AbortSignal) => Promise<{ success: boolean; summary: string; agentId: string }>;

// ============ 统一 Agent 工具定义 ============

/** 统一 agent 工具 Schema（替代旧的 4 个独立子 agent 工具） */
const AGENT_TOOL_SCHEMA: ToolSchema = {
  type: 'function',
  name: 'agent',
  description: [
    '启动子 Agent 执行独立任务。支持并行：可同时启动多个 Agent 在不同标签页工作。',
    '',
    '预定义类型：',
    '- explore：只读侦察页面结构和交互元素',
    '- plan：分析任务并制定执行计划',
    '- review：独立验证操作结果',
    '- subtask：执行独立子目标（可使用大部分工具）',
    '',
    '⚠️ 不要用此工具来：',
    '- 简单的单步查询（直接用 page_viewer 等工具）',
    '- 需要当前完整上下文的操作（Agent 上下文是隔离的）',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['explore', 'plan', 'review', 'subtask'],
        description: '预定义 Agent 类型',
      },
      goal: {
        type: 'string',
        description: '任务目标描述，要具体明确',
      },
      tab_id: {
        type: 'number',
        description: '目标标签页 ID。不传则继承父 Agent 的 tab',
      },
    },
    required: ['goal'],
  },
};

/** 旧工具名 → agent type 映射（向后兼容） */
const LEGACY_AGENT_MAP: Record<string, string> = {
  spawn_subtask: 'subtask',
  explore: 'explore',
  plan: 'plan',
  review: 'review',
};

/** Agent 类型 → thinking 前缀 */
const AGENT_THINKING_PREFIX: Record<string, string> = {
  explore: '正在探索',
  plan: '正在规划',
  review: '正在审查',
  subtask: '正在处理子任务',
};

/** 判断是否是 agent 相关工具（含旧名别名） */
export const isAgentTool = (name: string): boolean =>
  name === 'agent' || name === 'send_message' || name in LEGACY_AGENT_MAP;

/** 返回 agent 工具的 schema 列表 */
export const getAgentSchemas = (): ToolSchema[] => [AGENT_TOOL_SCHEMA];

// ── 向后兼容导出 ──
export const getSubagentSchemas = getAgentSchemas;
export const isSubagent = isAgentTool;
export const getSubagentNames = (): string[] => ['agent', ...Object.keys(LEGACY_AGENT_MAP)];

/** 执行组类型：并行组或串行组 */
interface ExecutionGroup {
  type: 'parallel' | 'serial';
  calls: OutputFunctionCallItem[];
}

/**
 * 按 supportsParallel 标记将 calls 数组分组
 * 连续的 parallel 工具收集为一个并行组，serial 工具各自独立成组
 */
const buildExecutionGroups = async (calls: OutputFunctionCallItem[]): Promise<ExecutionGroup[]> => {
  const groups: ExecutionGroup[] = [];
  let currentParallelGroup: OutputFunctionCallItem[] = [];

  const flushParallelGroup = () => {
    if (currentParallelGroup.length > 0) {
      groups.push({ type: 'parallel', calls: [...currentParallelGroup] });
      currentParallelGroup = [];
    }
  };

  for (const call of calls) {
    // agent 工具支持并行执行（不再强制串行）
    if (isAgentTool(call.name)) {
      currentParallelGroup.push(call);
      continue;
    }

    const parallel = await mcpClient.isParallel(call.name);
    if (parallel) {
      currentParallelGroup.push(call);
    } else {
      flushParallelGroup();
      groups.push({ type: 'serial', calls: [call] });
    }
  }

  // 收尾：清空剩余的并行组
  flushParallelGroup();

  return groups;
};

/**
 * 执行一批工具调用
 * 支持并行分流：连续的 supportsParallel 工具用 Promise.all 并发执行
 */
/**
 * 会话级敏感操作信任标记：按 sessionId/taskId 隔离。
 * 无身份信息的调用（定时器、常驻任务等）不共享任何信任作用域，必须每次确认。
 */
const sensitiveTrustScopes = new Set<string>();

/** 解析信任作用域：优先会话，其次任务；没有身份时返回空串表示“永不信任”。 */
const resolveTrustScope = (context?: Omit<ToolExecutionContext, 'tabId' | 'signal'>): string =>
  context?.sessionId || context?.taskId || '';

/** 重置敏感操作信任标记；不传作用域时清空全部（仅供测试/登出）。 */
export const resetSensitiveAccessTrust = (scope?: string) => {
  if (scope) sensitiveTrustScopes.delete(scope);
  else sensitiveTrustScopes.clear();
};

export const executeToolCalls = async (
  calls: OutputFunctionCallItem[],
  tabId: number | undefined,
  signal: AbortSignal | undefined,
  emit: (event: AIStreamEvent) => void,
  agentRunner?: AgentRunner,
  executionContext?: Omit<ToolExecutionContext, 'tabId' | 'signal'>,
): Promise<InputItem[]> => {
  const results: InputItem[] = [];
  const trustScope = resolveTrustScope(executionContext);

  // ===== 元数据驱动的权限检查 =====

  /** 解析调用显式指定的目标标签页 */
  const explicitTargetTabId = (params: Record<string, any>): number | undefined => {
    const raw = params.tab_id ?? params.tabId;
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : undefined;
  };

  /** 是否跨标签页访问：显式目标与当前任务标签页不一致 */
  const isCrossTabTarget = (params: Record<string, any>): boolean => {
    const target = explicitTargetTabId(params);
    return target !== undefined && typeof tabId === 'number' && target !== tabId;
  };

  /** 获取工具+action 的实际权限等级（从 FunctionDefinition 元数据读取） */
  const resolvePermissionLevel = (name: string, params: Record<string, any>): PermissionLevel => {
    // Agent 编排工具由内部执行器接管，本身不产生直接副作用（子工具各自校验）
    if (isAgentTool(name)) return 'interact';
    const def = getRegisteredFunction(name);
    // 未知/动态工具的服务端行为无法预判，默认按敏感操作处理（P1-24）
    if (!def) return 'sensitive';
    const action = String(params.action || '');
    // action 级覆盖优先
    const baseLevel: PermissionLevel = (action && def.actionPermissions?.[action])
      ? def.actionPermissions[action]
      : def.permissionLevel || 'interact';
    // 读取/交互类工具跨标签页访问时提升为 sensitive，避免静默读取其他标签页
    if (isCrossTabTarget(params) && (baseLevel === 'read' || baseLevel === 'interact')) {
      return 'sensitive';
    }
    return baseLevel;
  };

  /** 生成确认消息（根据工具元数据的 approvalMessageTemplate 或兜底） */
  const buildApprovalMessage = (name: string, params: Record<string, any>): string | null => {
    const level = resolvePermissionLevel(name, params);
    if (level === 'read' || level === 'interact') return null;

    const def = getRegisteredFunction(name);
    const action = String(params.action || '');
    const template = typeof def?.approvalMessageTemplate === 'string'
      ? def.approvalMessageTemplate
      : def?.approvalMessageTemplate?.[action];

    const baseMessage = template
      ? template.replace(/\{(\w+)\}/g, (_, key: string) => String(params[key] ?? '?'))
      : `AI 正在执行需要授权的操作: ${name}${action ? ` (${action})` : ''}`;

    // 跨标签页访问必须在审批文案里点名目标，否则用户无法判断读的是哪个页面
    if (isCrossTabTarget(params)) {
      return `${baseMessage}（目标标签页 #${explicitTargetTabId(params)}，当前任务标签页 #${tabId}）`;
    }
    return baseMessage;
  };

  /** 带用户数据出站/可批量读取历史的工具：不能被“本次不再询问”长期放行 */
  const OUTBOUND_RISK_TOOLS = new Set(['fetch_url', 'webhook', 'history_search']);

  /** 判断是否每次必须确认（dangerous、跨标签页与数据外发工具不受 trustAll 影响） */
  const isAlwaysConfirmOperation = (name: string, params: Record<string, any>): boolean => {
    return resolvePermissionLevel(name, params) === 'dangerous'
      || (name === 'tab_navigate' && String(params.action || '') === 'open')
      || isCrossTabTarget(params)
      || OUTBOUND_RISK_TOOLS.has(name);
  };

  /**
   * 串行处理敏感操作确认
   * 返回 null 表示已通过（或无需确认），返回 string 表示被拒绝（值为 output）
   */
  const resolveSensitiveApproval = async (
    call: OutputFunctionCallItem,
  ): Promise<string | null> => {
    const params = safeParseArgs(call.arguments);
    const approvalMessage = buildApprovalMessage(call.name, params);
    if (!approvalMessage) return null;
    // 高危操作（导航/关闭标签页）始终需要确认，不受 trustAll 影响
    const alwaysConfirm = isAlwaysConfirmOperation(call.name, params);
    if (trustScope && sensitiveTrustScopes.has(trustScope) && !alwaysConfirm) return null;

    const approvalResult = await requestConfirmationFunction.execute(
      { message: approvalMessage },
      { tabId, signal, sessionId: executionContext?.sessionId, taskId: executionContext?.taskId },
    );
    const approved = approvalResult.success && approvalResult.data?.approved;
    // 用户选择“本轮内不再询问”时，后续自动跳过确认（跨标签页、dangerous 与外发工具除外）
    if (approved && approvalResult.data?.trustAll && !alwaysConfirm && trustScope) {
      sensitiveTrustScopes.add(trustScope);
    }
    if (approved) return null;

    // 被拒绝：emit 结果并返回 output
    const output = JSON.stringify({
      success: false,
      error: approvalResult.data?.userMessage || '用户拒绝了敏感数据访问请求',
    });
    emit({
      type: 'function_result',
      content: JSON.stringify({
        name: call.name,
        callId: call.call_id,
        success: false,
        message: '用户拒绝',
        cancelled: false,
      }),
    });
    return output;
  };

  /** 执行单个工具调用（不含 emit function_call，由调用方控制；确认已在外部完成） */
  const executeSingleTool = async (
    call: OutputFunctionCallItem,
  ): Promise<{ call: OutputFunctionCallItem; output: string }> => {
    const params = safeParseArgs(call.arguments);
    let output: string;

    // 执行器层禁用：即使模型伪造了未出现在 schema 中的工具名，也必须拒绝。
    const disallowed = executionContext?.disallowedTools;
    if (disallowed && (disallowed.has(call.name)
      || (disallowed.has('agent') && call.name !== 'send_message' && isAgentTool(call.name)))) {
      const message = `工具 ${call.name} 在当前会话中不可用`;
      output = JSON.stringify({ success: false, error: message });
      emit({
        type: 'function_result',
        content: JSON.stringify({ name: call.name, callId: call.call_id, success: false, message, cancelled: false }),
      });
      return { call, output };
    }

    // 显式目标必须落在当前任务租约内；同标签页若已被其他任务租用也不允许读取/操作。
    const targetTabId = explicitTargetTabId(params);
    const mustCheckLease = targetTabId !== undefined
      && (targetTabId !== tabId || Boolean(tabLeaseManager.get(targetTabId)));
    if (mustCheckLease) {
      try {
        const task = executionContext?.taskId ? taskManager.get(executionContext.taskId) : undefined;
        // 没有可验证的任务身份时不能跨标签页操作，避免绕过租约。
        if (!task) throw new Error('跨标签页操作需要有效的任务上下文');
        tabLeaseManager.authorize({
          taskId: task.taskId,
          sessionId: executionContext?.sessionId || task.sessionId,
          clientId: executionContext?.clientId || task.clientId || task.owner,
          requestId: executionContext?.requestId || `ai-${task.taskId}`,
          owner: task.owner,
        }, targetTabId, (getRegisteredFunction(call.name)?.permissionLevel || 'interact') !== 'read');
      } catch (error: any) {
        output = JSON.stringify({ success: false, error: error?.message || '目标标签页不在当前任务租约内' });
        emit({
          type: 'function_result',
          content: JSON.stringify({ name: call.name, callId: call.call_id, success: false,
            message: error?.message || '目标标签页不在当前任务租约内', cancelled: false }),
        });
        return { call, output };
      }
    }

    if (isAgentTool(call.name) && call.name !== 'send_message') {
      // 统一 Agent 执行（含旧工具名别名映射）
      const agentType = call.name === 'agent'
        ? (params.type || 'subtask')
        : LEGACY_AGENT_MAP[call.name];
      const goal = String(params.goal || '');
      const targetTabId = params.tab_id as number | undefined;
      const prefix = AGENT_THINKING_PREFIX[agentType] || '正在执行 Agent';
      emit({ type: 'thinking', content: `${prefix}：${goal.slice(0, 60)}` });

      if (!agentRunner) {
        output = JSON.stringify({ success: false, error: 'Agent 执行器未注入' });
      } else {
        try {
          const result = await agentRunner({ type: agentType, goal, tab_id: targetTabId }, signal);
          output = JSON.stringify({
            success: result.success,
            data: { summary: result.summary, agentId: result.agentId },
          });
        } catch (err: any) {
          output = JSON.stringify({
            success: false,
            error: err?.message || 'Agent 执行失败',
          });
        }
      }
    } else if (call.name === 'send_message') {
      // send_message 消息投递（Phase 3 完善）
      output = JSON.stringify({ success: false, error: 'send_message 尚未实现' });
    } else {
      // 常规工具执行
      try {
        const result = await mcpClient.callTool(
          call.name,
          params,
          { ...executionContext, tabId },
          { signal },
        );
        const text = result.content?.[0]?.text || '{}';
        output = truncateToolResult(text);
      } catch (err: any) {
        if (signal?.aborted) {
          output = JSON.stringify({ success: false, error: '任务已取消' });
        } else {
          output = JSON.stringify({
            success: false,
            error: err?.message || '工具执行异常',
          });
        }
      }
    }

    // 将截图附件 ID 传给侧栏；图片本体仍留在 ArtifactStore，避免把 base64 放进事件流。
    let resultSuccess = true;
    let resultMessage = '';
    let resultCancelled = false;
    let resultArtifactId: string | undefined;
    let resultDataMessage = '';
    try {
      const parsed = JSON.parse(output);
      resultSuccess = parsed.success !== false;
      resultMessage = parsed.error || parsed.data?.summary || parsed.data?.message || '';
      resultArtifactId = typeof parsed.data?.artifact_id === 'string' ? parsed.data.artifact_id : undefined;
      resultDataMessage = parsed.data?.message || '';
      resultCancelled = signal?.aborted === true && !resultSuccess;
    } catch {
      // output 解析失败，保持默认值
    }

    // 工具执行完成后立即 emit 结果（并行组内按完成顺序 emit）
    emit({
      type: 'function_result',
      content: JSON.stringify({
        name: call.name,
        callId: call.call_id,
        success: resultSuccess,
        message: resultMessage || resultDataMessage,
        artifactId: resultArtifactId,
        cancelled: resultCancelled,
      }),
    });

    return { call, output };
  };

  // 构建执行分组
  const groups = await buildExecutionGroups(calls);

  for (const group of groups) {
    if (signal?.aborted) break;

    if (group.type === 'serial' || group.calls.length === 1) {
      // 串行执行（包括只有 1 个工具的"并行组"退化为串行）
      for (const call of group.calls) {
        if (signal?.aborted) break;

        // 串行路径：先确认再执行
        const rejected = await resolveSensitiveApproval(call);
        if (rejected) {
          results.push({ type: 'function_call_output' as const, call_id: call.call_id, output: rejected });
          continue;
        }

        emit({
          type: 'function_call',
          content: JSON.stringify({
            name: call.name,
            callId: call.call_id,
            arguments: call.arguments,
          }),
        });

        const { output } = await executeSingleTool(call);

        results.push({
          type: 'function_call_output' as const,
          call_id: call.call_id,
          output,
        });
      }
    } else {
      // 并行执行：先串行完成所有敏感操作确认，再并发执行工具
      const approvedCalls: OutputFunctionCallItem[] = [];
      for (const call of group.calls) {
        if (signal?.aborted) break;
        const rejected = await resolveSensitiveApproval(call);
        if (rejected) {
          results.push({ type: 'function_call_output' as const, call_id: call.call_id, output: rejected });
        } else {
          approvedCalls.push(call);
        }
      }

      // emit 所有已通过确认的 function_call 事件
      for (const call of approvedCalls) {
        emit({
          type: 'function_call',
          content: JSON.stringify({
            name: call.name,
            callId: call.call_id,
            arguments: call.arguments,
          }),
        });
      }

      // Promise.all 并发执行
      const groupResults = await Promise.all(
        approvedCalls.map((call) => executeSingleTool(call)),
      );

      // 按原始 calls 顺序 push 到 results（保持与输入顺序一致）
      for (const { call, output } of groupResults) {
        results.push({
          type: 'function_call_output' as const,
          call_id: call.call_id,
          output,
        });
      }
    }
  }

  return results;
};

/** 安全解析工具参数 */
const safeParseArgs = (raw: string): Record<string, any> => {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
};

/** 从上下文中提取最后一条助手回复 */
export const extractLastAssistantReply = (context: InputItem[]): string => {
  for (let i = context.length - 1; i >= 0; i--) {
    const item = context[i];
    if ('role' in item && item.role === 'assistant') {
      return getTextContent((item as MessageInputItem).content);
    }
  }
  return '';
};
