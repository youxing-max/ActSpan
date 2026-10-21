/**
 * 基础 Channel 消息处理器
 * 从 background.ts 提取，处理非会话相关的 Channel 消息
 */
import Channel from '../lib/channel';
import _console from '../lib/console';
import { VERSION } from '../config';
import dayjs from 'dayjs';
import { CDPSessionManager } from '../lib/cdp-session';
import { isBlockedFetchUrl } from '../lib/ssrf-guard';
import { tabLeaseManager } from './tab-lease-manager';

// ============ 工具函数 ============

/**
 * 显示 Chrome 桌面通知
 */
export function showNotification(title: string, message: string, notificationId: string = `actspan-ext-${Date.now()}`) {
    chrome.notifications.create(notificationId, {
        type: 'basic',
        iconUrl: './actspan-icon-128.png',
        title: title,
        message: message,
    }).then(() => {
        _console.log(`[background] 通知已显示: ${title}`);
    }).catch((error: unknown) => {
        _console.error('[background] 显示通知失败:', error);
    });
}

// ============ 内置消息处理 ============

/**
 * 获取 tab 信息
 * content script 请求自身的 tab 信息
 */
Channel.on('__get_tab_info', (_data, sender, sendResponse) => {
    if (sender?.tab && sendResponse) {
        sendResponse({
            id: sender.tab.id,
            url: sender.tab.url,
            title: sender.tab.title,
        });
    }
    return true;
});

/**
 * 显示桌面通知
 */
Channel.on('__show_notification', (data, _sender, sendResponse) => {
    const { title, message } = data || {};
    if (title && message) {
        showNotification(title, message);
    }
    if (sendResponse) sendResponse({ success: true });
    return true;
});

/**
 * 获取网页标题（link preview 用）
 * content script 请求 → background fetch → 提取 <title> → 返回
 */
const pageTitleCache = new Map<string, string>();
/** link preview 缓存上限，防止大量唯一链接无限增长 */
const MAX_PAGE_TITLE_CACHE = 200;

const rememberPageTitle = (url: string, title: string) => {
    if (pageTitleCache.size >= MAX_PAGE_TITLE_CACHE) {
        const oldest = pageTitleCache.keys().next().value;
        if (oldest !== undefined) pageTitleCache.delete(oldest);
    }
    pageTitleCache.set(url, title);
};

/** 手动跟随重定向并逐跳校验，防止公网 URL 302 到内网 */
const fetchPublicHtml = async (url: string, depth = 0): Promise<Response> => {
    const resp = await fetch(url, {
        headers: { 'Accept': 'text/html' },
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
    });
    if (resp.type === 'opaqueredirect' || resp.status === 0) {
        // 浏览器不会把 manual 重定向的 Location 交给扩展：无法逐跳校验就 fail-closed。
        throw new Error('重定向无法安全校验');
    }
    if (resp.status < 300 || resp.status >= 400) return resp;
    const location = resp.headers.get('location');
    if (!location || depth >= 3) throw new Error('重定向过多');
    const next = new URL(location, url).toString();
    if (isBlockedFetchUrl(next)) throw new Error('重定向目标被拒绝');
    return fetchPublicHtml(next, depth + 1);
};

Channel.on('__fetch_page_title', async (data, _sender, sendResponse) => {
    const url = data?.url;
    if (!url || typeof url !== 'string' || !sendResponse) return true;

    // content script 传来的链接可能来自模型输出：只允许公网 http(s)，避免成为内网探测器
    if (isBlockedFetchUrl(url)) {
        sendResponse({});
        return true;
    }

    // 缓存命中
    const cached = pageTitleCache.get(url);
    if (cached !== undefined) {
        sendResponse({ title: cached });
        return true;
    }

    try {
        const resp = await fetchPublicHtml(url);
        // 只读前 16KB 提取 title，避免下载整页
        const reader = resp.body?.getReader();
        if (!reader) { sendResponse({}); return true; }

        let text = '';
        const decoder = new TextDecoder();
        while (text.length < 16384) {
            const { done, value } = await reader.read();
            if (done) break;
            text += decoder.decode(value, { stream: true });
            const match = text.match(/<title[^>]*>([^<]+)<\/title>/i);
            if (match) {
                reader.cancel().catch(() => {});
                const title = match[1].trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
                rememberPageTitle(url, title);
                sendResponse({ title });
                return true;
            }
        }
        reader.cancel().catch(() => {});
        rememberPageTitle(url, '');
        sendResponse({});
    } catch {
        sendResponse({});
    }
    return true;
});

