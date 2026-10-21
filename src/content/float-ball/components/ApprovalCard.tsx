/**
 * 审批确认卡片组件
 * AI 请求用户确认时展示，支持批准/拒绝/本次不再询问
 */

import React, { useState, useCallback } from 'react';
import Channel from '../../../lib/channel';
import { LOGO_REQUEST_CONFIRMATION } from '../icons';
import { useActspan } from '../context/useActspan';

interface ApprovalCardProps {
  requestId: string;
  message: string;
}

export const ApprovalCard: React.FC<ApprovalCardProps> = ({ requestId, message }) => {
  const { dispatch } = useActspan();
  const [settled, setSettled] = useState(false);
  const [result, setResult] = useState<'approved' | 'rejected' | 'cancelled' | null>(null);
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  const settle = useCallback((res: 'approved' | 'rejected') => {
    setSettled(true);
    setResult(res);
    // 延迟清除状态，让用户看到结果
    setTimeout(() => dispatch({ type: 'SET_APPROVAL_REQUEST', payload: null }), 1500);
  }, [dispatch]);

  // 卡片位于开放 Shadow DOM，页面脚本可调用 click()；只接受可信的用户事件。
  const handleApprove = useCallback((event: React.MouseEvent) => {
    if (!event.nativeEvent.isTrusted) return;
    Channel.send('__approval_response', { requestId, approved: true });
    settle('approved');
  }, [requestId, settle]);

  const handleReject = useCallback((event: React.MouseEvent) => {
    if (!event.nativeEvent.isTrusted) return;
    if (!showRejectInput) {
      setShowRejectInput(true);
      return;
    }
    Channel.send('__approval_response', { requestId, approved: false, userMessage: rejectReason });
    settle('rejected');
  }, [requestId, showRejectInput, rejectReason, settle]);

  const handleTrustAll = useCallback((event: React.MouseEvent) => {
    if (!event.nativeEvent.isTrusted) return;
    Channel.send('__approval_response', { requestId, approved: true, trustAll: true });
    settle('approved');
  }, [requestId, settle]);

  const headerText = result === 'approved' ? '已批准'
    : result === 'rejected' ? '已拒绝'
    : result === 'cancelled' ? '已取消'
    : '需要你的确认';

  return (
    <div className={`actspan-approval-standalone${settled ? ' settled' : ''}`}>
      <div className="actspan-approval-header-bar">
        <img src={LOGO_REQUEST_CONFIRMATION} alt="" />
        <span>{headerText}</span>
      </div>
      <div className={`actspan-approval-card${settled ? ' settled' : ''}`} data-request-id={requestId}>
        <div className="actspan-approval-message">{message}</div>
        {!settled && (
          <div className="actspan-approval-actions">
            <button className="actspan-approval-btn approve" onClick={handleApprove}>批准</button>
            <button className="actspan-approval-btn reject" onClick={handleReject}>
              {showRejectInput ? '确认拒绝' : '拒绝'}
            </button>
            <button className="actspan-approval-btn trust-all" onClick={handleTrustAll}>本轮内不再询问</button>
          </div>
        )}
        {showRejectInput && !settled && (
          <div className="actspan-approval-reject-input open">
            <input
              className="actspan-approval-reject-text"
              placeholder="拒绝理由（可选）"
              value={rejectReason}
              onChange={e => setRejectReason(e.target.value)}
            />
          </div>
        )}
        {settled && (
          <div className="actspan-approval-result">
            {result === 'approved' ? '✓ 已批准' : result === 'rejected' ? '✗ 已拒绝' : '已取消'}
          </div>
        )}
      </div>
    </div>
  );
};
