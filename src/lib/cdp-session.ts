/**
 * Chrome DevTools Protocol 会话管理器
 * 管理 chrome.debugger 的 attach/detach 生命周期
 * 提供 sendCommand 封装，自动确保 debugger 已 attach
 *
 * Phase 2: Page/Runtime 域、对话框、iframe context
 * Phase 3: Network 域事件监听、Console/Exception 捕获
 */

// ============ 类型 ============

interface CDPSessionEntry {
  tabId: number;
  attachedAt: number;
  /** 已启用的 CDP 域（Page, Runtime, Network 等） */
  domainsEnabled: Set<string>;
}

/** JS 对话框类型 */
type DialogType = 'alert' | 'confirm' | 'prompt' | 'beforeunload';

/** 待处理对话框信息 */
interface PendingDialog {
  message: string;
  type: DialogType;
  defaultPrompt: string;
  url: string;
  receivedAt: number;
}

/** 对话框自动处理策略 */
type DialogPolicy = 'manual' | 'auto_accept' | 'auto_dismiss';

/** CDP 网络事件 */
export interface CDPNetworkEvent {
  requestId: string;
  method: string;
  url: string;
  resourceType: string;
  timestamp: number;
  // 请求
  requestHeaders?: Record<string, string>;
  postData?: string;
  // 响应
  statusCode?: number;
  statusText?: string;
  responseHeaders?: Record<string, string>;
  mimeType?: string;
  // 时序
  startTime: number;
  endTime?: number;
  durationMs?: number;
  // 其他
  error?: string;
  fromCache?: boolean;
}

/** 网络监听配置 */
interface NetworkListeningState {
  active: boolean;
  urlPatterns: string[];
  maxEvents: number;
  startedAt: number;
  /** pending 表中的单请求滞留上限（毫秒），超时即驱逐 */
  pendingTimeoutMs: number;
  /** 单次监听最长时间，防止客户端忘记 stop 导致 debugger 永久附着 */
  maxDurationMs: number;
  /** 上一次惰性清理 pending 的时间（节流） */
  lastEvictAt: number;
}

/** 控制台消息 */
export interface CDPConsoleEntry {
  type: string;
  text: string;
  timestamp: number;
  url?: string;
  lineNumber?: number;
  stackTrace?: string;
}

/** 未捕获异常 */
export interface CDPExceptionEntry {
  text: string;
  timestamp: number;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  stackTrace?: string;
}

/** 控制台监听配置 */
interface ConsoleListeningState {
  active: boolean;
  maxEntries: number;
  startedAt: number;
}

/** Fetch 域被暂停的请求 */
export interface CDPFetchPausedRequest {
  requestId: string;
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;
  };
  resourceType: string;
  frameId: string;
  /** 仅 Response 阶段有值 */
  responseStatusCode?: number;
  responseHeaders?: Array<{ name: string; value: string }>;
  networkId?: string;
  pausedAt: number;
}

/** Fetch 拦截配置 */
interface FetchInterceptionState {
  active: boolean;
  urlPatterns: string[];
  resourceTypes: string[];
  maxPaused: number;
  startedAt: number;
}

// ============ 内部状态 ============

/** L2 debugger idle lifecycle. */
export const L2_IDLE_MS = 5000;
export type CDPLifecycleErrorCode = 'NEEDS_L2' | 'L2_BUSY';

export interface CDPCommandResult {
  success: boolean;
  result?: any;
  error?: string;
  code?: CDPLifecycleErrorCode;
}

const sessions = new Map<number, CDPSessionEntry>();
const idleTimers = new Map<number, ReturnType<typeof setTimeout>>();
const inFlightCommands = new Map<number, number>();

/** debugger 协议版本 */
const PROTOCOL_VERSION = '1.3';

// --- 对话框 ---
const pendingDialogs = new Map<number, PendingDialog>();
const dialogPolicies = new Map<number, DialogPolicy>();

// --- Frame ---
const frameContexts = new Map<number, Map<string, number>>();

// --- 网络 ---
const networkEvents = new Map<number, CDPNetworkEvent[]>();
const networkListening = new Map<number, NetworkListeningState>();
const networkExpiryTimers = new Map<number, ReturnType<typeof setTimeout>>();
/** 网络请求临时数据（用于关联 requestWillBeSent 和后续事件） */
const networkPendingRequests = new Map<number, Map<string, CDPNetworkEvent>>();

// --- 控制台 ---
const consoleEntries = new Map<number, CDPConsoleEntry[]>();
const exceptionEntries = new Map<number, CDPExceptionEntry[]>();
const consoleListening = new Map<number, ConsoleListeningState>();

// --- Fetch 拦截 ---
const fetchPausedRequests = new Map<number, Map<string, CDPFetchPausedRequest>>();
const fetchInterception = new Map<number, FetchInterceptionState>();

// ============ 基础方法 ============

const isSupported = (): boolean => {
  return typeof chrome !== 'undefined' && Boolean(chrome.debugger);
};

const clearIdleTimer = (tabId: number): void => {
  const timer = idleTimers.get(tabId);
  if (timer !== undefined) clearTimeout(timer);
  idleTimers.delete(tabId);
};

