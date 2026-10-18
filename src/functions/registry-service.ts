import type { SkillSpec, SkillManifestSource, WorkflowEntry, WorkflowStep } from './skill-types';
import {
  MIGRATION_FLAG_KEY,
  OLD_WORKFLOW_STORAGE_KEY,
  REGISTRY_SCHEMA_VERSION,
  REGISTRY_STORAGE_KEY,
  type RegistryChangedEvent,
  type RegistryChangeReason,
  type RegistryListener,
  type RegistryServiceOptions,
  type RegistrySnapshot,
  type RegistryStorage,
  type RegistryStore,
} from './registry-model';
const SOURCES_STORAGE_KEY = 'actspan_skill_sources';
const OLD_SOURCES_STORAGE_KEY = 'mole_site_workflow_sources_v1';
const SOURCE_MIGRATION_FLAG_KEY = 'actspan_skill_sources_migrated_v1';

const SOURCE_RANK: Record<SkillSpec['source'], number> = {
  builtin: 1,
  remote: 2,
  user: 3,
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const isObject = (value: unknown): value is Record<string, any> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const normalizeSourceStore = (raw: unknown, now: number): { version: 1; updatedAt: number; sources: SkillManifestSource[] } | null => {
  if (!isObject(raw) || !Array.isArray(raw.sources)) return null;
  const sources = raw.sources
    .filter(isObject)
    .map(source => ({
      url: String(source.url || '').trim(),
      ...(source.label ? { label: String(source.label) } : {}),
      enabled: source.enabled !== false,
      ...(Number.isFinite(Number(source.lastSyncAt)) ? { lastSyncAt: Number(source.lastSyncAt) } : {}),
      ...(Number.isFinite(Number(source.syncStartedAt)) ? { syncStartedAt: Number(source.syncStartedAt) } : {}),
      ...(source.lastSyncError ? { lastSyncError: String(source.lastSyncError) } : {}),
    }))
    .filter(source => source.url);
  return { version: 1, updatedAt: Number(raw.updatedAt) || now, sources };
};

const defaultStorage = (): RegistryStorage | undefined => {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return undefined;
  return {
    get: keys => chrome.storage.local.get<Record<string, unknown>>(keys),
    set: items => chrome.storage.local.set(items),
  };
};

const normalizeStep = (raw: unknown): WorkflowStep | null => {
  if (!isObject(raw)) return null;
  const id = String(raw.id || '').trim();
  const capability = raw.capability;
  if (!id || typeof capability !== 'string') return null;
  const capabilities = new Set([
    'page_read', 'page_click', 'page_type', 'page_eval', 'screenshot', 'agent_delegate',
  ]);
  if (!capabilities.has(capability)) return null;
  const input = isObject(raw.input) ? raw.input : {};
  const onError = raw.onError === 'retry' || raw.onError === 'fallback' ? raw.onError : 'stop';
  return {
    id,
    capability: capability as WorkflowStep['capability'],
    input: clone(input),
    ...(raw.optional === true ? { optional: true } : {}),
    ...(raw.onError ? { onError } : {}),
  };
};
export const normalizeWorkflow = (raw: unknown, now: number): WorkflowEntry | null => {
  if (!isObject(raw)) return null;
  const name = String(raw.name || '').trim();
  const label = String(raw.label || name).trim();
  if (!name || name.length > 128 || !label) return null;
  const plan = isObject(raw.plan) ? clone(raw.plan) : null;
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) return null;
  const steps = plan.steps.map(normalizeStep).filter((step): step is WorkflowStep => step !== null);
  const structuredSteps = steps.length === plan.steps.length ? steps : undefined;
  const parameters = isObject(raw.parameters)
    ? clone(raw.parameters)
    : { type: 'object', properties: {} };
  return {
    name,
    label,
    description: String(raw.description || '').trim(),
    parameters,
    plan,
    ...(structuredSteps ? { steps: structuredSteps } : {}),
    ...(Number.isFinite(Number(raw.version)) ? { version: Math.max(1, Math.floor(Number(raw.version))) } : {}),
    ...(Number.isFinite(Number(raw.updatedAt)) ? { updatedAt: Number(raw.updatedAt) } : { updatedAt: now }),
    ...(typeof raw.contentHash === 'string' && raw.contentHash ? { contentHash: raw.contentHash } : {}),
  };
};

