/**
 * ActspanContext 定义（纯 Context 对象，无组件）
 */

import { createContext, type Dispatch } from 'react';
import type { ActspanState, ActspanAction } from './types';

export interface ActspanContextValue {
  state: ActspanState;
  dispatch: Dispatch<ActspanAction>;
}

export const ActspanContext = createContext<ActspanContextValue | null>(null);