const notifyCommandIdle = (tabId: number): void => {
  if ((inFlightCommands.get(tabId) || 0) > 0) return;
  scheduleIdleDetach(tabId);
};

const hasActiveListeners = (tabId: number): boolean => {
  return networkListening.get(tabId)?.active === true
    || consoleListening.get(tabId)?.active === true
    || fetchInterception.get(tabId)?.active === true;
};

const scheduleIdleDetach = (tabId: number): void => {
  clearIdleTimer(tabId);
  if (!sessions.has(tabId)) return;
  // 控制台/Fetch/网络监听期间必须保持 attach，否则约 5 秒后捕获会静默失效。
  if (hasActiveListeners(tabId)) return;
  idleTimers.set(tabId, setTimeout(() => {
    idleTimers.delete(tabId);
    if ((inFlightCommands.get(tabId) || 0) > 0) { scheduleIdleDetach(tabId); return; }
    // attach 与激活监听之间可能已经排入定时器，回调时再检查一次。
    if (hasActiveListeners(tabId)) return;
    void detach(tabId);
  }, L2_IDLE_MS));
};

const touchSession = (tabId: number): void => {
  if (sessions.has(tabId)) scheduleIdleDetach(tabId);
};

const errorMessage = (error: unknown): string => {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = error.message;
    return typeof message === 'string' ? message : String(message);
  }
  return String(error || '');
};

type AttachResult = { success: boolean; error?: string; code?: CDPLifecycleErrorCode };
const attachInFlight = new Map<number, Promise<AttachResult>>();

const attach = async (tabId: number): Promise<AttachResult> => {
  if (!isSupported()) {
    return { success: false, code: 'NEEDS_L2', error: '需要启用高保真调试器权限：请点开扩展图标启用高保真模式' };
  }

  if (sessions.has(tabId)) {
    touchSession(tabId);
    return { success: true };
  }
  const pending = attachInFlight.get(tabId);
  if (pending) return pending;

  const operation = (async (): Promise<AttachResult> => {
    try {
      await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
      const entry: CDPSessionEntry = { tabId, attachedAt: Date.now(), domainsEnabled: new Set() };
      sessions.set(tabId, entry);

      // 自动启用 Page 和 Runtime 域
      try {
        await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {});
        entry.domainsEnabled.add('Page');
      } catch { /* 忽略 */ }

      try {
        await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {});
        entry.domainsEnabled.add('Runtime');
      } catch { /* 忽略 */ }

      scheduleIdleDetach(tabId);
      return { success: true };
    } catch (err: unknown) {
      const msg = errorMessage(err);
      if (msg.includes('Another debugger is already attached')) {
        return {
          success: false,
          code: 'L2_BUSY',
          error: 'L2_BUSY：多半是你自己开着 DevTools——一个标签页只允许一个调试器。已自动降级；如需真实事件请关闭 DevTools 后重试',
        };
      }
      return {
        success: false,
        code: 'NEEDS_L2',
        error: `NEEDS_L2：需要启用高保真调试器权限，请点开扩展图标启用高保真模式（${msg || 'debugger attach 失败'}）`,
      };
    }
  })();
  attachInFlight.set(tabId, operation);
  try {
    return await operation;
  } finally {
    attachInFlight.delete(tabId);
  }
};

/** 清理指定 tab 的调试器会话状态。网络捕获结果是浏览器侧的真实观察，不随 detach 丢弃：
 *  空闲 5s 的 L2 detach 若顺手清空缓冲，会让「刚看过的请求」在下次读取时凭空消失。 */
const cleanupTabState = (tabId: number): void => {
  clearIdleTimer(tabId);
  inFlightCommands.delete(tabId);
  sessions.delete(tabId);
  pendingDialogs.delete(tabId);
  dialogPolicies.delete(tabId);
  frameContexts.delete(tabId);
  networkPendingRequests.delete(tabId);
  consoleEntries.delete(tabId);
  exceptionEntries.delete(tabId);
  consoleListening.delete(tabId);
  fetchPausedRequests.delete(tabId);
  fetchInterception.delete(tabId);
};

const waitForCommands = async (tabId: number): Promise<void> => {
  if ((inFlightCommands.get(tabId) || 0) === 0) return;
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if ((inFlightCommands.get(tabId) || 0) === 0) {
        clearInterval(timer);
        resolve();
      }
    }, 10);
  });
};

const detach = async (tabId: number): Promise<{ success: boolean; error?: string }> => {
  clearIdleTimer(tabId);
  if (!sessions.has(tabId)) return { success: true };
  await waitForCommands(tabId);
  cleanupTabState(tabId);
  if (!isSupported()) return { success: true };
  try {
    await chrome.debugger.detach({ tabId });
  } catch { /* 已由用户或浏览器断开 */ }
  return { success: true };
};

const isAttached = (tabId: number): boolean => {
  return sessions.has(tabId);
};

