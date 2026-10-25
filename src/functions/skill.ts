/**
 * skill 工具
 * 三模式：list（查看目录）、detail（获取指南）、run（执行工作流）
 *
 * 上下文优化策略：
 *   域级 Skill（URL 匹配到的，数量少）→ guide 直接注入系统提示词
 *   全局 Skill（可能很多）→ 系统提示词只放目录，AI 按需 detail
 *
 * 这样 skill 数量增长不会撑爆系统提示词
 */

import type { FunctionDefinition, FunctionResult, ToolExecutionContext } from './types';
import type { ToolSchema } from '../ai/types';
import type { SkillSpec, WorkflowEntry } from './skill-types';
import { ensureSkillRegistryReady, registryService } from './skill-registry';
import { matchSkills } from './skill-matcher';
import { executeDebugRemotePlan } from './remote-workflow';

const MAX_WORKFLOWS_IN_SCHEMA = 15;

/** guide 条目（传给系统提示词，仅域级 Skill） */
export interface SkillGuideEntry {
  scope: 'global' | 'domain';
  skillName: string;
  skillLabel: string;
  guide: string;
}

/** 全局 Skill 目录条目（轻量，放在系统提示词中） */
export interface SkillCatalogEntry {
  name: string;
  label: string;
  description: string;
  workflowCount: number;
}

/** 从 JSON Schema 中提取参数默认值 */
const extractDefaults = (schema: Record<string, any>): Record<string, any> => {
  const defaults: Record<string, any> = {};
  const properties = schema?.properties;
  if (!properties || typeof properties !== 'object') return defaults;
  for (const [key, prop] of Object.entries(properties)) {
    if (prop && typeof prop === 'object' && 'default' in prop) {
      defaults[key] = (prop as any).default;
    }
  }
  return defaults;
};

/** 构建单个 workflow 的轻量元数据（不包含执行计划） */
const buildWorkflowMetadata = (wf: WorkflowEntry): Record<string, unknown> => ({
  name: wf.name,
  label: wf.label,
  description: wf.description,
  ...(Array.isArray(wf.triggers) && wf.triggers.length > 0 ? { triggers: wf.triggers } : {}),
  parameters: wf.parameters,
});

/** 构建单个 workflow 的参数简述 */
const buildWorkflowDescription = (wf: WorkflowEntry): string => {
  const paramProps = wf.parameters?.properties;
  let paramHint = '';
  if (paramProps && typeof paramProps === 'object') {
    const parts = Object.entries(paramProps as Record<string, any>).map(([key, schema]) => {
      const desc = (schema as any)?.description || '';
      const req = Array.isArray(wf.parameters?.required) && (wf.parameters.required as string[]).includes(key);
      const def = (schema as any)?.default !== undefined ? `, default: ${(schema as any).default}` : '';
      return `${key}(${desc}${def}${req ? ', required' : ''})`;
    });
    if (parts.length > 0) paramHint = ` | params: ${parts.join(', ')}`;
  }
  const triggers = Array.isArray(wf.triggers) && wf.triggers.length > 0
    ? ` | triggers: ${wf.triggers.join(', ')}` : '';
  return `- ${wf.label} (workflow name: ${wf.name}): ${wf.description}${triggers}${paramHint}`;
};

/**
 * 根据当前 tab URL 构建 Skill 上下文
 *
 * 混合策略：
 *   域级 Skill → guide 直接注入系统提示词（数量少，高度相关）
 *   全局 Skill → 只返回目录（名称+一句话），AI 按需调用 detail
 *
 * 返回：
 * - schema: skill 工具的动态 ToolSchema
 * - domainGuides: 域级 guide（直接注入系统提示词）
 * - globalCatalog: 全局 Skill 目录（轻量，注入系统提示词）
 */
