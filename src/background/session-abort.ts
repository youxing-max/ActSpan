import type {
    RunningSessionTask,
    Session,
    SessionFailureCode,
    TurnAbortReason,
} from './session-types';
import { GRACEFUL_ABORT_TIMEOUT_MS } from './session-types';

interface AbortTaskResourcesOptions {
    task: RunningSessionTask;
    runningSession: Session | undefined;
    reason: TurnAbortReason;
    message: string;
    failureCode: SessionFailureCode;
    detach?: () => Promise<void>;
    closeByRun: (sessionId: string, runId: string) => Promise<void>;
    timeoutMs?: number;
}

/** 等待任务退出、执行 runner 的 detach hook，再关闭该 run 的资源。 */
export async function abortTaskResources({
    task,
    runningSession,
    reason,
    message,
    failureCode,
    detach,
    closeByRun,
    timeoutMs = GRACEFUL_ABORT_TIMEOUT_MS,
}: AbortTaskResourcesOptions): Promise<void> {
    task.controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const timeout = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
        });
        await Promise.race([task.done, timeout]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }

    task.markDone();
    if (runningSession && task.runner.abort) {
        try {
            await task.runner.abort({
                session: runningSession,
                reason,
                message,
                failureCode,
                task,
            });
        } catch (err) {
            console.warn('[Actspan] 执行任务 abort hook 失败:', err);
        }
    }
    if (detach) {
        try {
            await detach();
        } catch (err) {
            console.warn('[Actspan] debugger detach 失败:', err);
        }
    }
    if (reason === 'interrupted') {
        await closeByRun(task.sessionId, task.runId);
    }
}
