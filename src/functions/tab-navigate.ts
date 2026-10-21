/**
 * 标签页导航控制工具函数
 * 支持打开/关闭/切换/列出标签页，以及获取当前活动标签页信息
 */

import type { FunctionDefinition, ToolExecutionContext } from './types';
import { tabLeaseManager } from '../background/tab-lease-manager';
import { isBlockedFetchUrl, isSafeNavigableUrl } from '../lib/ssrf-guard';
import { waitForTabComplete } from './tab-utils';
import { taskManager } from '../background/task-manager';
import type { TaskContext } from '../background/task-types';

/**
 * 打开标签页后等待首次加载并复检最终地址：初始 URL 是公网不代表 302 后仍是公网。
 * 命中本机/内网/非 http(s) 时关闭标签页并失败，避免盲 SSRF。
 */
const verifyOpenedTabTarget = async (tabId: number, signal?: AbortSignal): Promise<string | null> => {
  const inspect = (tab: chrome.tabs.Tab | undefined): string | null => {
    const finalUrl = tab?.url || tab?.pendingUrl || '';
    if (!finalUrl || finalUrl.startsWith('about:blank')) return null;
    if (!isSafeNavigableUrl(finalUrl) || isBlockedFetchUrl(finalUrl)) {
      return '目标页面重定向到本机、内网或非 http(s) 地址，已关闭标签页';
    }
    return null;
  };
  try {
    // 已加载完成（含测试替身）时无需等待事件；仍在加载才监听完成事件。
    const initial = await chrome.tabs.get(tabId);
    // 测试替身可能没有 onUpdated；真实 Chrome 始终提供，只有能监听时才等待加载完成。
    const canObserveUpdates = typeof (chrome.tabs as unknown as {
      onUpdated?: { addListener?: unknown };
    }).onUpdated?.addListener === 'function';
    if (initial?.status !== 'complete' && canObserveUpdates) {
      try {
        await waitForTabComplete(tabId, 15_000, '打开标签页等待加载超时', signal);
      } catch {
        // 超时或被用户中止时仍以当前地址为准，继续做一次静态复检。
      }
    }
    const error = inspect(await chrome.tabs.get(tabId));
    if (error) await chrome.tabs.remove(tabId).catch(() => undefined);
    return error;
  } catch {
    // 标签页已被用户关闭或读取失败：没有可复检的目标，按成功返回打开结果。
    return null;
  }
};

/** 操作已有标签页的写动作：必须通过任务租约授权，避免跨任务操作他人标签页。 */
const TAB_WRITE_ACTIONS: Record<string, true> = {
  navigate: true, close: true, switch: true, reload: true, duplicate: true,
  pin: true, mute: true, move: true, go_back: true, go_forward: true,
};

/** 只有携带完整任务租约上下文的调用方才做租约校验；workflow/隔离调试只传 tabId。 */
const ownedContext = (context?: ToolExecutionContext): TaskContext | null => {
  if (!context?.clientId || !context.requestId || !context.taskId || !context.sessionId || !context.owner) return null;
  return {
    clientId: context.clientId,
    requestId: context.requestId,
    taskId: context.taskId,
    sessionId: context.sessionId,
    owner: context.owner,
    tabId: context.tabId,
    signal: context.signal,
  };
};

const isHttpUrl = (value: string): boolean => /^https?:/i.test(String(value).trim());

/** 只有 http(s) 需要做内网/本机校验；about:blank 应放行。 */
const isBlockedNavigationTarget = (value: string): boolean =>
  isHttpUrl(value) && isBlockedFetchUrl(value);

