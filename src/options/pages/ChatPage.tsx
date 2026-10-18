/**
 * 对话页面
 * 作为 Options 侧栏菜单的独立页面，承载 AI 对话功能
 * 与 content script 悬浮球完全同步
 */

import { FloatingChat } from '../components/FloatingChat';

export function ChatPage() {
  return <FloatingChat mode="page" />;
}
