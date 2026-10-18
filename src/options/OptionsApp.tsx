/** Actspan Console workspace shell. */

import { ConfigProvider, App } from 'antd';
import { actspanTheme } from './theme';
import { routes, useHashRoute } from './routes';
import { LLMSettingsPage } from './pages/LLMSettingsPage';
import { WorkflowsPage } from './pages/WorkflowsPage';
import { BlocklistPage } from './pages/BlocklistPage';
import { HistoryPage } from './pages/HistoryPage';
import { WebhookPage } from './pages/WebhookPage';

/** 路由 key → 页面组件映射 */
const PAGE_MAP: Record<string, React.ComponentType> = {
  settings: LLMSettingsPage,
  workflows: WorkflowsPage,
  blocklist: BlocklistPage,
  webhook: WebhookPage,
  history: HistoryPage,
};

function OptionsLayout() {
  const [activeKey, setActiveKey] = useHashRoute();
  const PageComponent = PAGE_MAP[activeKey] || LLMSettingsPage;
  const activeRoute = routes.find((route) => route.key === activeKey) || routes[0];

  return (
    <div className="options-page">
      <div className="options-panel">
        <header className="options-commandbar">
          <div className="options-command-brand">
            <img src={chrome.runtime.getURL('actspan-logo.svg')} alt="" className="options-command-logo" />
            <span>Actspan <strong>Console</strong></span>
          </div>
          <span className="options-command-context">Browser workspace <span aria-hidden="true">/</span> {activeRoute.label}</span>
          <span className="options-command-state"><span aria-hidden="true" />本地工作区</span>
        </header>
        <nav className="options-navigation" aria-label="控制台导航">
          <span className="options-navigation-label">WORKSPACE</span>
          {routes.map((route) => (
            <button
              key={route.key}
              type="button"
              className={`options-navigation-item${activeKey === route.key ? ' active' : ''}`}
              aria-current={activeKey === route.key ? 'page' : undefined}
              onClick={() => setActiveKey(route.key)}
            >
              <span aria-hidden="true">{route.icon}</span>{route.label}
            </button>
          ))}
        </nav>
        <div className="options-workspace">
          <aside className="options-workspace-context" aria-label="工作区位置">
            <div className="options-workspace-overline">ACTSPAN / WORKSPACE</div>
            <div className="options-workspace-index">{String(routes.indexOf(activeRoute) + 1).padStart(2, '0')} <span>/ {String(routes.length).padStart(2, '0')}</span></div>
            <h1>{activeRoute.label}</h1>
            <p>{activeRoute.description}</p>
            <div className="options-workspace-context-footer">实时浏览器能力 · 本地控制台</div>
          </aside>
          <main className="options-body" id="workspace-content">
            <div className="options-body-topbar">
              <span>ACTSPAN CONSOLE <span aria-hidden="true">/</span> {activeRoute.label}</span>
              <span>工作区</span>
            </div>
            <div className="options-body-content"><PageComponent /></div>
          </main>
        </div>
      </div>
    </div>
  );
}

export function OptionsApp() {
  return (
    <ConfigProvider theme={actspanTheme}>
      <App>
        <OptionsLayout />
      </App>
    </ConfigProvider>
  );
}