export const normalizeSkill = (raw: unknown, now: number): SkillSpec | null => {
  if (!isObject(raw)) return null;
  const name = String(raw.name || '').trim();
  const label = String(raw.label || name).trim();
  const scope = raw.scope === 'global' || raw.scope === 'domain' ? raw.scope : null;
  const source = raw.source === 'builtin' || raw.source === 'remote' || raw.source === 'user'
    ? raw.source
    : null;
  if (!name || name.length > 128 || !label || !scope || !source) return null;
  const urlPatterns = Array.isArray(raw.url_patterns)
    ? raw.url_patterns.map(value => String(value || '').trim()).filter(Boolean)
    : [];
  if (scope === 'domain' && urlPatterns.length === 0) return null;
  const rawWorkflows = Array.isArray(raw.workflows) ? raw.workflows : [];
  const workflows = rawWorkflows
    .map(workflow => normalizeWorkflow(workflow, now))
    .filter((workflow): workflow is WorkflowEntry => workflow !== null);
  return {
    name,
    label,
    description: String(raw.description || '').trim(),
    scope,
    url_patterns: urlPatterns,
    guide: String(raw.guide || '').trim(),
    workflows,
    enabled: raw.enabled !== false,
    source,
    ...(typeof raw.manifestUrl === 'string' && raw.manifestUrl ? { manifestUrl: raw.manifestUrl } : {}),
    version: Math.max(1, Math.floor(Number(raw.version) || 1)),
    ...(typeof raw.contentHash === 'string' && raw.contentHash ? { contentHash: raw.contentHash } : {}),
    createdAt: Number(raw.createdAt) || now,
    updatedAt: Number(raw.updatedAt) || now,
  };
};

const skillKey = (skill: Pick<SkillSpec, 'name' | 'scope'>): string => `${skill.scope}:${skill.name}`;
const sourceKey = (skill: SkillSpec): string =>
  `${skill.source}:${skill.scope}:${skill.name}:${skill.manifestUrl || ''}`;

const winner = (current: SkillSpec | undefined, candidate: SkillSpec): SkillSpec => {
  if (!current) return candidate;
  const currentRank = SOURCE_RANK[current.source];
  const candidateRank = SOURCE_RANK[candidate.source];
  if (candidateRank !== currentRank) return candidateRank > currentRank ? candidate : current;
  if (candidate.version !== current.version) return candidate.version > current.version ? candidate : current;
  return candidate.updatedAt >= current.updatedAt ? candidate : current;
};

const resolveSkills = (skills: SkillSpec[]): SkillSpec[] => {
  const resolved = new Map<string, SkillSpec>();
  for (const skill of skills) {
    const key = skillKey(skill);
    resolved.set(key, winner(resolved.get(key), skill));
  }
  return Array.from(resolved.values())
    .sort((a, b) => a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === 'global' ? -1 : 1)
    .map(clone);
};

const migrationSkills = (raw: unknown, now: number): SkillSpec[] => {
  if (!isObject(raw) || !Array.isArray(raw.workflows)) return [];
  const result: SkillSpec[] = [];
  for (const item of raw.workflows) {
    if (!isObject(item)) continue;
    if (item.source && item.source !== 'user') continue;
    const workflow = normalizeWorkflow(item, now);
    if (!workflow) continue;
    const name = `user-${workflow.name.replace(/\s+/g, '-')}`;
    const skill = normalizeSkill({
      name,
      label: workflow.label,
      description: workflow.description,
      scope: 'domain',
      url_patterns: Array.isArray(item.url_patterns) && item.url_patterns.length > 0
        ? item.url_patterns : ['*://*/*'],
      guide: '',
      workflows: [workflow],
      enabled: item.enabled !== false,
      source: 'user',
      version: item.version,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }, now);
    if (skill) result.push(skill);
  }
  return result;
};

export class RegistryService {
  private readonly storage: RegistryStorage | undefined;
  private readonly now: () => number;
  private readonly emitExternal?: (event: RegistryChangedEvent) => void;
  private readonly listeners = new Set<RegistryListener>();
  private rawSkills: SkillSpec[] = [];
  private revision = 0;
  private updatedAt = 0;
  private initialized = false;
  private initializing: Promise<void> | null = null;
  private pendingWrite: Promise<void> = Promise.resolve();
  private storageListenerRegistered = false;

  constructor(options: RegistryServiceOptions = {}) {
    this.storage = options.storage || defaultStorage();
    this.now = options.now || Date.now;
    this.emitExternal = options.emit;
    this.rawSkills = (options.initialSkills || [])
      .map(skill => normalizeSkill(skill, this.now()))
      .filter((skill): skill is SkillSpec => skill !== null);
    this.registerStorageListener();
  }

