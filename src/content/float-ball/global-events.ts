/**
 * 宿主文档事件桥
 *
 * 页面脚本可以任意 dispatchEvent(CustomEvent)，因此 ESC/点击外部不能通过
 * window 自定义事件传递。入口文件与 React 组件在同一个隔离世界模块图中，
 * 直接通过模块内注册的回调通信，页面脚本无法触达。
 */

type UiEventHandler = () => void;

let escapeHandler: UiEventHandler | null = null;
let clickOutsideHandler: UiEventHandler | null = null;

export const registerGlobalUiEventHandlers = (handlers: {
  escape: UiEventHandler;
  clickOutside: UiEventHandler;
}): (() => void) => {
  escapeHandler = handlers.escape;
  clickOutsideHandler = handlers.clickOutside;
  return () => {
    if (escapeHandler === handlers.escape) escapeHandler = null;
    if (clickOutsideHandler === handlers.clickOutside) clickOutsideHandler = null;
  };
};

export const emitGlobalEscape = (): void => {
  escapeHandler?.();
};

export const emitGlobalClickOutside = (): void => {
  clickOutsideHandler?.();
};
