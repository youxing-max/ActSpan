export const DEFAULT_LLM_IDLE_TIMEOUT_MS = 60_000;
export const DEFAULT_LLM_TOTAL_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_USER_WAIT_TIMEOUT_MS = 5 * 60_000;

export class DeadlineTimeoutError extends Error {
  readonly code = 'E_TIMEOUT';

  constructor(message = 'Operation timed out') {
    super(`E_TIMEOUT: ${message}`);
    this.name = 'DeadlineTimeoutError';
  }
}

export const isTimeoutError = (error: unknown): error is DeadlineTimeoutError => {
  return error instanceof DeadlineTimeoutError
    || (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'E_TIMEOUT');
};

export interface DeadlineSignal {
  signal: AbortSignal;
  didTimeout: () => boolean;
  timeoutError: DeadlineTimeoutError;
  cleanup: () => void;
}

/** Create an abort signal that preserves caller cancellation and adds a deadline. */
export const createDeadlineSignal = (
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
  message = 'Operation timed out',
): DeadlineSignal => {
  const controller = new AbortController();
  const timeoutError = new DeadlineTimeoutError(message);
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleaned = false;

  const onCallerAbort = () => {
    if (!controller.signal.aborted) controller.abort(callerSignal?.reason);
  };

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (timer !== undefined) clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  };

  if (callerSignal?.aborted) {
    controller.abort(callerSignal.reason);
  } else {
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    timer = setTimeout(() => {
      if (cleaned || controller.signal.aborted) return;
      timedOut = true;
      controller.abort(timeoutError);
    }, timeoutMs);
  }

  return { signal: controller.signal, didTimeout: () => timedOut, timeoutError, cleanup };
};