export const buildSkillContext = async (tabUrl: string): Promise<{
  schema: ToolSchema;
  domainGuides: SkillGuideEntry[];
  globalCatalog: SkillCatalogEntry[];
}> => {
  await ensureSkillRegistryReady();
  const matchedSkills = matchSkills(tabUrl, (await registryService.listAll()).skills);

  // 1. 分离全局和域级
  const globalSkills = matchedSkills.filter(s => s.scope === 'global');
  const domainSkills = matchedSkills.filter(s => s.scope === 'domain');

  // 2. 域级 Skill：收集完整 guide（直接注入）
  const domainGuides: SkillGuideEntry[] = domainSkills
    .filter(s => s.guide?.trim())
    .map(s => ({
      scope: 'domain' as const,
      skillName: s.name,
      skillLabel: s.label,
      guide: s.guide.trim(),
    }));

  // 3. 全局 Skill：只收集目录（轻量）
  const globalCatalog: SkillCatalogEntry[] = globalSkills.map(s => ({
    name: s.name,
    label: s.label,
    description: s.description,
    workflowCount: s.workflows.length,
  }));

  // 4. 收集域级 workflow（直接放在 schema enum 中，零延迟调用）
  const domainWorkflows: { skill: SkillSpec; wf: WorkflowEntry }[] = [];
  for (const skill of domainSkills) {
    for (const wf of skill.workflows) {
      domainWorkflows.push({ skill, wf });
    }
  }

  // 5. 构建 schema
  const limited = domainWorkflows.slice(0, MAX_WORKFLOWS_IN_SCHEMA);

  // description 中列出域级可直接 run 的 workflow + 提示全局需 detail
  const descParts: string[] = [
    'Predefined skill workflows. Supports three actions:',
    '',
    '**action=run** (default): Execute a workflow, fast.',
    '**action=detail**: View the full guide and workflow list of a skill.',
    '**action=list**: List all available skills.',
  ];

  if (limited.length > 0) {
    descParts.push('');
    descParts.push('Workflows available for direct run on the current page:');
    for (const { wf } of limited) {
      descParts.push(buildWorkflowDescription(wf));
    }
  }

  if (globalCatalog.length > 0) {
    descParts.push('');
    descParts.push('Base skills (use detail to view details before run):');
    for (const cat of globalCatalog) {
      descParts.push(`- ${cat.name}: ${cat.description} (${cat.workflowCount} workflows)`);
    }
  }

  // name enum 只包含域级 workflow（全局需 detail 后才知道具体 name）
  const domainWfNames = limited.map(({ wf }) => wf.name);

  const schema: ToolSchema = {
    type: 'function',
    name: 'skill',
    description: descParts.join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['run', 'detail', 'list'],
          description: 'Action type. run=execute workflow (default), detail=view skill details, list=list all skills',
        },
        name: {
          type: 'string',
          description: 'Workflow name when action=run, skill name when action=detail.',
          ...(domainWfNames.length > 0 ? {} : {}), // 不设 enum，允许全局 workflow 名称
        },
        params: {
          type: 'object',
          description: 'Parameter object passed to the workflow when action=run.',
        },
        tab_id: {
          type: 'number',
          description: 'Target tab ID. Uses the current active tab if omitted.',
        },
      },
    },
  };

  return { schema, domainGuides, globalCatalog };
};

// ============ action 处理器 ============

/** action=list：列出所有可用技能 */
const handleList = async (tabUrl?: string): Promise<FunctionResult> => {
  await ensureSkillRegistryReady();

  const snapshot = await registryService.listAll();
  const skills = tabUrl ? matchSkills(tabUrl, snapshot.skills) : snapshot.skills;

  const result = skills.map(s => ({
    name: s.name,
    version: s.version,
    source: s.source,
    enabled: s.enabled,
    label: s.label,
    description: s.description,
    scope: s.scope,
    workflowCount: s.workflows.length,
    workflows: s.workflows.map(buildWorkflowMetadata),
  }));

  return {
    success: true,
    data: {
      revision: snapshot.revision,
      totalSkills: result.length,
      skills: result,
      hint: 'Use skill(action="detail", name="<skill_name>") to view metadata, guide, parameters, and steps. Use the workflow name from the list with skill(action="run", name="<workflow_name>", params={...}).',
    },
  };
};

/** action=detail：查看某个技能的完整指南 */
const handleDetail = async (skillName: string): Promise<FunctionResult> => {
  await ensureSkillRegistryReady();
  const snapshot = await registryService.listAll();
  const skill = snapshot.skills.find(item => item.name === skillName);
  if (!skill) {
    return { success: false, error: `Skill not found: ${skillName}` };
  }

  const workflowDetails = skill.workflows.map(wf => ({
    ...buildWorkflowMetadata(wf),
    version: wf.version,
    updatedAt: wf.updatedAt,
    steps: wf.steps || wf.plan.steps,
    plan: wf.plan,
  }));

  return {
    success: true,
    data: {
      name: skill.name,
      label: skill.label,
      description: skill.description,
      revision: snapshot.revision,
      version: skill.version,
      source: skill.source,
      enabled: skill.enabled,
      url_patterns: skill.url_patterns,
      scope: skill.scope,
      guide: skill.guide || '(no guide)',
      workflows: workflowDetails,
      hint: 'detail 的 name 传 Skill name；执行时使用 skill(action="run", name="<workflow_name>", params={...})，其中 name 必须是内部 workflow name（workflow.name），不能使用 Skill name 或 label。',
    },
  };
};