export const tabNavigateFunction: FunctionDefinition = {
  name: 'tab_navigate',
  description: 'Tab navigation control. Supports: open/close/switch/list/reload/go back & forward/duplicate/pin/mute/move tab position.\n\n⚠️ Do NOT use this tool for:\n- Do not use navigate to redirect the page the user is currently browsing (use open to create a new tab instead)\n- Before close, make sure it will not lose the user\'s ongoing work',
  supportsParallel: false,
  permissionLevel: 'interact',
  actionPermissions: {
    // 打开新标签页会立即发起 GET，可用于数据外发或探测本机/内网服务
    open: 'sensitive',
    navigate: 'dangerous',
    close: 'dangerous',
    // 列举所有标签页会暴露用户正在浏览的完整 URL 列表，需确认
    list: 'sensitive',
  },
  approvalMessageTemplate: {
    open: 'AI 正在请求打开标签页 {url}',
    navigate: 'AI 正在请求跳转当前页面到 {url}',
    close: 'AI 正在请求关闭标签页',
    list: 'AI 正在请求列出所有标签页（包含完整 URL）',
  },
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['open', 'navigate', 'close', 'switch', 'list', 'current', 'reload', 'duplicate', 'pin', 'mute', 'move', 'go_back', 'go_forward'],
        description: 'Action type: open(new tab)/navigate(navigate within current tab)/close/switch/list/current/reload/duplicate/pin/mute/move/go_back/go_forward',
      },
      url: {
        type: 'string',
        description: 'URL to open in a new tab or navigate within the current tab (required when action=open/navigate)',
      },
      tab_id: {
        type: 'number',
        description: 'Target tab ID (used when action=close/switch)',
      },
      active: {
        type: 'boolean',
        description: 'Whether to activate (focus) the tab. Default false (opens in background without disturbing the user). Only set to true when the user explicitly requests to navigate/view',
      },
      bypass_cache: {
        type: 'boolean',
        description: 'Whether to bypass cache when reloading the tab (action=reload)',
      },
      pinned: {
        type: 'boolean',
        description: 'Whether to pin the tab (action=pin). Default true',
      },
      muted: {
        type: 'boolean',
        description: 'Whether to mute the tab (action=mute). Default true',
      },
      index: {
        type: 'number',
        description: 'Target position to move to (action=move, 0 is leftmost)',
      },
      keep_alive: {
        type: 'boolean',
        description: 'Default false (auto-close when task ends). Almost never needs to be true. Only set to true when the user explicitly says "open it for me" / "show me this page" and wants the page to persist. Temporary tabs opened during work (searching, researching, data collection) should NEVER be set to true',
      },
    },
    required: ['action'],
  },
  validate: (params: { action?: string; url?: string; tab_id?: number; index?: number }) => {
    const action = params.action;
    if (!action) return 'Missing action';
    if (action === 'open' && !params.url) return 'open requires url';
    if (action === 'navigate' && !params.url) return 'navigate requires url';
    if ((action === 'open' || action === 'navigate') && params.url && !isSafeNavigableUrl(params.url)) {
      return 'url must be http/https (or about:blank)';
    }
    if ((action === 'open' || action === 'navigate') && params.url && isBlockedNavigationTarget(params.url)) {
      return 'url 不允许指向本机或内网地址';
    }
    if (action === 'switch' && typeof params.tab_id !== 'number') return 'switch requires tab_id';
    if (action === 'move' && typeof params.index !== 'number') return 'move requires index';
    return null;
  },
  execute: async (
    params: {
      action: string;
      url?: string;
      tab_id?: number;
      active?: boolean;
      bypass_cache?: boolean;
      pinned?: boolean;
      muted?: boolean;
      index?: number;
    },
    context?: ToolExecutionContext,
  ) => {
    const { action, url, tab_id, active = false, bypass_cache = false, pinned = true, muted = true, index } = params;

    const taskContext = ownedContext(context);
    if (TAB_WRITE_ACTIONS[action] && taskContext) {
      // workflow、隔离调试等只传 tabId 的调用方没有租约上下文，保持原有行为。
      const targetId = action === 'switch' ? tab_id : tab_id || context?.tabId;
      if (typeof targetId === 'number') tabLeaseManager.authorize(taskContext, targetId);
    }

    switch (action) {
      case 'open': {
        if (!url) {
          return { success: false, error: '打开标签页需要提供 url' };
        }
        if (!isSafeNavigableUrl(url)) {
          return { success: false, error: '仅允许打开 http/https 页面（或 about:blank）' };
        }
        if (isBlockedNavigationTarget(url)) {
          return { success: false, error: 'url 不允许指向本机或内网地址' };
        }
        let debugPlacement: Pick<chrome.tabs.CreateProperties, 'openerTabId' | 'windowId'> | undefined;
        if (context?.isolatedDebug && typeof context.tabId === 'number') {
          const openerTab = await chrome.tabs.get(context.tabId);
          debugPlacement = { openerTabId: context.tabId, windowId: openerTab.windowId };
        }
        const tab = await chrome.tabs.create({
          url,
          active,
          ...debugPlacement,
        });
        // 新标签页必须挂到当前任务租约，否则后续 tab_navigate 写动作会被自己的租约校验拒绝。
        if (taskContext && typeof tab.id === 'number') {
          const task = taskManager.get(taskContext.taskId);
          if (task) {
            try {
              tabLeaseManager.acquire(task, tab.id, taskContext.clientId);
            } catch { /* 标签页已创建，租约失败不应回滚打开结果 */ }
          }
        }
        if (typeof tab.id === 'number') {
          const redirectError = await verifyOpenedTabTarget(tab.id, context?.signal);
          if (redirectError) {
            if (taskContext) tabLeaseManager.release(taskContext.taskId, tab.id, taskContext.clientId);
            return { success: false, error: redirectError };
          }
        }
        return {
          success: true,
          data: {
            tab_id: tab.id,
            url: tab.pendingUrl || url,
            message: active ? '已打开并跳转到新标签页' : '已在后台打开新标签页',
          },
        };
      }

      case 'navigate': {
        if (!url) {
          return { success: false, error: '当前标签页导航需要提供 url' };
        }
        if (!isSafeNavigableUrl(url)) {
          return { success: false, error: '仅允许导航到 http/https 页面（或 about:blank）' };
        }
        if (isBlockedNavigationTarget(url)) {
          return { success: false, error: 'url 不允许指向本机或内网地址' };
        }
        const targetId = tab_id || context?.tabId;
        if (!targetId) {
          return { success: false, error: '无法确定当前标签页' };
        }
        try {
          const tab = await chrome.tabs.update(targetId, { url });
          if (!tab) {
            return { success: false, error: '当前标签页导航失败: 标签页不存在' };
          }
          return {
            success: true,
            data: {
              tab_id: tab.id,
              url: tab.pendingUrl || url,
              message: '已在当前标签页内导航',
            },
          };
        } catch (err: any) {
          return { success: false, error: `当前标签页导航失败: ${err.message}` };
        }
      }

      case 'close': {
        const targetId = tab_id || context?.tabId;
        if (!targetId) {
          return { success: false, error: '需要提供 tab_id' };
        }
        try {
          await chrome.tabs.remove(targetId);
          return {
            success: true,
            data: { message: `已关闭标签页 ${targetId}` },
          };
        } catch (err: any) {
          return { success: false, error: `关闭标签页失败: ${err.message}` };
        }
      }

      case 'switch': {
        if (!tab_id) {
          return { success: false, error: '切换标签页需要提供 tab_id' };
        }
        try {
          await chrome.tabs.update(tab_id, { active: true });
          const tab = await chrome.tabs.get(tab_id);
          return {
            success: true,
            data: {
              tab_id: tab.id,
              url: tab.url,
              title: tab.title,
              message: '已切换到目标标签页',
            },
          };
        } catch (err: any) {
          return { success: false, error: `切换标签页失败: ${err.message}` };
        }
      }

      case 'list': {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        const tabList = tabs.map(t => ({
          tab_id: t.id,
          title: t.title || '',
          url: t.url || '',
          active: t.active,
          index: t.index,
        }));
        return {
          success: true,
          data: { total: tabList.length, tabs: tabList },
        };
      }

      case 'current': {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab) {
          return { success: false, error: '无法获取当前标签页' };
        }
        return {
          success: true,
          data: {
            tab_id: activeTab.id,
            title: activeTab.title,
            url: activeTab.url,
            favicon: activeTab.favIconUrl,
          },
        };
      }

      case 'reload': {
        const targetId = tab_id || context?.tabId;
        if (!targetId) return { success: false, error: '刷新标签页需要提供 tab_id' };
        try {
          await chrome.tabs.reload(targetId, { bypassCache: bypass_cache });
          return {
            success: true,
            data: { tab_id: targetId, bypass_cache, message: '已刷新标签页' },
          };
        } catch (err: any) {
          return { success: false, error: `刷新标签页失败: ${err.message}` };
        }
      }

      case 'duplicate': {
        const targetId = tab_id || context?.tabId;
        if (!targetId) return { success: false, error: '复制标签页需要提供 tab_id' };
        try {
          const tab = await chrome.tabs.duplicate(targetId);
          if (!tab) {
            return { success: false, error: '复制标签页失败: 标签页不存在' };
          }
          return {
            success: true,
            data: {
              tab_id: tab.id,
              url: tab.url,
              title: tab.title,
              message: '已复制标签页',
            },
          };
        } catch (err: any) {
          return { success: false, error: `复制标签页失败: ${err.message}` };
        }
      }

      case 'pin': {
        const targetId = tab_id || context?.tabId;
        if (!targetId) return { success: false, error: '固定标签页需要提供 tab_id' };
        try {
          const tab = await chrome.tabs.update(targetId, { pinned });
          if (!tab) {
            return { success: false, error: '更新标签页固定状态失败: 标签页不存在' };
          }
          return {
            success: true,
            data: {
              tab_id: tab.id,
              pinned: tab.pinned,
              message: tab.pinned ? '已固定标签页' : '已取消固定标签页',
            },
          };
        } catch (err: any) {
          return { success: false, error: `更新标签页固定状态失败: ${err.message}` };
        }
      }

      case 'mute': {
        const targetId = tab_id || context?.tabId;
        if (!targetId) return { success: false, error: '静音标签页需要提供 tab_id' };
        try {
          const tab = await chrome.tabs.update(targetId, { muted });
          if (!tab) {
            return { success: false, error: '更新标签页静音状态失败: 标签页不存在' };
          }
          return {
            success: true,
            data: {
              tab_id: tab.id,
              muted: tab.mutedInfo?.muted || false,
              message: tab.mutedInfo?.muted ? '已静音标签页' : '已取消静音',
            },
          };
        } catch (err: any) {
          return { success: false, error: `更新标签页静音状态失败: ${err.message}` };
        }
      }

      case 'move': {
        const targetId = tab_id || context?.tabId;
        if (!targetId || typeof index !== 'number' || !Number.isFinite(index)) {
          return { success: false, error: '移动标签页需要提供 tab_id 和有效的 index' };
        }
        try {
          const tab = await chrome.tabs.move(targetId, { index: Math.max(0, Math.floor(index)) });
          return {
            success: true,
            data: {
              tab_id: tab.id,
              index: tab.index,
              message: `已移动标签页到位置 ${tab.index}`,
            },
          };
        } catch (err: any) {
          return { success: false, error: `移动标签页失败: ${err.message}` };
        }
      }

      case 'go_back': {
        const targetId = tab_id || context?.tabId;
        if (!targetId) return { success: false, error: '后退需要提供 tab_id' };
        try {
          await chrome.tabs.goBack(targetId);
          return {
            success: true,
            data: { tab_id: targetId, message: '已执行后退' },
          };
        } catch (err: any) {
          return { success: false, error: `后退失败: ${err.message}` };
        }
      }

      case 'go_forward': {
        const targetId = tab_id || context?.tabId;
        if (!targetId) return { success: false, error: '前进需要提供 tab_id' };
        try {
          await chrome.tabs.goForward(targetId);
          return {
            success: true,
            data: { tab_id: targetId, message: '已执行前进' },
          };
        } catch (err: any) {
          return { success: false, error: `前进失败: ${err.message}` };
        }
      }

      default:
        return { success: false, error: `不支持的操作: ${action}` };
    }
  },
};
