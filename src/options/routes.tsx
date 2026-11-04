/**
 * 路由 & 菜单配置
 * 新增页面只需在 routes 数组追加一项 + 创建对应 Page 组件
 */

import { useCallback, useEffect, useState } from 'react';
import {
  SettingOutlined,
  ThunderboltOutlined,
  HistoryOutlined,
  ApiOutlined,
  CloudOutlined,
} from '@ant-design/icons';

export interface RouteItem {
  key: string;
  label: string;
  icon: React.ReactNode;
}

export const routes: RouteItem[] = [
  {
    key: 'settings',
    label: '模型与连接',
    icon: <SettingOutlined />,
  },
  {
    key: 'workflows',
    label: '技能与工作流',
    icon: <ThunderboltOutlined />,
  },
  {
    key: 'webhook',
    label: 'Webhook',
    icon: <ApiOutlined />,
  },
  {
    key: 'cloud',
    label: '云端连接器',
    icon: <CloudOutlined />,
  },
  {
    key: 'history',
    label: '运行记录',
    icon: <HistoryOutlined />,
  },
];

const DEFAULT_KEY = 'settings';

/** 解析 hash 值为路由 key */
const parseHash = (): string => {
  const hash = window.location.hash.replace(/^#\/?/, '').split('?')[0];
  const matched = routes.find((r) => r.key === hash);
  return matched ? matched.key : DEFAULT_KEY;
};

/** 自定义 hash 路由 hook */
export const useHashRoute = (): [string, (key: string) => void] => {
  const [activeKey, setActiveKeyState] = useState(parseHash);

  useEffect(() => {
    const onHashChange = () => {
      setActiveKeyState(parseHash());
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const setActiveKey = useCallback((key: string) => {
    window.location.hash = '#/' + key;
  }, []);

  return [activeKey, setActiveKey];
};
