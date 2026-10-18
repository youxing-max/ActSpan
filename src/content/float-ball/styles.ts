/**
 * 悬浮胶囊 — 样式定义
 */

import {
  PILL_WIDTH,
  PILL_HEIGHT,
  PILL_COMPACT_WIDTH,
  LOGO_SIZE,
  TUCK_OFFSET,
} from './constants';

export const getStyles = () => `
  :host {
    all: initial;
    --ec-surface: rgba(255, 255, 255, 0.84);
    --ec-surface-strong: rgba(255, 255, 255, 0.95);
    --ec-surface-soft: rgba(255, 255, 255, 0.76);
    --ec-border: rgba(219, 227, 238, 0.92);
    --ec-border-soft: rgba(219, 227, 238, 0.74);
    --ec-text: #14253a;
    --ec-text-muted: #596b80;
    --ec-text-soft: #465a70;
    --ec-text-secondary: #465a70;
    --ec-primary: #2563eb;
    --ec-primary-strong: #1d4ed8;
    --ec-primary-soft: rgba(37, 99, 235, 0.1);
    --ec-bg-soft: #f2f6fb;
    --ec-success: #039855;
    --ec-success-soft: rgba(18, 183, 106, 0.12);
    --ec-danger: #d92d20;
    --ec-danger-soft: rgba(239, 68, 68, 0.1);
    --ec-focus-ring: 0 0 0 4px rgba(37, 99, 235, 0.18);
    --ec-shadow: 0 24px 68px rgba(15, 23, 42, 0.16), 0 10px 28px rgba(15, 23, 42, 0.08);
    --ec-pill-shadow: 0 12px 30px rgba(15, 23, 42, 0.14), inset 0 1px 0 rgba(255, 255, 255, 0.84);
    --ec-card-shadow: 0 10px 24px rgba(15, 23, 42, 0.08);
  }

  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
    font-family: "SF Pro Text", "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  }

  /* ---- 胶囊触发区域 ---- */
  .actspan-trigger {
    position: absolute;
    z-index: 2147483647;
    width: ${PILL_WIDTH + 10}px;
    height: ${PILL_HEIGHT + 10}px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    pointer-events: none;
  }

  /* hover 桥接已移至 JS .hovering class 管理，不再需要 ::before 拦截 */

  .actspan-pill {
    position: relative;
    isolation: isolate;
    overflow: visible;
    width: ${PILL_COMPACT_WIDTH}px;
    height: ${PILL_HEIGHT}px;
    padding: 0 12px;
    border-radius: 999px;
    border: none;
    background: #fff;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 8px;
    user-select: none;
    -webkit-user-select: none;
    flex-shrink: 0;
    white-space: normal;
    pointer-events: auto;
    transition: transform 0.36s cubic-bezier(0.22, 1, 0.36, 1),
                width 0.28s cubic-bezier(0.22, 1, 0.36, 1),
                box-shadow 0.28s ease;
  }

  .actspan-pill::before {
    content: "";
    position: absolute;
    inset: 0;
    background: none;
    pointer-events: none;
    z-index: 0;
  }

  .actspan-pill::after {
    content: "";
    position: absolute;
    inset: -1px;
    border-radius: inherit;
    background: none;
    opacity: 0;
    pointer-events: none;
    z-index: 0;
  }

  .actspan-trigger.side-right .actspan-pill {
    transform: translateX(${TUCK_OFFSET}px);
  }

  .actspan-trigger.side-left .actspan-pill {
    transform: translateX(-${TUCK_OFFSET}px);
    flex-direction: row-reverse;
    padding: 0 12px;
  }

  .actspan-trigger.side-left .actspan-pill-info {
    align-items: flex-end;
    text-align: right;
  }

  .actspan-trigger.side-left .actspan-pill::before {
    background: linear-gradient(220deg, rgba(255, 255, 255, 0.92), rgba(255, 255, 255, 0.28) 42%, rgba(255, 255, 255, 0) 72%);
  }

  .actspan-trigger.side-left .actspan-pill::after {
    background: radial-gradient(circle at 14% 50%, rgba(22, 119, 255, 0.16), rgba(22, 119, 255, 0));
  }

  .actspan-trigger.announce .actspan-pill,
  .actspan-trigger.auditing .actspan-pill {
    width: ${PILL_WIDTH}px;
    transform: translateX(0);
  }

  /* hover / active：略微滑出，露出完整 logo + 一点文字 */
  .actspan-trigger.side-right.hovering:not(.announce):not(.auditing) .actspan-pill,
  .actspan-trigger.side-right.active:not(.announce):not(.auditing) .actspan-pill {
    transform: translateX(${TUCK_OFFSET - 56}px);
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.12);
  }

  .actspan-trigger.side-left.hovering:not(.announce):not(.auditing) .actspan-pill,
  .actspan-trigger.side-left.active:not(.announce):not(.auditing) .actspan-pill {
    transform: translateX(-${TUCK_OFFSET - 56}px);
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.12);
  }

  .actspan-trigger.hovering .actspan-pill::after,
  .actspan-trigger.active .actspan-pill::after {
    opacity: 1;
  }

  .actspan-trigger.dragging .actspan-pill {
    width: ${PILL_HEIGHT}px;
    padding: 0;
    gap: 0;
    justify-content: center;
    transform: translateX(0);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.13);
    /* 保留 transition 实现胶囊→圆球的变形动画 */
  }

  .actspan-trigger.dragging .actspan-pill-info {
    opacity: 0;
    width: 0;
    flex: 0;
    margin: 0;
    padding: 0;
    overflow: hidden;
    transition: opacity 0.12s ease;
  }

  .actspan-trigger.dragging .actspan-bg-task-badge {
    opacity: 0;
    transition: opacity 0.12s ease;
  }

  .actspan-trigger.dragging .actspan-close-btn {
    opacity: 0 !important;
    pointer-events: none !important;
  }

  .actspan-pill img {
    position: relative;
    z-index: 1;
    width: ${LOGO_SIZE}px;
    height: ${LOGO_SIZE}px;
    border-radius: 8px;
    pointer-events: none;
    user-select: none;
    -webkit-user-drag: none;
    flex-shrink: 0;
  }

  .actspan-pill-info {
    position: relative;
    z-index: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 2px;
    flex: 1;
    overflow: hidden;
  }

  .actspan-shortcut {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    font-weight: 600;
    color: var(--ec-text);
    letter-spacing: 0.2px;
    line-height: 1.15;
    white-space: nowrap;
    text-overflow: ellipsis;
    overflow: hidden;
    transition: color 0.2s ease;
  }

  .actspan-shortcut:empty {
    display: none;
  }

  .actspan-pill-meta {
    font-size: 10px;
    color: var(--ec-text-muted);
    line-height: 1.1;
    white-space: nowrap;
    text-overflow: ellipsis;
    overflow: hidden;
    transition: color 0.2s ease;
  }

  /* 胶囊任务状态 */
  .actspan-task-dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: radial-gradient(circle, #fff 0%, var(--ec-primary) 60%);
    box-shadow: 0 0 0 3px var(--ec-primary-soft);
    animation: actspan-pulse 1.2s ease-in-out infinite;
  }

  .actspan-trigger.task-running .actspan-pill {
    box-shadow: 0 0 20px rgba(37, 99, 235, 0.5), 0 0 8px rgba(20, 37, 58, 0.3);
    animation: actspan-pill-glow 2s ease-in-out infinite;
  }

  @keyframes actspan-pill-glow {
    0%, 100% {
      box-shadow: 0 0 18px rgba(37, 99, 235, 0.45), 0 0 6px rgba(20, 37, 58, 0.25);
    }
    50% {
      box-shadow: 0 0 36px rgba(37, 99, 235, 0.7), 0 0 14px rgba(20, 37, 58, 0.45);
    }
  }

  .actspan-trigger.task-running .actspan-pill-meta {
    color: var(--ec-primary-strong);
  }

  .actspan-trigger.task-done .actspan-pill {
    box-shadow: 0 0 10px rgba(18, 183, 106, 0.3), 0 2px 8px rgba(0, 0, 0, 0.06);
  }

  .actspan-trigger.task-error .actspan-pill {
    box-shadow: 0 0 10px rgba(239, 68, 68, 0.3), 0 2px 8px rgba(0, 0, 0, 0.06);
  }

  .actspan-pill-notice {
    position: absolute;
    top: -34px;
    left: 50%;
    transform: translate(-50%, 8px) scale(0.96);
    background: var(--ec-surface-strong);
    border: 1px solid var(--ec-border-soft);
    box-shadow: 0 10px 20px rgba(15, 23, 42, 0.16);
    border-radius: 999px;
    padding: 4px 10px;
    font-size: 11px;
    color: var(--ec-text);
    max-width: 220px;
    white-space: nowrap;
    text-overflow: ellipsis;
    overflow: hidden;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s ease, transform 0.22s ease;
  }

  .actspan-pill-notice.tone-success {
    border-color: rgba(36, 138, 61, 0.24);
    color: var(--ec-success);
  }

  .actspan-pill-notice.tone-info {
    border-color: rgba(0, 113, 227, 0.24);
    color: var(--ec-primary-strong);
  }

  .actspan-pill-notice.tone-error {
    border-color: rgba(215, 0, 21, 0.24);
    color: var(--ec-danger);
  }

  .actspan-trigger::after {
    content: "";
    position: absolute;
    top: 100%;
    left: 50%;
    width: 56px;
    height: 18px;
    transform: translateX(-50%);
    z-index: 1;
  }

  .actspan-trigger.side-right:not(.announce):not(.auditing)::after {
    left: calc(50% + ${TUCK_OFFSET}px);
    transition: left 0.36s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .actspan-trigger.side-right.hovering:not(.announce):not(.auditing)::after {
    left: calc(50% + ${TUCK_OFFSET - 56}px);
  }

  .actspan-trigger.side-left:not(.announce):not(.auditing)::after {
    left: calc(50% - ${TUCK_OFFSET}px);
    transition: left 0.36s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .actspan-trigger.side-left.hovering:not(.announce):not(.auditing)::after {
    left: calc(50% - ${TUCK_OFFSET - 56}px);
  }

  .actspan-trigger.notice-visible .actspan-pill-notice {
    opacity: 1;
    transform: translate(-50%, 0) scale(1);
  }

  .actspan-settings-btn {
    position: absolute;
    top: calc(100% + 8px);
    left: 50%;
    transform: translate(-50%, -4px);
    width: 30px;
    height: 30px;
    border-radius: 50%;
    border: 1px solid var(--ec-border);
    background: linear-gradient(180deg, rgba(248, 251, 255, 0.96) 0%, var(--ec-surface) 100%);
    box-shadow: 0 10px 22px rgba(15, 23, 42, 0.14);
    color: var(--ec-text);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    pointer-events: none;
    cursor: pointer;
    transition: opacity 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease;
    z-index: 2;
  }

  .actspan-trigger.side-right:not(.announce):not(.auditing) .actspan-settings-btn {
    left: calc(50% + ${TUCK_OFFSET}px);
    transition: opacity 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease, left 0.36s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .actspan-trigger.side-right.hovering:not(.announce):not(.auditing) .actspan-settings-btn {
    left: calc(50% + ${TUCK_OFFSET - 56}px);
  }

  .actspan-trigger.side-left:not(.announce):not(.auditing) .actspan-settings-btn {
    left: calc(50% - ${TUCK_OFFSET}px);
    transition: opacity 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease, left 0.36s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .actspan-trigger.side-left.hovering:not(.announce):not(.auditing) .actspan-settings-btn {
    left: calc(50% - ${TUCK_OFFSET - 56}px);
  }

  .actspan-settings-btn svg {
    width: 14px;
    height: 14px;
    stroke: currentColor;
    fill: none;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .actspan-settings-btn:hover {
    transform: translate(-50%, -6px);
    box-shadow: 0 12px 24px rgba(15, 23, 42, 0.2);
  }

  .actspan-settings-btn:focus-visible {
    box-shadow: var(--ec-focus-ring);
  }

  .actspan-trigger.hovering .actspan-settings-btn,
  .actspan-trigger:focus-within .actspan-settings-btn {
    opacity: 1;
    pointer-events: auto;
    transform: translate(-50%, 0);
  }

  .actspan-trigger.dragging .actspan-settings-btn {
    opacity: 0;
    pointer-events: none;
  }

  /* ---- 悬浮球迷你操作卡片 ---- */
  .actspan-pill-action-card {
    position: absolute;
    bottom: calc(100% + 6px);
    right: 10%;
    transform: translateY(4px) scale(0.96);
    width: max-content;
    max-width: 280px;
    min-width: 160px;
    background: #fff;
    border: 1px solid var(--ec-border);
    border-radius: 12px;
    box-shadow: 0 4px 16px rgba(15, 23, 42, 0.14);
    padding: 0;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s ease, transform 0.22s ease;
    z-index: 10;
  }

  .actspan-pill-action-card.visible {
    opacity: 1;
    pointer-events: auto;
    transform: translateY(0px) scale(1);
  }

  /* 左侧时卡片左对齐 */
  .actspan-trigger.side-left .actspan-pill-action-card {
    right: auto;
    left: 0;
  }

  .pac-body {
    padding: 10px 12px;
  }

  .pac-msg {
    font-size: 12px;
    color: var(--ec-text);
    line-height: 1.4;
    margin-bottom: 8px;
    word-break: break-word;
  }

  .pac-actions {
    display: flex;
    gap: 6px;
  }

  .pac-options {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 6px;
  }

  .pac-btn {
    flex: 1;
    min-width: 0;
    padding: 5px 10px;
    border: 1px solid var(--ec-border);
    border-radius: 8px;
    font-size: 12px;
    cursor: pointer;
    background: var(--ec-surface);
    color: var(--ec-text);
    transition: background 0.15s ease, border-color 0.15s ease;
  }

  .pac-btn:hover {
    background: var(--ec-surface-strong);
  }

  .pac-approve {
    background: var(--ec-primary);
    color: #fff;
    border-color: var(--ec-primary);
  }

  .pac-approve:hover {
    background: var(--ec-primary-strong);
    border-color: var(--ec-primary-strong);
  }

  .pac-reject {
    background: var(--ec-surface);
    color: var(--ec-danger);
    border-color: var(--ec-danger);
  }

  .pac-reject:hover {
    background: rgba(215, 0, 21, 0.06);
  }

  .pac-option {
    flex: none;
    background: var(--ec-surface);
    border-color: var(--ec-border);
    color: var(--ec-primary);
  }

  .pac-option:hover {
    background: rgba(0, 113, 227, 0.06);
    border-color: var(--ec-primary);
  }

  .pac-input-row {
    display: flex;
    gap: 4px;
    margin-top: 6px;
  }

  .pac-text {
    flex: 1;
    min-width: 0;
    padding: 5px 8px;
    border: 1px solid var(--ec-border);
    border-radius: 8px;
    font-size: 12px;
    background: var(--ec-surface);
    color: var(--ec-text);
    outline: none;
  }

  .pac-text:focus {
    border-color: var(--ec-primary);
    box-shadow: 0 0 0 2px rgba(0, 113, 227, 0.12);
  }

  .pac-send {
    flex: none;
    width: auto;
    padding: 5px 10px;
    background: var(--ec-primary);
    color: #fff;
    border-color: var(--ec-primary);
  }

  .pac-send:hover {
    background: var(--ec-primary-strong);
    border-color: var(--ec-primary-strong);
  }

  /* 面板展开时隐藏迷你卡片（避免重复操作） */
  .actspan-trigger.active .actspan-pill-action-card {
    opacity: 0;
    pointer-events: none;
  }

  .actspan-trigger.dragging .actspan-pill-action-card {
    opacity: 0;
    pointer-events: none;
  }

  /* ---- 关闭按钮（角标式，内嵌于 pill） ---- */
  .actspan-close-btn {
    position: absolute;
    top: -5px;
    left: -5px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 1.5px solid rgba(255, 255, 255, 0.4);
    background: rgba(0, 0, 0, 0.28);
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    pointer-events: none;
    cursor: pointer;
    transition: opacity 0.18s ease, transform 0.15s ease, background 0.15s ease;
    z-index: 3;
  }

  /* 左侧时角标在右上角 */
  .actspan-trigger.side-left .actspan-close-btn {
    left: auto;
    right: -5px;
  }

  .actspan-close-btn svg {
    width: 9px;
    height: 9px;
    stroke: currentColor;
    fill: none;
    stroke-width: 2.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .actspan-close-btn:hover {
    background: rgba(0, 0, 0, 0.45);
    transform: scale(1.12);
  }

  .actspan-close-btn:focus-visible {
    box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.4);
  }

  .actspan-trigger.hovering .actspan-close-btn,
  .actspan-trigger:focus-within .actspan-close-btn {
    opacity: 1;
    pointer-events: auto;
  }

  .actspan-trigger.active .actspan-close-btn {
    opacity: 0;
    pointer-events: none;
  }

  /* ---- 关闭菜单 ---- */
  .actspan-close-menu {
    display: none;
    position: absolute;
    bottom: calc(100% + 6px);
    min-width: 180px;
    background: linear-gradient(180deg, var(--ec-surface-strong) 0%, var(--ec-surface) 100%);
    backdrop-filter: blur(22px) saturate(180%);
    -webkit-backdrop-filter: blur(22px) saturate(180%);
    border: 1px solid var(--ec-border);
    border-radius: 14px;
    box-shadow: 0 16px 40px rgba(15, 23, 42, 0.18);
    padding: 6px;
    z-index: 10;
    pointer-events: auto;
  }

  /* 右侧：菜单右对齐，向左展开，不会溢出屏幕右边 */
  .actspan-trigger.side-right .actspan-close-menu {
    right: 0;
  }

  /* 左侧：菜单左对齐，向右展开，不会溢出屏幕左边 */
  .actspan-trigger.side-left .actspan-close-menu {
    left: 0;
  }

  .actspan-close-menu.visible {
    display: block;
  }

  .actspan-close-menu-item {
    display: block;
    width: 100%;
    padding: 8px 12px;
    border: none;
    border-radius: 10px;
    background: transparent;
    color: var(--ec-text);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    transition: background 0.15s ease;
    white-space: nowrap;
  }

  .actspan-close-menu-item:hover {
    background: var(--ec-primary-soft);
    color: var(--ec-primary-strong);
  }

  .actspan-close-menu-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 5px;
    background: rgba(15, 23, 42, 0.06);
    font-size: 10px;
    margin-right: 8px;
    flex-shrink: 0;
  }

  .actspan-close-menu-divider {
    height: 1px;
    background: var(--ec-border-soft);
    margin: 4px 8px;
  }

  .actspan-close-menu-domain {
    display: flex !important;
    align-items: center;
    gap: 8px;
  }

  .actspan-close-menu-favicon {
    width: 16px;
    height: 16px;
    border-radius: 4px;
    flex-shrink: 0;
  }

  .actspan-close-menu-domain-info {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }

  .actspan-close-menu-domain-label {
    font-size: 13px;
    line-height: 1.3;
  }

  .actspan-close-menu-domain-host {
    font-size: 11px;
    color: var(--ec-text-muted);
    line-height: 1.2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 180px;
  }

  .actspan-close-menu-item:hover .actspan-close-menu-domain-host {
    color: var(--ec-primary);
  }

  .actspan-close-menu-item:hover .actspan-close-menu-icon {
    background: rgba(22, 119, 255, 0.12);
    color: var(--ec-primary);
  }

  .actspan-trigger.side-right.booting .actspan-pill {
    animation: actspan-pill-enter-right 560ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  .actspan-trigger.side-left.booting .actspan-pill {
    animation: actspan-pill-enter-left 560ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  .actspan-trigger.side-right.snapping:not(.task-running):not(.announce):not(.auditing) .actspan-pill {
    animation: actspan-pill-snap-right 480ms cubic-bezier(0.2, 1.18, 0.32, 1);
  }

  .actspan-trigger.side-left.snapping:not(.task-running):not(.announce):not(.auditing) .actspan-pill {
    animation: actspan-pill-snap-left 480ms cubic-bezier(0.2, 1.18, 0.32, 1);
  }

  /* 终止按钮 */
  .actspan-stop-btn {
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    border: 1px solid rgba(215, 0, 21, 0.18);
    outline: none;
    background: var(--ec-danger-soft);
    color: var(--ec-danger);
    border-radius: 9px;
    cursor: pointer;
    display: none;
    align-items: center;
    justify-content: center;
    padding: 0;
    transition: transform 0.15s ease, background 0.15s ease, border-color 0.15s ease;
  }

  .actspan-stop-btn svg {
    display: block;
  }

  .actspan-stop-btn:hover {
    transform: translateY(-1px);
    background: rgba(215, 0, 21, 0.12);
    border-color: rgba(215, 0, 21, 0.24);
  }

  .actspan-stop-btn.visible {
    display: flex;
  }

  .actspan-stop-btn:focus-visible,
  .actspan-new-btn:focus-visible {
    box-shadow: var(--ec-focus-ring);
  }

  .actspan-trigger.snapping {
    transition: left 0.35s cubic-bezier(0.25, 0.46, 0.45, 0.94),
                top 0.35s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  }

  /* ---- 遮罩层 ---- */
  .actspan-overlay {
    position: absolute;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    z-index: 2147483646;
    background:
      radial-gradient(circle at top left, rgba(137, 181, 255, 0.22), transparent 34%),
      radial-gradient(circle at top right, rgba(255, 255, 255, 0.92), transparent 36%),
      rgba(244, 248, 252, 0.56);
    backdrop-filter: blur(18px) saturate(125%);
    -webkit-backdrop-filter: blur(18px) saturate(125%);
    opacity: 0;
    transition: opacity 0.2s ease;
    pointer-events: none;

    /* 搜索框居中偏上 */
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 18vh;
  }

  .actspan-overlay.visible {
    opacity: 1;
    pointer-events: auto;
  }

  /* ---- 搜索框容器 ---- */
  .actspan-searchbox {
    position: relative;
    width: 580px;
    max-width: 90vw;
    background: rgba(255, 255, 255, 0.96);
    backdrop-filter: blur(28px) saturate(155%);
    -webkit-backdrop-filter: blur(28px) saturate(155%);
    border: 1px solid rgba(219, 227, 238, 0.6);
    border-radius: 30px;
    box-shadow: 0 16px 48px rgba(15, 23, 42, 0.12), 0 4px 16px rgba(15, 23, 42, 0.06);
    overflow: hidden;

    transform: scale(0.95) translateY(-10px);
    opacity: 0;
    transition: transform 0.25s cubic-bezier(0.34, 1.3, 0.64, 1),
                opacity 0.2s ease;
  }

  .actspan-overlay.visible .actspan-searchbox {
    transform: scale(1) translateY(0);
    opacity: 1;
  }

  /* ---- 流光边框 wrapper ---- */
  .actspan-searchbox-wrap {
    position: relative;
    border-radius: 32px;
    overflow: hidden;
    padding: 2px;
    background: transparent;
    transition: box-shadow 0.4s ease;
  }

  .actspan-searchbox-wrap::before {
    content: '';
    position: absolute;
    /* 始终保持正方形，以宽度为基准，确保任何高度下旋转都均匀 */
    left: 50%;
    top: 50%;
    width: 150%;
    aspect-ratio: 1;
    transform: translate(-50%, -50%);
    background: conic-gradient(
      from 0deg,
      transparent 0deg,
      transparent 80deg,
      rgba(37, 99, 235, 0.35) 140deg,
      rgba(20, 37, 58, 0.25) 180deg,
      rgba(37, 99, 235, 0.35) 220deg,
      transparent 280deg,
      transparent 360deg
    );
    opacity: 0;
    transition: opacity 0.4s ease;
    pointer-events: none;
    z-index: 0;
  }

  .actspan-searchbox-wrap.state-running::before {
    opacity: 1;
    animation: actspan-glow-spin 2.8s linear infinite;
  }

  .actspan-searchbox-wrap.state-running {
    box-shadow: 0 0 20px -6px rgba(22, 119, 255, 0.1);
  }

  /* searchbox 需要在伪元素之上，自带背景遮住中间区域 */
  .actspan-searchbox-wrap > .actspan-searchbox {
    position: relative;
    z-index: 1;
  }

  @keyframes actspan-glow-spin {
    to { transform: translate(-50%, -50%) rotate(360deg); }
  }

  .actspan-searchbox.state-running {
    border-color: transparent;
  }

  .actspan-searchbox.state-done {
    border-color: rgba(18, 183, 106, 0.45);
  }

  .actspan-searchbox.state-error {
    border-color: rgba(239, 68, 68, 0.18);
  }

  /* 输入行 */
  .actspan-input-row {
    display: flex;
    align-items: center;
    margin: 0;
    padding: 18px 20px;
    gap: 14px;
    border-radius: 0;
    border: none;
    background: transparent;
    transition: background-color 0.2s ease;
  }

  .actspan-input-row:focus-within {
    background: rgba(22, 119, 255, 0.02);
  }

  .actspan-input-icon {
    width: 26px;
    height: 26px;
    border-radius: 8px;
    flex-shrink: 0;
  }

  .actspan-input {
    flex: 1;
    border: none;
    outline: none;
    background: transparent;
    font-size: 16px;
    line-height: 1.5;
    color: var(--ec-text);
    caret-color: var(--ec-primary);
  }

  .actspan-input::placeholder {
    color: var(--ec-text-muted);
    opacity: 0.78;
  }

  .actspan-input:disabled {
    opacity: 1;
    cursor: default;
  }

  /* 运行态扫光 placeholder */
  .state-running .actspan-input::placeholder {
    background: linear-gradient(
      90deg,
      var(--ec-text-muted) 0%,
      var(--ec-text-muted) 35%,
      rgba(22, 119, 255, 0.85) 50%,
      var(--ec-text-muted) 65%,
      var(--ec-text-muted) 100%
    );
    background-size: 250% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    animation: actspan-shimmer-text 2.4s ease-in-out infinite;
    opacity: 1;
  }

  @keyframes actspan-shimmer-text {
    0% { background-position: 100% center; }
    100% { background-position: -50% center; }
  }

  .actspan-input-hint {
    flex-shrink: 0;
    font-size: 11px;
    color: var(--ec-text-muted);
    padding: 4px 8px;
    border: none;
    background: rgba(241, 244, 248, 0.8);
    border-radius: 6px;
    line-height: 1;
  }

  /* 分割线 */
  .actspan-divider {
    height: 1px;
    margin: 0 18px;
  }

  /* ---- 结果展示区 ---- */
  .actspan-result {
    display: none;
    max-height: 50vh;
    overflow-y: auto;
    padding: 12px 18px 16px;
    font-size: 15px;
    line-height: 1.72;
    letter-spacing: 0.01em;
    color: var(--ec-text);
    background: transparent;
  }

  .actspan-result.visible {
    display: block;
  }

  /* 状态指示 */
  .actspan-status {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 6px 0;
    padding: 9px 12px;
    color: var(--ec-text);
    font-size: 12px;
    border-radius: 10px;
    border: none;
    background: rgba(248, 250, 252, 0.88);
  }

  .actspan-status .dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ec-primary);
    animation: actspan-pulse 1.2s ease-in-out infinite;
  }

  /* 规划状态指示（与 thinking 类似，使用品牌蓝） */
  .actspan-planning {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 6px 0;
    padding: 9px 12px;
    color: var(--ec-primary-strong);
    font-size: 12px;
    border-radius: 10px;
    border: none;
    background: rgba(22, 119, 255, 0.06);
  }

  .actspan-planning .dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ec-primary-strong);
    animation: actspan-pulse 1.2s ease-in-out infinite;
  }

  .actspan-review-output {
    margin: 8px 0;
    border: none;
    border-radius: 10px;
    background: rgba(248, 250, 252, 0.72);
    padding: 10px 12px;
    color: var(--ec-text);
    font-size: 13px;
    line-height: 1.5;
  }

  .actspan-review-summary {
    font-weight: 600;
    color: #0f172a;
    margin-bottom: 6px;
  }

  .actspan-review-findings {
    margin: 0;
    padding-left: 18px;
  }

  .actspan-review-findings li + li {
    margin-top: 6px;
  }

  .actspan-review-priority {
    color: #b45309;
    font-weight: 700;
  }

  /* 调度状态机日志 */
  .actspan-agent-state-panel {
    margin: 4px 0;
    border-radius: 8px;
    border: none;
    background: rgba(248, 250, 253, 0.6);
    overflow: hidden;
    margin-bottom: 16px;
  }

  .actspan-agent-state-title {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 4px;
    padding: 6px 10px;
    font-size: 11px;
    color: var(--ec-text-muted);
    background: transparent;
    font-weight: 500;
    user-select: none;
    cursor: pointer;
    transition: background 0.18s ease;
  }

  .actspan-agent-state-panel.is-live .actspan-agent-state-title {
    background: rgba(22, 119, 255, 0.02);
  }

  .actspan-agent-state-title-main {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    font-size: 10px;
    letter-spacing: 0.02em;
    color: var(--ec-text-muted);
  }

  .actspan-agent-state-summary {
    min-width: 0;
    margin-left: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: normal;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    font-size: 11px;
    line-height: 1.45;
    color: var(--ec-text-soft);
    font-weight: 500;
    padding: 5px 8px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.55);
    border: none;
  }

  .actspan-agent-state-panel.is-live .actspan-agent-state-summary::before {
    content: '';
    display: inline-block;
    width: 5px;
    height: 5px;
    margin-right: 5px;
    border-radius: 999px;
    background: rgba(0, 113, 227, 0.55);
    animation: actspan-pulse 2.6s ease-in-out infinite;
    vertical-align: middle;
  }

  .actspan-agent-state-ops-anchor {
    display: none;
    padding: 0 12px 12px;
  }

  .actspan-agent-state-panel.open .actspan-agent-state-ops-anchor {
    display: block;
  }

  .actspan-agent-state-ops-anchor .actspan-calls-group {
    margin: 0;
  }

  .actspan-agent-state-title:hover {
    background: rgba(0, 113, 227, 0.04);
  }

  .actspan-agent-state-title .arrow {
    font-size: 10px;
    transition: transform 0.2s ease;
  }

  .actspan-agent-state-panel.open .actspan-agent-state-title .arrow {
    transform: rotate(90deg);
  }

  .actspan-agent-state-panel.open .actspan-agent-state-summary {
    display: none;
  }

  .actspan-agent-state-log {
    display: none;
    padding: 6px 14px 4px;
  }

  .actspan-agent-state-panel.open .actspan-agent-state-log {
    display: block;
  }

  .actspan-agent-state-item {
    font-size: 12px;
    color: var(--ec-text);
    line-height: 1.6;
    word-break: break-word;
  }

  .actspan-agent-state-item + .actspan-agent-state-item {
    margin-top: 4px;
  }

  .actspan-task-runtime-board {
    display: none;
    gap: 6px;
    padding: 0 10px 10px;
    background: transparent;
  }

  .actspan-agent-state-panel.open .actspan-task-runtime-board {
    display: grid;
  }

  /* ── Todo 进度视图 ── */
  .actspan-todo-board {
    display: none;
    padding: 0 14px 10px;
  }

  .actspan-agent-state-panel.open .actspan-todo-board:not(:empty) {
    display: block;
  }

  .actspan-todo-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }

  .actspan-todo-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--ec-primary-strong);
  }

  .actspan-todo-stats {
    font-size: 11px;
    font-weight: 600;
    color: var(--ec-text-muted);
  }

  .actspan-todo-progress-bar {
    height: 3px;
    border-radius: 2px;
    background: rgba(22, 119, 255, 0.1);
    margin-bottom: 8px;
    overflow: hidden;
  }

  .actspan-todo-progress-fill {
    height: 100%;
    border-radius: 2px;
    background: var(--ec-primary);
    transition: width 0.3s ease;
  }

  .actspan-todo-list {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .actspan-todo-item {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    padding: 4px 8px;
    border-radius: 6px;
    font-size: 12px;
    line-height: 1.5;
    color: var(--ec-text);
    transition: background 0.15s ease;
  }

  .actspan-todo-item.active {
    background: rgba(22, 119, 255, 0.06);
    font-weight: 600;
  }

  .actspan-todo-item.done {
    color: var(--ec-text-muted);
  }

  .actspan-todo-item.done .actspan-todo-text {
    text-decoration: line-through;
    text-decoration-color: rgba(102, 112, 133, 0.4);
  }

  .actspan-todo-item.pending {
    color: var(--ec-text-muted);
  }

  .actspan-todo-icon {
    flex-shrink: 0;
    width: 16px;
    text-align: center;
    font-weight: 700;
    line-height: 1.5;
  }

  .actspan-todo-item.done .actspan-todo-icon {
    color: var(--ec-success);
  }

  .actspan-todo-item.active .actspan-todo-icon {
    color: var(--ec-primary);
  }

  .actspan-todo-item.pending .actspan-todo-icon {
    color: rgba(102, 112, 133, 0.4);
  }

  .actspan-todo-text {
    min-width: 0;
    flex: 1;
    word-break: break-word;
  }

  .actspan-runtime-now {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.5);
    border: none;
    color: var(--ec-text-soft);
    font-size: 11px;
    line-height: 1.45;
    font-weight: 500;
  }

  .actspan-runtime-now-text {
    min-width: 0;
    flex: 1;
  }

  .actspan-inline-loader {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    flex-shrink: 0;
  }

  .actspan-inline-loader span {
    width: 3px;
    height: 3px;
    border-radius: 999px;
    background: rgba(22, 119, 255, 0.45);
    animation: actspan-loader-fade 1.2s ease-in-out infinite;
  }

  .actspan-inline-loader span:nth-child(2) {
    animation-delay: 0.16s;
  }

  .actspan-inline-loader span:nth-child(3) {
    animation-delay: 0.32s;
  }

  .actspan-task-runtime-step-dot {
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: rgba(22, 119, 255, 0.18);
    flex-shrink: 0;
  }

  @keyframes actspan-pulse {
    0%, 100% {
      opacity: 0.55;
      transform: scale(1);
    }
    50% {
      opacity: 0.9;
      transform: scale(1.03);
    }
  }

  @keyframes actspan-loader-fade {
    0%, 80%, 100% { opacity: 0.24; transform: scale(1); }
    40% { opacity: 0.9; transform: scale(1.15); }
  }

  @keyframes actspan-breathe {
    0%, 100% { transform: scale(1); opacity: 0.98; }
    50% { transform: scale(1.004); opacity: 1; }
  }

  @keyframes actspan-pill-enter-right {
    0% {
      opacity: 0;
      transform: translateX(${TUCK_OFFSET + 16}px) scale(0.9);
    }
    65% {
      opacity: 1;
      transform: translateX(${TUCK_OFFSET - 4}px) scale(1.02);
    }
    100% {
      opacity: 1;
      transform: translateX(${TUCK_OFFSET}px) scale(1);
    }
  }

  @keyframes actspan-pill-enter-left {
    0% {
      opacity: 0;
      transform: translateX(-${TUCK_OFFSET + 16}px) scale(0.9);
    }
    65% {
      opacity: 1;
      transform: translateX(-${TUCK_OFFSET - 4}px) scale(1.02);
    }
    100% {
      opacity: 1;
      transform: translateX(-${TUCK_OFFSET}px) scale(1);
    }
  }

  @keyframes actspan-pill-snap-right {
    0% { transform: translateX(0); }
    60% { transform: translateX(${TUCK_OFFSET + 10}px) scale(0.98); }
    100% { transform: translateX(${TUCK_OFFSET}px) scale(1); }
  }

  @keyframes actspan-pill-snap-left {
    0% { transform: translateX(0); }
    60% { transform: translateX(-${TUCK_OFFSET + 10}px) scale(0.98); }
    100% { transform: translateX(-${TUCK_OFFSET}px) scale(1); }
  }

  /* 函数调用标签 */
  .actspan-func-tag {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 10px;
    margin: 4px 0;
    background: rgba(22, 119, 255, 0.06);
    border: none;
    border-radius: 8px;
    font-size: 12px;
    color: var(--ec-primary-strong);
  }

  .actspan-func-icon {
    width: 12px;
    height: 12px;
    border-radius: 3px;
    flex-shrink: 0;
  }

  /* ---- 函数调用折叠区 ---- */
  .actspan-calls-group {
    margin: 2px 0 0;
  }

  .actspan-calls-summary {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 5px 8px;
    background: rgba(22, 119, 255, 0.03);
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 11px;
    font-weight: 500;
    color: var(--ec-text-muted);
    user-select: none;
    transition: background 0.15s ease;
  }

  .actspan-calls-summary:hover {
    background: rgba(22, 119, 255, 0.06);
  }

  .actspan-calls-summary .arrow {
    display: inline-block;
    font-size: 9px;
    transition: transform 0.2s ease;
  }

  .actspan-calls-summary .arrow.open {
    transform: rotate(90deg);
  }

  .actspan-calls-icons {
    display: flex;
    gap: 3px;
  }

  .actspan-calls-icons img {
    width: 14px;
    height: 14px;
    border-radius: 3px;
  }

  .actspan-calls-detail {
    display: none;
    padding: 3px 0 0;
  }

  .actspan-calls-detail.open {
    display: grid;
    gap: 2px;
  }

  .actspan-calls-detail .actspan-call-item {
    margin: 0;
  }

  .actspan-call-header {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 3px 6px;
    border-radius: 5px;
    cursor: default;
    font-size: 11px;
    color: var(--ec-text-soft);
    user-select: none;
    border: none;
    background: rgba(255, 255, 255, 0.45);
  }

  .actspan-call-item.tone-status .actspan-call-header {
    background: rgba(22, 119, 255, 0.05);
  }

  .actspan-call-item.tone-action .actspan-call-header {
    background: rgba(22, 119, 255, 0.06);
    animation: actspan-call-bg-pulse 1.8s ease-in-out infinite;
  }

  .actspan-call-item.tone-action .actspan-task-runtime-step-dot {
    background: rgba(22, 119, 255, 0.7);
    box-shadow: 0 0 0 0 rgba(22, 119, 255, 0.4);
    animation: actspan-dot-pulse 1.8s ease-in-out infinite;
  }

  .actspan-call-item.tone-action .actspan-call-status.running {
    color: var(--ec-primary);
    animation: actspan-loader-fade 1.2s ease-in-out infinite;
  }

  @keyframes actspan-call-bg-pulse {
    0%, 100% { background: rgba(22, 119, 255, 0.04); }
    50% { background: rgba(22, 119, 255, 0.1); }
  }

  @keyframes actspan-dot-pulse {
    0%, 100% {
      box-shadow: 0 0 0 0 rgba(22, 119, 255, 0.35);
      transform: scale(1);
    }
    50% {
      box-shadow: 0 0 0 4px rgba(22, 119, 255, 0);
      transform: scale(1.15);
    }
  }

  .actspan-call-item.tone-issue .actspan-call-header {
    background: rgba(245, 158, 11, 0.06);
  }

  .actspan-call-item.tone-done .actspan-call-header {
    background: rgba(18, 183, 106, 0.05);
  }

  .actspan-call-header.has-body {
    cursor: pointer;
  }

  .actspan-call-header .arrow {
    display: inline-block;
    font-size: 10px;
    transition: transform 0.2s ease;
  }

  .actspan-call-header .arrow.open {
    transform: rotate(90deg);
  }

  .actspan-call-status {
    margin-left: auto;
    font-size: 10px;
    color: rgba(18, 183, 106, 0.6);
    flex-shrink: 0;
  }
  .actspan-call-status.running {
    color: var(--ec-text-muted);
    letter-spacing: 1px;
  }

  .actspan-call-main {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
    flex: 1;
    overflow: hidden;
  }

  .actspan-call-title {
    line-height: 1.4;
    font-weight: 600;
    color: var(--ec-text);
    flex-shrink: 0;
    font-size: 10px;
  }

  .actspan-call-intent {
    font-size: 10px;
    line-height: 1.4;
    color: var(--ec-text-muted);
    font-weight: 400;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .actspan-call-body {
    display: none;
    padding: 8px 0 8px 24px;
  }

  .actspan-call-body.open {
    display: block;
  }

  /* ---- 推荐卡片 ---- */
  .actspan-rec-cards {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 10px 0 4px;
  }

  .actspan-rec-card {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    background: rgba(248, 250, 253, 0.72);
    border: none;
    border-radius: 10px;
    cursor: pointer;
    transition: all 0.15s ease;
    text-decoration: none;
    color: inherit;
  }

  .actspan-rec-card:hover {
    background: rgba(240, 247, 255, 0.88);
    transform: translateY(-1px);
  }

  .actspan-rec-card-body {
    flex: 1;
    min-width: 0;
  }

  .actspan-rec-card-title {
    font-size: 13px;
    font-weight: 500;
    color: var(--ec-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .actspan-rec-card-meta {
    font-size: 12px;
    color: var(--ec-text-muted);
    margin-top: 2px;
  }

  .actspan-rec-card-price {
    color: var(--ec-danger);
    font-weight: 600;
  }

  .actspan-rec-tag {
    flex-shrink: 0;
    padding: 2px 8px;
    background: var(--ec-primary-soft);
    color: var(--ec-primary-strong);
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
  }

  .actspan-rec-arrow {
    flex-shrink: 0;
    color: var(--ec-text-muted);
    font-size: 16px;
    line-height: 1;
  }

  /* ---- 新对话按钮 ---- */
  .actspan-new-btn {
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    border: 1px solid var(--ec-border-soft);
    outline: none;
    background: var(--ec-primary-soft);
    color: var(--ec-primary-strong);
    border-radius: 9px;
    cursor: pointer;
    display: none;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    line-height: 1;
    transition: all 0.15s ease;
    padding: 0;
  }

  .actspan-new-btn:hover {
    background: rgba(0, 113, 227, 0.12);
    color: var(--ec-primary-strong);
    border-color: rgba(0, 113, 227, 0.2);
    transform: translateY(-1px);
  }

  .actspan-new-btn.visible {
    display: flex;
  }

  /* ---- 重试按钮（断点恢复） ---- */
  .actspan-retry-btn {
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    border: 1px solid rgba(245, 158, 11, 0.2);
    outline: none;
    background: rgba(245, 158, 11, 0.06);
    color: #d97706;
    border-radius: 9px;
    cursor: pointer;
    display: none;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    line-height: 1;
    transition: all 0.15s ease;
    padding: 0;
  }

  .actspan-retry-btn:hover {
    background: rgba(245, 158, 11, 0.12);
    color: #b45309;
    border-color: rgba(245, 158, 11, 0.3);
    transform: translateY(-1px);
  }

  .actspan-retry-btn.visible {
    display: flex;
  }

  .actspan-retry-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none;
  }

  .actspan-retry-btn:focus-visible {
    box-shadow: var(--ec-focus-ring);
  }

  /* ---- 定位到任务页签按钮 ---- */
  .actspan-focus-tab-btn {
    flex-shrink: 0;
    height: 26px;
    border: 1px solid rgba(0, 113, 227, 0.2);
    outline: none;
    background: var(--ec-primary-soft);
    color: var(--ec-primary-strong);
    border-radius: 13px;
    cursor: pointer;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    line-height: 1;
    transition: all 0.15s ease;
    padding: 0 10px;
    white-space: nowrap;
    pointer-events: auto;
  }
  .actspan-focus-tab-btn:hover {
    background: rgba(0, 113, 227, 0.15);
    border-color: rgba(0, 113, 227, 0.3);
  }

  /* ---- 用户消息气泡 ---- */
  .actspan-user-msg {
    margin: 10px 0 6px;
    padding: 9px 14px;
    background: rgba(22, 119, 255, 0.08);
    border: none;
    border-radius: 14px 14px 6px 14px;
    font-size: 13px;
    color: var(--ec-text);
    max-width: 85%;
    margin-left: auto;
    word-break: break-word;
  }

  /* ---- 历史对话折叠 ---- */
  .actspan-round-history {
    margin-bottom: 4px;
    border-bottom: 1px solid var(--ec-border-soft);
    padding-bottom: 4px;
  }
  .actspan-round-summary {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 2px;
    cursor: pointer;
    font-size: 12px;
    color: var(--ec-text-muted);
    user-select: none;
  }
  .actspan-round-summary:hover {
    color: var(--ec-text);
  }
  .actspan-round-summary .arrow {
    font-size: 9px;
    transition: transform 0.2s;
    color: var(--ec-text-muted);
  }
  .actspan-round-summary .arrow.open {
    transform: rotate(90deg);
  }
  .actspan-round-preview {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
  .actspan-round-content {
    display: none;
    padding: 4px 0 2px;
  }
  .actspan-round-content.open {
    display: block;
  }

  /* ---- 搜索结果卡片（带缩略图） ---- */
  .actspan-result-card {
    display: flex;
    gap: 12px;
    padding: 10px 12px;
    border: none;
    border-radius: 10px;
    background: rgba(248, 250, 253, 0.72);
    transition: background 0.15s ease, transform 0.15s ease;
    cursor: pointer;
  }

  .actspan-result-card:hover {
    background: rgba(240, 247, 255, 0.88);
    transform: translateY(-1px);
  }

  .actspan-result-thumb {
    width: 58px;
    height: 58px;
    border-radius: 12px;
    object-fit: cover;
    flex-shrink: 0;
    background: rgba(148, 163, 184, 0.18);
    border: 1px solid rgba(219, 227, 238, 0.84);
  }

  .actspan-result-body {
    flex: 1;
    min-width: 0;
  }

  /* AI 回复文本 */
  .actspan-answer {
    margin: 4px 0;
    padding: 2px 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 14px;
    line-height: 1.85;
    color: var(--ec-text);
  }

  .actspan-answer p {
    margin: 0;
  }

  .actspan-answer p + p {
    margin-top: 14px;
  }

  /* 流式增量淡入：仅对新追加的块级元素生效 */
  .actspan-answer-new {
    animation: actspan-answer-fadein 0.35s ease-out;
  }
  @keyframes actspan-answer-fadein {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .actspan-answer h3, .actspan-answer h4, .actspan-answer h5 {
    font-weight: 650;
    color: #111112;
    letter-spacing: -0.01em;
  }

  .actspan-answer h3 {
    font-size: 16px;
    margin: 20px 0 8px;
  }
  .actspan-answer h4 {
    font-size: 15px;
    margin: 16px 0 6px;
  }
  .actspan-answer h5 {
    font-size: 14px;
    margin: 14px 0 4px;
  }

  .actspan-answer ul, .actspan-answer ol {
    padding-left: 22px;
    margin: 10px 0;
  }

  .actspan-answer li {
    margin: 5px 0;
  }

  .actspan-answer li + li {
    margin-top: 6px;
  }

  .actspan-answer code {
    background: rgba(37, 99, 235, 0.07);
    color: var(--ec-primary-strong);
    font-weight: 500;
    padding: 2px 7px;
    border-radius: 5px;
    font-size: 12.5px;
    font-family: "SF Mono", Monaco, Consolas, monospace;
  }

  .actspan-answer pre {
    margin: 12px 0 4px;
    padding: 14px 16px;
    border-radius: 10px;
    border: 1px solid rgba(15, 23, 42, 0.08);
    background: rgba(15, 23, 42, 0.92);
    color: #e8ecf2;
    font-family: "SF Mono", Monaco, Consolas, monospace;
    font-size: 12.5px;
    line-height: 1.6;
    overflow-x: auto;
    white-space: pre;
  }

  .actspan-answer pre code {
    border: 0;
    background: transparent;
    color: inherit;
    padding: 0;
    font-size: inherit;
  }

  .actspan-answer blockquote {
    margin: 12px 0 4px;
    padding: 10px 14px;
    border-left: 3px solid rgba(37, 99, 235, 0.35);
    border-radius: 0 10px 10px 0;
    background: rgba(37, 99, 235, 0.04);
    color: #3b4963;
  }

  .actspan-answer img.actspan-md-img {
    max-width: 70%;
    max-height: 280px;
    width: auto;
    height: auto;
    object-fit: contain;
    border-radius: 8px;
    margin: 8px 0;
    display: block;
  }

  .actspan-link-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 10px 3px 6px;
    margin: 2px 0;
    border-radius: 6px;
    background: rgba(37, 99, 235, 0.06);
    border: 1px solid rgba(37, 99, 235, 0.12);
    color: var(--ec-primary-strong) !important;
    text-decoration: none !important;
    font-size: 13px;
    line-height: 1.5;
    max-width: 100%;
    overflow: hidden;
    transition: background 0.15s, border-color 0.15s;
    word-break: break-all;
  }
  .actspan-link-chip:hover {
    background: rgba(37, 99, 235, 0.12);
    border-color: rgba(37, 99, 235, 0.25);
  }
  .actspan-link-favicon {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    border-radius: 2px;
  }
  .actspan-link-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .actspan-answer hr {
    border: none;
    height: 1px;
    background: rgba(219, 227, 238, 0.5);
    margin: 18px 0;
  }

  .actspan-answer table {
    width: 100%;
    border-collapse: collapse;
    margin: 12px 0;
    font-size: 13px;
  }

  .actspan-answer th, .actspan-answer td {
    padding: 7px 12px;
    border: 1px solid rgba(219, 227, 238, 0.7);
    text-align: left;
  }

  .actspan-answer th {
    background: rgba(37, 99, 235, 0.05);
    font-weight: 600;
    color: #111112;
  }

  .actspan-answer tr:nth-child(even) td {
    background: rgba(248, 250, 253, 0.4);
  }

  .actspan-answer strong {
    font-weight: 650;
    color: var(--ec-text);
  }

  .actspan-answer a {
    color: var(--ec-primary-strong);
    text-decoration: underline;
    text-decoration-color: rgba(37, 99, 235, 0.3);
    text-underline-offset: 3px;
    transition: text-decoration-color 0.15s;
  }
  .actspan-answer a:hover {
    text-decoration-color: rgba(37, 99, 235, 0.7);
  }
  .actspan-answer del {
    text-decoration: line-through;
    opacity: 0.55;
  }
  .actspan-answer em {
    font-style: italic;
  }

  /* 错误信息 */
  .actspan-error {
    color: var(--ec-danger);
    padding: 4px 0;
    font-size: 13px;
  }

  /* ---- 搜索结果卡片 ---- */
  .actspan-search-results {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .actspan-result-title {
    font-size: 13px;
    font-weight: 500;
    color: var(--ec-primary-strong);
    text-decoration: none;
    display: -webkit-box;
    -webkit-line-clamp: 1;
    -webkit-box-orient: vertical;
    overflow: hidden;
    line-height: 1.4;
  }

  .actspan-result-title:hover {
    text-decoration: underline;
  }

  .actspan-result-snippet {
    font-size: 12px;
    color: var(--ec-text-muted);
    margin-top: 4px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    line-height: 1.5;
  }

  .actspan-result-source {
    font-size: 12px;
    color: var(--ec-text-muted);
    margin-top: 4px;
  }

  .actspan-result-count {
    font-size: 12px;
    color: var(--ec-text-muted);
    padding: 4px 2px 10px;
  }

  /* 截图结果内联展示 */
  .actspan-screenshot-section {
    margin: 8px 0;
    padding: 10px;
    background: rgba(248, 250, 253, 0.72);
    border-radius: 10px;
    border: none;
  }
  .actspan-screenshot-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 8px;
  }
  .actspan-screenshot-meta {
    min-width: 0;
  }
  .actspan-screenshot-label {
    font-size: 12px;
    color: #354b67;
    font-weight: 600;
    line-height: 1.4;
  }
  .actspan-screenshot-sub {
    font-size: 11px;
    margin-top: 2px;
    color: var(--ec-text-muted);
    line-height: 1.4;
  }
  .actspan-screenshot-open {
    flex-shrink: 0;
    border: 1px solid rgba(0, 113, 227, 0.2);
    background: rgba(0, 113, 227, 0.08);
    color: var(--ec-primary-strong);
    border-radius: 8px;
    height: 26px;
    padding: 0 10px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
  }
  .actspan-screenshot-open:hover {
    background: rgba(0, 113, 227, 0.12);
  }
  .actspan-verify-section,
  .actspan-repair-section {
    margin: 8px 0;
    padding: 10px;
    background: rgba(248, 250, 253, 0.72);
    border-radius: 10px;
    border: none;
  }
  .actspan-verify-header,
  .actspan-repair-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 8px;
  }
  .actspan-verify-title,
  .actspan-repair-title {
    font-size: 12px;
    color: #354b67;
    font-weight: 600;
    line-height: 1.4;
  }
  .actspan-verify-badge,
  .actspan-repair-badge {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 999px;
    font-weight: 600;
  }
  .actspan-verify-badge.ok,
  .actspan-repair-badge.ok {
    color: #166534;
    background: rgba(22, 101, 52, 0.1);
  }
  .actspan-verify-badge.fail,
  .actspan-repair-badge.fail {
    color: #b42318;
    background: rgba(180, 35, 24, 0.1);
  }
  .actspan-verify-list,
  .actspan-repair-list,
  .actspan-repair-candidates {
    display: grid;
    gap: 6px;
  }
  .actspan-verify-item,
  .actspan-repair-item,
  .actspan-repair-candidate {
    font-size: 12px;
    line-height: 1.5;
    color: var(--ec-text);
    padding: 7px 8px;
    background: rgba(255, 255, 255, 0.6);
    border-radius: 8px;
    border: none;
  }
  .actspan-verify-item.fail {
    background: rgba(255, 240, 240, 0.72);
  }
  .actspan-repair-item-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .actspan-verify-sub,
  .actspan-repair-sub {
    font-size: 11px;
    margin-top: 2px;
    color: var(--ec-text-muted);
    line-height: 1.45;
  }
  .actspan-screenshot-open:focus-visible {
    box-shadow: var(--ec-focus-ring);
    outline: none;
  }

  /* 确认卡片 — 独立展示 */
  .actspan-approval-standalone {
    margin: 10px 18px;
    border-radius: 14px;
    background: linear-gradient(135deg, rgba(240, 253, 250, 0.95), rgba(204, 251, 241, 0.55));
    border: 1.5px solid rgba(13, 148, 136, 0.22);
    box-shadow: 0 4px 20px rgba(13, 148, 136, 0.08);
    animation: actspan-approval-fadein 0.35s ease-out;
    overflow: hidden;
  }
  .actspan-approval-header-bar {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 11px 14px 0;
    font-size: 13px;
    font-weight: 600;
    color: rgb(15, 118, 110);
  }
  .actspan-approval-header-bar img {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
  }
  .actspan-approval-standalone .actspan-approval-card {
    margin: 8px 14px 14px;
    padding: 0;
    background: none;
    border: none;
    box-shadow: none;
    border-radius: 0;
  }
  .actspan-approval-standalone.settled {
    opacity: 0.75;
    animation: none;
    border-color: var(--ec-border);
    background: var(--ec-bg-soft);
    transition: opacity 0.3s ease;
  }
  .actspan-approval-standalone.settled .actspan-approval-header-bar {
    color: var(--ec-text-muted);
    padding-bottom: 10px;
  }
  .actspan-approval-standalone.settled .actspan-approval-card {
    display: none;
  }
  @keyframes actspan-approval-fadein {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .actspan-approval-card {
    padding: 10px 12px;
    border-radius: 10px;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.9), rgba(245, 250, 255, 0.7));
    border: 1px solid rgba(13, 148, 136, 0.18);
    box-shadow: 0 4px 12px rgba(15, 23, 42, 0.06);
  }
  .actspan-approval-message {
    font-size: 13px;
    line-height: 1.5;
    color: var(--ec-text);
    margin-bottom: 30px;
    word-break: break-word;
  }
  .actspan-approval-actions {
    display: flex;
    gap: 8px;
  }
  .actspan-approval-btn {
    padding: 6px 16px;
    border-radius: 6px;
    border: none;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    transition: opacity 0.15s;
    line-height: 1.4;
  }
  .actspan-approval-btn:hover { opacity: 0.85; }
  .actspan-approval-btn.approve {
    background: var(--ec-success);
    color: #fff;
  }
  .actspan-approval-btn.reject {
    background: var(--ec-danger-soft);
    color: var(--ec-danger);
  }
  .actspan-approval-btn.trust-all {
    background: var(--ec-bg-soft);
    color: var(--ec-text-secondary);
    font-size: 11px;
  }
  .actspan-approval-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    pointer-events: none;
  }
  .actspan-approval-reject-input {
    margin-top: 8px;
    display: none;
    gap: 6px;
    align-items: center;
  }
  .actspan-approval-reject-input.open {
    display: flex;
  }
  .actspan-approval-reject-input input {
    flex: 1;
    padding: 5px 8px;
    border: 1px solid var(--ec-border);
    border-radius: 6px;
    font-size: 12px;
    outline: none;
    background: rgba(255, 255, 255, 0.9);
    color: var(--ec-text);
    line-height: 1.4;
  }
  .actspan-approval-reject-input input:focus {
    border-color: var(--ec-primary);
    box-shadow: 0 0 0 2px rgba(0, 113, 227, 0.1);
  }
  .actspan-approval-card.settled {
    opacity: 0.7;
  }
  .actspan-approval-result {
    font-size: 12px;
    margin-top: 6px;
    color: var(--ec-text-muted);
  }
  .actspan-screenshot-img-wrap {
    position: relative;
  }
  .actspan-screenshot-img {
    width: 100%;
    max-height: 240px;
    object-fit: cover;
    border-radius: 10px;
    cursor: pointer;
    border: 1px solid rgba(15, 23, 42, 0.08);
    transition: transform 0.2s ease, filter 0.2s ease;
  }
  .actspan-screenshot-img:hover {
    transform: scale(1.01);
    filter: saturate(104%);
  }
  .actspan-screenshot-hint {
    position: absolute;
    right: 8px;
    bottom: 8px;
    border-radius: 999px;
    padding: 3px 8px;
    font-size: 11px;
    color: #fff;
    background: rgba(15, 23, 42, 0.62);
    pointer-events: none;
  }
  .actspan-screenshot-artifact {
    font-size: 12px;
    color: var(--ec-text-muted);
    border: 1px dashed rgba(15, 23, 42, 0.16);
    border-radius: 10px;
    padding: 8px 10px;
    background: rgba(255, 255, 255, 0.64);
    word-break: break-all;
  }

  .actspan-image-viewer {
    position: absolute;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 26px;
    background: rgba(9, 12, 18, 0.78);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.18s ease;
    z-index: 2147483647;
  }

  .actspan-image-viewer.open {
    opacity: 1;
    pointer-events: auto;
  }

  .actspan-image-viewer-content {
    position: relative;
    width: min(920px, 100%);
    max-height: calc(100vh - 52px);
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: center;
  }

  .actspan-image-viewer-stage {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 14px;
  }

  .actspan-image-viewer-img {
    flex: 1;
    width: 100%;
    max-height: calc(100vh - 120px);
    border-radius: 14px;
    border: 1px solid rgba(255, 255, 255, 0.16);
    box-shadow: 0 28px 62px rgba(0, 0, 0, 0.4);
    background: #fff;
    object-fit: contain;
  }

  .actspan-image-viewer-nav {
    flex-shrink: 0;
    width: 38px;
    height: 38px;
    border-radius: 50%;
    border: 1px solid rgba(255, 255, 255, 0.24);
    background: rgba(15, 23, 42, 0.66);
    color: #fff;
    font-size: 18px;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }

  .actspan-image-viewer-nav:disabled {
    opacity: 0.32;
    cursor: not-allowed;
  }

  .actspan-image-viewer-nav:not(:disabled):hover {
    background: rgba(15, 23, 42, 0.8);
  }

  .actspan-image-viewer-nav:focus-visible,
  .actspan-image-viewer-close:focus-visible {
    box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.22);
    outline: none;
  }

  .actspan-image-viewer-meta {
    border-radius: 999px;
    padding: 6px 12px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.9);
    background: rgba(15, 23, 42, 0.52);
    border: 1px solid rgba(255, 255, 255, 0.16);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .actspan-image-viewer-close {
    position: absolute;
    top: -8px;
    right: -8px;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    border: 1px solid rgba(255, 255, 255, 0.24);
    background: rgba(15, 23, 42, 0.68);
    color: #fff;
    font-size: 18px;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }

  .actspan-image-viewer-close:hover {
    background: rgba(15, 23, 42, 0.86);
  }

  /* 底部提示区 */
  .actspan-footer {
    padding: 10px 18px 12px;
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--ec-text-muted);
    font-size: 12px;
    background: transparent;
    border-top: 1px solid rgba(219, 227, 238, 0.4);
  }

  .actspan-footer-icon {
    font-size: 14px;
    color: var(--ec-primary-strong);
  }

  .actspan-footer-text {
    min-width: 0;
    flex: 1;
    white-space: nowrap;
    text-overflow: ellipsis;
    overflow: hidden;
  }

  .actspan-footer-time {
    margin-left: auto;
    font-size: 11px;
    color: var(--ec-text-muted);
    background: rgba(248, 250, 252, 0.8);
    border: none;
    border-radius: 999px;
    padding: 4px 8px;
    white-space: nowrap;
  }

  .actspan-footer-time:empty {
    display: none;
  }

  .actspan-searchbox.state-running .actspan-footer-time {
    background: rgba(22, 119, 255, 0.08);
    color: var(--ec-primary-strong);
  }

  .actspan-searchbox.state-running .actspan-footer-icon {
    animation: actspan-breathe 1.4s ease-in-out infinite;
  }

  .actspan-searchbox.state-done .actspan-footer-icon {
    color: var(--ec-success);
  }

  .actspan-searchbox.state-error .actspan-footer-icon {
    color: var(--ec-danger);
  }

  .actspan-searchbox.state-done .actspan-footer-time {
    background: rgba(18, 183, 106, 0.08);
    color: var(--ec-success);
  }

  .actspan-searchbox.state-error .actspan-footer-time {
    background: rgba(239, 68, 68, 0.08);
    color: var(--ec-danger);
  }

  /* 滚动条美化 */
  .actspan-result::-webkit-scrollbar {
    width: 4px;
  }

  .actspan-result::-webkit-scrollbar-track {
    background: transparent;
  }

  .actspan-result::-webkit-scrollbar-thumb {
    background: rgba(0, 113, 227, 0.26);
    border-radius: 2px;
  }

  @media (max-width: 720px) {
    .actspan-image-viewer {
      padding: 14px;
    }

    .actspan-image-viewer-stage {
      gap: 8px;
    }

    .actspan-image-viewer-nav {
      width: 34px;
      height: 34px;
      font-size: 16px;
    }
  }

  /* ===== 提问卡片（ask_user）===== */

  .actspan-ask-user-standalone {
    margin: 10px 18px;
    border-radius: 14px;
    background: var(--ec-bg-soft);
    border: 1.5px solid rgba(37, 99, 235, 0.22);
    box-shadow: 0 4px 20px rgba(20, 37, 58, 0.08);
    animation: actspan-ask-user-fadein 0.35s ease-out;
    overflow: hidden;
  }
  .actspan-ask-user-header-bar {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 11px 14px 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--ec-text);
  }
  .actspan-ask-user-header-bar img {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
  }
  .actspan-ask-user-standalone .actspan-ask-user-card {
    margin: 8px 14px 14px;
    padding: 0;
    background: none;
    border: none;
    box-shadow: none;
    border-radius: 0;
  }
  .actspan-ask-user-standalone.settled {
    opacity: 0.65;
    animation: none;
    border-color: var(--ec-border);
    background: var(--ec-bg-soft);
  }
  .actspan-ask-user-standalone.settled .actspan-ask-user-header-bar {
    color: var(--ec-text-muted);
  }
  @keyframes actspan-ask-user-fadein {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .actspan-ask-user-question {
    font-size: 13px;
    line-height: 1.5;
    color: var(--ec-text);
    margin-bottom: 10px;
    word-break: break-word;
  }
  .actspan-ask-user-options {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 8px;
  }
  .actspan-ask-user-option {
    padding: 6px 14px;
    border-radius: 8px;
    border: 1px solid rgba(37, 99, 235, 0.22);
    background: var(--ec-primary-soft);
    color: var(--ec-primary-strong);
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    transition: background 0.15s, border-color 0.15s, transform 0.1s;
    line-height: 1.4;
  }
  .actspan-ask-user-option:hover {
    background: rgba(37, 99, 235, 0.14);
    border-color: rgba(37, 99, 235, 0.38);
    transform: translateY(-1px);
  }
  .actspan-ask-user-option:active {
    transform: translateY(0);
  }
  .actspan-ask-user-option.selected {
    background: var(--ec-primary);
    color: #fff;
    border-color: var(--ec-primary);
  }
  .actspan-ask-user-option:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    pointer-events: none;
    transform: none;
  }
  .actspan-ask-user-input-row {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .actspan-ask-user-text {
    flex: 1;
    padding: 6px 10px;
    border: 1px solid var(--ec-border);
    border-radius: 8px;
    font-size: 13px;
    outline: none;
    background: rgba(255, 255, 255, 0.9);
    color: var(--ec-text);
    line-height: 1.4;
  }
  .actspan-ask-user-text:focus {
    border-color: var(--ec-primary);
    box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.18);
  }
  .actspan-ask-user-text:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .actspan-ask-user-submit {
    padding: 6px 14px;
    border-radius: 8px;
    border: none;
    background: var(--ec-primary);
    color: #fff;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    transition: opacity 0.15s;
    line-height: 1.4;
    flex-shrink: 0;
  }
  .actspan-ask-user-submit:hover { opacity: 0.85; }
  .actspan-ask-user-submit:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    pointer-events: none;
  }
  .actspan-ask-user-card.settled {
    opacity: 0.7;
  }
  .actspan-ask-user-result {
    font-size: 12px;
    margin-top: 6px;
    color: var(--ec-text-muted);
  }

  /* ===== Workflow 快捷操作卡片 ===== */

  .actspan-workflow-hints {
    padding: 10px 14px 8px;
  }

  .actspan-workflow-hints-title {
    font-size: 10px;
    color: #b0b0b4;
    margin-bottom: 6px;
    font-weight: 500;
    letter-spacing: 0.03em;
  }

  .actspan-workflow-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .actspan-workflow-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 5px 10px;
    border-radius: 999px;
    background: rgba(241, 244, 248, 0.8);
    border: none;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
    font-size: 11px;
    line-height: 1.4;
    color: #667085;
  }

  .actspan-workflow-chip:hover {
    background: rgba(37, 99, 235, 0.08);
    color: var(--ec-primary-strong);
  }

  .actspan-workflow-chip:active {
    background: rgba(37, 99, 235, 0.14);
  }

  .actspan-workflow-chip-label {
    font-weight: 500;
  }

  .actspan-workflow-chip-desc {
    display: none;
  }

  @media (prefers-reduced-motion: reduce) {
    * {
      animation: none !important;
      transition: none !important;
    }
  }

  /* ===== 后台任务角标 ===== */

  .actspan-bg-task-badge {
    position: absolute;
    top: 2px;
    left: 22px;
    min-width: 16px;
    height: 16px;
    border-radius: 999px;
    background: var(--ec-primary-strong);
    color: #fff;
    font-size: 10px;
    font-weight: 700;
    line-height: 16px;
    text-align: center;
    padding: 0 4px;
    display: none;
    z-index: 2;
    pointer-events: none;
  }

  .actspan-bg-task-badge.visible {
    display: block;
  }


  /* ===== 后台任务面板 ===== */

  .actspan-bg-tasks-panel {
    display: none;
    padding: 6px 14px 8px;
  }

  .actspan-bg-tasks-panel.visible {
    display: block;
  }

  .actspan-bg-tasks-header {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--ec-text-muted);
    cursor: pointer;
    padding: 4px 6px;
    border-radius: 8px;
    transition: background 0.15s;
    user-select: none;
  }

  .actspan-bg-tasks-header:hover {
    background: rgba(0, 113, 227, 0.06);
  }

  .actspan-bg-tasks-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 18px;
    min-width: 18px;
    padding: 0 6px;
    border-radius: 999px;
    background: var(--ec-primary-soft);
    color: var(--ec-primary-strong);
    font-size: 11px;
    font-weight: 600;
  }

  .actspan-bg-tasks-toggle {
    margin-left: auto;
    font-size: 10px;
    transition: transform 0.2s ease;
  }

  .actspan-bg-tasks-panel.open .actspan-bg-tasks-toggle {
    transform: rotate(90deg);
  }

  .actspan-bg-tasks-list {
    display: none;
    gap: 4px;
    margin-top: 6px;
  }

  .actspan-bg-tasks-panel.open .actspan-bg-tasks-list {
    display: grid;
  }

  .actspan-bg-task-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.7);
    transition: background 0.15s;
  }

  .actspan-bg-task-item:hover {
    background: rgba(255, 255, 255, 0.9);
  }

  .actspan-bg-task-icon {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
  }

  .actspan-bg-task-icon img {
    width: 100%;
    height: 100%;
  }

  .actspan-bg-task-info {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }

  .actspan-bg-task-name {
    font-size: 12px;
    font-weight: 500;
    color: var(--ec-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .actspan-bg-task-meta {
    font-size: 11px;
    color: var(--ec-text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .actspan-bg-task-close {
    width: 22px;
    height: 22px;
    border-radius: 7px;
    border: none;
    background: transparent;
    color: var(--ec-text-muted);
    font-size: 14px;
    line-height: 22px;
    text-align: center;
    cursor: pointer;
    opacity: 0;
    flex-shrink: 0;
    transition: opacity 0.15s, background 0.15s, color 0.15s;
    padding: 0;
  }

  .actspan-bg-task-item:hover .actspan-bg-task-close {
    opacity: 1;
  }

  .actspan-bg-task-close:hover {
    background: var(--ec-danger-soft);
    color: var(--ec-danger);
  }

  /* ===== 工作流录制 ===== */

  /* 录制按钮容器（hover 时出现在悬浮球上方） */
  .actspan-record-wrap {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 50%;
    transform: translate(-50%, 4px);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s ease, transform 0.2s ease;
    z-index: 2;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .actspan-trigger.side-right:not(.announce):not(.auditing) .actspan-record-wrap {
    left: calc(50% + ${TUCK_OFFSET}px);
    transition: opacity 0.2s ease, transform 0.2s ease, left 0.36s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .actspan-trigger.side-right.hovering:not(.announce):not(.auditing) .actspan-record-wrap {
    left: calc(50% + ${TUCK_OFFSET - 56}px);
  }
  .actspan-trigger.side-left:not(.announce):not(.auditing) .actspan-record-wrap {
    left: calc(50% - ${TUCK_OFFSET}px);
    transition: opacity 0.2s ease, transform 0.2s ease, left 0.36s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .actspan-trigger.side-left.hovering:not(.announce):not(.auditing) .actspan-record-wrap {
    left: calc(50% - ${TUCK_OFFSET - 56}px);
  }
  .actspan-trigger.hovering .actspan-record-wrap,
  .actspan-trigger:focus-within .actspan-record-wrap {
    opacity: 1;
    pointer-events: auto;
    transform: translate(-50%, 0);
  }
  .actspan-trigger.dragging .actspan-record-wrap,
  .actspan-trigger.recording .actspan-record-wrap,
  .actspan-trigger.auditing .actspan-record-wrap,
  .actspan-trigger.active .actspan-record-wrap {
    opacity: 0;
    pointer-events: none;
  }

  /* 录制按钮 */
  .actspan-record-btn {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    border: 1px solid var(--ec-border);
    background: linear-gradient(180deg, rgba(248, 251, 255, 0.96) 0%, var(--ec-surface) 100%);
    box-shadow: 0 10px 22px rgba(15, 23, 42, 0.14);
    color: var(--ec-danger);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: transform 0.2s ease, box-shadow 0.2s ease;
    position: relative;
  }
  .actspan-record-btn svg {
    width: 14px;
    height: 14px;
  }
  .actspan-record-btn:hover {
    transform: translateY(-4px);
    box-shadow: 0 12px 24px rgba(215, 0, 21, 0.2);
    color: #d70015;
  }

  /* 录制按钮 tooltip */
  .actspan-record-tooltip {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 50%;
    transform: translateX(-50%);
    background: #fff;
    color: #333;
    font-size: 12px;
    font-weight: 500;
    line-height: 1;
    padding: 6px 10px;
    border-radius: 6px;
    white-space: nowrap;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s ease;
  }
  .actspan-record-tooltip::after {
    content: '';
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    border: 5px solid transparent;
    border-top-color: #fff;
  }
  .actspan-record-btn:hover + .actspan-record-tooltip {
    opacity: 1;
  }

  /* 录制中状态 - footer 录制状态栏 */
  .actspan-recorder-bar {
    display: none;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    background: rgba(215, 0, 21, 0.04);
    border-top: 1px solid rgba(215, 0, 21, 0.12);
    font-size: 12px;
    color: var(--ec-text-secondary, var(--ec-text-muted));
  }
  .actspan-recorder-bar.visible { display: flex; }
  .actspan-recorder-bar-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--ec-danger);
    animation: actspan-breathe 1.4s ease-in-out infinite;
    flex-shrink: 0;
  }
  .actspan-recorder-bar-info { flex: 1; min-width: 0; }
  .actspan-recorder-bar-stop {
    padding: 4px 12px;
    border: 1px solid rgba(215, 0, 21, 0.2);
    border-radius: 6px;
    background: transparent;
    color: var(--ec-danger);
    font-size: 12px;
    cursor: pointer;
    transition: background 0.15s;
  }
  .actspan-recorder-bar-stop:hover {
    background: rgba(215, 0, 21, 0.08);
  }

  /* 审计中状态 */
  .actspan-recorder-bar.auditing {
    background: var(--ec-primary-soft);
    border-color: rgba(22, 119, 255, 0.15);
  }
  .actspan-recorder-bar-dot.auditing {
    background: var(--ec-primary);
    animation: actspan-rec-pulse 1.2s ease-in-out infinite;
  }

  /* 胶囊录制状态 */
  .actspan-trigger.recording .actspan-pill {
    border-color: rgba(215, 0, 21, 0.3);
  }
  .actspan-trigger.recording .actspan-pill::after {
    content: '';
    position: absolute;
    top: 4px;
    right: 4px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--ec-danger);
    animation: actspan-breathe 1.4s ease-in-out infinite;
    opacity: 1;
    z-index: 2;
  }

  /* 胶囊审计状态（AI 生成工作流中） */
  .actspan-trigger.auditing .actspan-pill {
    border-color: rgba(0, 113, 227, 0.3);
  }
  .actspan-trigger.auditing .actspan-pill::after {
    content: '';
    position: absolute;
    top: 4px;
    right: 4px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--ec-primary-strong);
    animation: actspan-breathe 1.4s ease-in-out infinite;
    opacity: 1;
    z-index: 2;
  }

  /* ===== 录制确认 Modal ===== */
  .actspan-record-modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2147483647;
    pointer-events: auto;
    backdrop-filter: blur(2px);
  }

  .actspan-record-modal {
    background: var(--ec-surface-strong);
    border: 1px solid var(--ec-border);
    border-radius: 16px;
    padding: 28px 32px 24px;
    width: 420px;
    max-width: 90vw;
    box-shadow: var(--ec-shadow);
  }

  .actspan-record-modal-title {
    font-size: 18px;
    font-weight: 700;
    color: var(--ec-text);
    margin-bottom: 20px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .actspan-record-modal-title::before {
    content: '';
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--ec-danger);
    animation: actspan-rec-pulse 1.5s ease-in-out infinite;
  }

  .actspan-record-modal-hints {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-bottom: 24px;
  }

  .actspan-record-modal-hint {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    font-size: 14px;
    line-height: 1.6;
    color: var(--ec-text-muted);
  }

  .actspan-record-modal-hint-icon {
    flex-shrink: 0;
    font-size: 16px;
    line-height: 1.6;
  }

  .actspan-record-modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 12px;
  }

  .actspan-record-modal-btn {
    padding: 8px 22px;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease;
    border: none;
    outline: none;
  }

  .actspan-record-modal-btn.cancel {
    background: transparent;
    border: 1px solid var(--ec-border);
    color: var(--ec-text-muted);
  }
  .actspan-record-modal-btn.cancel:hover {
    background: var(--ec-surface-soft);
    border-color: var(--ec-border-soft);
  }

  .actspan-record-modal-btn.confirm {
    background: var(--ec-danger);
    color: #fff;
  }
  .actspan-record-modal-btn.confirm:hover {
    background: #c0241c;
  }

  @keyframes actspan-rec-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

`;
