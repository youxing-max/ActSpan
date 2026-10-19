/**
 * AI 提问卡片组件
 * AI 主动提问时展示，支持选项选择和自由文本输入
 */

import React, { useState, useCallback } from 'react';
import Channel from '../../../lib/channel';
import { LOGO_ASK_USER } from '../icons';

interface AskUserCardProps {
  requestId: string;
  question: string;
  options?: string[];
  allowFreeText?: boolean;
}

export const AskUserCard: React.FC<AskUserCardProps> = ({
  requestId,
  question,
  options,
  allowFreeText = true,
}) => {
  const [settled, setSettled] = useState(false);
  const [answer, setAnswer] = useState('');
  const [textInput, setTextInput] = useState('');

  const handleOptionClick = useCallback((opt: string) => {
    Channel.send('__ask_user_response', { requestId, answer: opt, source: 'option' });
    setSettled(true);
    setAnswer(opt);
  }, [requestId]);

  const handleSubmitText = useCallback(() => {
    const value = textInput.trim();
    if (!value) return;
    Channel.send('__ask_user_response', { requestId, answer: value, source: 'text' });
    setSettled(true);
    setAnswer(value);
  }, [requestId, textInput]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      handleSubmitText();
    }
  }, [handleSubmitText]);

  const headerText = settled ? '已回答' : 'Actspan 有个问题';

  return (
    <div className={`actspan-ask-user-standalone${settled ? ' settled' : ''}`}>
      <div className="actspan-ask-user-header-bar">
        <img src={LOGO_ASK_USER} alt="" />
        <span>{headerText}</span>
      </div>
      <div className={`actspan-ask-user-card${settled ? ' settled' : ''}`} data-request-id={requestId}>
        <div className="actspan-ask-user-question">{question}</div>
        {options && options.length > 0 && (
          <div className="actspan-ask-user-options">
            {options.map((opt, idx) => (
              <button
                key={idx}
                className={`actspan-ask-user-option${settled && answer === opt ? ' selected' : ''}`}
                disabled={settled}
                onClick={() => handleOptionClick(opt)}
              >
                {opt}
              </button>
            ))}
          </div>
        )}
        {allowFreeText && !settled && (
          <div className="actspan-ask-user-input-row">
            <input
              className="actspan-ask-user-text"
              placeholder={options && options.length > 0 ? '或者直接输入...' : '请输入你的回答...'}
              value={textInput}
              onChange={e => setTextInput(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <button className="actspan-ask-user-submit" onClick={handleSubmitText}>发送</button>
          </div>
        )}
        {settled && (
          <div className="actspan-ask-user-result">已回答：{answer}</div>
        )}
      </div>
    </div>
  );
};