const sendCommand = async (
  tabId: number,
  method: string,
  params?: Record<string, any>,
): Promise<CDPCommandResult> => {
  const attachResult = await attach(tabId);
  if (!attachResult.success) {
    return { success: false, code: attachResult.code, error: attachResult.error };
  }
  touchSession(tabId);
  inFlightCommands.set(tabId, (inFlightCommands.get(tabId) || 0) + 1);
  try {
    const pausedRequest = method === 'Fetch.continueRequest' || method === 'Fetch.fulfillRequest' || method === 'Fetch.failRequest'
      ? fetchPausedRequests.get(tabId)?.get(params?.requestId) : undefined;
    const result = await chrome.debugger.sendCommand({ tabId }, method, params || {});
    if (pausedRequest && fetchPausedRequests.get(tabId)?.get(params?.requestId) === pausedRequest) {
      fetchPausedRequests.get(tabId)?.delete(params?.requestId);
    }
    return { success: true, result };
  } catch (err: unknown) {
    const msg = errorMessage(err) || 'CDP 命令执行失败';
    if (msg.includes('Another debugger is already attached')) {
      return { success: false, code: 'L2_BUSY', error: `L2_BUSY：${msg}。已自动降级；如需真实事件请关闭 DevTools 后重试` };
    }
    if (msg.includes('Debugger is not attached') || msg.includes('No tab with given id')) {
      cleanupTabState(tabId);
      return { success: false, code: 'NEEDS_L2', error: `NEEDS_L2：${msg}` };
    }
    return { success: false, error: msg };
  } finally {
    const remaining = Math.max(0, (inFlightCommands.get(tabId) || 1) - 1);
    if (remaining === 0) inFlightCommands.delete(tabId);
    else inFlightCommands.set(tabId, remaining);
    notifyCommandIdle(tabId);
  }
};

const detachTab = async (tabId: number): Promise<void> => {
  if (sessions.has(tabId)) {
    await detach(tabId);
  }
};

const listAttached = (): number[] => {
  return Array.from(sessions.keys());
};

// ============ 对话框相关方法 ============

const getPendingDialog = (tabId: number): PendingDialog | null => {
  return pendingDialogs.get(tabId) || null;
};

const handleDialog = async (
  tabId: number,
  accept: boolean,
  promptText?: string,
): Promise<{ success: boolean; error?: string }> => {
  const dialog = pendingDialogs.get(tabId);
  if (!dialog) {
    return { success: false, error: '当前没有待处理的对话框' };
  }
  const cmdParams: Record<string, any> = { accept };
  if (accept && typeof promptText === 'string') {
    cmdParams.promptText = promptText;
  }
  const result = await sendCommand(tabId, 'Page.handleJavaScriptDialog', cmdParams);
  if (result.success) {
    pendingDialogs.delete(tabId);
  }
  return result;
};

const setDialogPolicy = (tabId: number, policy: DialogPolicy): void => {
  if (policy === 'manual') {
    dialogPolicies.delete(tabId);
  } else {
    dialogPolicies.set(tabId, policy);
  }
};

const getDialogPolicy = (tabId: number): DialogPolicy => {
  return dialogPolicies.get(tabId) || 'manual';
};

// ============ Frame 相关方法 ============

const getFrameContextId = (tabId: number, frameId: string): number | null => {
  const map = frameContexts.get(tabId);
  if (!map) return null;
  return map.get(frameId) ?? null;
};

const clearFrameContexts = (tabId: number): void => {
  frameContexts.delete(tabId);
};

// ============ 网络监听方法 ============

/** 单个请求允许在 pending 表中滞留的上限：SSE / 长轮询 / chunked 永远等不到
 *  loadingFinished / loadingFailed，没有上限时 pending map 会随请求数无限累积。 */
export const NETWORK_PENDING_TIMEOUT_MS = 60_000;
/** 网络监听最大时长：到期自动停止并 detach，避免忘记 stop 时 debugger 常驻 */
export const NETWORK_MAX_LISTEN_MS = 30 * 60_000;
/** 被驱逐请求写入事件队列时使用的标记，与真实网络错误区分 */
const PENDING_TIMEOUT_ERROR = 'pending timeout';

/** URL 通配符匹配 */
const matchUrlPattern = (url: string, pattern: string): boolean => {
  // 将通配符模式转为正则
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  try {
    return new RegExp(`^${escaped}$`, 'i').test(url);
  } catch {
    return url.includes(pattern.replace(/\*/g, ''));
  }
};

/** 检查 URL 是否匹配监听过滤器 */
const matchesNetworkFilter = (tabId: number, url: string): boolean => {
  const state = networkListening.get(tabId);
  if (!state?.active) return false;
  if (!state.urlPatterns.length) return true; // 空模式 = 全部匹配
  return state.urlPatterns.some((p) => matchUrlPattern(url, p));
};

