/**
 * useActspan — 访问悬浮球全局状态的 Hook
 */

import { useContext } from 'react';
import { ActspanContext } from './context';

export const useActspan = () => {
  const ctx = useContext(ActspanContext);
  if (!ctx) throw new Error('useActspan 必须在 ActspanProvider 内使用');
  return ctx;
};
