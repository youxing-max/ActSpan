import { parseStatusUpdate } from './text-utils';
import type { StatusUpdatePayload } from './text-utils';

/** Status is explicit and replaceable; no tool-name-derived fallback survives a clear. */
export const nextStatusState = (
  current: StatusUpdatePayload | null,
  raw: unknown,
): StatusUpdatePayload | null => {
  if (!raw || typeof raw !== 'object') return current;
  const data = raw as Record<string, unknown>;
  if (data.active === false || data.text === '') return null;
  if (typeof data.text !== 'string') return current;
  return parseStatusUpdate(data) || current;
};