/** 按 startedAt + maxDurationMs 注册到期停止，空闲监听也不会永久附着调试器。 */
const scheduleNetworkExpiry = (tabId: number): void => {
  const state = networkListening.get(tabId);
  const existingTimer = networkExpiryTimers.get(tabId);
  if (existingTimer !== undefined) clearTimeout(existingTimer);
  networkExpiryTimers.delete(tabId);
  if (!state?.active) return;
  const remaining = Math.max(0, state.startedAt + state.maxDurationMs - Date.now());
  const timer = setTimeout(() => {
    networkExpiryTimers.delete(tabId);
    if (networkListening.get(tabId)?.startedAt === state.startedAt) {
      void stopNetworkListening(tabId);
    }
  }, remaining);
  // Node 测试环境：容忍 30 分钟的到期定时器不应吊住进程。
  (timer as unknown as { unref?: () => void }).unref?.();
  networkExpiryTimers.set(tabId, timer);
};

/** 向事件队列中追加，超过上限时丢弃最旧的 */
const pushNetworkEvent = (tabId: number, event: CDPNetworkEvent): void => {
  const state = networkListening.get(tabId);
  if (!state) return;
  const now = Date.now();
  // 惰性清理 pending：每次事件都全表扫描太贵，节流到 5 秒一次
  if (now - state.lastEvictAt >= 5_000) {
    state.lastEvictAt = now;
    evictStalePendingRequests(tabId);
  }
  // 超过最大监听时长后自动停止，避免调试器永久附着
  if (now - state.startedAt > state.maxDurationMs) {
    void stopNetworkListening(tabId);
    return;
  }
  let events = networkEvents.get(tabId);
  if (!events) {
    events = [];
    networkEvents.set(tabId, events);
  }
  events.push(event);
  // 超出上限，移除最旧的
  while (events.length > state.maxEvents) {
    events.shift();
  }
};

/** 驱逐滞留超时的 pending 请求：标记超时并落入事件队列，随后从 pending 中移除，
 *  保证永不完成的请求不会无限占用内存。请求之后若真的完成，pending 已无该条目，不会重复记录。 */
const evictStalePendingRequests = (tabId: number): void => {
  const pending = networkPendingRequests.get(tabId);
  if (!pending || pending.size === 0) return;
  const timeoutMs = networkListening.get(tabId)?.pendingTimeoutMs ?? NETWORK_PENDING_TIMEOUT_MS;
  const now = Date.now();
  for (const [requestId, event] of pending) {
    if (now - event.startTime <= timeoutMs) continue;
    pending.delete(requestId);
    event.endTime = now;
    event.durationMs = now - event.startTime;
    event.error = PENDING_TIMEOUT_ERROR;
    pushNetworkEvent(tabId, event);
  }
};

/** 开始网络监听（启用 Network 域） */
const startNetworkListening = async (
  tabId: number,
  options?: { urlPatterns?: string[]; maxEvents?: number; pendingTimeoutMs?: number },
): Promise<{ success: boolean; error?: string }> => {
  const attachResult = await attach(tabId);
  if (!attachResult.success) {
    return { success: false, error: attachResult.error };
  }

  const entry = sessions.get(tabId);
  if (entry && !entry.domainsEnabled.has('Network')) {
    const enableResult = await sendCommand(tabId, 'Network.enable', {});
    if (!enableResult.success) {
      return { success: false, error: `启用 Network 域失败: ${enableResult.error}` };
    }
    entry.domainsEnabled.add('Network');
  }

  const maxEvents = Math.max(20, Math.min(5000, Math.floor(options?.maxEvents || 500)));
  const pendingTimeoutMs = Math.max(50, Math.floor(options?.pendingTimeoutMs || NETWORK_PENDING_TIMEOUT_MS));
  const existing = networkListening.get(tabId);
  const alreadyActive = existing?.active === true;
  // 已在监听时保留既有捕获，避免第二个调用方清空第一个客户端的数据
  if (!alreadyActive) {
    networkEvents.set(tabId, []);
    networkPendingRequests.set(tabId, new Map());
  }
  networkListening.set(tabId, {
    active: true,
    urlPatterns: options?.urlPatterns || existing?.urlPatterns || [],
    maxEvents,
    // 重复 start 不重置计时，防止无限续期绕过最大时长
    startedAt: alreadyActive ? existing.startedAt : Date.now(),
    pendingTimeoutMs,
    maxDurationMs: existing?.maxDurationMs ?? NETWORK_MAX_LISTEN_MS,
    lastEvictAt: Date.now(),
  });
  scheduleIdleDetach(tabId);
  scheduleNetworkExpiry(tabId);

  return { success: true };
};

/** 让捕获状态与当前 attach 会话对齐：域被 detach 关掉后重新启用，但不重置已捕获事件。 */
const ensureNetworkListening = async (tabId: number): Promise<{ success: boolean; error?: string }> => {
  const attachResult = await attach(tabId);
  if (!attachResult.success) {
    return { success: false, error: attachResult.error };
  }

  const entry = sessions.get(tabId);
  if (entry && !entry.domainsEnabled.has('Network')) {
    const enableResult = await sendCommand(tabId, 'Network.enable', {});
    if (!enableResult.success) {
      return { success: false, error: `启用 Network 域失败: ${enableResult.error}` };
    }
    entry.domainsEnabled.add('Network');
  }

  if (!networkListening.has(tabId)) {
    networkListening.set(tabId, {
      active: true,
      urlPatterns: [],
      maxEvents: 2000,
      startedAt: Date.now(),
      pendingTimeoutMs: NETWORK_PENDING_TIMEOUT_MS,
      maxDurationMs: NETWORK_MAX_LISTEN_MS,
      lastEvictAt: Date.now(),
    });
  }
  if (!networkEvents.has(tabId)) networkEvents.set(tabId, []);
  if (!networkPendingRequests.has(tabId)) networkPendingRequests.set(tabId, new Map());
  scheduleIdleDetach(tabId);
  scheduleNetworkExpiry(tabId);

  return { success: true };
};