/**
 * 打开扩展设置页（options.html）
 */
Channel.on('__open_options_page', (_data, _sender, sendResponse) => {
    chrome.runtime.openOptionsPage(() => {
        const lastError = chrome.runtime.lastError;
        if (sendResponse) {
            sendResponse({
                success: !lastError,
                error: lastError?.message,
            });
        }
    });
    return true;
});

/**
 * 日志上报（content script → background 汇总日志）
 */
Channel.on('__log_report', (data, sender) => {
    if (!data) return;

    const timeStamp = data.timeStamp;
    const type = data.type || 'LOG';
    const text = data.text || '';
    const tabId = sender?.tab?.id || 'unknown';

    const tempText = `[${dayjs(timeStamp).format('HH:mm:ss.SSS')}][Tab:${tabId}] ${text}`;
    const textTitle = `%c Actspan %c V${VERSION} `;
    const titleStyle = 'padding: 2px 1px; border-radius: 3px 0 0 3px; color: #fff; background: #606060; font-weight: bold;';
    const versionStyle = 'padding: 2px 1px; border-radius: 0 3px 3px 0; color: #fff; background: #42c02e; font-weight: bold;';

    const logData = data.error || data.logObj;

    switch (type) {
        case 'LOG':
            console.log(textTitle, titleStyle, versionStyle, tempText, logData);
            break;
        case 'WARN':
            console.warn(textTitle, titleStyle, versionStyle, tempText, logData);
            break;
        case 'ERROR':
            console.error(textTitle, titleStyle, versionStyle, tempText, logData);
            break;
    }
});

// ============ Tab 管理 ============

// tab 关闭时清理注册
chrome.tabs.onRemoved.addListener((tabId) => {
    Channel.unregisterTab(tabId);
    // 标签页关闭后租约不会自己消失，必须主动释放，否则同标签 ID 被复用时会被误判占用
    tabLeaseManager.releaseTab(tabId);
    // CDP debugger 会话清理
    CDPSessionManager.detachTab(tabId).catch(() => {});
});

/**
 * 打开 Side Panel
 * content script 或 popup 请求打开侧边栏
 */
Channel.on('__open_side_panel', async (data, sender, sendResponse) => {
    const tabId = sender?.tab?.id ?? data?.tabId;
    if (typeof tabId !== 'number') {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab?.id) {
                await (chrome.sidePanel as any).open({ tabId: tab.id });
            }
            if (sendResponse) sendResponse({ success: true });
        } catch (err) {
            _console.error('[Actspan] 打开 Side Panel 失败:', err);
            if (sendResponse) sendResponse({ success: false, error: String(err) });
        }
        return true;
    }
    try {
        await (chrome.sidePanel as any).open({ tabId });
        if (sendResponse) sendResponse({ success: true });
    } catch (err) {
        _console.error('[Actspan] 打开 Side Panel 失败:', err);
        if (sendResponse) sendResponse({ success: false, error: String(err) });
    }
    return true;
});

/**
 * 定位到任务发起页签
 * 非发起页签请求跳转到任务所在页签
 */
Channel.on('__session_focus_tab', async (data) => {
    const tabId = data?.tabId;
    if (typeof tabId !== 'number') return;
    try {
        const tab = await chrome.tabs.get(tabId);
        await chrome.tabs.update(tabId, { active: true });
        if (typeof tab.windowId === 'number') {
            await chrome.windows.update(tab.windowId, { focused: true });
        }
    } catch (err) {
        console.warn('[Actspan] 定位到任务页签失败:', err);
    }
});
