import type { FunctionDefinition, FunctionResult } from './types';
import { registryService } from './skill-registry';
import { normalizeWorkflow } from './registry-service';
import type { SkillSpec } from './skill-types';
import { isSupportedRemotePlanAction } from './remote-workflow';

// 保存用户确认的工作流
export const saveWorkflowFunction: FunctionDefinition = {
  name: 'save_workflow',
  description: 'Save a user-confirmed workflow definition to the registry. Only call this after the user has explicitly confirmed the workflow content. Pass the complete workflow JSON object serialized as a string to the workflow_json parameter.',
  supportsParallel: false,
  permissionLevel: 'interact',
  parameters: {
    type: 'object',
    properties: {
      workflow_json: {
        type: 'string',
        description: 'Complete workflow definition as a JSON string. Must contain name and plan fields. Example: {"name":"search_product","label":"Search Product","plan":{"steps":[...]}}',
      },
    },
    required: ['workflow_json'],
  },
  execute: async (params: Record<string, any>): Promise<FunctionResult> => {
    // 解析 JSON 字符串
    let workflow: any;
    try {
      const raw = params.workflow_json || params.workflow || params;
      workflow = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return { success: false, error: 'workflow_json is not a valid JSON string' };
    }

    // 兼容嵌套传参
    if (workflow && typeof workflow === 'object' && workflow.workflow && typeof workflow.workflow === 'object') {
      workflow = workflow.workflow;
    }

    if (!workflow || typeof workflow !== 'object' || !workflow.name || !workflow.plan) {
      return { success: false, error: 'Missing required workflow fields (name, plan)' };
    }

    // Validate plan actions through the resolver wired by the registry after static initialization.
    const steps = workflow.plan?.steps;
    if (Array.isArray(steps)) {
      for (let i = 0; i < steps.length; i++) {
        const action = steps[i]?.action;
        if (!action || !isSupportedRemotePlanAction(action)) {
          return {
            success: false,
            error: `Step ${i + 1} action "${action || '(empty)'}" is not a valid built-in tool name`,
          };
        }
      }
    }

    const now = Date.now();
    const normalized = normalizeWorkflow({ ...workflow, updatedAt: now }, now);
    if (!normalized) return { success: false, error: 'Invalid workflow definition' };
    const name = `user-${normalized.name.replace(/\s+/g, '-')}`;
    try {
      const previous = await registryService.get(name, 'domain');
      const patterns = Array.isArray(workflow.url_patterns) && workflow.url_patterns.length > 0
        ? workflow.url_patterns : previous?.url_patterns || ['*://*/*'];
      const skill: SkillSpec = {
        name,
        label: normalized.label,
        description: normalized.description,
        scope: 'domain',
        url_patterns: patterns,
        guide: '',
        workflows: [normalized],
        enabled: workflow.enabled !== false,
        source: 'user',
        version: normalized.version || 1,
        createdAt: previous?.createdAt || now,
        updatedAt: now,
      };
      const result = await registryService.upsertSkill(skill);
      return { success: true, data: { name, revision: result.revision } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Workflow save failed' };
    }
  },
};
