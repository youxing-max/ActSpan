import type { FunctionDefinition, ToolExecutionContext } from './types';
import { builtinSiteExperience } from './builtin-experience';
import {
  chooseRecipe,
  readSiteExperience,
  resolveSiteExperienceDomain,
  saveSiteExperience,
  type SiteExperienceMemory,
} from './site-experience';

const resolveTarget = async (params: { url?: string }, context?: ToolExecutionContext): Promise<string> => {
  if (typeof params.url === 'string' && params.url.trim()) return params.url;
  const domain = await resolveSiteExperienceDomain(context);
  if (!domain) throw new Error('site_experience requires url or a readable current tab');
  return domain;
};

export const siteExperienceFunction: FunctionDefinition = {
  name: 'site_experience',
  description: 'Read or update layered local site experience. Experience is advisory, not a rule: re-read the live page before acting. Use get to inspect built-in/local/merged layers (factoryHosts names the read-only built-in section), choose to select a supported recipe, and save only sanitized observations without credentials, user values, or full URLs. Passing a previous get result straight back to save is safe: the built-in section and its guidance are stripped, so only local content is stored.',
  supportsParallel: false,
  permissionLevel: 'read',
  actionPermissions: { save: 'interact' },
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'choose', 'save'] },
      url: { type: 'string', description: 'Site URL or host; defaults to the current tab domain' },
      goal: { type: 'string', description: 'Action goal for choose' },
      experience: { type: 'object', description: 'Sanitized local SiteExperienceMemory for save. A previous get result may be passed back verbatim; the built-in section is stripped before saving.' },
    },
    required: ['action'],
  },
  validate: (params: { action?: string; goal?: unknown; experience?: unknown }) => {
    if (!['get', 'choose', 'save'].includes(String(params?.action || ''))) return 'unsupported action';
    if (params.action === 'choose' && (typeof params.goal !== 'string' || !params.goal.trim())) return 'choose requires goal';
    if (params.action === 'save' && (!params.experience || typeof params.experience !== 'object' || Array.isArray(params.experience))) return 'save requires experience';
    return null;
  },
  execute: async (
    params: { action: 'get' | 'choose' | 'save'; url?: string; goal?: string; experience?: SiteExperienceMemory },
    context?: ToolExecutionContext,
  ) => {
    try {
      if (params.action === 'save') {
        // F6：出厂段要一起传进去，否则回贴的全文会把出厂条目当成本机内容存下来。
        return { success: true, data: await saveSiteExperience(params.experience, builtinSiteExperience()) };
      }
      const target = await resolveTarget(params, context);
      const layers = await readSiteExperience(builtinSiteExperience(), target);
      if (params.action === 'choose') {
        return { success: true, data: { recipe: chooseRecipe(layers.merged, params.goal!, { url: target }), guidance: layers.guidance } };
      }
      return { success: true, data: layers };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'site experience operation failed' };
    }
  },
};