  private registerStorageListener(): void {
    if (this.storageListenerRegistered || typeof chrome === 'undefined' || !chrome.storage?.onChanged) return;
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes[REGISTRY_STORAGE_KEY]) return;
      if (!this.initialized) return;
      void this.reload();
    });
    this.storageListenerRegistered = true;
  }

  private async read(key: string): Promise<unknown> {
    if (!this.storage) return undefined;
    const result = await this.storage.get(key);
    return result[key];
  }

  private async write(items: Record<string, unknown>): Promise<void> {
    if (this.storage) await this.storage.set(items);
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pendingWrite.then(operation);
    this.pendingWrite = result.then(() => {}, () => {});
    return result;
  }

  private store(skills = this.rawSkills, revision = this.revision, updatedAt = this.updatedAt): RegistryStore {
    return {
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      revision,
      skills: clone(skills).sort((a, b) => sourceKey(a).localeCompare(sourceKey(b))),
      updatedAt,
    };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (!this.initializing) {
      this.initializing = this.load().finally(() => { this.initializing = null; });
    }
    return this.initializing;
  }

  private async migrateManifestSources(now: number): Promise<void> {
    if (await this.read(SOURCE_MIGRATION_FLAG_KEY)) return;
    const oldStore = normalizeSourceStore(await this.read(OLD_SOURCES_STORAGE_KEY), now);
    if (!oldStore) {
      await this.write({ [SOURCE_MIGRATION_FLAG_KEY]: true });
      return;
    }
    const canonicalStore = normalizeSourceStore(await this.read(SOURCES_STORAGE_KEY), now);
    const merged = canonicalStore ? [...canonicalStore.sources] : [];
    const knownUrls = new Set(merged.map(source => source.url));
    for (const source of oldStore.sources) {
      if (knownUrls.has(source.url)) continue;
      knownUrls.add(source.url);
      merged.push(source);
    }
    const next = {
      version: 1 as const,
      updatedAt: canonicalStore?.updatedAt || oldStore.updatedAt || now,
      sources: merged,
    };
    if (!canonicalStore || JSON.stringify(canonicalStore.sources) !== JSON.stringify(next.sources)) {
      await this.write({ [SOURCES_STORAGE_KEY]: next });
    }
    await this.write({ [SOURCE_MIGRATION_FLAG_KEY]: true });
  }

  private async load(): Promise<void> {
    const now = this.now();
    const rawStore = await this.read(REGISTRY_STORAGE_KEY);
    const canonical = isObject(rawStore) && Array.isArray(rawStore.skills) ? rawStore : null;
    if (canonical) {
      this.rawSkills = canonical.skills
        .map((skill: unknown) => normalizeSkill(skill, now))
        .filter((skill: SkillSpec | null): skill is SkillSpec => skill !== null);
      this.revision = Math.max(0, Math.floor(Number(canonical.revision) || 0));
      this.updatedAt = Number(canonical.updatedAt) || now;
    }

    await this.migrateManifestSources(now);
    const migrated = await this.read(MIGRATION_FLAG_KEY);
    if (!migrated) {
      const oldSkills = await this.read('mole_skills');
      const oldStore = await this.read(OLD_WORKFLOW_STORAGE_KEY);
      const existing = new Set(this.rawSkills.map(sourceKey));
      const imported = [
        ...(isObject(oldSkills) && Array.isArray(oldSkills.skills) ? oldSkills.skills : [])
          .map(item => normalizeSkill(item, now))
          .filter((item): item is SkillSpec => item !== null),
        ...migrationSkills(oldStore, now),
      ].filter(skill => {
        const key = sourceKey(skill);
        if (existing.has(key)) return false;
        existing.add(key);
        return true;
      });
      if (imported.length > 0) {
        await this.commit([...this.rawSkills, ...imported], imported.map(skill => skill.name), 'migration',
          { [MIGRATION_FLAG_KEY]: true });
      } else {
        await this.write({ [MIGRATION_FLAG_KEY]: true });
      }
    }
    this.updatedAt ||= now;
    this.initialized = true;
  }

  private async commit(nextSkills: SkillSpec[], changedSkills: string[], reason: RegistryChangeReason,
    extra: Record<string, unknown> = {}): Promise<number> {
    const nextRevision = this.revision + 1;
    const timestamp = this.now();
    await this.write({ [REGISTRY_STORAGE_KEY]: this.store(nextSkills, nextRevision, timestamp), ...extra });
    this.rawSkills = nextSkills;
    this.revision = nextRevision;
    this.updatedAt = timestamp;
    const event: RegistryChangedEvent = {
      type: 'registry_changed',
      revision: nextRevision,
      changedSkills: Array.from(new Set(changedSkills)).sort(),
      reason,
      timestamp,
    };
    this.emitExternal?.(event);
    for (const listener of this.listeners) listener(clone(event));
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      try {
        void chrome.runtime.sendMessage(event);
      } catch {
        // Runtime messaging is best-effort; storage remains authoritative.
      }
    }
    return nextRevision;
  }

  async listAll(): Promise<RegistrySnapshot> {
    await this.initialize();
    return {
      revision: this.revision,
      skills: resolveSkills(this.rawSkills),
      updatedAt: this.updatedAt || this.now(),
    };
  }

  async get(name: string, scope?: 'global' | 'domain'): Promise<SkillSpec | undefined> {
    const snapshot = await this.listAll();
    return snapshot.skills.find(skill => skill.name === name && (!scope || skill.scope === scope));
  }

  async upsertSkill(raw: SkillSpec): Promise<{ success: true; revision: number }> {
    await this.initialize();
    return this.serialize(() => this.saveSkill(raw));
  }

  private async saveSkill(raw: SkillSpec): Promise<{ success: true; revision: number }> {
    const skill = normalizeSkill(raw, this.now());
    if (!skill) throw new Error('Invalid skill definition');
    const identity = sourceKey(skill);
    const nextSkills = this.rawSkills.filter(existing => sourceKey(existing) !== identity);
    nextSkills.push(skill);
    const reason: RegistryChangeReason = skill.source === 'user' ? 'user_save' : 'remote_sync';
    const revision = await this.commit(nextSkills, [skill.name], reason);
    return { success: true, revision };
  }

  async upsertWorkflow(skillName: string, rawWorkflow: WorkflowEntry): Promise<{ success: true; revision: number }> {
    await this.initialize();
    return this.serialize(async () => {
      const workflow = normalizeWorkflow(rawWorkflow, this.now());
      if (!workflow) throw new Error('Invalid workflow definition');
      const skill = resolveSkills(this.rawSkills).find(item => item.name === skillName);
      if (!skill) throw new Error(`Skill not found: ${skillName}`);
      const workflows = skill.workflows.filter(item => item.name !== workflow.name);
      workflows.push(workflow);
      return this.saveSkill({ ...skill, workflows, source: 'user', manifestUrl: undefined, updatedAt: this.now() });
    });
  }

  async remove(name: string, scope?: 'global' | 'domain'): Promise<{ success: true; revision: number }> {
    await this.initialize();
    return this.serialize(async () => {
      const existing = resolveSkills(this.rawSkills)
        .find(skill => skill.name === name && (!scope || skill.scope === scope));
      if (!existing) return { success: true, revision: this.revision };
      const identity = sourceKey(existing);
      const nextSkills = this.rawSkills.filter(skill => sourceKey(skill) !== identity);
      const revision = await this.commit(nextSkills, [name], 'user_delete');
      return { success: true, revision };
    });
  }

  async replaceSourceSkills(
    source: 'builtin' | 'remote',
    sourceId: string | undefined,
    incoming: SkillSpec[],
    scope?: 'global' | 'domain',
  ): Promise<{ success: true; revision: number; changed: boolean }> {
    await this.initialize();
    return this.serialize(() => this.replaceSourceSkillsNow(source, sourceId, incoming, scope));
  }

  private async replaceSourceSkillsNow(
    source: 'builtin' | 'remote',
    sourceId: string | undefined,
    incoming: SkillSpec[],
    scope?: 'global' | 'domain',
  ): Promise<{ success: true; revision: number; changed: boolean }> {
    const normalized = incoming
      .map(item => normalizeSkill({ ...item, source, ...(source === 'remote' && sourceId ? { manifestUrl: sourceId } : {}) }, this.now()))
      .filter((item): item is SkillSpec => item !== null)
      .filter(item => !scope || item.scope === scope);
    const kept = this.rawSkills.filter(skill => {
      const owned = skill.source === source && (!scope || skill.scope === scope)
        && (source !== 'remote' || skill.manifestUrl === sourceId);
      return !owned;
    });
    const changedNames = new Set<string>([
      ...this.rawSkills.filter(skill => skill.source === source && (!scope || skill.scope === scope)
        && (source !== 'remote' || skill.manifestUrl === sourceId)).map(skill => skill.name),
      ...normalized.map(skill => skill.name),
    ]);
    const before = JSON.stringify(this.store().skills);
    const nextSkills = [...kept, ...normalized];
    const changed = before !== JSON.stringify(this.store(nextSkills).skills);
    if (!changed) return { success: true, revision: this.revision, changed: false };
    const revision = await this.commit(nextSkills, Array.from(changedNames), 'remote_sync');
    return { success: true, revision, changed: true };
  }

  async removeSourceSkills(source: 'builtin' | 'remote', sourceId?: string, scope?: 'global' | 'domain'):
    Promise<{ success: true; revision: number }> {
    const result = await this.replaceSourceSkills(source, sourceId, [], scope);
    return { success: true, revision: result.revision };
  }

  subscribe(listener: RegistryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async reload(): Promise<void> {
    await this.pendingWrite;
    this.initialized = false;
    this.initializing = null;
    await this.initialize();
  }
}

export const createRegistryService = (options: RegistryServiceOptions = {}): RegistryService =>
  new RegistryService(options);
