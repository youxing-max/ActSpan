import type { SkillSpec } from './skill-types';

export const REGISTRY_STORAGE_KEY = 'actspan_skills';
export const OLD_WORKFLOW_STORAGE_KEY = 'mole_site_workflows_v1';
export const MIGRATION_FLAG_KEY = 'actspan_registry_migrated_v1';
export const REGISTRY_SCHEMA_VERSION = 1;

export type RegistryChangeReason = 'user_save' | 'user_delete' | 'remote_sync' | 'migration';

export interface RegistryStore {
  schemaVersion: number;
  revision: number;
  skills: SkillSpec[];
  updatedAt: number;
}

export interface RegistrySnapshot {
  revision: number;
  skills: SkillSpec[];
  updatedAt: number;
}

export interface RegistryChangedEvent {
  type: 'registry_changed';
  revision: number;
  changedSkills: string[];
  reason: RegistryChangeReason;
  timestamp: number;
}

export type RegistryListener = (event: RegistryChangedEvent) => void;

export interface RegistryStorage {
  get(
    keys?: string | string[] | null,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
  set(items: Record<string, unknown>): Promise<void> | void;
}

export interface RegistryServiceOptions {
  storage?: RegistryStorage;
  initialSkills?: SkillSpec[];
  now?: () => number;
  emit?: (event: RegistryChangedEvent) => void;
}