/** 停止网络监听（禁用 Network 域） */
const stopNetworkListening = async (tabId: number): Promise<void> => {
  const expiryTimer = networkExpiryTimers.get(tabId);
  if (expiryTimer !== undefined) clearTimeout(expiryTimer);
  networkExpiryTimers.delete(tabId);
  networkListening.delete(tabId);
  networkPendingRequests.delete(tabId);

  const entry = sessions.get(tabId);
  if (entry?.domainsEnabled.has('Network')) {
    await sendCommand(tabId, 'Network.disable', {}).catch(() => { /* 忽略 */ });
    entry.domainsEnabled.delete('Network');
  }
  if (sessions.has(tabId)) scheduleIdleDetach(tabId);
};

const isNetworkListening = (tabId: number): boolean => {
  return networkListening.get(tabId)?.active === true;
};

/** 获取网络事件列表 */
const getNetworkEvents = (
  tabId: number,
  options?: { onlyErrors?: boolean; urlFilter?: string; limit?: number },
): CDPNetworkEvent[] => {
  evictStalePendingRequests(tabId);
  let events = networkEvents.get(tabId) || [];

  if (options?.onlyErrors) {
    events = events.filter((e) => e.error || (e.statusCode && e.statusCode >= 400));
  }
  if (options?.urlFilter) {
    const filter = options.urlFilter.toLowerCase();
    events = events.filter((e) => e.url.toLowerCase().includes(filter));
  }

  const limit = Math.max(1, Math.min(2000, options?.limit || 200));
  if (events.length > limit) {
    events = events.slice(-limit);
  }

  return events;
};

/** 清空网络事件 */
const clearNetworkEvents = (tabId: number): void => {
  networkEvents.set(tabId, []);
  const pending = networkPendingRequests.get(tabId);
  if (pending) pending.clear();
};

/** 网络事件统计汇总 */
const getNetworkSummary = (tabId: number): Record<string, any> => {
  const events = networkEvents.get(tabId) || [];
  const total = events.length;
  let errors = 0;
  const byResourceType: Record<string, number> = {};
  const byStatusClass: Record<string, number> = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, error: 0 };
  const domainCounts: Record<string, number> = {};

  for (const evt of events) {
    // 资源类型
    const rt = evt.resourceType || 'other';
    byResourceType[rt] = (byResourceType[rt] || 0) + 1;

    // 状态码
    if (evt.error) {
      byStatusClass['error']++;
      errors++;
    } else if (evt.statusCode) {
      if (evt.statusCode >= 200 && evt.statusCode < 300) byStatusClass['2xx']++;
      else if (evt.statusCode >= 300 && evt.statusCode < 400) byStatusClass['3xx']++;
      else if (evt.statusCode >= 400 && evt.statusCode < 500) { byStatusClass['4xx']++; errors++; }
      else if (evt.statusCode >= 500) { byStatusClass['5xx']++; errors++; }
    }

    // 域名
    try {
      const domain = new URL(evt.url).hostname;
      domainCounts[domain] = (domainCounts[domain] || 0) + 1;
    } catch { /* 忽略 */ }
  }

  // 前 10 域名
  const topDomains = Object.entries(domainCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([domain, count]) => ({ domain, count }));

  return {
    total,
    errors,
    by_resource_type: byResourceType,
    by_status_class: byStatusClass,
    top_domains: topDomains,
    last_event_at: events.length > 0 ? events[events.length - 1].timestamp : null,
  };
};

// ============ 控制台监听方法 ============

/** 开始捕获控制台消息（Runtime 域已在 attach 时启用） */
const startConsoleListening = async (
  tabId: number,
  maxEntries: number = 200,
): Promise<{ success: boolean; error?: string }> => {
  const attachResult = await attach(tabId);
  if (!attachResult.success) {
    return { success: false, error: attachResult.error };
  }

  const clampedMax = Math.max(20, Math.min(2000, Math.floor(maxEntries)));
  consoleListening.set(tabId, {
    active: true,
    maxEntries: clampedMax,
    startedAt: Date.now(),
  });
  consoleEntries.set(tabId, []);
  exceptionEntries.set(tabId, []);

  return { success: true };
};

/** 停止控制台捕获 */
const stopConsoleListening = (tabId: number): void => {
  consoleListening.delete(tabId);
  if (sessions.has(tabId)) scheduleIdleDetach(tabId);
};

const isConsoleListening = (tabId: number): boolean => {
  return consoleListening.get(tabId)?.active === true;
};

