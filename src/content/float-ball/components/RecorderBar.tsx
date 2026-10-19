/**
 * 工作流录制状态栏组件
 * 录制中显示步数和停止按钮；审计中显示处理状态和取消按钮
 */

import React from 'react';
import { useActspan } from '../context/useActspan';

export const RecorderBar: React.FC<{
  onStop: () => void;
  onCancelAudit?: () => void;
}> = ({ onStop, onCancelAudit }) => {
  const { state } = useActspan();
  const { isRecording, isRecorderAuditing, recorderStepCount } = state;

  // 审计中状态
  if (isRecorderAuditing) {
    return (
      <div className="actspan-recorder-bar visible auditing">
        <span className="actspan-recorder-bar-dot auditing" />
        <span className="actspan-recorder-bar-info">
          正在整理录制的工作流...
        </span>
        {onCancelAudit && (
          <button className="actspan-recorder-bar-stop" type="button" onClick={onCancelAudit}>
            取消
          </button>
        )}
      </div>
    );
  }

  // 录制中状态
  if (!isRecording) return null;

  return (
    <div className="actspan-recorder-bar visible">
      <span className="actspan-recorder-bar-dot" />
      <span className="actspan-recorder-bar-info">
        录制中 · {recorderStepCount} 步
      </span>
      <button className="actspan-recorder-bar-stop" type="button" onClick={onStop}>
        停止录制
      </button>
    </div>
  );
};
