/**
 * 侧边栏「视频」面板
 *
 * 与图片一致的 composer：模型 chip → 参考内容 → 提示词 → 底部只显示该模型
 * 支持的参数（分辨率 / 比例 / 时长 / 声音）→ 发送并轮询结果。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PlusOutlined, SendOutlined } from '@ant-design/icons';
import { VIDEO_MODELS, findVideoModel, resolveVideoParams } from '../media/videoModels';
import type { VideoModelSpec, VideoSelection } from '../media/videoModels';
import { loadMediaSettings } from '../media/settings';
import { generateVideo } from '../media/generator';
import type { MediaSettings } from '../media/types';

const readAsDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result || ''));
  reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
  reader.readAsDataURL(file);
});

export const VideoPanel: React.FC = () => {
  const [settings, setSettings] = useState<MediaSettings | null>(null);
  const [modelId, setModelId] = useState(VIDEO_MODELS[0].id);
  const [prompt, setPrompt] = useState('');
  const [refs, setRefs] = useState<string[]>([]);
  const [params, setParams] = useState<{ resolution?: string; aspect?: string; duration?: number; audio?: boolean }>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadMediaSettings().then((loaded) => {
      setSettings(loaded);
      const initial = VIDEO_MODELS.some((item) => item.id === loaded.video.model)
        ? loaded.video.model
        : VIDEO_MODELS[0].id;
      setModelId(initial);
    });
  }, []);

  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const spec: VideoModelSpec = useMemo(() => findVideoModel(modelId), [modelId]);

  useEffect(() => {
    setParams({ ...spec.defaults });
    setRefs((prev) => prev.slice(0, spec.refs || 0));
  }, [spec]);

  const configured = Boolean(settings?.video?.baseUrl && settings?.video?.apiKey);

  const openSettings = useCallback(() => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('options.html#/media') });
  }, []);

  const addRefs = useCallback(async (files: File[]) => {
    const limit = spec.refs || 0;
    if (limit <= 0) return;
    const accepted: string[] = [];
    for (const file of files) {
      if (refs.length + accepted.length >= limit) break;
      if (!file.type.startsWith('image/')) continue;
      try { accepted.push(await readAsDataUrl(file)); } catch { /* 跳过 */ }
    }
    if (accepted.length > 0) setRefs((prev) => [...prev, ...accepted].slice(0, limit));
  }, [refs.length, spec.refs]);

  const run = useCallback(async () => {
    if (!settings) return;
    const text = prompt.trim();
    if (!text) { setError('请先输入视频描述'); return; }
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
      const selection: VideoSelection = { prompt: text, ...params, refs };
      const result = await generateVideo(spec, settings.video, selection, {
        signal: controller.signal,
        onProgress: (outcome) => {
          if (!outcome.url) setStatus(`任务 ${outcome.id}：${outcome.status || '处理中'}`);
        },
      });
      setVideoUrl(result.url);
      setStatus('已完成');
    } catch (err) {
      if (controller.signal.aborted) { setStatus(''); return; }
      setStatus('');
      setError(err instanceof Error ? err.message : '视频生成失败');
    } finally {
      if (abortRef.current === controller) { abortRef.current = null; setBusy(false); }
    }
  }, [settings, spec, prompt, params, refs, configured]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setStatus('');
  }, []);

  const resolved = useMemo(
    () => resolveVideoParams(spec, { prompt, ...params, refs }),
    [spec, prompt, params, refs],
  );
  // 只有能算出真实像素（Sora 的 size）时才额外提示；ark 的 chips 已经展示全参数
  const sizeHint = resolved.size ? resolved.size.replace('x', ' × ') : '';

  return (
    <div className="actspan-image">
      <div className="actspan-image-modelbar">
        <select
          className="actspan-model-chip"
          aria-label="视频模型"
          value={modelId}
          onChange={(event) => setModelId(event.target.value)}
          disabled={busy}
        >
          {VIDEO_MODELS.map((item) => (
            <option key={item.id} value={item.id}>{item.vendor} · {item.label}</option>
          ))}
        </select>
        {!configured && (
          <button type="button" className="actspan-translate-link" onClick={openSettings}>去设置</button>
        )}
      </div>

      <div className="actspan-composer">
        {spec.refs && spec.refs > 0 && (
          <div className="actspan-composer-head">
            <button
              type="button"
              className="actspan-ref-add"
              title={`最多 ${spec.refs} 张参考内容`}
              onClick={() => fileRef.current?.click()}
              disabled={busy}
            >
              <PlusOutlined />
              <span>参考内容</span>
            </button>
            {refs.map((ref, index) => (
              <span className="actspan-ref-thumb" key={`${index}-${ref.slice(-8)}`}>
                <img src={ref} alt={`参考图 ${index + 1}`} />
                <button
                  type="button"
                  className="actspan-ref-remove"
                  title="移除"
                  onClick={() => setRefs((prev) => prev.filter((_, i) => i !== index))}
                >×</button>
              </span>
            ))}
            <span className="actspan-ref-hint">{refs.length}/{spec.refs}</span>
          </div>
        )}

        <textarea
          className="actspan-composer-input"
          placeholder="输入内容开始生成，Shift + Enter 换行，Ctrl/⌘ + Enter 直接发送"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              void run();
            }
          }}
          disabled={busy}
        />

        <div className="actspan-composer-foot">
          <div className="actspan-composer-params">
            {spec.resolutions && (
              <select
                className="actspan-chip"
                aria-label="分辨率"
                value={params.resolution || spec.defaults.resolution || ''}
                onChange={(event) => setParams((prev) => ({ ...prev, resolution: event.target.value }))}
                disabled={busy}
              >
                {spec.resolutions.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            )}
            {spec.aspects && (
              <select
                className="actspan-chip"
                aria-label="画面比例"
                value={params.aspect || spec.defaults.aspect || ''}
                onChange={(event) => setParams((prev) => ({ ...prev, aspect: event.target.value }))}
                disabled={busy}
              >
                {spec.aspects.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            )}
            {spec.durations && (
              <select
                className="actspan-chip"
                aria-label="时长"
                value={String(params.duration ?? spec.defaults.duration ?? '')}
                onChange={(event) => setParams((prev) => ({ ...prev, duration: Number(event.target.value) }))}
                disabled={busy}
              >
                {spec.durations.map((item) => <option key={item} value={item}>{item}s</option>)}
              </select>
            )}
            {spec.audio && (
              <button
                type="button"
                className={`actspan-chip actspan-chip-toggle${params.audio ? ' on' : ''}`}
                aria-label="声音"
                aria-pressed={params.audio === true}
                title={params.audio ? '已开启声音' : '静音'}
                onClick={() => setParams((prev) => ({ ...prev, audio: !prev.audio }))}
                disabled={busy}
              >
                {params.audio ? '声音 开' : '声音 关'}
              </button>
            )}
            {sizeHint && <span className="actspan-composer-size">{sizeHint}</span>}
          </div>
          <button
            type="button"
            className="actspan-send"
            title={busy ? '生成中' : '生成'}
            onClick={() => void run()}
            disabled={busy || !prompt.trim()}
          >
            <SendOutlined />
          </button>
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={async (event) => {
          const files = Array.from(event.target.files || []);
          event.target.value = '';
          await addRefs(files);
        }}
      />

      {status && !error && <div className="actspan-media-status">{status}</div>}
      {busy && (
        <button type="button" className="actspan-translate-btn ghost" onClick={cancel}>取消生成</button>
      )}
      {error && <div className="actspan-translate-error">⚠ {error}</div>}

      <div className="actspan-media-result">
        {videoUrl ? (
          <>
            <video className="actspan-media-video" src={videoUrl} controls playsInline />
            <a className="actspan-media-download" href={videoUrl} download target="_blank" rel="noreferrer">打开 / 下载视频</a>
          </>
        ) : (
          <div className="actspan-media-placeholder">{busy ? '任务已提交，正在等待结果…' : '生成结果会显示在这里'}</div>
        )}
      </div>

      <div className="actspan-translate-hint">
        {spec.vendor} · {spec.label}：{spec.shape === 'ark'
          ? '按 content 数组提交（文本 + 参考图），参数为 resolution / ratio / duration'
          : '按 Sora 约定提交（prompt + size + seconds）'}
        ，密钥只保存在本机。
      </div>
    </div>
  );
};
