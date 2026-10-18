/**
 * ActspanProvider — 悬浮球全局状态 Provider 组件
 */

import React, { useReducer } from 'react';
import { initialActspanState } from './types';
import { actspanReducer } from './reducer';
import { ActspanContext } from './context';

export const ActspanProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, dispatch] = useReducer(actspanReducer, initialActspanState);
  return (
    <ActspanContext.Provider value={{ state, dispatch }}>
      {children}
    </ActspanContext.Provider>
  );
};
