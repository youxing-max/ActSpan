import type { SkillManifestSource } from '../../functions/skill-types';

export const getSyncStatus = (sources: SkillManifestSource[], now = Date.now()): 'ready' | 'syncing' | 'stale' | 'error' => {
  const active = sources.filter(source => source.enabled);
  if (active.some(source => source.syncStartedAt && now - source.syncStartedAt < 10 * 60 * 1000)) return 'syncing';
  if (active.some(source => source.syncStartedAt)) return active.some(source => source.lastSyncError) ? 'error' : 'stale';
  if (active.some(source => source.lastSyncError)) return 'error';
  if (active.some(source => !source.lastSyncAt || now - source.lastSyncAt > 12 * 60 * 60 * 1000)) return 'stale';
  return 'ready';
};