// ============ query → workflow 解析 ============

/** query 命中 triggers 的权重：远高于元数据重叠，保证调用短语优先 */
const TRIGGER_MATCH_SCORE = 100;
/** 元数据关键词重叠上限，避免长 query 靠字数堆过 trigger */
const MAX_METADATA_SCORE = 50;

/** 中文按二元组、英文/数字按词切分，用于 label/description 关键词重叠计分 */
const metadataTokens = (text: string): string[] => {
  const tokens: string[] = [];
  for (const run of text.toLowerCase().match(/[\u4e00-\u9fff]+|[a-z0-9_]+/g) || []) {
    if (/^[a-z0-9_]+$/.test(run)) {
      if (run.length >= 2) tokens.push(run);
      continue;
    }
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let index = 0; index + 1 < run.length; index++) {
      tokens.push(run.slice(index, index + 2));
    }
  }
  return tokens;
};

/**
 * 给单个 workflow 的 query 匹配分：
 * triggers 双向子串命中（query 含 trigger，或 trigger 含 query）优先；
 * 其次按 label/description 与 query 的中文二元组/英文词重叠计数。
 */
export const scoreWorkflowQuery = (
  query: string,
  workflow: Pick<WorkflowEntry, 'triggers' | 'label' | 'description'>,
): number => {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return 0;
  for (const raw of workflow.triggers || []) {
    const trigger = String(raw || '').trim().toLowerCase();
    if (trigger && (normalized.includes(trigger) || trigger.includes(normalized))) {
      return TRIGGER_MATCH_SCORE;
    }
  }
  const known = new Set(metadataTokens(`${workflow.label || ''} ${workflow.description || ''}`));
  if (known.size === 0) return 0;
  const overlap = metadataTokens(normalized).filter(token => known.has(token)).length;
  return Math.min(overlap, MAX_METADATA_SCORE);
};

export interface WorkflowQueryCandidate {
  skillName: string;
  name: string;
  label: string;
  score: number;
}

export interface WorkflowQueryResolution {
  workflow: WorkflowEntry | null;
  skillName: string | null;
  reason: 'matched' | 'ambiguous' | 'no-match';
  candidates: WorkflowQueryCandidate[];
}

/** 在所有 enabled Skill 中按 triggers/元数据解析 query；最高分唯一才算命中 */
export const resolveWorkflowByQuery = (query: string, skills: SkillSpec[]): WorkflowQueryResolution => {
  const scored: Array<{ skill: SkillSpec; workflow: WorkflowEntry; score: number }> = [];
  for (const skill of skills) {
    if (!skill.enabled) continue;
    for (const workflow of skill.workflows) {
      scored.push({ skill, workflow, score: scoreWorkflowQuery(query, workflow) });
    }
  }

  const toCandidate = (entry: typeof scored[number]): WorkflowQueryCandidate => ({
    skillName: entry.skill.name,
    name: entry.workflow.name,
    label: entry.workflow.label,
    score: entry.score,
  });

  const hits = scored
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.workflow.name.localeCompare(b.workflow.name));

  if (hits.length === 0) {
    return {
      workflow: null,
      skillName: null,
      reason: 'no-match',
      candidates: scored.slice(0, 3).map(toCandidate),
    };
  }
  if (hits.length > 1 && hits[1].score === hits[0].score) {
    return {
      workflow: null,
      skillName: null,
      reason: 'ambiguous',
      candidates: hits.slice(0, 3).map(toCandidate),
    };
  }
  return {
    workflow: hits[0].workflow,
    skillName: hits[0].skill.name,
    reason: 'matched',
    candidates: hits.slice(0, 3).map(toCandidate),
  };
};

