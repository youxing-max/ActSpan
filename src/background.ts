/**
 * Actspan Background Service Worker
 * 处理扩展核心逻辑和跨组件通信
 *
 * 模块职责：
 *   session-manager.ts         — 会话核心（类型/状态/所有内部函数）
 *   session-channel-handlers.ts — 会话 Channel 消息处理器
 *   channel-handlers.ts        — 基础 Channel 消息处理器
 *   workflow-handlers.ts       — 站点工作流/动态工具/调试处理器
 *   timer-dispatch.ts          — 定时器触发调度
 *   resident-ai.ts             — 常驻任务 AI 响应
 *   workflow-recorder.ts       — 工作流录制
 *   bg-tasks-manager.ts        — 后台任务管理
 */
import { VERSION } from './config';
import { LEGACY_STORAGE_KEY_AI_SETTINGS, STORAGE_KEY_AI_SETTINGS } from './ai/llm-client';
import { readMigratedStorage } from './lib/legacy-storage';
import Channel from './lib/channel';
import Storage from './lib/storage';
// [!] registry 必须在 bg-tasks-manager 之前导入，否则循环依赖会导致 TDZ 错误
// 依赖链：bg-tasks-manager → resident-runtime → remote-workflow → registry（循环）
import { ensureToolRegistryReady } from './functions/registry';
import { restoreRuntimeTimers, restoreSessionState } from './background/timer-dispatch';

// 注册所有 Channel 处理器（副作用导入，统一模式）
import './background/channel-handlers';
import './background/workflow-handlers';
import './background/session-channel-handlers';
import './background/bg-tasks-manager';
import './background/workflow-recorder';
import './background/resident-ai';
import './background/timer-dispatch';
import { initMcpBridge } from './background/mcp-bridge';
import { getTaskExecutor, getTaskManager } from './background/policy-executor';
import { createSession, runSessionNow } from './background/session-manager';

// ============ 初始化 ============

// 启动 Channel 监听（background 侧不传 tabId）
Channel.listen();
getTaskManager().setRunner(async (task, input, context) => {
    const query = typeof input.query === 'string' ? input.query : typeof input.goal === 'string' ? input.goal : '';
    if (!query.trim()) throw new Error('任务缺少 query/goal');
    const session = createSession(query, context.tabId);
    await runSessionNow(session, query, context.tabId, {
        allowConcurrent: true,
        signal: context.signal,
        taskKind: 'regular',
        coalesceKey: task.taskId,
    });
    if (session.status === 'error') throw new Error(session.lastError || 'Agent Loop 执行失败');
    return { sessionId: session.id, status: session.status, result: session.context.at(-1) };
});
initMcpBridge();

console.log(`[Actspan] Background Service Worker 已启动, V${VERSION}`);
void ensureToolRegistryReady().catch((err) => {
    console.warn('[Actspan] 初始化动态工具失败:', err);
});

/**
 * 扩展首次安装时，检测是否已配置 AI 设置
 * 若未配置则自动打开 options 页引导用户完成初始化
 */
chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason !== 'install') return;
    void readMigratedStorage<Record<string, string>>(
        chrome.storage.local,
        STORAGE_KEY_AI_SETTINGS,
        LEGACY_STORAGE_KEY_AI_SETTINGS,
    ).then((settings) => {
        const hasConfig = !!(settings?.apiKey || settings?.endpoint);
        if (!hasConfig) chrome.runtime.openOptionsPage();
    });
});

// ============ 启动恢复 ============

// 顺序恢复（先会话、任务，再定时器）
(async () => {
    try {
        await restoreSessionState();
    } catch (err) {
        console.error('[Actspan] 恢复会话状态失败:', err);
    }
    try {
        await getTaskExecutor().recover();
    } catch (err) {
        console.error('[Actspan] 恢复任务状态失败:', err);
    }
    try {
        await restoreRuntimeTimers();
    } catch (err) {
        console.error('[Actspan] 恢复运行时定时器失败:', err);
    }
})();

// ============ 保持 Service Worker 活跃 ============

// 定期发送心跳，防止 Service Worker 被回收
setInterval(() => {
    Storage.get('heartbeat').then(() => {
        Storage.save('heartbeat', Date.now());
    });
}, 20 * 1000);
