/**
 * Popup App — 状态面板
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AI_CONFIG, VERSION } from './config';
import { LEGACY_STORAGE_KEY_AI_SETTINGS, STORAGE_KEY_AI_SETTINGS, isAISettingsConfigured } from './ai/llm-client';
import { readMigratedStorage } from './lib/legacy-storage';
import { registryService } from './functions/skill-registry';

/** LLM 配置状态 */
interface LLMStatus {
  configured: boolean;
  endpoint: string;
  model: string;
}

/** 从 chrome.storage.local 读取 LLM 配置状态 */
const getLLMStatus = async (): Promise<LLMStatus> => {
  let settings: Record<string, string> | undefined;
  try {
    settings = await readMigratedStorage<Record<string, string>>(
      chrome.storage.local,
      STORAGE_KEY_AI_SETTINGS,
      LEGACY_STORAGE_KEY_AI_SETTINGS,
    );
  } catch {
    settings = undefined;
  }
  const endpoint = settings?.endpoint || '';
  const model = settings?.model || '';
  const apiKey = settings?.apiKey || '';
  return { configured: isAISettingsConfigured({ endpoint, apiKey, model }), endpoint, model };
};

/** Read the current canonical registry snapshot, including its object-shaped skill list. */
const getWorkflowCount = async (): Promise<number> =>
  (await registryService.listAll()).skills.reduce((count, skill) => count + skill.workflows.length, 0);

/** 从 endpoint 提取更短的展示文本 */
const formatEndpointLabel = (endpoint?: string): string => {
  if (!endpoint) return '尚未设置 API 地址';
  try {
    const url = new URL(endpoint);
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return endpoint;
  }
};

function App() {
  const [llmStatus, setLLMStatus] = useState<LLMStatus | null>(null);
  const [workflowCount, setWorkflowCount] = useState<number | null>(null);

  const loadOverview = useCallback(async () => {
    const [nextLLMStatus, nextWorkflowCount] = await Promise.all([
      getLLMStatus(),
      getWorkflowCount(),
    ]);
    setLLMStatus(nextLLMStatus);
    setWorkflowCount(nextWorkflowCount);
  }, []);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    const handleStorageChange = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
      if (areaName !== 'local') return;
      if (changes[STORAGE_KEY_AI_SETTINGS] || changes.actspan_skills) {
        void loadOverview();
      }
    };

    chrome.storage.onChanged.addListener(handleStorageChange);
    return () => chrome.storage.onChanged.removeListener(handleStorageChange);
  }, [loadOverview]);

  /** 打开 Options 页面 */
  const openOptions = (hash?: string) => {
    const optionsUrl = chrome.runtime.getURL(`options.html${hash ? `#/${hash}` : ''}`);
    void chrome.tabs.create({ url: optionsUrl });
    window.close();
  };

  /** 打开 Side Panel 对话 */
  const openSidePanel = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await (chrome.sidePanel as any).open({ tabId: tab.id });
    }
    window.close();
  };

  const llmReady = !!llmStatus?.configured;
  const endpointLabel = useMemo(() => formatEndpointLabel(llmStatus?.endpoint), [llmStatus?.endpoint]);
  const modelLabel = llmStatus?.model || AI_CONFIG.DEFAULT_MODEL || '未配置';
  const workflowValue = workflowCount === null ? '...' : String(workflowCount);

  return (
    <div className="popup-shell">

      <div className="popup-card">
        <div className="popup-topbar">
          <div className="popup-topbar-badge">
            <span className="popup-topbar-dot" />
            Actspan Console
          </div>
          <div className="popup-version">v{VERSION}</div>
        </div>

        <div className="popup-brand">
          <img src="actspan-logo.svg" alt="Actspan" className="popup-logo" />
          <div className="popup-brand-copy">
            <h1 className="popup-title">Actspan</h1>
            <p className="popup-subtitle">浏览器行动工作区</p>
          </div>
        </div>

        <div className="popup-summary">
          <div>
            <div className="popup-summary-eyebrow">Quick Overview</div>
            <div className="popup-summary-title">核心状态</div>
            <div className="popup-summary-text">
              {llmStatus === null ? '正在同步配置…' : llmReady ? '模型与工作流已就绪' : '请先完成模型配置'}
            </div>
          </div>
          <div className={`popup-hero-status${llmReady ? ' is-ready' : ' is-warning'}`}>
            {llmStatus === null ? '读取中' : llmReady ? '已就绪' : '待配置'}
          </div>
        </div>

        <div className="popup-metrics">
          <div className="popup-metric popup-metric-blue">
            <div className="popup-metric-label">模型连接</div>
            <div className="popup-metric-value">{llmStatus === null ? '...' : llmReady ? '正常' : '未配置'}</div>
            <div className="popup-metric-hint">{endpointLabel}</div>
          </div>
          <div className="popup-metric popup-metric-green">
            <div className="popup-metric-label">默认模型</div>
            <div className="popup-metric-value">{llmStatus === null ? '...' : modelLabel}</div>
            <div className="popup-metric-hint">当前默认模型</div>
          </div>
          <div className="popup-metric popup-metric-orange">
            <div className="popup-metric-label">工作流数量</div>
            <div className="popup-metric-value">{workflowValue}</div>
            <div className="popup-metric-hint">本地已加载配置</div>
          </div>
        </div>

        <div className="popup-section">
          <div className="popup-section-header">
            <div className="popup-section-title">状态摘要</div>
          </div>

          <div className="popup-status-list">
            <div className="popup-status-item">
              <div className="popup-status-copy">
                <div className="popup-status-name">LLM 接口</div>
                <div className="popup-status-text">
                  {llmStatus === null ? '正在读取本地配置…' : llmReady ? endpointLabel : '需要先配置 Endpoint 和 API Key'}
                </div>
              </div>
              <div className={`popup-pill${llmReady ? ' is-success' : ' is-danger'}`}>
                {llmStatus === null ? '读取中' : llmReady ? '已配置' : '未配置'}
              </div>
            </div>

          </div>
        </div>

        <div className="popup-actions">
          <button type="button" className="popup-btn popup-btn-primary" onClick={openSidePanel}>
            打开对话
          </button>
          <button type="button" className="popup-btn popup-btn-secondary" onClick={() => openOptions()}>
            打开控制台
          </button>
        </div>

        <div className="popup-links">
          <button type="button" className="popup-link-btn" onClick={() => openOptions('settings')}>
            模型设置
          </button>
          <button type="button" className="popup-link-btn" onClick={() => openOptions('workflows')}>
            技能与工作流
          </button>
        </div>
      </div>
    </div>
  );
}

export default App;
