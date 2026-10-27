/**
 * 侧边栏「图片」面板
 *
 * 按参考交互做成 composer：顶部选模型 → 中间写提示词 / 加参考图 →
 * 底部只显示该模型支持的参数（分辨率 / 比例 / 尺寸 / 质量）→ 发送。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PlusOutlined, SendOutlined } from '@ant-design/icons';
import { IMAGE_MODELS, findImageModel, resolveImageParams } from '../media/models';
import type { ImageModelSpec, ImageSelection } from '../media/models';
import { loadMediaSettings } from '../media/settings';
import { generateImage } from '../media/generator';
import type { GeneratedImage } from '../media/generator';
import type { MediaSettings } from '../media/types';

const readAsDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result || ''));
  reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
  reader.readAsDataURL(file);
});

export const ImagePanel: React.FC = () => {
  const [settings, setSettings] = useState<MediaSettings | null>(null);
  const [modelId, setModelId] = useState(IMAGE_MODELS[0].id);
  const [prompt, setPrompt] = useState('');
  const [refs, setRefs] = useState<string[]>([]);
  const [params, setParams] = useState<{ size?: string; aspect?: string; resolution?: string; quality?: string }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [image, setImage] = useState<GeneratedImage | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadMediaSettings().then((loaded) => {
      setSettings(loaded);
      const initial = IMAGE_MODELS.some((item) => item.id === loaded.image.model)
        ? loaded.image.model
        : IMAGE_MODELS[0].id;
      setModelId(initial);
    });
  }, []);

  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const spec: ImageModelSpec = useMemo(() => findImageModel(modelId), [modelId]);

  // 切换模型时把参数重置为该模型的默认值
  useEffect(() => {
    setParams({ ...spec.defaults });
    setRefs((prev) => prev.slice(0, spec.refs || 0));
  }, [spec]);

  const configured = Boolean(settings?.image?.baseUrl && settings?.image?.apiKey);

  const openSettings = useCallback(() => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('options.html#/media') });
  }, []);

  const addRefs = useCallback(async (files: File[]) => {
    const limit = spec.refs || 0;
    if (limit <= 0 || files.length === 0) return;
    const accepted: string[] = [];
    for (const file of files) {
      if (refs.length + accepted.length >= limit) break;
      if (!file.type.startsWith('image/')) continue;
      try {
        accepted.push(await readAsDataUrl(file));
      } catch { /* 单张失败跳过 */ }
    }
    if (accepted.length > 0) setRefs((prev) => [...prev, ...accepted].slice(0, limit));
  }, [refs.length, spec.refs]);

  const run = useCallback(async () => {
    if (!settings) return;
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
      const selection: ImageSelection = { prompt: text, ...params, refs };
      const result = await generateImage(spec, settings.image, selection, { signal: controller.signal });
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
  }, [settings, spec, prompt, params, refs, configured]);

  const resolved = useMemo(() => resolveImageParams(spec, { prompt, ...params, refs }), [spec, prompt, params, refs]);
  const formatSize = (value?: string) =>
    (!value || value === 'auto' ? (value || '') : value.replace('x', ' × '));
  const sizeHint = resolved.pixelSize
    ? formatSize(resolved.pixelSize)
    : (formatSize(resolved.size) || (resolved.aspect ? `比例 ${resolved.aspect}` : ''));

  return (
    <div className="actspan-image">
      {/* 模型选择 */}
      <div className="actspan-image-modelbar">
        <select
          className="actspan-model-chip"
          aria-label="图片模型"
          value={modelId}
          onChange={(event) => setModelId(event.target.value)}
          disabled={busy}
        >
          {IMAGE_MODELS.map((item) => (
            <option key={item.id} value={item.id}>{item.vendor} · {item.label}</option>
          ))}
        </select>
        {!configured && (
          <button type="button" className="actspan-translate-link" onClick={openSettings}>去设置</button>
        )}
      </div>

      {/* composer */}
      <div className="actspan-composer">
        {spec.refs && spec.refs > 0 && (
          <div className="actspan-composer-head">
            <button
              type="button"
              className="actspan-ref-add"
              title={`最多 ${spec.refs} 张参考图`}
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
          placeholder="输入内容开始生成（Shift + Enter 换行，Ctrl/⌘ + Enter 直接发送）"
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
            {spec.sizes && (
              <select
                className="actspan-chip"
                aria-label="尺寸"
                value={params.size || spec.defaults.size || ''}
                onChange={(event) => setParams((prev) => ({ ...prev, size: event.target.value }))}
                disabled={busy}
              >
                {spec.sizes.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            )}
            {spec.qualities && (
              <select
                className="actspan-chip"
                aria-label="质量"
                value={params.quality || spec.defaults.quality || ''}
                onChange={(event) => setParams((prev) => ({ ...prev, quality: event.target.value }))}
                disabled={busy}
              >
                {spec.qualities.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
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

      {error && <div className="actspan-translate-error">⚠ {error}</div>}

      <div className="actspan-media-result">
        {image ? (
          <>
            <img className="actspan-media-image" src={image.src} alt={prompt || '生成结果'} />
            {image.revisedPrompt && <div className="actspan-media-note">服务端改写：{image.revisedPrompt}</div>}
            <a className="actspan-media-download" href={image.src} download={`actspan-image-${Date.now()}.png`}>下载图片</a>
          </>
        ) : (
          <div className="actspan-media-placeholder">{busy ? '正在生成…' : '生成结果会显示在这里'}</div>
        )}
      </div>

      <div className="actspan-translate-hint">
        {spec.vendor} · {spec.label}：{spec.refs ? `支持 ${spec.refs} 张参考图，` : '不支持参考图，'}
        参数按该模型的接口约定发送{spec.shape === 'gemini' ? '（比例走 imageConfig.aspectRatio）' : ''}。
        密钥只保存在本机。
      </div>
    </div>
  );
};
