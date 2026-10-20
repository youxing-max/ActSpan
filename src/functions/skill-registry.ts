import type { SkillSpec, WorkflowEntry, SkillManifestSource } from './skill-types';
import { matchSkills } from './skill-matcher';
import {
  createRegistryService,
  normalizeSkill,
  normalizeWorkflow,
  type RegistryService,
} from './registry-service';

const SOURCES_KEY = 'actspan_skill_sources';
const SYNC_ALARM_NAME = 'actspan_skill_sync';
const SYNC_INTERVAL_HOURS = 6;

const getGlobalManifestUrl = (): string =>
  typeof chrome !== 'undefined' && chrome.runtime?.getURL
    ? chrome.runtime.getURL('skills/global/manifest.json') : '';

const getDomainSeedUrl = (): string =>
  typeof chrome !== 'undefined' && chrome.runtime?.getURL
    ? chrome.runtime.getURL('skills/domains/manifest.json') : '';

const hasChromeStorage = (): boolean =>
  typeof chrome !== 'undefined' && Boolean(chrome.storage?.local);

const storageGet = async (key: string): Promise<unknown> => {
  if (!hasChromeStorage()) return undefined;
  const result = await new Promise<Record<string, unknown>>(resolve => {
    chrome.storage.local.get<Record<string, unknown>>(key, resolve);
  });
  return result[key];
};

const storageSet = async (key: string, value: unknown): Promise<void> => {
  if (!hasChromeStorage()) return;
  await new Promise<void>(resolve => chrome.storage.local.set({ [key]: value }, resolve));
};

const registrySources = async (): Promise<SkillManifestSource[]> => {
  const raw = await storageGet(SOURCES_KEY);
  return raw && typeof raw === 'object' && Array.isArray((raw as any).sources)
    ? (raw as any).sources as SkillManifestSource[] : [];
};

const persistSources = async (sources: SkillManifestSource[]): Promise<void> => {
  await storageSet(SOURCES_KEY, { version: 1, updatedAt: Date.now(), sources });
};

export const registryService: RegistryService = createRegistryService();

const fetchBuiltin = async (url: string, scope: 'global' | 'domain'): Promise<void> => {
  if (!url) return;
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) return;
    const payload = await response.json();
    const skills = (Array.isArray(payload?.skills) ? payload.skills : [])
      .map((skill: unknown) => normalizeSkill({ ...(skill as object), source: 'builtin', scope }, Date.now()))
      .filter((skill: SkillSpec | null): skill is SkillSpec => skill !== null);
    await registryService.replaceSourceSkills('builtin', undefined, skills, scope);
  } catch {
    // A bundled manifest is optional; retain the previous canonical snapshot on failure.
  }
};

const syncFromManifestUrl = async (manifestUrl: string): Promise<{
  imported: number;
  skipped: number;
  removed: number;
  error?: string;
}> => {
  try {
    const response = await fetch(manifestUrl, { cache: 'no-store' });
    if (!response.ok) return { imported: 0, skipped: 0, removed: 0, error: `HTTP ${response.status}` };
    const payload = await response.json();
    let rawSkills: unknown[] = Array.isArray(payload?.skills) ? payload.skills : [];
    if (rawSkills.length === 0 && Array.isArray(payload?.workflows)) {
      rawSkills = payload.workflows.map((workflow: any) => ({
        name: `migrated-wf-${String(workflow?.name || '').trim().replace(/\s+/g, '-')}`,
        label: workflow?.label || workflow?.name || '',
        description: workflow?.description || '',
        scope: 'domain',
        url_patterns: workflow?.url_patterns || ['*://*/*'],
        guide: '',
        workflows: [workflow],
        enabled: workflow?.enabled !== false,
        version: workflow?.version || 1,
      }));
    }
    const skills: SkillSpec[] = [];
    let skipped = 0;
    for (const raw of rawSkills) {
      const skill = normalizeSkill({ ...(raw as object), source: 'remote', scope: 'domain', manifestUrl }, Date.now());
      if (!skill) skipped++;
      else skills.push(skill);
    }
    if (!(await registrySources()).some(source => source.url === manifestUrl && source.enabled)) {
      return { imported: 0, skipped, removed: 0, error: 'Manifest 源已移除或停用' };
    }
    const before = await registryService.listAll();
    const result = await registryService.replaceSourceSkills('remote', manifestUrl, skills, 'domain');
    const after = await registryService.listAll();
    const namesBefore = new Set(before.skills.filter(skill => skill.source === 'remote' && skill.manifestUrl === manifestUrl).map(skill => skill.name));
    const namesAfter = new Set(after.skills.filter(skill => skill.source === 'remote' && skill.manifestUrl === manifestUrl).map(skill => skill.name));
    let removed = 0;
    namesBefore.forEach(name => { if (!namesAfter.has(name)) removed++; });
    return { imported: result.changed ? skills.length : 0, skipped, removed };
  } catch (error) {
    return { imported: 0, skipped: 0, removed: 0, error: error instanceof Error ? error.message : '拉取失败' };
  }
};

