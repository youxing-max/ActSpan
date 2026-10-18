/**
 * Agent 注册表
 * 管理 Agent 定义、实例生命周期和消息队列
 * 对齐 Claude Code 的 AgentDefinition + AgentTool 设计
 */

import type { InputItem } from './types';
import type { LoopBudget } from './orchestrator';

// ============ 类型定义 ============

/** Agent 定义（对齐 CC 的 AgentDefinition） */
export interface AgentDefinition {
  /** 预定义 Agent 类型名（如 'explore'），Fork 模式为 undefined */
  type?: string;
  /** Agent 描述（给 LLM 看的简短说明） */
  description: string;
  /** 系统提示词构建函数 */
  buildPrompt: () => string;
  /** 工具过滤器（返回 true 保留，不提供则使用全部工具去掉 agent 自身） */
  toolFilter?: (toolName: string) => boolean;
  /** 预算覆盖 */
  budget: Partial<LoopBudget>;
}

/** Agent 实例状态 */
export type AgentStatus = 'running' | 'completed' | 'failed';

/** 运行中的 Agent 实例 */
export interface AgentInstance {
  /** 唯一 ID（如 'agent-1'） */
  id: string;
  /** Agent 定义 */
  definition: AgentDefinition;
  /** 当前状态 */
  status: AgentStatus;
  /** 父 Agent ID（顶层 Agent 无此字段） */
  parentId?: string;
  /** 绑定的 tab ID */
  tabId?: number;
  /** 完成后的结果摘要 */
  result?: string;
  /** 待处理的消息队列（SendMessage 传入） */
  messageQueue: string[];
  /** 创建时间 */
  createdAt: number;
}

/** 只读 Agent 类型（可共享 tab） */
const READ_ONLY_AGENT_TYPES = new Set(['explore', 'plan', 'review']);

// ============ AgentRegistry ============

/** Agent 注册表（内存，单次 handleChat 会话生命周期） */
export class AgentRegistry {
  private agents = new Map<string, AgentInstance>();
  private nextId = 1;

  /** 创建并注册一个新的 Agent 实例 */
  create(def: AgentDefinition, parentId?: string, tabId?: number): AgentInstance {
    const id = `agent-${this.nextId++}`;
    const instance: AgentInstance = {
      id,
      definition: def,
      status: 'running',
      parentId,
      tabId,
      result: undefined,
      messageQueue: [],
      createdAt: Date.now(),
    };
    this.agents.set(id, instance);
    return instance;
  }

  /** 获取 Agent 实例 */
  get(id: string): AgentInstance | undefined {
    return this.agents.get(id);
  }

  /** 更新 Agent 状态和结果 */
  updateStatus(id: string, status: AgentStatus, result?: string): void {
    const agent = this.agents.get(id);
    if (agent) {
      agent.status = status;
      if (result !== undefined) agent.result = result;
    }
  }

  /** 向指定 Agent 的消息队列推送消息 */
  pushMessage(targetId: string, message: string): boolean {
    const agent = this.agents.get(targetId);
    if (!agent) return false;
    // 已完成的 Agent 不接收新消息
    if (agent.status === 'completed' || agent.status === 'failed') return false;
    agent.messageQueue.push(message);
    return true;
  }

  /** 消费指定 Agent 的所有待处理消息（清空队列） */
  consumeMessages(id: string): string[] {
    const agent = this.agents.get(id);
    if (!agent || agent.messageQueue.length === 0) return [];
    const messages = [...agent.messageQueue];
    agent.messageQueue = [];
    return messages;
  }

  /** 获取指定父 Agent 的所有子 Agent */
  listByParent(parentId: string): AgentInstance[] {
    const children: AgentInstance[] = [];
    for (const agent of this.agents.values()) {
      if (agent.parentId === parentId) children.push(agent);
    }
    return children;
  }

  /** 获取所有 Agent 实例 */
  listAll(): AgentInstance[] {
    return Array.from(this.agents.values());
  }

  /** 获取所有运行中的 Agent 数量 */
  get runningCount(): number {
    let count = 0;
    for (const agent of this.agents.values()) {
      if (agent.status === 'running') count++;
    }
    return count;
  }

  /**
   * 检查指定 tab 上是否有写操作 Agent 正在运行
   * 只读 Agent（explore/plan/review）可以共享 tab
   */
  hasWriteAgentOnTab(tabId: number): boolean {
    for (const agent of this.agents.values()) {
      if (agent.status !== 'running') continue;
      if (agent.tabId !== tabId) continue;
      // 只读 Agent 不算写冲突
      if (agent.definition.type && READ_ONLY_AGENT_TYPES.has(agent.definition.type)) continue;
      return true;
    }
    return false;
  }

  /** 检查指定 Agent 类型是否是只读的 */
  static isReadOnly(type?: string): boolean {
    return type !== undefined && READ_ONLY_AGENT_TYPES.has(type);
  }

  /** 清理所有 Agent 实例（handleChat 结束时调用） */
  clear(): void {
    this.agents.clear();
    this.nextId = 1;
  }
}
