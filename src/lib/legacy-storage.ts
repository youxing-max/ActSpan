const markerFor = (newKey: string): string => `actspan_migrated_${newKey}`;

type StorageArea = {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};

/**
 * Import one legacy value once. After the marker is written, the legacy key is
 * never read again, so deleting a new value cannot resurrect old state.
 */
export const readMigratedStorage = async <T>(
  storage: StorageArea,
  newKey: string,
  legacyKey: string,
): Promise<T | undefined> => {
  const markerKey = markerFor(newKey);
  const current = await storage.get([newKey, markerKey]);
  if (current[markerKey] === true) return current[newKey] as T | undefined;
  if (Object.prototype.hasOwnProperty.call(current, newKey)) {
    await storage.set({ [markerKey]: true });
    return current[newKey] as T | undefined;
  }
  const legacyResult = await storage.get(legacyKey);
  const legacy = legacyResult[legacyKey] as T | undefined;
  await storage.set({
    ...(Object.prototype.hasOwnProperty.call(legacyResult, legacyKey) ? { [newKey]: legacy } : {}),
    [markerKey]: true,
  });
  return legacy;
};
