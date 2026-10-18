/**
 * Skill 类型定义
 * Skill 是上层概念：guide（AI 上下文指南） + workflows（确定性步骤）
 *
 * 两层架构：
 *   全局 Skill → 源码打包，始终注入，稳固基础能力
 *   域级 Skill → 远端 Manifest + 用户创建，按 URL 匹配
 */

/** Structured workflow step contract. */
export interface WorkflowStep {
  id: string;
  capability:
    | 'page_read'
    | 'page_click'
    | 'page_type'
    | 'page_eval'
    | 'screenshot'
    | 'agent_delegate';
  input: Record<string, unknown>;
  optional?: boolean;
  onError?: 'stop' | 'retry' | 'fallback';
}

/** Workflow 条目（嵌套在 Skill 内） */
export interface WorkflowEntry {
  /** 唯一名称，如 "京东搜索" */
  name: string;
  /** 显示名称 */
  label: string;
  /** 一句话描述（出现在工具 description 中） */
  description: string;
  /** 参数 JSON Schema */
  parameters: Record<string, any>;
  /** 执行计划（RemoteWorkflowPlan 格式，由 remote-workflow.ts 引擎执行） */
  plan: Record<string, any>;
  /** 可选的规范化步骤列表，保留 plan 作为现有执行器兼容字段。 */
  steps?: WorkflowStep[];
  /** 稳定 workflow 版本。 */
  version?: number;
  /** 内容更新时间。 */
  updatedAt?: number;
  /** 可选内容摘要。 */
  contentHash?: string;
}

/** Skill 定义 */
export interface SkillSpec {
  /** 唯一名称，如 "web-search"、"boss-zhipin" */
  name: string;
  /** 显示名称，如 "网页搜索" */
  label: string;
  /** 一句话描述 */
  description: string;
  /** 层级：global 始终注入，domain 按 URL 匹配 */
  scope: 'global' | 'domain';
  /** URL 匹配模式（域级使用，全局为空数组） */
  url_patterns: string[];
  /** AI 可读的 markdown 指南，注入系统提示词 */
  guide: string;
  /** 该 Skill 下的 workflow 清单 */
  workflows: WorkflowEntry[];
  /** 是否启用 */
  enabled: boolean;
  /** 来源：builtin 随扩展打包，remote 远端同步，user 用户创建 */
  source: 'builtin' | 'remote' | 'user';
  /** remote 来源的 Manifest URL */
  manifestUrl?: string;
  /** 版本号 */
  version: number;
  /** 内容摘要。 */
  contentHash?: string;
  /** 创建时间戳 */
  createdAt: number;
  /** 更新时间戳 */
  updatedAt: number;
}

/** Skill Manifest 格式（远端/本地 JSON 文件） */
export interface SkillManifest {
  version: number;
  updatedAt?: string;
  skills: SkillSpec[];
}

/** Manifest 源配置 */
export interface SkillManifestSource {
  url: string;
  label?: string;
  enabled: boolean;
  syncStartedAt?: number;
  lastSyncAt?: number;
  lastSyncError?: string;
}