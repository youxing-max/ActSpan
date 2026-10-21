/**
 * 全局事件 Hook
 * 监听从宿主文档桥接过来的 CustomEvent（ESC、点击外部）
 * 以及提供稳定的每秒计时器
 */

import { useEffect, useRef, useState } from 'react';
import Channel from '../../../lib/channel';
import { useActspan } from '../context/useActspan';
import { registerGlobalUiEventHandlers } from '../global-events';

/**
 * 监听宿主文档通过 CustomEvent 桥接的全局事件（ESC、点击外部）
 */
export const useGlobalEvents = () => {
  const { state, dispatch } = useActspan();
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    // ESC 键
    const handleEscape = () => {
      const s = stateRef.current;
      if (!s.isOpen) return;

      // 有截图预览 → 关闭预览
      if (s.screenshotPreviewList.length > 0) {
        dispatch({ type: 'SET_SCREENSHOT_PREVIEW', payload: { list: [], index: 0 } });
        return;
      }

      // 关闭菜单可见 → 关闭菜单
      if (s.closeMenuVisible) {
        dispatch({ type: 'SET_CLOSE_MENU', payload: false });
        return;
      }

      // 有会话 → 清除会话（新对话）
      if (s.currentTask) {
        Channel.send('__session_clear', { sessionId: s.currentTask.id });
        dispatch({ type: 'SET_TASK', payload: null });
        return;
      }

      // 无会话 → 关闭面板
      dispatch({ type: 'TOGGLE_OPEN', payload: false });
    };

    // 点击外部关闭
    const handleClickOutside = () => {
      const s = stateRef.current;
      if (s.closeMenuVisible) {
        dispatch({ type: 'SET_CLOSE_MENU', payload: false });
      }
      if (s.isOpen) {
        dispatch({ type: 'TOGGLE_OPEN', payload: false });
      }
    };

    // 通过模块内回调接收入口文件转发的可信宿主事件；不使用 window 自定义事件，
    // 避免页面脚本 dispatchEvent 合成 ESC 中止会话。
    return registerGlobalUiEventHandlers({
      escape: handleEscape,
      clickOutside: handleClickOutside,
    });
  }, [dispatch]);
};

/**
 * 稳定的每秒计时器
 * 返回一个每秒递增的 tick 值，用于触发时间显示更新
 */
export const useSecondTick = (enabled: boolean): number => {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return tick;
};
