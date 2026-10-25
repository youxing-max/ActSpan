import type { FunctionDefinition, FunctionResult } from './types';
import { registryService } from './skill-registry';
import { normalizeWorkflow } from './registry-service';
import type { SkillSpec } from './skill-types';
import { isSupportedRemotePlanAction, isWorkflowPlanSubActionAllowed } from './remote-workflow';
import { isPlainObject } from '../lib/guards';

// F4：剧本体检。好剧本零警告；坏形状照存但逐条点名——经验不阻塞，话要说清。
const CHINESE_TEXT = /[\u3400-\u9fff]/;
const SNAKE_CASE_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const RESERVED_NAME = /^(?:workflow|workflow_name|unnamed|untitled|name)$/i;
const PLACEHOLDER_TEXT = /(?:未命名|未填写|待补充|待 AI 根据步骤补全)/;
// 这些文字会进 skill 工具描述，也就是每一轮的系统提示。不设上限，被注入的页面就能把
// 任意长的指令永久写进去，所以按「够用即止」截断并留警告。
const MAX_LABEL_CHARS = 60;
const MAX_DESCRIPTION_CHARS = 300;
const MAX_TRIGGER_CHARS = 40;
const MAX_TRIGGERS = 5;

const planSteps = (plan: unknown): unknown[] | null => {
  if (!isPlainObject(plan) || !('steps' in plan)) return null;
  return Array.isArray(plan.steps) ? plan.steps : null;
};

