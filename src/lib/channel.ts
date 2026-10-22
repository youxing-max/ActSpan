/**
 * Chrome Extension 信道工具，支持background/content/popup/options四方通信和tab广播
 * 用法：
 *   Channel.on(type, handler) // 注册消息处理
 *   Channel.off(type, handler) // 取消注册
 *   Channel.send(type, data, callback?) // 发送消息
 *   Channel.sendToTab(tabId, type, data, callback?) // 发送消息到指定tab
 *   Channel.listen(tabId?) // content侧传tabId注册，background侧不传
 *   Channel.broadcast(type, data) // background侧广播到所有注册tab + extension page
 *   Channel.connectAsExtensionPage() // extension page（options/popup）侧连接，接收broadcast；port 断开后自动重连
 *   Channel.getRegisteredTabs() // 获取所有已注册的tabId
 */

export type ChannelHandler = (data: any, sender?: chrome.runtime.MessageSender, sendResponse?: (response: any) => void) => void | boolean | Promise<void | boolean>;

/** Port 连接名称标识，用于区分 extension page 的 port */
const EXTENSION_PAGE_PORT_NAME = '__channel_extension_page';

/** extension page 本地事件：port 断线后重连成功，订阅方应重新拉取会话补齐丢失事件 */
export const EXTENSION_PAGE_RECONNECTED = '__channel_extension_reconnected';

/** 重连延迟：给正在关闭的 background 一点时间，避免断开瞬间的忙循环 */
const EXTENSION_PAGE_RECONNECT_DELAY_MS = 1000;

/** 调试/动态工具/会话控制等内部接口，只允许扩展自身来源调用。 */
const SENSITIVE_CHANNEL_TYPES = new Set<string>([
    '__debug_run_plan', '__debug_call_tool', '__debug_tools_catalog',
    '__dynamic_tools_import_manifest', '__dynamic_tools_list', '__dynamic_tools_remove', '__dynamic_tools_upsert',
    '__clipboard_ops', '__session_clear', '__session_create', '__session_continue', '__session_resume',
    '__session_replay', '__session_replay_request', '__session_rollback',
    '__recorder_start', '__recorder_stop', '__recorder_submit', '__recorder_transfer',
    '__fetch_page_title', '__parse_page_content',
    '__page_grounding_action', '__page_grounding_assert', '__page_grounding_snapshot',
]);

class Channel {
    private static handlers: Map<string, Set<ChannelHandler>> = new Map();
    // 仅background用：已注册tabId集合
    private static tabSet: Set<number> = new Set();
    // 仅background用：extension page（options/popup）的 port 连接集合
    private static extensionPorts: Set<chrome.runtime.Port> = new Set();
    // 仅 extension page 用：与 background 的 port 连接
    private static _extensionPort: chrome.runtime.Port | null = null;
    // 仅 extension page 用：调用方已显式断开，不再自动重连
    private static _extensionPageClosed = false;
    private static _extensionConnectAttempts = 0;
    /** 注册消息处理 */
    static on(type: string, handler: ChannelHandler) {
        if (!this.handlers.has(type)) {
            this.handlers.set(type, new Set());
        }
        this.handlers.get(type)!.add(handler);
    }

    /** 取消注册 */
    static off(type: string, handler: ChannelHandler) {
        if (this.handlers.has(type)) {
            this.handlers.get(type)!.delete(handler);
        }
    }

    /** 发送消息（支持回调） */
    static send(type: string, data?: any, callback?: (response: any) => void) {
        const msg = { type, data };
        try {
            if (callback) {
                chrome.runtime.sendMessage(msg, callback);
            } else {
                chrome.runtime.sendMessage(msg);
            }
        } catch (error) {
            console.error('[Channel] 发送消息失败:', error);
        }
    }

    /** 发送消息到指定tab；frameId 省略时按 Chrome 默认行为投递，指定时只投递到该 frame */
    static sendToTab(tabId: number, type: string, data?: unknown, callback?: (response: unknown) => void, frameId?: number) {
        if (!chrome.tabs) {
            console.error('[Channel] chrome.tabs API 不可用');
            return;
        }
        const msg = { type, data };
        const options = typeof frameId === 'number' ? { frameId } : undefined;
        try {
            if (callback) {
                if (options) chrome.tabs.sendMessage(tabId, msg, options, callback);
                else chrome.tabs.sendMessage(tabId, msg, callback);
            } else if (options) {
                chrome.tabs.sendMessage(tabId, msg, options);
            } else {
                chrome.tabs.sendMessage(tabId, msg);
            }
        } catch (error) {
            console.error(`[Channel] 发送消息到 tab ${tabId} 失败:`, error);
        }
    }

