/**
 * AI 对话入口 — 从 background.ts 调用的公共 API
 *
 * 设计哲学：代码管机制和边界（保下限），模型管决策和策略（定上限）
 *
 * 模块拆分：
 *   - loop-config.ts — 类型、常量、配置
 *   - core-loop.ts — agenticLoop 核心循环 + 辅助函数
 *   - review-agent.ts — 审查 Agent
 *   - phase-orchestrator.ts — 多阶段编排器
 *   - orchestrator.ts（本文件）— 对外入口 handleChat + re-exports
 */

import type { InputItem, AIStreamEvent } from './types';
import type { SkillGuideEntry, SkillCatalogEntry } from '../functions/skill';
import { ensureToolRegistryReady, mcpClient } from '../functions/registry';
import { mcpToolsToSchema } from '../mcp/adapters';
import { buildToolCatalog } from '../functions/tool-tiers';
import { buildSkillContext } from '../functions/skill';
import { readSiteExperience } from '../functions/site-experience';
import { builtinSiteExperience } from '../functions/builtin-experience';
import { buildSystemPrompt } from './system-prompt';
import { TodoManager } from './todo-manager';
import { TabTracker } from './tab-tracker';
import { createTodoFunction } from '../functions/todo';
import { resetSensitiveAccessTrust, getSubagentSchemas } from './core-loop';
import { phaseOrchestrator } from './phase-orchestrator';

import type { LoopBudget, HandleChatOptions, HandleChatCheckpoint, PhaseControl, PendingTurnResponseRequest } from './loop-config';
import { DEFAULT_BUDGET, COMPACT_SCHEMA } from './loop-config';

// ============ Re-exports（保持外部 import 路径不变） ============

export type { LoopBudget, HandleChatOptions, HandleChatCheckpoint, PhaseControl, PendingTurnResponseRequest };

// ============ 对外接口 ============

/**
 * AI 对话入口（与 background.ts 对接）
 *
 * 签名保持向后兼容
 */
export const handleChat = async (
  query: string,
  onEvent: (event: AIStreamEvent) => void,
  tabId?: number,
  signal?: AbortSignal,
  previousContext?: InputItem[],
  options?: HandleChatOptions,
): Promise<InputItem[]> => {
  // 每轮开始只清理本会话的敏感信任；无身份调用不能清空其他会话。
  const trustScope = options?.toolContext?.sessionId || options?.toolContext?.taskId;
  if (trustScope) resetSensitiveAccessTrust(trustScope);

  const budget: LoopBudget = {
    ...DEFAULT_BUDGET,
    ...(options?.maxRounds != null ? { maxRounds: options.maxRounds } : {}),
    ...(options?.maxToolCalls != null ? { maxToolCalls: options.maxToolCalls } : {}),
    ...(options?.maxSameToolCalls != null ? { maxSameSignature: options.maxSameToolCalls } : {}),
    ...(options?.maxInputItems != null ? { maxContextItems: options.maxInputItems } : {}),
  };

  // 准备工具
  await ensureToolRegistryReady();
  const mcpTools = await mcpClient.listTools();
  let tools = mcpToolsToSchema(mcpTools).map(tool => {
    switch (tool.name) {
      case 'act':
        return tool.description.includes('Your DEFAULT way') ? tool : { ...tool, description: `Your DEFAULT way to run multi-step browser actions. Stop when an expected effect is unmet; report the diagnostic instead of guessing. ${tool.description}` };
      case 'cdp_network':
        return tool.description.includes('START HERE when you need DATA') ? tool : { ...tool, description: `START HERE when you need DATA rather than a page action. Never guess an endpoint name from memory: list observed requests, compare response sizes, then inspect the response. If replaying a modified request fails, drive the site's UI and read its response instead. ${tool.description.split('\n\n⚠️ Do NOT use this tool for:')[0]}` };
      case 'download_file':
        return tool.description.includes('LAST RESORT') ? tool : { ...tool, description: `LAST RESORT for extracting structured data. Try first: observed network responses, fetch_url, or data_pipeline export. Use this tool when the user needs an actual file saved. ${tool.description}` };
      case 'load_tools':
        return { ...tool, description: 'Legacy category command for older callers. All registered tools are already available; there is no need to load categories before calling them.' };
      default:
        return tool;
    }
  });

  // 动态注入 skill（根据当前 tab URL 匹配可用 Skill + workflow）
  let domainGuides: SkillGuideEntry[] = [];
  let globalCatalog: SkillCatalogEntry[] = [];
  let tabUrl = '';
  try {
    // Current tab URL is shared by skill discovery and site experience.
    if (typeof chrome !== 'undefined' && chrome.tabs && tabId && Number.isFinite(tabId)) {
      const tab = await chrome.tabs.get(tabId);
      tabUrl = tab?.url || '';
    }

    const skillContext = await buildSkillContext(tabUrl);
    domainGuides = skillContext.domainGuides;
    globalCatalog = skillContext.globalCatalog;

    if (skillContext.schema) {
      // 替换静态的 skill schema 为动态版本
      tools = tools.filter(t => t.name !== 'skill');
      tools.push(skillContext.schema);
    }

  } catch {
    // skill 注入失败不影响正常工具链
  }

  let experienceGuidance = '';
  if (tabUrl) {
    try {
      // Bundled skill guides/workflows stay in buildSkillContext: they contain no observed success stats.
      const experience = await readSiteExperience(builtinSiteExperience(), tabUrl);
      experienceGuidance = experience.hasRecords
        ? experience.guidance
        : '当前站点暂无经验记录；不阻塞操作，可在成功后回流沉淀经验。';
    } catch {
      // Optional local experience must not prevent browsing.
    }
  }

  // 注入子 agent 工具（只有顶层才有）
  tools.push(...getSubagentSchemas());

  // ── 任务规划追踪 ──
  const todoManager = options?.resumeTodoSnapshot
    ? TodoManager.fromSnapshot(options.resumeTodoSnapshot)
    : new TodoManager();
  const todoFn = createTodoFunction(() => todoManager);
  tools.push({
    type: 'function' as const,
    name: todoFn.name,
    description: todoFn.description,
    parameters: todoFn.parameters,
  });

  // 注入 compact 上下文压缩工具
  tools.push(COMPACT_SCHEMA);

  // 过滤被禁用的工具
  if (options?.disallowTools && options.disallowTools.length > 0) {
    const disallowed = new Set(options.disallowTools);
    tools = tools.filter(t => !disallowed.has(t.name));
  }

  // Registered tools (including dynamic tools and agent) are resident from the first round.
  // Retain the full catalog for legacy load_tools calls and sub-agent tool inheritance.
  const allTools = [...tools];
  const loadedOnDemandTools = new Set<string>();

  // 构建系统提示词（域级 guide 直接注入，全局只放目录）
  let systemPrompt = buildSystemPrompt(tools, tools.some(tool => tool.name === 'agent'), domainGuides, globalCatalog, experienceGuidance);

  systemPrompt += buildToolCatalog(tools.map(tool => tool.name));

  // 标签页生命周期追踪：任务结束后自动关闭 AI 打开的标签页
  const tabTracker = new TabTracker();
  await tabTracker.startListening();
  try {
    return await phaseOrchestrator(
      query, tools, systemPrompt, budget,
      tabId, signal, onEvent, options,
      previousContext, todoManager, todoFn, tabTracker,
      allTools, loadedOnDemandTools,
    );
  } finally {
    await tabTracker.closeAll();
  }
};
