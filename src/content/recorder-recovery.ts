export interface RecorderRecovery {
  stepCount: number;
  startedAt: number;
}

export const getRecorderRecovery = (state: unknown, now = Date.now()): RecorderRecovery | null => {
  if (!state || typeof state !== 'object' || !('active' in state) || state.active !== true) {
    return null;
  }

  const steps = 'steps' in state ? state.steps : undefined;
  const startedAt = 'startedAt' in state ? state.startedAt : undefined;
  return {
    stepCount: Array.isArray(steps) ? steps.length : 0,
    startedAt: typeof startedAt === 'number' && startedAt > 0 ? startedAt : now,
  };
};
