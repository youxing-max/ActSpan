/**
 * 悬浮球顶层组件
 * 主视图已迁移到 Side Panel，content script 只保留触发器和接管提示
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Channel from '../../lib/channel';
import type { StatusUpdatePayload } from './text-utils';
import { nextStatusState } from './status-state';
import { ActspanProvider } from './context/ActspanContext';
import { Trigger } from './components/Trigger';
import { TakeoverBanner } from './components/TakeoverBanner';
import { useGlobalEvents } from './hooks/useGlobalEvents';
import { useAIStream } from './hooks/useAIStream';
import { useRecorder } from './hooks/useRecorder';
import { useActspan } from './context/useActspan';
const STATUS_EXPIRY_MS = 120_000;

/** A non-blocking curtain: the page remains usable while the current action is visible. */
export const StatusCurtain: React.FC<{ text: string }> = ({ text }) => text ? (
  <div className="actspan-status-curtain" role="status" aria-live="polite">
    <span className="actspan-status-curtain-mark" aria-hidden="true" />
    <span className="actspan-status-curtain-text">{text}</span>
  </div>
) : null;

/** 内部组件，在 Provider 内部才能用 hooks */
const ActspanInner: React.FC = () => {
  useGlobalEvents();
  useAIStream({ current: null });
  const { state } = useActspan();
  const { startRecording, stopRecording } = useRecorder();
  const [explicitStatus, setExplicitStatus] = useState<StatusUpdatePayload | null>(null);
  const [fallbackStale, setFallbackStale] = useState(false);
  const statusTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const handleStatus = (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const data = raw as Record<string, unknown>;
      if (data.active !== false && typeof data.text !== 'string') return;
      setExplicitStatus((previous) => nextStatusState(previous, data));
      window.clearTimeout(statusTimer.current);
      if (data.active !== false && typeof data.text === 'string' && data.text.trim()) {
        statusTimer.current = window.setTimeout(() => setExplicitStatus(null), STATUS_EXPIRY_MS);
      }
    };
    Channel.on('__status_update', handleStatus);
    return () => {
      Channel.off('__status_update', handleStatus);
      window.clearTimeout(statusTimer.current);
    };
  }, []);

  const fallbackSource = state.currentTask?.liveStatusText;
  const taskRunning = state.currentTask?.status === 'running';
  useEffect(() => {
    setFallbackStale(false);
    if (!taskRunning) return;
    let timer: number | undefined;
    const refresh = (raw?: unknown) => {
      if (raw && typeof raw === 'object') {
        const event = raw as { taskId?: string; type?: string };
        if (event.taskId && event.taskId !== state.currentTask?.id) return;
        if (!['thinking', 'function_call', 'function_result', 'planning', 'warning', 'turn_started'].includes(event.type || '')) return;
      }
      setFallbackStale(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setFallbackStale(true), 3000);
    };
    refresh();
    Channel.on('__ai_stream', refresh);
    return () => {
      Channel.off('__ai_stream', refresh);
      window.clearTimeout(timer);
    };
  }, [fallbackSource, state.currentTask?.id, taskRunning]);
  const statusText = explicitStatus?.text || (taskRunning
    ? fallbackStale || !fallbackSource ? '仍在处理…' : fallbackSource
    : '');

  const handleRecordClick = useCallback(() => {
    if (state.isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }, [state.isRecording, stopRecording, startRecording]);

  return (
    <>
      <Trigger onRecordClick={handleRecordClick} statusText={statusText} />
      <StatusCurtain text={statusText} />
      <TakeoverBanner />
    </>
  );
};

export const ActspanRoot: React.FC = () => {
  return (
    <ActspanProvider>
      <ActspanInner />
    </ActspanProvider>
  );
};
