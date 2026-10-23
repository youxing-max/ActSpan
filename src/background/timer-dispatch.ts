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

        // 标签页已关闭也照常执行：free mode 下 IDE agent 创建定时任务后用户大概率会关 tab，
        // 静默不跑会让用户以为任务没设上。没有 tab 就无 tabId 执行，完成后再发系统通知。
        await dispatchSessionOp(`timer:${timerId}`, async () => {
            const session = createSession(task.action, tabExists ? task.tabId : undefined);

            if (tabExists) {
                // 先发送 __ai_timer_trigger 让悬浮球创建任务
                Channel.sendToTab(task.tabId!, '__ai_timer_trigger', {
                    taskId: session.id,
                    sessionId: session.id,
                    action: task.action,
                    timerId,
                    timerType: task.type,
                });
                // 稍等一下让悬浮球创建任务
                await new Promise(r => setTimeout(r, 200));
            }

            // 直接执行（定时触发禁止再创建定时任务）
            await runSessionNow(session, task.action, tabExists ? task.tabId : undefined, {
                coalesceKey,
                disallowTools: ['timer'],
                maxRounds: 20,
                maxToolCalls: 50,
                maxSameToolCalls: 5,
                taskKind: 'aux',
            });

            if (!tabExists) {
                showNotification('定时任务已完成', task.action);
            }
        });
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
        if (task.scheduleMode !== 'runtime') {
            // 扩展重载会清空 chrome.alarms：过期的任务用 when=now+1 立即补触发，
            // 未到期的按原 nextRunAt 重建；interval 仍保持周期 alarm。
            const when = Math.max(task.nextRunAt || now, now + 1);
            const info: chrome.alarms.AlarmCreateInfo = { when };
            if (task.type === 'interval') {
                const intervalMs = task.intervalMs || Math.max(1, Math.round((task.intervalMinutes || 1) * 60 * 1000));
                info.periodInMinutes = Math.max(1, intervalMs / 60_000);
            }
            await chrome.alarms.create(`${TIMER_ALARM_PREFIX}${task.id}`, info);
            continue;
        }

        if (task.type === 'timeout') {
            const nextRunAt = task.nextRunAt || now;
            const delayMs = Math.max(1, nextRunAt - now);
            TimerScheduler.scheduleTimeout(task.id, delayMs);
            continue;
        }

        if (task.type === 'interval') {
            const intervalMs = task.intervalMs || Math.max(1, Math.round((task.intervalMinutes || 1) * 60 * 1000));
            TimerScheduler.scheduleInterval(task.id, intervalMs);
            // 恢复时同步下一次执行时间，便于 UI 展示
            await TimerStore.update(task.id, { nextRunAt: now + intervalMs });
        }
    }
}

/**
 * Service Worker 启动时恢复会话运行态
 */
export async function restoreSessionState() {
    await restoreRuntimeSessions();
}