export const syncAllSkillManifests = async (): Promise<{
  totalImported: number;
  totalSkipped: number;
  errors: string[];
}> => {
  const sources = await registrySources();
  const enabled = sources.filter(item => item.enabled && item.url);
  if (enabled.length) {
    for (const source of enabled) source.syncStartedAt = Date.now();
    await persistSources(sources);
  }
  let totalImported = 0;
  let totalSkipped = 0;
  const errors: string[] = [];
  for (const source of enabled) {
    const result = await syncFromManifestUrl(source.url);
    totalImported += result.imported;
    totalSkipped += result.skipped;
    source.lastSyncAt = Date.now();
    source.lastSyncError = result.error;
    if (result.error) errors.push(`${source.url}: ${result.error}`);
  }
  if (enabled.length > 0) {
    const latest = await registrySources();
    for (const source of enabled) {
      const current = latest.find(item => item.url === source.url && item.syncStartedAt === source.syncStartedAt);
      if (!current) continue;
      current.lastSyncAt = source.lastSyncAt;
      current.lastSyncError = source.lastSyncError;
      delete current.syncStartedAt;
    }
    await persistSources(latest);
  }
  return { totalImported, totalSkipped, errors };
};

const registerSyncAlarm = (): void => {
  if (typeof chrome === 'undefined' || !chrome.alarms || (registerSyncAlarm as any).registered) return;
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === SYNC_ALARM_NAME) void syncAllSkillManifests();
  });
  chrome.alarms.create(SYNC_ALARM_NAME, {
    delayInMinutes: SYNC_INTERVAL_HOURS * 60,
    periodInMinutes: SYNC_INTERVAL_HOURS * 60,
  });
  (registerSyncAlarm as any).registered = true;
};

let registryReadyPromise: Promise<void> | null = null;
export const ensureSkillRegistryReady = async (): Promise<void> => {
  if (!registryReadyPromise) {
    registryReadyPromise = (async () => {
      await registryService.initialize();
      await Promise.all([
        fetchBuiltin(getGlobalManifestUrl(), 'global'),
        fetchBuiltin(getDomainSeedUrl(), 'domain'),
      ]);
      registerSyncAlarm();
      void syncAllSkillManifests();
    })().catch(error => {
      console.warn('[Actspan] 加载 Skill 注册表失败:', error);
    });
  }
  await registryReadyPromise;
};
void ensureSkillRegistryReady();

export const listAllSkills = async (): Promise<SkillSpec[]> => {
  await ensureSkillRegistryReady();
  return (await registryService.listAll()).skills;
};
export const listGlobalSkills = async (): Promise<SkillSpec[]> => {
  await ensureSkillRegistryReady();
  return (await registryService.listAll()).skills.filter(skill => skill.scope === 'global');
};
export const listDomainSkills = async (): Promise<SkillSpec[]> => {
  await ensureSkillRegistryReady();
  return (await registryService.listAll()).skills.filter(skill => skill.scope === 'domain');
};
export const getSkill = async (name: string): Promise<SkillSpec | null> => {
  await ensureSkillRegistryReady();
  return (await registryService.get(name)) || null;
};
export const matchSkillsByUrl = async (url: string): Promise<SkillSpec[]> => {
  await ensureSkillRegistryReady();
  return matchSkills(url, (await registryService.listAll()).skills);
};
export const getWorkflowByName = async (workflowName: string): Promise<WorkflowEntry | null> => {
  await ensureSkillRegistryReady();
  const skills = (await registryService.listAll()).skills;
  for (const skill of skills) {
    if (!skill.enabled) continue;
    const workflow = skill.workflows.find(item => item.name === workflowName);
    if (workflow) return workflow;
  }
  return null;
};

