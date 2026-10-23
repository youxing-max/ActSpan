/**
 * 定时器触发调度
 * 从 background.ts 提取，处理定时任务触发、Chrome Alarms 和运行时定时器恢复
 */
import Channel from '../lib/channel';
import { TimerStore } from '../lib/timer-store';
import { TimerScheduler } from '../lib/timer-scheduler';
import { computeNextScheduleRun, TIMER_ALARM_PREFIX, LEGACY_TIMER_ALARM_PREFIX } from '../functions/timer';
import { broadcastBgTasksChanged } from './bg-tasks-manager';
import { showNotification } from './channel-handlers';
import {
    createSession,
    runSessionNow,
    hasRunningTasks,
    getRunningTasks,
    dispatchSessionOp,
    RuntimeResourceManager,
    activeCoalescedTasks,
    restoreRuntimeSessions,
} from './session-manager';

// ============ 定时器到期处理 ============

const activeTimerDispatch = new Set<string>();
/** 定时器因同标签页任务而被跳过时的重试间隔 */
const TIMER_BUSY_RETRY_MS = 15_000;

/**
 * 定时任务触发处理（支持 alarm + runtime）
 */
async function handleTimerTrigger(timerId: string, source: 'alarm' | 'runtime_timeout' | 'runtime_interval') {
    if (activeTimerDispatch.has(timerId)) {
        console.log(`[Actspan] 定时器触发忽略（仍在处理上一轮）: ${timerId}, 来源: ${source}`);
        return;
    }

    activeTimerDispatch.add(timerId);
    try {
        const task = await TimerStore.get(timerId);
        if (!task) return;

        const coalesceKey = `timer:${timerId}`;
        const hasInFlightTimerRun = activeCoalescedTasks.has(coalesceKey);
        // 只有同一标签页的任务才构成资源冲突；无关会话不应阻塞定时器
        const tabHasRunningTask = task.tabId
            ? getRunningTasks().some(running => running.tabId === task.tabId)
            : hasRunningTasks();
        if (hasInFlightTimerRun || tabHasRunningTask) {
            if (task.type === 'interval') {
                const intervalMs = task.intervalMs || Math.max(1, Math.round((task.intervalMinutes || 1) * 60 * 1000));
                await TimerStore.update(timerId, {
                    nextRunAt: Date.now() + intervalMs,
                });
            } else if (task.type === 'schedule') {
                // 一次性 alarm 已触发，跳过时必须重新排下一次，否则永久丢失
                const nextRunAt = computeNextScheduleRun(task.scheduleRule!);
                await TimerStore.update(timerId, { nextRunAt });
                await chrome.alarms.create(`${TIMER_ALARM_PREFIX}${timerId}`, { when: nextRunAt });
            } else {
                // timeout 的运行时定时器已触发并清除，短延迟重试而不是丢弃
                const retryAt = Date.now() + TIMER_BUSY_RETRY_MS;
                if (task.scheduleMode === 'runtime') {
                    TimerScheduler.scheduleTimeout(timerId, TIMER_BUSY_RETRY_MS);
                } else {
                    await chrome.alarms.create(`${TIMER_ALARM_PREFIX}${timerId}`, { when: retryAt });
                }
                await TimerStore.update(timerId, { nextRunAt: retryAt });
            }
            console.log(`[Actspan] 定时器触发已合并（同一标签页仍有任务）: ${timerId}`);
            return;
        }

        console.log(`[Actspan] 定时器触发: ${timerId}, 来源: ${source}, 操作: ${task.action}`);

        // 更新计数或清理
        if (task.type === 'interval') {
            task.currentCount++;
            if (task.maxCount && task.currentCount >= task.maxCount) {
                // 达到最大次数，清理
                TimerScheduler.clear(timerId);
                await chrome.alarms.clear(`${TIMER_ALARM_PREFIX}${timerId}`);
                await TimerStore.remove(timerId);
                RuntimeResourceManager.unregisterFromAllSessions('timer', timerId);
                console.log(`[Actspan] 周期任务已达最大次数，已清理: ${timerId}`);
                void broadcastBgTasksChanged();
            } else {
                const intervalMs = task.intervalMs || Math.max(1, Math.round((task.intervalMinutes || 1) * 60 * 1000));
                await TimerStore.update(timerId, {
                    currentCount: task.currentCount,
                    nextRunAt: Date.now() + intervalMs,
                });
            }
        } else if (task.type === 'schedule') {
            task.currentCount++;
            if (task.maxCount && task.currentCount >= task.maxCount) {
                // 达到最大次数，清理
                await chrome.alarms.clear(`${TIMER_ALARM_PREFIX}${timerId}`);
                await TimerStore.remove(timerId);
                RuntimeResourceManager.unregisterFromAllSessions('timer', timerId);
                console.log(`[Actspan] 定时调度已达最大次数，已清理: ${timerId}`);
                void broadcastBgTasksChanged();
            } else {
                // 计算下一次执行时间，创建新的一次性 alarm
                const nextRunAt = computeNextScheduleRun(task.scheduleRule!);
                await TimerStore.update(timerId, { currentCount: task.currentCount, nextRunAt });
                await chrome.alarms.create(`${TIMER_ALARM_PREFIX}${timerId}`, { when: nextRunAt });
            }
        } else {
            // timeout：执行后清理
            TimerScheduler.clear(timerId);
            await TimerStore.remove(timerId);
            RuntimeResourceManager.unregisterFromAllSessions('timer', timerId);
            void broadcastBgTasksChanged();
        }

        // 检查标签页是否存在
        let tabExists = false;
        if (task.tabId) {
            try {
                await chrome.tabs.get(task.tabId);
                tabExists = true;
            } catch {
                tabExists = false;
            }
        }

        if (tabExists) {
            await dispatchSessionOp(`timer:${timerId}`, async () => {
                // 标签页存在：通过 session 体系执行定时任务
                const session = createSession(task.action, task.tabId);
                const taskId = session.id;

                // 先发送 __ai_timer_trigger 让悬浮球创建任务
                Channel.sendToTab(task.tabId, '__ai_timer_trigger', {
                    taskId,
                    sessionId: taskId,
                    action: task.action,
                    timerId,
                    timerType: task.type,
                });

                // 稍等一下让悬浮球创建任务
                await new Promise(r => setTimeout(r, 200));

                // 直接执行（定时触发禁止再创建定时任务）
                await runSessionNow(session, task.action, task.tabId, {
                    coalesceKey,
                    disallowTools: ['timer'],
                    maxRounds: 20,
                    maxToolCalls: 50,
                    maxSameToolCalls: 5,
                    taskKind: 'aux',
                });
            });
        } else {
            // 标签页不存在：显示通知
            showNotification(
                '定时任务触发',
                `${task.action}\n（原标签页已关闭，无法推送结果）`,
            );
        }
    } finally {
        activeTimerDispatch.delete(timerId);
    }
}

