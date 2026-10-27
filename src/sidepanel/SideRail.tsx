/**
 * 右侧竖排导航栏：聊天 / 图片 / 视频 / 翻译
 */
import React from 'react';
import {
  MessageOutlined,
  PictureOutlined,
  VideoCameraOutlined,
  TranslationOutlined,
} from '@ant-design/icons';

export type SideRailKey = 'chat' | 'image' | 'video' | 'translate';

interface RailItem {
  key: SideRailKey;
  label: string;
  icon: React.ReactNode;
  title: string;
}

const RAIL_ITEMS: RailItem[] = [
  { key: 'chat', label: '聊天', icon: <MessageOutlined />, title: '与 AI 对话' },
  { key: 'image', label: '图片', icon: <PictureOutlined />, title: '图片生成' },
  { key: 'video', label: '视频', icon: <VideoCameraOutlined />, title: '视频生成' },
  { key: 'translate', label: '翻译', icon: <TranslationOutlined />, title: '文本翻译' },
];

interface SideRailProps {
  active: SideRailKey;
  onChange: (key: SideRailKey) => void;
}

export const SideRail: React.FC<SideRailProps> = ({ active, onChange }) => (
  <nav className="sidepanel-rail" aria-label="功能导航">
    {RAIL_ITEMS.map((item) => (
      <button
        key={item.key}
        type="button"
        className={`sidepanel-rail-item${active === item.key ? ' active' : ''}`}
        aria-current={active === item.key ? 'page' : undefined}
        title={item.title}
        onClick={() => onChange(item.key)}
      >
        <span className="sidepanel-rail-icon" aria-hidden="true">{item.icon}</span>
        <span className="sidepanel-rail-label">{item.label}</span>
      </button>
    ))}
  </nav>
);
