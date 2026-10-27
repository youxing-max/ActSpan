/**
 * 侧边栏「图片」面板：调用用户自带的 OpenAI 兼容图片接口
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { IMAGE_SIZE_OPTIONS } from '../media/types';
import type { ImageProviderConfig, MediaSettings } from '../media/types';
import { loadMediaSettings } from '../media/settings';
import { generateImage } from '../media/generator';
import type { GeneratedImage } from '../media/generator';

export const ImagePanel: React.FC = () => {
  const [settings, setSettings] = useState<MediaSettings | null>(null);
  const [config, setConfig] = useState<ImageProviderConfig | null>(null);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [image, setImage] = useState<GeneratedImage | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    void loadMediaSettings().then((loaded) => {
      setSettings(loaded);
      setConfig(loaded.image);
    });
  }, []);

  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const configured = Boolean(config?.baseUrl && config?.apiKey);

  const openSettings = useCallback(() => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('options.html#/media') });
  }, []);

  const run = useCallback(async () => {
    if (!config) return;
    const text = prompt.trim();
    if (!text) {
      setError('请先输入画面描述');
      return;
    }
    if (!configured) {
      setError('还没配置图片接口，请点「去设置」填写根地址与 API Key');
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError('');
    try {
      const result = await generateImage(config, text, { signal: controller.signal });
      setImage(result);
    } catch (err) {
      if (controller.signal.aborted) return;
      setImage(null);
      setError(err instanceof Error ? err.message : '图片生成失败');
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setBusy(false);
      }
    }
  }, [config, prompt, configured]);

  const modelLabel = settings?.image?.model || '未设置模型';

  return (
    <div className="actspan-media">
      <div className="actspan-media-head">
        <span className="actspan-media-title">图片生成</span>
        {!configured && (
          <button type="button" className="actspan-translate-link" onClick={openSettings}>去设置</button>
        )}
      </div>

      <textarea
        className="actspan-media-prompt"
        placeholder="描述你想要的画面，例如：一只在雨夜打字的水獭，赛博朋克霓虹"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        disabled={busy}
      />

      <div className="actspan-media-row">
        <label className="actspan-media-label" htmlFor="actspan-image-size">尺寸</label>
        <select
          id="actspan-image-size"
          className="actspan-translate-select"
          value={config?.size || '1024x1024'}
          onChange={(event) => setConfig((prev) => (prev ? { ...prev, size: event.target.value } : prev))}
          disabled={busy}
        >
          {IMAGE_SIZE_OPTIONS.map((item) => (
            <option key={item.value} value={item.value}>{item.label}</option>
          ))}
        </select>
        <button
          type="button"
          className="actspan-translate-btn primary"
          onClick={() => void run()}
          disabled={busy || !prompt.trim()}
        >
          {busy ? '生成中…' : '生成'}
        </button>
      </div>

      {error && <div className="actspan-translate-error">⚠ {error}</div>}

      <div className="actspan-media-result">
        {image ? (
          <>
            <img className="actspan-media-image" src={image.src} alt={prompt || '生成结果'} />
            {image.revisedPrompt && (
              <div className="actspan-media-note">服务端改写：{image.revisedPrompt}</div>
            )}
            <a className="actspan-media-download" href={image.src} download={`actspan-image-${Date.now()}.png`}>
              下载图片
            </a>
          </>
        ) : (
          <div className="actspan-media-placeholder">生成结果会显示在这里</div>
        )}
      </div>

      <div className="actspan-translate-hint">
        当前模型：{modelLabel}。接口按 OpenAI 兼容的 <code>{'{baseUrl}/images/generations'}</code> 调用，
        密钥只保存在本机。
      </div>
    </div>
  );
};
