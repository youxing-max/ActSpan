/**
 * 侧边栏「视频」面板：提交任务 + 轮询状态，直到拿到可播放地址
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { MediaSettings, VideoProviderConfig } from '../media/types';
import { loadMediaSettings } from '../media/settings';
import { generateVideo } from '../media/generator';

export const VideoPanel: React.FC = () => {
  const [settings, setSettings] = useState<MediaSettings | null>(null);
  const [config, setConfig] = useState<VideoProviderConfig | null>(null);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    void loadMediaSettings().then((loaded) => {
      setSettings(loaded);
      setConfig(loaded.video);
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
      setError('请先输入视频描述');
      return;
    }
    if (!configured) {
      setError('还没配置视频接口，请点「去设置」填写根地址与 API Key');
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError('');
    setVideoUrl('');
    setStatus('正在提交任务…');
    try {
      const result = await generateVideo(config, text, {
        signal: controller.signal,
        onProgress: (outcome) => {
          if (!outcome.url) {
            setStatus(`任务 ${outcome.id}：${outcome.status || '处理中'}`);
          }
        },
      });
      setVideoUrl(result.url);
      setStatus('已完成');
    } catch (err) {
      if (controller.signal.aborted) {
        setStatus('');
        return;
      }
      setStatus('');
      setError(err instanceof Error ? err.message : '视频生成失败');
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setBusy(false);
      }
    }
  }, [config, prompt, configured]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setStatus('');
  }, []);

  const modelLabel = settings?.video?.model || '未设置模型';

  return (
    <div className="actspan-media">
      <div className="actspan-media-head">
        <span className="actspan-media-title">视频生成</span>
        {!configured && (
          <button type="button" className="actspan-translate-link" onClick={openSettings}>去设置</button>
        )}
      </div>

      <textarea
        className="actspan-media-prompt"
        placeholder="描述你想要的镜头，例如：海浪拍打礁石，黄昏逆光，慢镜头"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        disabled={busy}
      />

      <div className="actspan-media-row">
        <button
          type="button"
          className="actspan-translate-btn primary"
          onClick={() => void run()}
          disabled={busy || !prompt.trim()}
        >
          {busy ? '生成中…' : '生成'}
        </button>
        {busy && (
          <button type="button" className="actspan-translate-btn ghost" onClick={cancel}>取消</button>
        )}
        {status && <span className="actspan-media-status">{status}</span>}
      </div>

      {error && <div className="actspan-translate-error">⚠ {error}</div>}

      <div className="actspan-media-result">
        {videoUrl ? (
          <>
            <video className="actspan-media-video" src={videoUrl} controls playsInline />
            <a className="actspan-media-download" href={videoUrl} download target="_blank" rel="noreferrer">
              打开 / 下载视频
            </a>
          </>
        ) : (
          <div className="actspan-media-placeholder">
            {busy ? '任务已提交，正在等待结果…' : '生成结果会显示在这里'}
          </div>
        )}
      </div>

      <div className="actspan-translate-hint">
        当前模型：{modelLabel}。按「提交任务 + 轮询」约定调用：
        <code>{'{baseUrl}{submitPath}'}</code> 返回任务 ID，
        <code>{'{baseUrl}{queryPath}'}</code> 查询状态与地址。密钥只保存在本机。
      </div>
    </div>
  );
};
