/**
 * TodoManager — 任务规划与进度追踪
 *
 * 纯状态管理器，不依赖 Chrome API。
 * 生命周期：单次 handleChat 任务。
 *
 * 三个核心约束：
 *   1. 计划外化 — 通过 todo 工具将计划变为可追踪的状态对象
 *   2. 单焦点约束 — 同一时间只允许一个任务 in_progress
 *   3. 20 条上限 — 防止过度规划，保持正确抽象层级
 */

// ============ 类型定义 ============

/** 单个 todo 项的状态 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

/** 单个 todo 项 */
export interface TodoItem {
  /** 唯一 ID，自增整数（对模型友好，省 token） */
  id: number;
  /** 任务标题（简短，祈使句） */
  title: string;
  /** 当前状态 */
  status: TodoStatus;
  /** 完成后的简要结果备注（仅 completed 时可选） */
  result?: string;
}

/** TodoManager 的可序列化快照 */
export interface TodoSnapshot {
  items: TodoItem[];
  nextId: number;
}

// ============ TodoManager ============

export class TodoManager {
  /** 最大条目数 */
  static readonly MAX_ITEMS = 20;

  private items: TodoItem[] = [];
  private nextId: number = 1;

  /** 是否已初始化（有任何 todo 项） */
  get active(): boolean {
    return this.items.length > 0;
  }

  /** 当前 in_progress 的项（最多一个） */
  get current(): TodoItem | null {
    return this.items.find(i => i.status === 'in_progress') || null;
  }

  /** 获取所有项的只读副本 */
  get all(): readonly TodoItem[] {
    return this.items;
  }

  /** 统计信息 */
  get stats(): { total: number; pending: number; inProgress: number; completed: number } {
    let pending = 0, inProgress = 0, completed = 0;
    for (const item of this.items) {
      if (item.status === 'pending') pending++;
      else if (item.status === 'in_progress') inProgress++;
      else completed++;
    }
    return { total: this.items.length, pending, inProgress, completed };
  }

  /**
   * 创建新的 todo 项（状态为 pending）
   * 达上限时返回 null
   */
  add(title: string): TodoItem | null {
    if (this.items.length >= TodoManager.MAX_ITEMS) return null;
    const item: TodoItem = { id: this.nextId++, title: title.trim(), status: 'pending' };
    this.items.push(item);
    return item;
  }

  /**
   * 批量创建（用于一次性制定计划）
   * 返回成功创建的项列表，达上限时提前终止
   */
  addBatch(titles: string[]): TodoItem[] {
    const created: TodoItem[] = [];
    for (const title of titles) {
      const item = this.add(title);
      if (!item) break;
      created.push(item);
    }
    return created;
  }

  /**
   * 更新项的状态
   *
   * 合法转换：
   *   pending → in_progress（前提：当前没有其他 in_progress 项）
   *   pending → completed（允许跳过）
   *   in_progress → completed
   *
   * 不允许：回退到 pending、修改已 completed 的项
   *
   * 返回更新后的项，违反规则时返回 null
   */
  update(id: number, status: TodoStatus, result?: string): TodoItem | null {
    const item = this.items.find(i => i.id === id);
    if (!item) return null;

    // 不允许回退到 pending
    if (status === 'pending') return null;
    // 已完成不能修改
    if (item.status === 'completed') return null;

    if (status === 'in_progress') {
      // 只有 pending 可以转为 in_progress
      if (item.status !== 'pending') return null;
      // 单焦点约束：同一时间只能有一个 in_progress
      const existing = this.current;
      if (existing && existing.id !== id) return null;
    }

    item.status = status;
    if (status === 'completed' && result) {
      item.result = result.trim().slice(0, 200);
    }
    return item;
  }

  /**
   * 删除项（仅 pending 状态允许删除）
   */
  remove(id: number): boolean {
    const idx = this.items.findIndex(i => i.id === id);
    if (idx < 0) return false;
    if (this.items[idx].status !== 'pending') return false;
    this.items.splice(idx, 1);
    return true;
  }

  /**
   * 生成可读的 todo 状态文本（用于注入上下文）
   * 格式紧凑，对 token 友好
   */
  toStatusText(): string {
    if (this.items.length === 0) return '';
    const { total, completed, inProgress, pending } = this.stats;
    const lines: string[] = [];
    lines.push(`[任务进度 ${completed}/${total} 完成]`);
    for (const item of this.items) {
      const icon = item.status === 'completed' ? '[x]'
                 : item.status === 'in_progress' ? '[>]'
                 : '[ ]';
      const suffix = item.result ? ` → ${item.result}` : '';
      lines.push(`${icon} #${item.id} ${item.title}${suffix}`);
    }
    if (inProgress > 0) {
      const cur = this.current!;
      lines.push(`\n当前焦点：#${cur.id} ${cur.title}`);
    } else if (pending > 0) {
      const next = this.items.find(i => i.status === 'pending')!;
      lines.push(`\n下一步：#${next.id} ${next.title}`);
    } else {
      lines.push('\n所有任务已完成。');
    }
    return lines.join('\n');
  }

  /** 序列化为快照 */
  toSnapshot(): TodoSnapshot {
    return {
      items: this.items.map(i => ({ ...i })),
      nextId: this.nextId,
    };
  }

  /** 从快照恢复 */
  static fromSnapshot(snapshot: TodoSnapshot): TodoManager {
    const mgr = new TodoManager();
    mgr.items = snapshot.items.map(i => ({ ...i }));
    mgr.nextId = snapshot.nextId;
    return mgr;
  }

  /** 重置（新任务开始时） */
  reset(): void {
    this.items = [];
    this.nextId = 1;
  }
}
