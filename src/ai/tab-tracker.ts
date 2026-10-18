/**
 * 标签页生命周期追踪器
 * 记录 AI 在任务执行过程中通过工具显式打开的标签页，任务结束时自动批量关闭。
 *
 * 核心策略：显式注册
 * - 只关闭通过 trackOpened() 注册且未标记 keep_alive 的标签页
 * - 用户手动打开的标签页不受影响
 */

import _console from '../lib/console';

export class TabTracker {
  /** AI 工具打开的标签页 ID（任务结束时清理） */
  private aiOpenedIds = new Set<number>();

  /** keep_alive 标记的标签页 ID（不清理） */
  private keepAliveIds = new Set<number>();

  /** 任务开始时初始化（当前策略无需快照） */
  async startListening(): Promise<void> {
    this.aiOpenedIds.clear();
    this.keepAliveIds.clear();
    _console.log('[TabTracker] 开始追踪 AI 打开的标签页');
  }

  /** 兼容接口：停止监听 */
  stopListening(): void {
    // no-op
  }

  /** 记录 AI 工具显式打开的标签页 */
  trackOpened(tabId: number, keepAlive: boolean): void {
    if (keepAlive) {
      this.keepAliveIds.add(tabId);
      _console.log(`[TabTracker] trackOpened ${tabId} keep_alive=true`);
    } else {
      this.aiOpenedIds.add(tabId);
      _console.log(`[TabTracker] trackOpened ${tabId}`);
    }
  }

  /** 记录已关闭的标签页（从追踪集合中移除） */
  trackClosed(tabId: number): void {
    this.aiOpenedIds.delete(tabId);
    this.keepAliveIds.delete(tabId);
  }

  /** 任务结束时批量关闭 AI 打开的标签页（不含 keep_alive） */
  async closeAll(): Promise<number> {
    const toClose = [...this.aiOpenedIds];
    _console.log(`[TabTracker] closeAll: AI 打开 ${this.aiOpenedIds.size} 个, keepAlive ${this.keepAliveIds.size} 个, 待清理 ${toClose.length} 个: [${toClose.join(', ')}]`);

    if (toClose.length === 0) {
      this.aiOpenedIds.clear();
      this.keepAliveIds.clear();
      return 0;
    }

    let closed = 0;
    for (const id of toClose) {
      try {
        await chrome.tabs.remove(id);
        closed++;
      } catch (err: any) {
        _console.log(`[TabTracker] 关闭标签页 ${id} 失败: ${err?.message}`);
      }
    }

    _console.log(`[TabTracker] 任务结束，自动关闭 ${closed}/${toClose.length} 个标签页`);
    this.aiOpenedIds.clear();
    this.keepAliveIds.clear();
    return closed;
  }
}
