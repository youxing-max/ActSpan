/**
 * 截图预览浮层组件
 * 全屏预览截图，支持左右切换
 */

import React, { useCallback, useEffect } from 'react';
import { useActspan } from '../context/useActspan';

export const ImageViewer: React.FC = () => {
  const { state, dispatch } = useActspan();
  const { screenshotPreviewList, screenshotPreviewIndex } = state;
  const isOpen = screenshotPreviewList.length > 0;

  const close = useCallback(() => {
    dispatch({ type: 'SET_SCREENSHOT_PREVIEW', payload: { list: [], index: 0 } });
  }, [dispatch]);

  const navigate = useCallback((delta: number) => {
    if (screenshotPreviewList.length === 0) return;
    const newIndex = (screenshotPreviewIndex + delta + screenshotPreviewList.length) % screenshotPreviewList.length;
    dispatch({ type: 'SET_SCREENSHOT_PREVIEW', payload: { list: screenshotPreviewList, index: newIndex } });
  }, [screenshotPreviewList, screenshotPreviewIndex, dispatch]);

  // 键盘导航
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { close(); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { navigate(-1); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { navigate(1); e.preventDefault(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, close, navigate]);

  if (!isOpen) return null;

  const currentSrc = screenshotPreviewList[screenshotPreviewIndex] || '';
  const meta = `${screenshotPreviewIndex + 1} / ${screenshotPreviewList.length}`;

  return (
    <div className="actspan-image-viewer open">
      <div className="actspan-image-viewer-content">
        <button className="actspan-image-viewer-close" type="button" aria-label="关闭预览" onClick={close}>
          ×
        </button>
        <div className="actspan-image-viewer-stage">
          {screenshotPreviewList.length > 1 && (
            <button className="actspan-image-viewer-nav prev" type="button" aria-label="上一张" onClick={() => navigate(-1)}>
              ‹
            </button>
          )}
          <img className="actspan-image-viewer-img" src={currentSrc} alt="截图预览" />
          {screenshotPreviewList.length > 1 && (
            <button className="actspan-image-viewer-nav next" type="button" aria-label="下一张" onClick={() => navigate(1)}>
              ›
            </button>
          )}
        </div>
        <div className="actspan-image-viewer-meta">{meta}</div>
      </div>
    </div>
  );
};