// 保存工作流定义
export const saveWorkflowFunction: FunctionDefinition = {
  name: 'save_workflow',
  description: 'Save a workflow definition to the registry. Call this when a recording audit is ready to save or when the user explicitly asks to save changes. A well-formed definition saves with zero warnings; a bad shape is still saved, but every defect is named in data.warnings and data.healthy is false — report those warnings to the user verbatim. Only unparseable JSON or an empty plan.steps is refused, because there is then nothing runnable to save.',
  supportsParallel: false,
  permissionLevel: 'interact',
  parameters: {
    type: 'object',
    properties: {
      workflow_json: {
        type: 'string',
        description: 'Complete workflow definition as a JSON string. Preferred shape: an English snake_case name, Chinese label and description, 2-5 non-blank trigger strings, and plan.steps with at least one step. plan steps may only use the allowlisted actions: tab_navigate, page, cdp_dom (read-only sub-actions), extract_data, screenshot, and cdp_input (interactive actions such as click/type/fill/key_press/scroll — these are executed under user approval). A defective shape is saved anyway with data.warnings naming each defect; only unparseable JSON or an empty plan.steps is refused. Example: {"name":"search_product","label":"搜索商品","description":"帮助用户搜索商品","triggers":["搜索商品","查找商品"],"plan":{"steps":[{"action":"tab_navigate","params":{"action":"open","url":"https://shop.example/search"}},{"action":"cdp_input","params":{"action":"fill","selector":"input[name=\\"q\\"]","value":"{{keyword}}"}}]}}',
      },
      unique_name: {
        type: 'boolean',
        description: 'Recorder-only: when the skill name is already taken, save under name-2/name-3 instead of overwriting an unrelated workflow.',
      },
    },
    required: ['workflow_json'],
  },
  execute: async (params: Record<string, unknown>): Promise<FunctionResult> => {
    // 解析 JSON 字符串
    let parsed: unknown;
    try {
      const raw = params.workflow_json || params.workflow || params;
      parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (error) {
      // 坏 JSON 要点名到具体位置，只说「不是合法 JSON」等于没说。
      return { success: false, error: `workflow_json is not valid JSON: ${error instanceof Error ? error.message : 'parse failed'}` };
    }

    // 兼容嵌套传参
    const unwrapped = isPlainObject(parsed) && isPlainObject(parsed.workflow) ? parsed.workflow : parsed;
    if (!isPlainObject(unwrapped)) {
      return { success: false, error: 'Missing required workflow object' };
    }

    const warnings: string[] = [];
    const draft: Record<string, unknown> = { ...unwrapped };

    if (typeof draft.name !== 'string' || !SNAKE_CASE_NAME.test(draft.name) || RESERVED_NAME.test(draft.name)) {
      const fallback = `workflow_${Date.now().toString(36)}`;
      warnings.push(`name ${JSON.stringify(draft.name ?? null)} is not English snake_case; saved as "${fallback}"`);
      draft.name = fallback;
    }
    if (typeof draft.label !== 'string' || !CHINESE_TEXT.test(draft.label) || PLACEHOLDER_TEXT.test(draft.label)) {
      warnings.push('label is missing, non-Chinese or a placeholder; saved with the workflow name as its label');
      draft.label = draft.name;
    } else if (draft.label.length > MAX_LABEL_CHARS) {
      warnings.push(`label exceeded ${MAX_LABEL_CHARS} characters; truncated`);
      draft.label = draft.label.slice(0, MAX_LABEL_CHARS);
    }
    if (typeof draft.description !== 'string' || !CHINESE_TEXT.test(draft.description) || PLACEHOLDER_TEXT.test(draft.description)) {
      warnings.push('description is missing, non-Chinese or a placeholder; saved empty');
      draft.description = '';
    } else if (draft.description.length > MAX_DESCRIPTION_CHARS) {
      warnings.push(`description exceeded ${MAX_DESCRIPTION_CHARS} characters; truncated`);
      draft.description = draft.description.slice(0, MAX_DESCRIPTION_CHARS);
    }
    if (!Array.isArray(draft.triggers)) {
      warnings.push('triggers is not an array; saved with no triggers');
      draft.triggers = [];
    } else {
      const usable = draft.triggers.filter((trigger: unknown) =>
        typeof trigger === 'string' && trigger.trim().length > 0 && CHINESE_TEXT.test(trigger));
      if (usable.length !== draft.triggers.length) {
        warnings.push(`triggers: dropped ${draft.triggers.length - usable.length} blank or non-Chinese entr${draft.triggers.length - usable.length === 1 ? 'y' : 'ies'}`);
      }
      const triggers = usable.map((trigger: string) => trigger.trim().slice(0, MAX_TRIGGER_CHARS));
      if (triggers.length > MAX_TRIGGERS) {
        warnings.push(`triggers: kept the first ${MAX_TRIGGERS} of ${triggers.length}`);
        triggers.length = MAX_TRIGGERS;
      }
      if (triggers.length < 2) warnings.push(`triggers should hold 2-${MAX_TRIGGERS} Chinese strings; saved ${triggers.length}`);
      draft.triggers = triggers;
    }

    const steps = planSteps(draft.plan);
    if (!steps || steps.length === 0) {
      return { success: false, error: 'workflow.plan.steps must be a non-empty array; there is no runnable script to save' };
    }
    // Validate plan actions through the resolver wired by the registry after static initialization.
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const action = isPlainObject(step) ? step.action : undefined;
      if (typeof action !== 'string' || !isSupportedRemotePlanAction(action)) {
        warnings.push(`step ${i + 1} action ${JSON.stringify(action ?? null)} is not a valid built-in tool name; saved as-is`);
        continue;
      }
      // action 合法不等于可执行：page / cdp_dom 在 plan 层按 (action, subAction) 再收窄一次。
      // 只校验 action 时这些步骤零警告入库，跑到 workflow_run 才撞 E_POLICY_DENIED——保存时先点名。
      const rawSubAction = isPlainObject(step) && isPlainObject(step.params) ? step.params.action : undefined;
      if (typeof rawSubAction !== 'string' || rawSubAction.includes('{{')) continue;
      const subAction = rawSubAction.trim().toLowerCase();
      if (!isWorkflowPlanSubActionAllowed(action.trim(), subAction)) {
        warnings.push(`step ${i + 1} ${action.trim()}.${subAction} is not an allowed workflow-plan sub-action; saved as-is and will fail when the workflow runs`);
      }
    }

    const now = Date.now();
    const normalized = normalizeWorkflow({ ...draft, updatedAt: now }, now);
    if (!normalized) return { success: false, error: 'Invalid workflow definition' };
    const baseName = `user-${normalized.name.replace(/\s+/g, '-')}`;
    // 录制审计产出的名字可能撞上已有工作流；撞名时另存为 -2/-3，绝不静默覆盖别人的定义。
    let name = baseName;
    if (params.unique_name === true) {
      for (let suffix = 2; suffix <= 50; suffix++) {
        if (!(await registryService.get(name, 'domain'))) break;
        name = `${baseName}-${suffix}`;
      }
    }
    try {
      const previous = await registryService.get(name, 'domain');
      const patterns = Array.isArray(draft.url_patterns)
        ? draft.url_patterns.map((pattern) => String(pattern || '').trim()).filter(Boolean)
        : previous?.url_patterns || ['*://*/*'];
      const skill: SkillSpec = {
        name,
        label: normalized.label,
        description: normalized.description,
        scope: 'domain',
        url_patterns: patterns,
        guide: '',
        workflows: [normalized],
        enabled: draft.enabled !== false,
        source: 'user',
        version: normalized.version || 1,
        createdAt: previous?.createdAt || now,
        updatedAt: now,
      };
      const result = await registryService.upsertSkill(skill);
      return { success: true, data: { name, revision: result.revision, warnings, healthy: warnings.length === 0 } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Workflow save failed' };
    }
  },
};
