/**
 * 侧边栏「翻译」面板
 *
 * 与对话视图并列的独立入口：用户选供应商 → 填文本 → 翻译。
 * 供应商凭据在设置页（options#/translate）里自行配置，这里只负责调用。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SwapOutlined } from '@ant-design/icons';
import {
  TRANSLATE_LANGS,
  TRANSLATE_PROVIDERS,
  TRANSLATE_TARGET_LANGS,
  isProviderConfigured,
} from '../translate/types';
import type { TranslateLangCode, TranslateProviderId, TranslateSettings } from '../translate/types';
import { loadTranslateSettings, saveTranslateSettings } from '../translate/settings';
import { translateText } from '../translate/providers';

/** 单次翻译输入上限（百度按字节限制，这里取一个保守的字符数） */
const MAX_INPUT_CHARS = 5000;

export const TranslatePanel: React.FC = () => {
  const [settings, setSettings] = useState<TranslateSettings | null>(null);
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void loadTranslateSettings().then((loaded) => {
      setSettings(loaded);
      requestAnimationFrame(() => inputRef.current?.focus());
    });
  }, []);

  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const provider = settings?.provider;
  const configured = settings && provider
    ? isProviderConfigured(provider, settings.providers[provider])
    : false;

  const update = useCallback((patch: Partial<TranslateSettings>) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      void saveTranslateSettings(next);
      return next;
    });
  }, []);

  const runTranslate = useCallback(async () => {
    if (!settings) return;
    const text = input.trim();
    if (!text) {
      setError('请先输入要翻译的内容');
      return;
    }
    if (!configured) {
      setError('当前供应商还没配置，请点「去设置」填写密钥');
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError('');
    setCopied(false);
    try {
      const result = await translateText(settings, text, controller.signal);
      setOutput(result);
    } catch (err) {
      if (controller.signal.aborted) return;
      setOutput('');
      setError(err instanceof Error ? err.message : '翻译失败');
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setBusy(false);
      }
    }
  }, [settings, input, configured]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void runTranslate();
    }
  }, [runTranslate]);

  const swapLangs = useCallback(() => {
    if (!settings || settings.source === 'auto') return;
    update({ source: settings.target, target: settings.source as TranslateLangCode });
  }, [settings, update]);

  const clearAll = useCallback(() => {
    abortRef.current?.abort();
    setInput('');
    setOutput('');
    setError('');
    inputRef.current?.focus();
  }, []);

  const copyResult = useCallback(async () => {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('复制失败，请手动选中结果复制');
    }
  }, [output]);

  const openSettings = useCallback(() => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('options.html#/translate') });
  }, []);

  const providerMeta = settings
    ? TRANSLATE_PROVIDERS.find((item) => item.id === settings.provider)
    : undefined;

  /** 语言代码 → 中文标签，用于结果区标题 */
  const langLabel = useCallback((code: string | undefined): string => {
    const matched = TRANSLATE_LANGS.find((item) => item.code === code);
    return matched ? matched.label : String(code || '');
  }, []);

  return (
    <div className="actspan-translate">
      {/* 供应商与语言 */}
      <div className="actspan-translate-toolbar">
        <div className="actspan-translate-row">
          <label className="actspan-translate-label" htmlFor="actspan-translate-provider">供应商</label>
          <select
            id="actspan-translate-provider"
            className="actspan-translate-select"
            value={settings?.provider || 'deepl'}
            onChange={(event) => update({ provider: event.target.value as TranslateProviderId })}
            disabled={!settings || busy}
          >
            {TRANSLATE_PROVIDERS.map((item) => (
              <option key={item.id} value={item.id}>{item.label}</option>
            ))}
          </select>
          {settings && !configured && (
            <button type="button" className="actspan-translate-link" onClick={openSettings}>去设置</button>
          )}
          {settings && configured && (
            <span className="actspan-translate-ok" title="已配置密钥">已配置</span>
          )}
        </div>

        <div className="actspan-translate-row">
          <select
            className="actspan-translate-select"
            aria-label="源语言"
            value={settings?.source || 'auto'}
            onChange={(event) => update({ source: event.target.value as TranslateLangCode })}
            disabled={!settings || busy}
          >
            {TRANSLATE_LANGS.map((item) => (
              <option key={item.code} value={item.code}>{item.label}</option>
            ))}
          </select>
          <button
            type="button"
            className="actspan-translate-swap"
            title={settings?.source === 'auto' ? '自动检测时无法互换' : '互换语言'}
            onClick={swapLangs}
            disabled={!settings || busy || settings.source === 'auto'}
          >
            <SwapOutlined />
          </button>
          <select
            className="actspan-translate-select"
            aria-label="目标语言"
            value={settings?.target || 'zh'}
            onChange={(event) => update({ target: event.target.value as TranslateLangCode })}
            disabled={!settings || busy}
          >
            {TRANSLATE_TARGET_LANGS.map((item) => (
              <option key={item.code} value={item.code}>{item.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* 输入 */}
      <textarea
        ref={inputRef}
        className="actspan-translate-input"
        placeholder="粘贴或输入要翻译的内容，Ctrl/⌘ + Enter 直接翻译"
        value={input}
        maxLength={MAX_INPUT_CHARS}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={handleKeyDown}
        disabled={busy}
      />
      <div className="actspan-translate-meta">
        <span>{input.length}/{MAX_INPUT_CHARS}</span>
        <span className="actspan-translate-actions">
          <button type="button" className="actspan-translate-btn ghost" onClick={clearAll} disabled={busy}>清空</button>
          <button
            type="button"
            className="actspan-translate-btn primary"
            onClick={() => void runTranslate()}
            disabled={busy || !input.trim()}
          >
            {busy ? '翻译中…' : '翻译'}
          </button>
        </span>
      </div>

      {error && <div className="actspan-translate-error">⚠ {error}</div>}

      {/* 结果 */}
      <div className="actspan-translate-result">
        <div className="actspan-translate-result-head">
          <span>
            {providerMeta && settings
              ? `${providerMeta.label} · ${settings.source === 'auto' ? '自动检测' : langLabel(settings.source)} → ${langLabel(settings.target)}`
              : '结果'}
          </span>
          <button
            type="button"
            className="actspan-translate-link"
            onClick={() => void copyResult()}
            disabled={!output}
          >
            {copied ? '已复制' : '复制'}
          </button>
        </div>
        <textarea
          className="actspan-translate-output"
          value={output}
          readOnly
          placeholder="翻译结果会显示在这里"
        />
      </div>

      {providerMeta && (
        <div className="actspan-translate-hint">
          当前供应商：{providerMeta.label}。密钥由你自己填写，扩展不会上传或代管。
        </div>
      )}
    </div>
  );
};