/** 获取控制台消息 */
const getConsoleEntries = (
  tabId: number,
  options?: { level?: string; limit?: number },
): CDPConsoleEntry[] => {
  let entries = consoleEntries.get(tabId) || [];

  if (options?.level) {
    const levelFilter = options.level.toLowerCase();
    entries = entries.filter((e) => {
      // CDP type → 常用 level 映射
      if (levelFilter === 'error') return e.type === 'error';
      if (levelFilter === 'warn' || levelFilter === 'warning') return e.type === 'warning';
      if (levelFilter === 'log') return e.type === 'log';
      if (levelFilter === 'info') return e.type === 'info';
      return e.type === levelFilter;
    });
  }

  const limit = Math.max(1, Math.min(2000, options?.limit || 200));
  if (entries.length > limit) {
    entries = entries.slice(-limit);
  }
  return entries;
};

/** 获取未捕获异常 */
const getExceptionEntries = (tabId: number, limit?: number): CDPExceptionEntry[] => {
  let entries = exceptionEntries.get(tabId) || [];
  const max = Math.max(1, Math.min(500, limit || 100));
  if (entries.length > max) {
    entries = entries.slice(-max);
  }
  return entries;
};

/** 清空控制台捕获 */
const clearConsoleEntries = (tabId: number): void => {
  consoleEntries.set(tabId, []);
  exceptionEntries.set(tabId, []);
};

// ============ Fetch 拦截方法 ============

/** 开始 Fetch 拦截（启用 Fetch 域） */
const startFetchInterception = async (
  tabId: number,
  options?: { urlPatterns?: string[]; resourceTypes?: string[]; maxPaused?: number },
): Promise<{ success: boolean; error?: string }> => {
  const attachResult = await attach(tabId);
  if (!attachResult.success) {
    return { success: false, error: attachResult.error };
  }

  // 构建 Fetch.enable 的 patterns 参数
  const patterns: Array<{ urlPattern?: string; resourceType?: string; requestStage?: string }> = [];
  const urlPatterns = options?.urlPatterns || [];
  const resourceTypes = options?.resourceTypes || [];

  if (urlPatterns.length > 0 || resourceTypes.length > 0) {
    // 有指定过滤条件
    if (urlPatterns.length > 0) {
      for (const urlPattern of urlPatterns) {
        if (resourceTypes.length > 0) {
          for (const rt of resourceTypes) {
            patterns.push({ urlPattern, resourceType: rt, requestStage: 'Request' });
          }
        } else {
          patterns.push({ urlPattern, requestStage: 'Request' });
        }
      }
    } else {
      for (const rt of resourceTypes) {
        patterns.push({ urlPattern: '*', resourceType: rt, requestStage: 'Request' });
      }
    }
  } else {
    // 无过滤条件，拦截所有请求
    patterns.push({ urlPattern: '*', requestStage: 'Request' });
  }

  const enableResult = await sendCommand(tabId, 'Fetch.enable', {
    patterns,
    handleAuthRequests: false,
  });
  if (!enableResult.success) {
    return { success: false, error: `启用 Fetch 域失败: ${enableResult.error}` };
  }

  const entry = sessions.get(tabId);
  if (entry) entry.domainsEnabled.add('Fetch');

  const maxPaused = Math.max(10, Math.min(500, Math.floor(options?.maxPaused || 100)));
  fetchInterception.set(tabId, {
    active: true,
    urlPatterns,
    resourceTypes,
    maxPaused,
    startedAt: Date.now(),
  });
  fetchPausedRequests.set(tabId, new Map());

  return { success: true };
};

/** 停止 Fetch 拦截（禁用 Fetch 域） */
const stopFetchInterception = async (tabId: number): Promise<void> => {
  // 先释放所有暂停的请求（避免页面卡死）
  const paused = fetchPausedRequests.get(tabId);
  if (paused && paused.size > 0) {
    for (const [reqId] of paused) {
      await sendCommand(tabId, 'Fetch.continueRequest', { requestId: reqId }).catch(() => { /* 忽略 */ });
    }
  }
  fetchInterception.delete(tabId);
  fetchPausedRequests.delete(tabId);

  const entry = sessions.get(tabId);
  if (entry?.domainsEnabled.has('Fetch')) {
    await sendCommand(tabId, 'Fetch.disable', {}).catch(() => { /* 忽略 */ });
    entry.domainsEnabled.delete('Fetch');
  }
  if (sessions.has(tabId)) scheduleIdleDetach(tabId);
};

const isFetchIntercepting = (tabId: number): boolean => {
  return fetchInterception.get(tabId)?.active === true;
};

/** 获取被暂停的请求列表 */
const getFetchPausedRequests = (tabId: number): CDPFetchPausedRequest[] => {
  const paused = fetchPausedRequests.get(tabId);
  if (!paused) return [];
  return Array.from(paused.values());
};

/** 清空被暂停的请求（全部放行） */
const clearFetchPausedRequests = async (tabId: number): Promise<void> => {
  const paused = fetchPausedRequests.get(tabId);
  if (paused && paused.size > 0) {
    for (const [reqId] of paused) {
      await sendCommand(tabId, 'Fetch.continueRequest', { requestId: reqId }).catch(() => { /* 忽略 */ });
    }
    paused.clear();
  }
};

