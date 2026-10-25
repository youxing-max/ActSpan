/**
 * Chrome Extension 信道工具，支持background/content/popup/options四方通信和tab广播
 * 用法：
 *   Channel.on(type, handler) // 注册消息处理
 *   Channel.off(type, handler) // 取消注册
 *   Channel.send(type, data, callback?) // 发送消息
 *   Channel.sendToTab(tabId, type, data, callback?) // 发送消息到指定tab
 *   Channel.listen(tabId?) // content侧传tabId注册，background侧不传
 *   Channel.broadcast(type, data) // background侧广播到所有注册tab + extension page
 *   Channel.connectAsExtensionPage() // extension page（options/popup）侧连接，接收broadcast
 *   Channel.getRegisteredTabs() // 获取所有已注册的tabId
 */

export type ChannelHandler = (data: any, sender?: chrome.runtime.MessageSender, sendResponse?: (response: any) => void) => void | boolean | Promise<void | boolean>;

/** Port 连接名称标识，用于区分 extension page 的 port */
const EXTENSION_PAGE_PORT_NAME = '__channel_extension_page';

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
    // MV3 background 被回收时 port 会断开；页面必须自行重连才能继续收到广播
    private static _extensionReconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private static _extensionReconnectAttempts = 0;
    private static _extensionExplicitlyDisconnected = false;
    private static _extensionWasDisconnected = false;

    /** 触发本地订阅者（不经过 background） */
    private static dispatchLocal(type: string, data?: unknown) {
        const handlers = this.handlers.get(type);
        if (!handlers) return;
        for (const handler of handlers) {
            try {
                handler(data);
            } catch (error) {
                console.error(`[Channel] 处理本地消息 ${type} 时出错:`, error);
            }
        }
    }

    /** extension page 断线后按 1s、2s、4s… 退避重连，最长 30s */
    private static scheduleExtensionReconnect() {
        if (this._extensionExplicitlyDisconnected || this._extensionReconnectTimer) return;
        const delay = Math.min(1000 * 2 ** this._extensionReconnectAttempts, 30000);
        this._extensionReconnectAttempts += 1;
        this._extensionReconnectTimer = setTimeout(() => {
            this._extensionReconnectTimer = null;
            this.connectAsExtensionPage();
        }, delay);
    }

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
            if (__channel_tab_register) {
                if (sender?.tab && sender.tab.id !== undefined) {
                    Channel.tabSet.add(sender.tab.id);
                    console.log(`[Channel] Tab ${sender.tab.id} 已注册`);
                    sendResponse?.({ success: true });
                    return;
                }
                // background 重启后内存中的 tabSet 会丢失。background 向所有标签页
                // 发送探测消息，content script 收到后回传自己的注册信息。
                try {
                    chrome.runtime.sendMessage({ __channel_tab_register: true });
                } catch { /* 扩展正在卸载时忽略 */ }
                // 通知页面重新拉取会话状态，补上后台休眠期间错过的完成事件
                Channel.dispatchLocal('__channel_tab_reconnected');
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
        // background 侧：Service Worker 重启后 tabSet 为空，主动让存活的 content script 重新注册
        if (typeof tabId === 'undefined' && chrome.tabs?.query) {
            void Promise.resolve(chrome.tabs.query({})).then((tabs) => {
                for (const tab of tabs) {
                    if (typeof tab.id !== 'number') continue;
                    // 先乐观登记；没有 content script 的标签页会在回调里因 lastError 被移除
                    Channel.tabSet.add(tab.id);
                    try {
                        chrome.tabs.sendMessage(tab.id, { __channel_tab_register: true }, () => {
                            if (chrome.runtime.lastError) Channel.tabSet.delete(tab.id!);
                        });
                    } catch {
                        Channel.tabSet.delete(tab.id);
                    }
                }
            }).catch(() => { /* 查询标签页失败不影响消息监听 */ });
        }
        // background 侧：监听 extension page 的 port 连接
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

    /**
     * extension page 侧：通过 port 连接到 background，接收 broadcast 消息
     * 连接后 broadcast 的消息会通过 port.onMessage 分发到本地 handlers
     * 调用方需在页面卸载时调用 disconnectExtensionPage() 清理
     */
    static connectAsExtensionPage(): void {
        if (Channel._extensionPort) return;
        Channel._extensionExplicitlyDisconnected = false;
        try {
            const port = chrome.runtime.connect({ name: EXTENSION_PAGE_PORT_NAME });
            Channel._extensionPort = port;
            Channel._extensionReconnectAttempts = 0;
            // 监听来自 background 的 broadcast 消息，分发到本地 handlers
            port.onMessage.addListener((message) => {
                const { type, data } = message || {};
                if (type && Channel.handlers.has(type)) {
                    for (const handler of Channel.handlers.get(type)!) {
                        try {
                            handler(data);
                        } catch (error) {
                            console.error(`[Channel] Extension page 处理消息 ${type} 时出错:`, error);
                        }
                    }
                }
            });
            port.onDisconnect.addListener(() => {
                if (Channel._extensionPort === port) Channel._extensionPort = null;
                console.log('[Channel] Extension page port 已断开');
                if (Channel._extensionExplicitlyDisconnected) return;
                Channel._extensionWasDisconnected = true;
                Channel.scheduleExtensionReconnect();
            });
            console.log('[Channel] Extension page 已连接到 background');
            if (Channel._extensionWasDisconnected) {
                Channel._extensionWasDisconnected = false;
                Channel.dispatchLocal('__channel_extension_reconnected');
            }
        } catch (error) {
            console.error('[Channel] Extension page 连接失败:', error);
            Channel._extensionWasDisconnected = true;
            Channel.scheduleExtensionReconnect();
        }
    }

    /** extension page 侧：断开与 background 的 port 连接 */
    static disconnectExtensionPage(): void {
        Channel._extensionExplicitlyDisconnected = true;
        Channel._extensionReconnectAttempts = 0;
        if (Channel._extensionReconnectTimer) {
            clearTimeout(Channel._extensionReconnectTimer);
            Channel._extensionReconnectTimer = null;
        }
        if (Channel._extensionPort) {
            try {
                Channel._extensionPort.disconnect();
            } catch { /* 忽略 */ }
            Channel._extensionPort = null;
        }
    }
}

export default Channel; 