    /** Service Worker 重启后 content script 仍在，主动让现有页面重新登记 tab。 */
    private static async rehydrateTabs(): Promise<void> {
        if (!chrome.tabs?.query || !chrome.tabs?.sendMessage) return;
        let tabs: chrome.tabs.Tab[];
        try {
            tabs = await chrome.tabs.query({});
        } catch {
            return;
        }
        for (const tab of tabs) {
            if (typeof tab.id !== 'number') continue;
            const tabId = tab.id;
            try {
                chrome.tabs.sendMessage(tabId, { __channel_tab_register: true }, () => {
                    // background 发出的消息没有 sender.tab，content 侧不会回登记；
                    // 没有 lastError 说明 content script 在，直接在这里登记。
                    if (!chrome.runtime.lastError) Channel.tabSet.add(tabId);
                });
            } catch {
                // 页面可能在查询后立即关闭。
            }
        }
    }

    /** content侧注册tabId，background侧不传 */
    static listen(tabId?: number) {
        if ((this as any)._listening) return;
        (this as any)._listening = true;
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            const { type, data, __channel_tab_register, __channel_tab_unregister } = message || {};

            // 只接受本扩展产生的消息；即使将来新增 external 中继，也不能直接触达内部处理器。
            const runtimeId = chrome.runtime?.id;
            if (sender?.id !== undefined && runtimeId && sender.id !== runtimeId) return;

            // 调试/动态工具/会话控制等内部接口只允许扩展页面或本扩展的 content script 调用。
            if (SENSITIVE_CHANNEL_TYPES.has(type)) {
                const extensionUrl = typeof chrome.runtime?.getURL === 'function' ? chrome.runtime.getURL('') : '';
                const fromExtensionPage = !!extensionUrl && typeof sender?.url === 'string' && sender.url.startsWith(extensionUrl);
                if (!sender?.tab && !fromExtensionPage) return;
            }

            // content注册tabId
            if (__channel_tab_register && sender.tab && sender.tab.id !== undefined) {
                Channel.tabSet.add(sender.tab.id);
                console.log(`[Channel] Tab ${sender.tab.id} 已注册`);
                sendResponse({ success: true });
                return;
            }

            // content注销tabId
            if (__channel_tab_unregister && sender.tab && sender.tab.id !== undefined) {
                Channel.tabSet.delete(sender.tab.id);
                console.log(`[Channel] Tab ${sender.tab.id} 已注销`);
                sendResponse({ success: true });
                return;
            }

            if (type && this.handlers.has(type)) {
                let asyncHandled = false;
                for (const handler of this.handlers.get(type)!) {
                    try {
                        const result = handler(data, sender, sendResponse);
                        // 支持 async 处理器：检查返回值是否为 true 或 Promise
                        if (result === true) {
                            asyncHandled = true;
                        } else if (result && typeof result === 'object' && typeof (result as any).then === 'function') {
                            // async 函数返回 Promise，也认为是异步处理
                            asyncHandled = true;
                        }
                    } catch (error) {
                        console.error(`[Channel] 处理消息 ${type} 时出错:`, error);
                    }
                }
                return asyncHandled;
            }
        });
        // content侧注册tabId到background
        if (typeof tabId === 'number') {
            chrome.runtime.sendMessage({ __channel_tab_register: true });
        }
        // background 侧：Service Worker 重启后恢复现有 tab 的登记，再监听 extension page 连接。
        if (typeof tabId === 'undefined') {
            void this.rehydrateTabs();
        }
        if (typeof tabId === 'undefined' && chrome.runtime.onConnect) {
            chrome.runtime.onConnect.addListener((port) => {
                if (port.name !== EXTENSION_PAGE_PORT_NAME) return;
                Channel.extensionPorts.add(port);
                console.log(`[Channel] Extension page 已连接 (共 ${Channel.extensionPorts.size} 个)`);
                port.onDisconnect.addListener(() => {
                    Channel.extensionPorts.delete(port);
                    console.log(`[Channel] Extension page 已断开 (剩余 ${Channel.extensionPorts.size} 个)`);
                });
            });
        }
    }

    /** background侧：广播消息到所有注册tab + extension page */
    static broadcast(type: string, data?: any) {
        const msg = { type, data };
        // 1. 广播到所有注册的 content script tab
        if (chrome.tabs) {
            for (const tabId of Channel.tabSet) {
                try {
                    chrome.tabs.sendMessage(tabId, msg);
                } catch (error) {
                    console.error(`[Channel] 广播消息到 tab ${tabId} 失败:`, error);
                    // 如果tab不存在了，从集合中移除
                    Channel.tabSet.delete(tabId);
                }
            }
        }
        // 2. 广播到所有连接的 extension page（options/popup）
        for (const port of Channel.extensionPorts) {
            try {
                port.postMessage(msg);
            } catch (error) {
                console.error('[Channel] 广播消息到 extension page 失败:', error);
                Channel.extensionPorts.delete(port);
            }
        }
    }

    /** 获取所有已注册的tabId */
    static getRegisteredTabs(): number[] {
        return Array.from(Channel.tabSet);
    }

    /** 注销tab（通常在tab关闭时调用） */
    static unregisterTab(tabId: number): void {
        Channel.tabSet.delete(tabId);
        console.log(`[Channel] Tab ${tabId} 已从注册列表移除`);
    }

    /** 清空所有已注册的tab */
    static clearAllTabs(): void {
        Channel.tabSet.clear();
        console.log('[Channel] 所有tab已清空');
    }

    /** 分发本地注册的 handler：extension page 的 port 消息与本地事件共用 */
    private static dispatchLocal(type: string, data?: unknown) {
        const handlers = Channel.handlers.get(type);
        if (!handlers) return;
        for (const handler of handlers) {
            try {
                handler(data);
            } catch (error) {
                console.error(`[Channel] Extension page 处理消息 ${type} 时出错:`, error);
            }
        }
    }

    /**
     * extension page 侧：通过 port 连接到 background，接收 broadcast 消息
     * 连接后 broadcast 的消息会通过 port.onMessage 分发到本地 handlers
     * background 空闲会被 MV3 回收并断开 port，这里自动重连并派发 EXTENSION_PAGE_RECONNECTED
     * 调用方需在页面卸载时调用 disconnectExtensionPage() 清理
     */
    static connectAsExtensionPage(): void {
        if (Channel._extensionPort) return; // 已连接
        Channel._extensionPageClosed = false;
        try {
            const port = chrome.runtime.connect({ name: EXTENSION_PAGE_PORT_NAME });
            Channel._extensionPort = port;
            Channel._extensionConnectAttempts = 0;
            // 监听来自 background 的 broadcast 消息，分发到本地 handlers
            port.onMessage.addListener((message) => {
                const { type, data } = message || {};
                if (type) Channel.dispatchLocal(type, data);
            });
            port.onDisconnect.addListener(() => {
                // 读取 lastError 消除未处理告警
                void chrome.runtime.lastError;
                if (Channel._extensionPort !== port) return;
                Channel._extensionPort = null;
                if (Channel._extensionPageClosed) return;
                // 断线期间广播的事件永久丢失，重连后由订阅方重新拉取会话补齐
                setTimeout(() => {
                    if (Channel._extensionPageClosed || Channel._extensionPort) return;
                    Channel.connectAsExtensionPage();
                    if (Channel._extensionPort) Channel.dispatchLocal(EXTENSION_PAGE_RECONNECTED);
                }, EXTENSION_PAGE_RECONNECT_DELAY_MS);
            });
            console.log('[Channel] Extension page 已连接到 background');
        } catch (error) {
            Channel._extensionPort = null;
            console.error('[Channel] Extension page 连接失败:', error);
            if (Channel._extensionPageClosed) return;
            Channel._extensionConnectAttempts += 1;
            if (Channel._extensionConnectAttempts > 5) return;
            setTimeout(() => {
                if (!Channel._extensionPageClosed && !Channel._extensionPort) Channel.connectAsExtensionPage();
            }, EXTENSION_PAGE_RECONNECT_DELAY_MS);
        }
    }

    /** extension page 侧：断开与 background 的 port 连接 */
    static disconnectExtensionPage(): void {
        Channel._extensionPageClosed = true;
        if (Channel._extensionPort) {
            try {
                Channel._extensionPort.disconnect();
            } catch { /* 忽略 */ }
            Channel._extensionPort = null;
        }
    }
}

export default Channel; 