// ============ 事件监听 ============

// 只有标签页真正消失时才丢弃它的网络观察结果。
if (isSupported() && chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    networkEvents.delete(tabId);
    networkListening.delete(tabId);
    networkPendingRequests.delete(tabId);
  });
}

// 外部 detach 处理
if (isSupported() && chrome.debugger.onDetach) {
  chrome.debugger.onDetach.addListener((source) => {
    const tabId = source.tabId;
    if (tabId !== undefined) {
      cleanupTabState(tabId);
    }
  });
}

// CDP 域事件处理
if (isSupported() && chrome.debugger.onEvent) {
  chrome.debugger.onEvent.addListener((source, method, params: any) => {
    const tabId = source.tabId;
    if (tabId === undefined || !sessions.has(tabId)) return;

    // ---- 对话框 ----
    if (method === 'Page.javascriptDialogOpening') {
      const dialog: PendingDialog = {
        message: params?.message || '',
        type: params?.type || 'alert',
        defaultPrompt: params?.defaultPrompt || '',
        url: params?.url || '',
        receivedAt: Date.now(),
      };
      pendingDialogs.set(tabId, dialog);

      const policy = dialogPolicies.get(tabId) || 'manual';
      if (policy === 'auto_accept') {
        sendCommand(tabId, 'Page.handleJavaScriptDialog', { accept: true }).then(() => {
          pendingDialogs.delete(tabId);
        }).catch(() => { /* 忽略 */ });
      } else if (policy === 'auto_dismiss') {
        sendCommand(tabId, 'Page.handleJavaScriptDialog', { accept: false }).then(() => {
          pendingDialogs.delete(tabId);
        }).catch(() => { /* 忽略 */ });
      }
    }

    // ---- Runtime context ----
    if (method === 'Runtime.executionContextCreated') {
      const ctx = params?.context;
      const frameId = ctx?.auxData?.frameId;
      if (frameId && ctx?.id && ctx.auxData?.isDefault) {
        let map = frameContexts.get(tabId);
        if (!map) {
          map = new Map();
          frameContexts.set(tabId, map);
        }
        map.set(frameId, ctx.id);
      }
    }

    if (method === 'Runtime.executionContextDestroyed') {
      const destroyedId = params?.executionContextId;
      if (typeof destroyedId === 'number') {
        const map = frameContexts.get(tabId);
        if (map) {
          for (const [fid, cid] of map.entries()) {
            if (cid === destroyedId) { map.delete(fid); break; }
          }
        }
      }
    }

    if (method === 'Runtime.executionContextsCleared') {
      frameContexts.delete(tabId);
    }

    // ---- 网络事件 ----
    if (method === 'Network.requestWillBeSent' && isNetworkListening(tabId)) {
      evictStalePendingRequests(tabId);
      const request = params?.request;
      const url = request?.url || '';
      if (matchesNetworkFilter(tabId, url)) {
        const event: CDPNetworkEvent = {
          requestId: params?.requestId || '',
          method: request?.method || 'GET',
          url,
          resourceType: (params?.type || 'Other').toLowerCase(),
          timestamp: Date.now(),
          startTime: Date.now(),
          requestHeaders: request?.headers,
          postData: request?.postData,
        };
        // 存入待处理映射，等待响应/完成/失败事件
        let pending = networkPendingRequests.get(tabId);
        if (!pending) {
          pending = new Map();
          networkPendingRequests.set(tabId, pending);
        }
        pending.set(event.requestId, event);
      }
    }

    if (method === 'Network.responseReceived' && isNetworkListening(tabId)) {
      const pending = networkPendingRequests.get(tabId);
      const event = pending?.get(params?.requestId);
      if (event) {
        const response = params?.response;
        event.statusCode = response?.status;
        event.statusText = response?.statusText;
        event.mimeType = response?.mimeType;
        event.responseHeaders = response?.headers;
        event.fromCache = response?.fromDiskCache || response?.fromPrefetchCache || false;
      }
    }

    if (method === 'Network.loadingFinished' && isNetworkListening(tabId)) {
      const pending = networkPendingRequests.get(tabId);
      const event = pending?.get(params?.requestId);
      if (event) {
        event.endTime = Date.now();
        event.durationMs = event.endTime - event.startTime;
        pending!.delete(params.requestId);
        pushNetworkEvent(tabId, event);
      }
    }

    if (method === 'Network.loadingFailed' && isNetworkListening(tabId)) {
      const pending = networkPendingRequests.get(tabId);
      const event = pending?.get(params?.requestId);
      if (event) {
        event.endTime = Date.now();
        event.durationMs = event.endTime - event.startTime;
        event.error = params?.errorText || 'loading failed';
        pending!.delete(params.requestId);
        pushNetworkEvent(tabId, event);
      }
    }

    // ---- 控制台消息 ----
    if (method === 'Runtime.consoleAPICalled' && isConsoleListening(tabId)) {
      const state = consoleListening.get(tabId)!;
      const args = params?.args || [];
      // 将参数序列化为文本
      const textParts: string[] = [];
      for (const arg of args) {
        if (arg.type === 'string') textParts.push(arg.value || '');
        else if (arg.type === 'number' || arg.type === 'boolean') textParts.push(String(arg.value));
        else if (arg.type === 'undefined') textParts.push('undefined');
        else if (arg.subtype === 'null') textParts.push('null');
        else if (arg.description) textParts.push(arg.description);
        else if (arg.value !== undefined) textParts.push(JSON.stringify(arg.value));
        else textParts.push(`[${arg.type}]`);
      }

      // 提取调用位置
      const stackTrace = params?.stackTrace;
      const firstFrame = stackTrace?.callFrames?.[0];

      const entry: CDPConsoleEntry = {
        type: params?.type || 'log',
        text: textParts.join(' '),
        timestamp: Date.now(),
        url: firstFrame?.url,
        lineNumber: firstFrame?.lineNumber,
        stackTrace: stackTrace?.callFrames
          ?.slice(0, 5)
          ?.map((f: any) => `  at ${f.functionName || '(anonymous)'} (${f.url}:${f.lineNumber}:${f.columnNumber})`)
          ?.join('\n'),
      };

      let entries = consoleEntries.get(tabId);
      if (!entries) {
        entries = [];
        consoleEntries.set(tabId, entries);
      }
      entries.push(entry);
      while (entries.length > state.maxEntries) {
        entries.shift();
      }
    }

    // ---- Fetch 拦截 ----
    if (method === 'Fetch.requestPaused' && isFetchIntercepting(tabId)) {
      const request = params?.request || {};
      const headers: Record<string, string> = {};
      if (Array.isArray(request.headers)) {
        for (const h of request.headers) {
          if (h?.name) headers[h.name] = h.value || '';
        }
      } else if (request.headers && typeof request.headers === 'object') {
        Object.assign(headers, request.headers);
      }

      const pausedReq: CDPFetchPausedRequest = {
        requestId: params?.requestId || '',
        request: {
          url: request.url || '',
          method: request.method || 'GET',
          headers,
          postData: request.postData,
        },
        resourceType: params?.resourceType || 'Other',
        frameId: params?.frameId || '',
        responseStatusCode: params?.responseStatusCode,
        responseHeaders: params?.responseHeaders,
        networkId: params?.networkId,
        pausedAt: Date.now(),
      };

      let paused = fetchPausedRequests.get(tabId);
      if (!paused) {
        paused = new Map();
        fetchPausedRequests.set(tabId, paused);
      }

      const state = fetchInterception.get(tabId);
      // 超过上限时自动放行最旧的请求
      if (state && paused.size >= state.maxPaused) {
        const oldest = paused.keys().next().value;
        if (oldest) {
          sendCommand(tabId, 'Fetch.continueRequest', { requestId: oldest }).catch(() => { /* 忽略 */ });
          paused.delete(oldest);
        }
      }
      paused.set(pausedReq.requestId, pausedReq);
    }

    // ---- 未捕获异常 ----
    if (method === 'Runtime.exceptionThrown' && isConsoleListening(tabId)) {
      const state = consoleListening.get(tabId)!;
      const exDetail = params?.exceptionDetails;
      if (exDetail) {
        const stackFrames = exDetail.stackTrace?.callFrames;
        const exEntry: CDPExceptionEntry = {
          text: exDetail.text || exDetail.exception?.description || 'Unknown exception',
          timestamp: Date.now(),
          url: exDetail.url,
          lineNumber: exDetail.lineNumber,
          columnNumber: exDetail.columnNumber,
          stackTrace: stackFrames
            ?.slice(0, 10)
            ?.map((f: any) => `  at ${f.functionName || '(anonymous)'} (${f.url}:${f.lineNumber}:${f.columnNumber})`)
            ?.join('\n'),
        };

        let entries = exceptionEntries.get(tabId);
        if (!entries) {
          entries = [];
          exceptionEntries.set(tabId, entries);
        }
        entries.push(exEntry);
        while (entries.length > state.maxEntries) {
          entries.shift();
        }
      }
    }
  });
}

// ============ 导出 ============

export const CDPSessionManager = {
  L2_IDLE_MS,
  NETWORK_PENDING_TIMEOUT_MS,
  isSupported,
  attach,
  detach,
  isAttached,
  sendCommand,
  detachTab,
  listAttached,
  // 对话框
  getPendingDialog,
  handleDialog,
  setDialogPolicy,
  getDialogPolicy,
  // Frame
  getFrameContextId,
  clearFrameContexts,
  // 网络
  startNetworkListening,
  ensureNetworkListening,
  stopNetworkListening,
  isNetworkListening,
  getNetworkEvents,
  clearNetworkEvents,
  getNetworkSummary,
  // 控制台
  startConsoleListening,
  stopConsoleListening,
  isConsoleListening,
  getConsoleEntries,
  getExceptionEntries,
  clearConsoleEntries,
  // Fetch 拦截
  startFetchInterception,
  stopFetchInterception,
  isFetchIntercepting,
  getFetchPausedRequests,
  clearFetchPausedRequests,
};