/**
 * Chrome Alarms 监听器（分钟级持久调度）
 */
chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm.name.startsWith(TIMER_ALARM_PREFIX)) return;
    const timerId = alarm.name.replace(TIMER_ALARM_PREFIX, '');
    void handleTimerTrigger(timerId, 'alarm').catch(err => {
        console.error(`[Actspan] alarm 定时器处理异常: ${timerId}`, err);
    });
});

/**
 * 运行时定时器触发处理（毫秒级）
 */
TimerScheduler.setTriggerHandler((timerId, source) => {
    return handleTimerTrigger(timerId, source);
});

/**
 * Service Worker 启动时恢复运行时定时器
 */
async function reconcileLegacyTimerAlarms(): Promise<void> {
    const alarms = await new Promise<chrome.alarms.Alarm[]>((resolve) => chrome.alarms.getAll(resolve));
    for (const alarm of alarms) {
        if (!alarm.name.startsWith(LEGACY_TIMER_ALARM_PREFIX)) continue;
        const timerId = alarm.name.slice(LEGACY_TIMER_ALARM_PREFIX.length);
        const canonicalName = `${TIMER_ALARM_PREFIX}${timerId}`;
        try {
            const existing = await new Promise<chrome.alarms.Alarm | undefined>((resolve) => {
                chrome.alarms.get(canonicalName, resolve);
            });
            if (!existing) {
                const info: chrome.alarms.AlarmCreateInfo = { when: alarm.scheduledTime };
                if (typeof alarm.periodInMinutes === 'number') info.periodInMinutes = alarm.periodInMinutes;
                await chrome.alarms.create(canonicalName, info);
            }
            await chrome.alarms.clear(alarm.name);
        } catch (err) {
            console.warn(`[Actspan] 迁移旧定时器 alarm 失败: ${alarm.name}`, err);
        }
    }
}

/** Service Worker 启动时恢复运行时定时器 */
export async function restoreRuntimeTimers() {
    await reconcileLegacyTimerAlarms();
    const tasks = await TimerStore.getAll();
    const now = Date.now();

    for (const task of tasks) {
        // 旧数据可能没有 scheduleMode：按新任务同款规则（timer.ts 的 1 分钟分界）推断，
        // 否则这类任务永远不会被恢复；推断为 alarm 的由 chrome.alarms 持久化，无需处理。
        const inferredInterval = task.intervalMs ?? task.delayMs
            ?? Math.max(1, Math.round((task.intervalMinutes || 1) * 60 * 1000));
        const mode = task.scheduleMode || (inferredInterval < 60_000 ? 'runtime' : 'alarm');
        if (mode !== 'runtime') continue;

        if (task.type === 'timeout') {
            const nextRunAt = task.nextRunAt || now;
            const delayMs = Math.max(1, nextRunAt - now);
            TimerScheduler.scheduleTimeout(task.id, delayMs);
            continue;
        }

        if (task.type === 'interval') {
            const intervalMs = task.intervalMs || Math.max(1, Math.round((task.intervalMinutes || 1) * 60 * 1000));
            TimerScheduler.scheduleInterval(task.id, intervalMs);
            // 保留原始节奏相位：按原 nextRunAt 推算下一个未来触发点，
            // 而不是重置为 now+intervalMs（那会丢弃 SW 睡眠期间的相位并整体漂移）。
            // 不追发欠账，避免 SW 启动瞬间突发放量执行。
            const base = typeof task.nextRunAt === 'number' && task.nextRunAt > 0 ? task.nextRunAt : now;
            const missed = Math.max(0, Math.ceil((now - base) / intervalMs));
            await TimerStore.update(task.id, { nextRunAt: base + missed * intervalMs });
        }
    }
}

/**
 * Service Worker 启动时恢复会话运行态
 */
export async function restoreSessionState() {
    await restoreRuntimeSessions();
}