/** action=run：执行工作流 */
const handleRun = async (
  rawParams: Record<string, unknown>,
  context?: ToolExecutionContext,
): Promise<FunctionResult> => {
  const workflowName = String(rawParams?.name || '').trim();
  const query = String(rawParams?.query || '').trim();
  if (!workflowName && !query) {
    return { success: false, error: 'Missing workflow name or query' };
  }

  await ensureSkillRegistryReady();
  // 在所有 Skill 中查找 workflow
  const snapshot = await registryService.listAll();
  const allSkills = snapshot.skills;
  let targetWorkflow: WorkflowEntry | null = null;

  if (workflowName) {
    for (const skill of allSkills) {
      if (!skill.enabled) continue;
      const found = skill.workflows.find(w => w.name === workflowName);
      if (found) {
        targetWorkflow = found;
        break;
      }
    }
    if (!targetWorkflow) {
      return { success: false, error: `Workflow not found: ${workflowName}. Use skill(action="list") to view available workflows.` };
    }
  } else {
    const resolution = resolveWorkflowByQuery(query, allSkills);
    if (!resolution.workflow) {
      const candidates = resolution.candidates
        .map(candidate => `${candidate.name} (${candidate.label})`)
        .join(', ');
      const prefix = resolution.reason === 'ambiguous'
        ? `Ambiguous query: "${query}"`
        : `No workflow matched query: "${query}"`;
      return {
        success: false,
        error: `${prefix}. Candidates: ${candidates || '(none)'}. Retry with skill(action="run", name="<workflow_name>").`,
        data: { query, reason: resolution.reason, candidates: resolution.candidates },
      };
    }
    targetWorkflow = resolution.workflow;
  }
  const resolvedWorkflowName = targetWorkflow.name;

  // 合并参数：schema 默认值 < 顶层参数 < params 嵌套参数
  const defaults = extractDefaults(targetWorkflow.parameters);
  const { action: _a, name: _n, query: _q, params: nested, tab_id: _t, ...topLevel } = rawParams || {};
  const nestedParams = nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : {};
  const mergedParams = { ...defaults, ...topLevel, ...nestedParams };

  // 构建最终 context：tab_id 参数优先于 context.tabId
  const effectiveContext: ToolExecutionContext = {
    ...context,
    tabId: (typeof rawParams.tab_id === 'number' && Number.isFinite(rawParams.tab_id))
      ? rawParams.tab_id
      : context?.tabId,
    signal: context?.signal,
  };

  // 自由化模式：技能写操作不再审批。

  const result = await executeDebugRemotePlan(
    resolvedWorkflowName,
    targetWorkflow.plan,
    mergedParams,
    effectiveContext,
  );
  return {
    ...result,
    data: result.data && typeof result.data === 'object' && !Array.isArray(result.data)
      ? { ...result.data, registryRevision: snapshot.revision }
      : { value: result.data, registryRevision: snapshot.revision },
  };
};

// ============ FunctionDefinition ============

/**
 * skill 工具
 * 三模式：list / detail / run
 */
export const skillFunction: FunctionDefinition = {
  name: 'skill',
  description: 'Predefined skill workflows. Supports list (list skills), detail (view guide), run (execute workflow, default).',
  supportsParallel: false,
  permissionLevel: 'interact',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['run', 'detail', 'list'],
        description: 'Action type. Default: run.',
      },
      name: {
        type: 'string',
        description: 'Workflow name for run, skill name for detail.',
      },
      query: {
        type: 'string',
        description: '自然语言请求；name 缺省时按 triggers 解析匹配的 workflow。',
      },
      params: {
        type: 'object',
        description: 'Parameters passed to the workflow for run.',
      },
      tab_id: {
        type: 'number',
        description: 'Target tab ID.',
      },
    },
  },

  execute: async (
    rawParams: { action?: string; name?: string; query?: string; params?: Record<string, unknown>; tab_id?: number; [key: string]: unknown },
    context?: ToolExecutionContext,
  ): Promise<FunctionResult> => {
    const action = String(rawParams?.action || 'run').trim().toLowerCase();

    switch (action) {
      case 'list':
        return handleList();

      case 'detail': {
        const skillName = String(rawParams?.name || '').trim();
        if (!skillName) return { success: false, error: 'Missing skill name' };
        return handleDetail(skillName);
      }

      case 'run':
      default:
        return handleRun(rawParams as Record<string, unknown>, context);
    }
  },
};