export const upsertUserSkill = async (raw: unknown): Promise<{ success: boolean; message: string }> => {
  const skill = normalizeSkill({ ...(raw as object), source: 'user', scope: 'domain', manifestUrl: undefined }, Date.now());
  if (!skill) return { success: false, message: 'Skill 定义不合法' };
  try {
    await registryService.upsertSkill(skill);
    return { success: true, message: `用户 Skill 已更新：${skill.name}` };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : 'Skill 保存失败' };
  }
};

export const addWorkflowToSkill = async (
  skillName: string,
  workflow: WorkflowEntry,
): Promise<{ success: boolean; message: string }> => {
  try {
    await registryService.upsertWorkflow(skillName, workflow);
    return { success: true, message: `workflow 已添加到 ${skillName}：${workflow.name}` };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : 'workflow 保存失败' };
  }
};

export const upsertUserWorkflow = async (
  workflowRaw: unknown,
  tabUrl?: string,
): Promise<{ success: boolean; message: string }> => {
  const workflow = normalizeWorkflow(workflowRaw, Date.now());
  if (!workflow) return { success: false, message: 'workflow 定义不合法' };
  await ensureSkillRegistryReady();
  if (tabUrl) {
    const matched = matchSkills(tabUrl, (await registryService.listAll()).skills.filter(skill => skill.scope === 'domain'));
    if (matched.length > 0) return addWorkflowToSkill(matched[0].name, workflow);
  }
  const hostPattern = (() => {
    try {
      const hostname = new URL(tabUrl || '').hostname.replace(/^www\./, '');
      return `*://*.${hostname}/*`;
    } catch {
      return '*://*/*';
    }
  })();
  const name = `user-${workflow.name.replace(/\s+/g, '-')}`;
  const skill = normalizeSkill({
    name,
    label: workflow.label,
    description: workflow.description,
    scope: 'domain',
    url_patterns: [hostPattern],
    guide: '',
    workflows: [workflow],
    enabled: true,
    source: 'user',
    version: 1,
  }, Date.now());
  if (!skill) return { success: false, message: 'workflow 定义不合法' };
  await registryService.upsertSkill(skill);
  return { success: true, message: `用户 workflow 已保存为新 Skill：${name}` };
};

export const removeUserSkill = async (name: string): Promise<{ success: boolean; message: string }> => {
  await ensureSkillRegistryReady();
  const skill = await registryService.get(name, 'domain');
  if (!skill) return { success: false, message: `Skill 不存在：${name}` };
  if (skill.source !== 'user') return { success: false, message: '只能删除用户自定义 Skill' };
  await registryService.remove(name, 'domain');
  return { success: true, message: `Skill 已删除：${name}` };
};

export const listManifestSources = async (): Promise<SkillManifestSource[]> => registrySources();

export const addManifestSource = async (url: string, label?: string): Promise<{ success: boolean; message: string }> => {
  const trimmedUrl = String(url || '').trim();
  if (!/^https?:\/\//i.test(trimmedUrl)) return { success: false, message: 'Manifest URL 必须是 http/https' };
  const sources = await registrySources();
  if (sources.some(source => source.url === trimmedUrl)) return { success: false, message: '该 Manifest 源已存在' };
  const source: SkillManifestSource = { url: trimmedUrl, label: label || trimmedUrl, enabled: true, syncStartedAt: Date.now() };
  sources.push(source);
  await persistSources(sources);
  const result = await syncFromManifestUrl(trimmedUrl);
  source.lastSyncAt = Date.now();
  source.lastSyncError = result.error;
  const latest = await registrySources();
  const current = latest.find(item => item.url === trimmedUrl && item.syncStartedAt === source.syncStartedAt);
  if (current) {
    current.lastSyncAt = source.lastSyncAt;
    current.lastSyncError = source.lastSyncError;
    delete current.syncStartedAt;
    await persistSources(latest);
  }
  return result.error
    ? { success: false, message: result.error }
    : { success: true, message: `Manifest 源已添加：${trimmedUrl}` };
};

export const removeManifestSource = async (url: string): Promise<{ success: boolean; message: string }> => {
  const sources = await registrySources();
  const index = sources.findIndex(source => source.url === url);
  if (index < 0) return { success: false, message: '该 Manifest 源不存在' };
  sources.splice(index, 1);
  await persistSources(sources);
  await registryService.removeSourceSkills('remote', url, 'domain');
  return { success: true, message: `Manifest 源已移除：${url}` };
};

export const reloadSkillRegistry = async (): Promise<void> => {
  registryReadyPromise = null;
  await registryService.reload();
  await ensureSkillRegistryReady();
};
