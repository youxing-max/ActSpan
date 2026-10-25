/**
 * 位置持久化 Hook — 从 chrome.storage 加载/保存胶囊球位置
 */
import { useCallback, useEffect, useState } from 'react';
import { STORAGE_KEY, LEGACY_STORAGE_KEY, PILL_HEIGHT, PILL_WIDTH, EDGE_MARGIN } from '../constants';
import type { Side, SavedPosition } from '../constants';
import { readMigratedStorage } from '../../../lib/legacy-storage';
import { useActspan } from '../context/useActspan';

const storageArea = {
  get: (keys: string | string[]) => new Promise<Record<string, unknown>>((resolve) => chrome.storage.local.get<Record<string, unknown>>(keys, resolve)),
  set: (items: Record<string, unknown>) => new Promise<void>((resolve) => chrome.storage.local.set(items, resolve)),
};

/** 获取可视区域宽度 */
const getViewportWidth = (): number => (typeof document === 'undefined' ? 0 : document.documentElement.clientWidth);

const clampY = (y: number): number => {
  return Math.max(EDGE_MARGIN, Math.min(y, window.innerHeight - PILL_HEIGHT - EDGE_MARGIN));
};

/**
 * 加载保存的位置，初始化到 state
 * 返回定位计算工具函数
 */
export const usePosition = () => {
  const { state, dispatch } = useActspan();
  // 初始渲染时视口宽度可能是 1（标签页还没布局完），算出的 x 会把球丢到屏幕外；
  // 用 ResizeObserver 跟住文档宽度，宽度正常后自然重算一次。
  const [viewportWidth, setViewportWidth] = useState(getViewportWidth);

  useEffect(() => {
    const ro = new ResizeObserver(() => setViewportWidth(getViewportWidth()));
    ro.observe(document.documentElement);
    return () => ro.disconnect();
  }, []);

  // 初始化加载
  useEffect(() => {
    void readMigratedStorage<SavedPosition>(storageArea, STORAGE_KEY, LEGACY_STORAGE_KEY).then((saved) => {
      if (saved) {
        dispatch({
          type: 'SET_POSITION',
          payload: { side: saved.side, currentY: clampY(saved.y) },
        });
      } else {
        dispatch({
          type: 'SET_Y',
          payload: window.innerHeight - PILL_HEIGHT - 100,
        });
      }
    }).catch(() => undefined);
  }, [dispatch]);

  // resize 时重新 clamp
  useEffect(() => {
    const onResize = () => {
      dispatch({ type: 'SET_Y', payload: clampY(state.currentY) });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [state.currentY, dispatch]);

  const savePosition = (pos: SavedPosition) => {
    try {
      chrome.storage.local.set({ [STORAGE_KEY]: pos });
    } catch { /* 忽略 */ }
    dispatch({ type: 'SET_POSITION', payload: { side: pos.side, currentY: pos.y } });
  };

  const getTriggerX = useCallback(
    (s: Side): number => {
      if (s === 'left') return -(PILL_WIDTH + 10 - PILL_WIDTH) / 2;
      return viewportWidth - PILL_WIDTH - (10 / 2);
    },
    [viewportWidth],
  );

  return {
    side: state.side,
    currentY: state.currentY,
    savePosition,
    clampY,
    getTriggerX,
  };
};
