/**
 * 悬浮球 React 版入口
 * 创建 Shadow DOM + 注入样式 + ReactDOM.createRoot 挂载
 */

import ReactDOM from 'react-dom/client';
import { getStyles } from './float-ball/styles';
import { ActspanRoot } from './float-ball/ActspanRoot';
import { DISABLED_DOMAINS_KEY, LEGACY_DISABLED_DOMAINS_KEY } from './float-ball/constants';
import { readMigratedStorage } from '../lib/legacy-storage';
import { emitGlobalClickOutside, emitGlobalEscape } from './float-ball/global-events';

const storageArea = {
  get: (keys: string | string[]) => new Promise<Record<string, unknown>>((resolve) => chrome.storage.local.get<Record<string, unknown>>(keys, resolve)),
  set: (items: Record<string, unknown>) => new Promise<void>((resolve) => chrome.storage.local.set(items, resolve)),
};

/**
 * 创建悬浮球 Shadow DOM 宿主与 React 挂载容器。
 * 使用 closed 模式：页面脚本无法通过 host.shadowRoot 读取或合成点击审批/提问控件，
 * 内容脚本通过返回的 shadow 引用继续挂载 React。
 */
export const createFloatBallShadowHost = () => {
  const host = document.createElement('div');
  host.id = 'actspan-root';
  host.style.cssText = 'position: fixed; top: 0; left: 0; width: 0; height: 0; overflow: visible; z-index: 2147483647; pointer-events: none;';
  const shadow = host.attachShadow({ mode: 'closed' });

  // 注入样式
  const styleEl = document.createElement('style');
  styleEl.textContent = getStyles();
  shadow.appendChild(styleEl);

  // React 挂载容器
  const reactRoot = document.createElement('div');
  reactRoot.id = 'actspan-react-root';
  shadow.appendChild(reactRoot);

  return { host, shadow, reactRoot };
};

export const initFloatBallReact = async () => {
  if (!document.body) return;
  if (window.location.protocol === 'chrome:' || window.location.protocol === 'chrome-extension:') return;

  // 域名黑名单检查
  try {
    const disabledData = await readMigratedStorage<{ domains?: (string | { hostname: string })[] }>(
      storageArea,
      DISABLED_DOMAINS_KEY,
      LEGACY_DISABLED_DOMAINS_KEY,
    );
    if (disabledData && Array.isArray(disabledData.domains)) {
      const host = window.location.hostname;
      const isDisabled = disabledData.domains.some((d) =>
        typeof d === 'string' ? d === host : d.hostname === host,
      );
      if (isDisabled) return;
    }
  } catch {
    // 读取失败时不阻塞初始化
  }

  // 创建 Shadow DOM 宿主
  const { host, reactRoot } = createFloatBallShadowHost();

  // 插入页面
  document.body.appendChild(host);

  // DOM 保护：MutationObserver 兜底
  let userDismissed = false;
  const bodyObserver = new MutationObserver(() => {
    if (!host.isConnected && !userDismissed) {
      document.body.appendChild(host);
    }
  });
  bodyObserver.observe(document.body, { childList: true });

  // 视口补偿：修复 position: fixed 在祖先有 transform 时失效
  let _compensateRAF = 0;
  const compensateHostPosition = () => {
    const rect = host.getBoundingClientRect();
    const offsetX = Math.round(rect.left);
    const offsetY = Math.round(rect.top);
    if (offsetX !== 0 || offsetY !== 0) {
      const curLeft = parseFloat(host.style.left) || 0;
      const curTop = parseFloat(host.style.top) || 0;
      host.style.left = `${curLeft - offsetX}px`;
      host.style.top = `${curTop - offsetY}px`;
    }
  };
  window.addEventListener('scroll', () => {
    cancelAnimationFrame(_compensateRAF);
    _compensateRAF = requestAnimationFrame(compensateHostPosition);
  }, { passive: true });
  requestAnimationFrame(compensateHostPosition);

  // React 挂载
  const root = ReactDOM.createRoot(reactRoot);
  root.render(<ActspanRoot />);

  // 截图时隐藏/恢复悬浮球（React 版补充，旧版 float-ball.ts 中有对应逻辑）
  import('../lib/channel').then(({ default: Channel }) => {
    Channel.on('__screenshot_hide', (_data: unknown, _sender: unknown, sendResponse?: (resp: unknown) => void) => {
      host.style.display = 'none';
      sendResponse?.({ ok: true });
      return true;
    });
    Channel.on('__screenshot_show', () => {
      host.style.display = '';
    });
  });

  // ---- 宿主文档上的全局事件监听 ----
  // 只接受用户真实输入（isTrusted），页面脚本合成的 keydown/mousedown 不得中止会话。

  // ESC 键（宿主文档）
  document.addEventListener('keydown', (e) => {
    if (e.isTrusted && e.key === 'Escape') {
      emitGlobalEscape();
    }
  });

  // 点击外部关闭（宿主文档 mousedown）
  document.addEventListener('mousedown', (e) => {
    if (!e.isTrusted) return;
    const path = e.composedPath();
    if (!path.includes(host)) {
      emitGlobalClickOutside();
    }
  });
};
