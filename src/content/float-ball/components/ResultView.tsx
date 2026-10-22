/**
 * 结果区容器组件
 * 显示 AI 回复内容：状态面板、工具调用、Markdown 答案、错误信息
 *
 * 改用 React 组件直接渲染，避免 dangerouslySetInnerHTML 导致 DOM 状态丢失
 */

import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { useActspan } from '../context/useActspan';
import { markdownToHtml } from '../markdown';
import type { RoundItem } from '../context/types';
import {
  sanitizeUserFacingRuntimeText,
  clipRuntimeText,
  formatDuration,
} from '../text-utils';

/** 判断滚动容器是否在底部附近（阈值 60px） */
const isNearBottom = (el: HTMLElement, threshold = 60): boolean => {
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
};

/** 截图展示区：复用既有 .actspan-screenshot-* 样式，点击交给全屏查看器 */
const ScreenshotSection: React.FC<{
  shots: Array<{ id: string; dataUrl: string; sizeKB: number }>;
}> = ({ shots }) => {
  const { dispatch } = useActspan();
  if (shots.length === 0) return null;
  return (
    <div className="actspan-screenshot-section">
      <div className="actspan-screenshot-header">
        <div className="actspan-screenshot-meta">
          <div className="actspan-screenshot-label">页面截图</div>
          <div className="actspan-screenshot-sub">{shots.length} 张 · 点击放大</div>
        </div>
      </div>
      {shots.map((shot, index) => (
        <div className="actspan-screenshot-img-wrap" key={shot.id}>
          <img
            className="actspan-screenshot-img"
            src={shot.dataUrl}
            alt="页面截图"
            onClick={() =>
              dispatch({
                type: 'SET_SCREENSHOT_PREVIEW',
                payload: { list: shots.map((s) => s.dataUrl), index },
              })
            }
          />
        </div>
      ))}
    </div>
  );
};

/** 工具调用折叠组 */
const CallsGroup: React.FC<{
  calls: Array<{ funcName: string; icon: string; text: string; userSummary?: string }>;
  isRunning: boolean;
}> = ({ calls, isRunning }) => {
  const [isOpen, setIsOpen] = useState(true);

  if (calls.length === 0) return null;

  return (
    <div className="actspan-calls-group actspan-agent-state-ops">
      <div
        className="actspan-calls-summary"
        onClick={() => setIsOpen(!isOpen)}
        style={{ cursor: 'pointer' }}
      >
        <span className={`arrow${isOpen ? ' open' : ''}`}>▶</span>
        <span className="calls-text">查看执行过程 · 共 {calls.length} 条</span>
      </div>
      {isOpen && (
        <div className="actspan-calls-detail open">
          {calls.map((call, idx) => (
            <div key={idx} className={`actspan-call-item tone-${isRunning && idx === calls.length - 1 ? 'action' : 'done'}`}>
              <div className="actspan-call-header">
                {call.icon
                  ? <img className="actspan-func-icon" src={call.icon} alt="" />
                  : <span className="actspan-task-runtime-step-dot" />
                }
                <span className="actspan-call-main">
                  <span className="actspan-call-title">{call.text}</span>
                  {call.userSummary && (
                    <span className="actspan-call-intent">{call.userSummary}</span>
                  )}
                </span>
                <span className={`actspan-call-status${isRunning && idx === calls.length - 1 ? ' running' : ''}`}>
                  {isRunning && idx === calls.length - 1 ? '···' : '✓'}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/** 进展状态面板 */
const AgentStatePanel: React.FC<{
  statusText: string;
  isRunning: boolean;
  isFinished: boolean;
  durationText: string;
  children?: React.ReactNode;
}> = ({ statusText, isRunning, isFinished, durationText, children }) => {
  const [isOpen, setIsOpen] = useState(true);

  // 任务结束自动折叠
  useEffect(() => {
    if (isFinished) setIsOpen(false);
  }, [isFinished]);

  const summaryText = isFinished
    ? (durationText ? `已完成 · 耗时 ${durationText}` : '已完成')
    : statusText;

  return (
    <div className={`actspan-agent-state-panel${isRunning ? ' is-live' : ''}${isOpen ? ' open' : ''}`}>
      <div
        className="actspan-agent-state-title"
        onClick={() => setIsOpen(!isOpen)}
        style={{ cursor: 'pointer' }}
      >
        <span className="actspan-agent-state-title-main">
          <span className={`arrow${isOpen ? ' open' : ''}`}>▶</span>
          <span>进展</span>
        </span>
        <span className="actspan-agent-state-summary">{summaryText}</span>
      </div>
      {isOpen && (
        <>
          <div className="actspan-task-runtime-board">
            {isRunning && (
              <div className="actspan-runtime-now">
                <span className="actspan-inline-loader"><span /><span /><span /></span>
                <span className="actspan-runtime-now-text">{statusText}</span>
              </div>
            )}
          </div>
          {children}
        </>
      )}
    </div>
  );
};

/** 历史轮次：折叠展示之前的对话 */
const HistoryRound: React.FC<{ round: RoundItem; index: number }> = ({ round }) => {
  const [isOpen, setIsOpen] = useState(false);
  const html = useMemo(() => round.aiText ? markdownToHtml(round.aiText) : '', [round.aiText]);
  const preview = round.aiText
    ? round.aiText.replace(/[#*`\n]/g, ' ').trim().slice(0, 60)
    : (round.status === 'error' ? round.errorMsg || '执行失败' : '已完成');

  return (
    <div className="actspan-round-history">
      {/* 用户消息气泡 */}
      <div className="actspan-user-msg">{round.query}</div>
      {/* 折叠摘要 */}
      <div className="actspan-round-summary" onClick={() => setIsOpen(!isOpen)}>
        <span className={`arrow${isOpen ? ' open' : ''}`}>▶</span>
        <span className="actspan-round-preview">{preview}</span>
      </div>
      {isOpen && (
        <div className="actspan-round-content open">
          {round.callStack.length > 0 && (
            <CallsGroup calls={round.callStack} isRunning={false} />
          )}
          {html && (
            <div className="actspan-answer" dangerouslySetInnerHTML={{ __html: html }} />
          )}
          {round.screenshotArtifacts && <ScreenshotSection shots={round.screenshotArtifacts} />}
          {round.status === 'error' && round.errorMsg && (
            <div className="actspan-error">⚠ {round.errorMsg}</div>
          )}
        </div>
      )}
    </div>
  );
};

export const ResultView: React.FC = () => {
  const { state } = useActspan();
  const resultRef = useRef<HTMLDivElement>(null);
  const answerRef = useRef<HTMLDivElement>(null);
  const prevTaskIdRef = useRef('');
  // 追踪用户是否在底部附近，新任务开始时重置为 true
  const userAtBottomRef = useRef(true);
  const task = state.currentTask;

  // 监听用户滚动：实时更新是否在底部
  const handleScroll = useCallback(() => {
    const el = resultRef.current;
    if (el) userAtBottomRef.current = isNearBottom(el);
  }, []);

  // 新任务开始时重置滚动状态
  useEffect(() => {
    userAtBottomRef.current = true;
  }, [task?.id]);

  // 智能滚动：仅在用户处于底部附近时才自动滚动
  useEffect(() => {
    const el = resultRef.current;
    if (el && userAtBottomRef.current) {
      requestAnimationFrame(() => {
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      });
    }
  }, [task?.lastAIText, task?.status, task?.liveStatusText, task?.callStack?.length]);

  // 增量 DOM 更新：只对新出现的块级元素加淡入动画，已有元素就地更新，避免全量替换闪烁
  useEffect(() => {
    const el = answerRef.current;
    if (!el) return;

    const text = task?.lastAIText || '';
    const html = text ? markdownToHtml(text) : '';
    const taskId = task?.id || '';

    // 任务切换 → 全量替换
    if (taskId !== prevTaskIdRef.current) {
      el.innerHTML = html;
      prevTaskIdRef.current = taskId;
      return;
    }

    if (!html) { el.innerHTML = ''; return; }

    // 解析新 HTML 到临时容器对比
    const temp = document.createElement('div');
    temp.innerHTML = html;

    const oldCount = el.childElementCount;
    const newCount = temp.childElementCount;

    // 首次出现内容 → 写入并对所有子元素加淡入
    if (oldCount === 0) {
      el.innerHTML = html;
      for (const child of Array.from(el.children)) {
        (child as HTMLElement).classList.add('actspan-answer-new');
      }
      return;
    }

    // 结构大幅变化（元素变少，罕见：markdown 重解析） → 全量替换
    if (newCount < oldCount) {
      el.innerHTML = html;
      return;
    }

    // 就地更新最后一个已有元素（流式追加到当前段落/代码块等）
    const lastIdx = oldCount - 1;
    const oldLast = el.children[lastIdx];
    const newLast = temp.children[lastIdx];
    if (oldLast && newLast) {
      if (oldLast.tagName === newLast.tagName) {
        // 同类型：直接更新内容
        oldLast.innerHTML = newLast.innerHTML;
      } else {
        // 类型变了（如文本变列表）：替换节点
        el.replaceChild(newLast.cloneNode(true), oldLast);
      }
    }

    // 追加新出现的块级元素，带淡入动画
    for (let i = oldCount; i < newCount; i++) {
      const newChild = temp.children[i].cloneNode(true) as HTMLElement;
      newChild.classList.add('actspan-answer-new');
      el.appendChild(newChild);
    }

    // 仅在本地显示 hostname；不在渲染阶段请求远程页面。
    const chips = el.querySelectorAll<HTMLAnchorElement>('a.actspan-link-chip');
    for (const chip of chips) {
      const url = chip.dataset.url;
      if (!url) continue;
      try {
        const hostname = new URL(url).hostname;
        if (hostname) {
          const textEl = chip.querySelector('.actspan-link-text');
          if (textEl) textEl.textContent = hostname;
        }
      } catch {
        // 保留 markdown 已生成的原始链接文本。
      }
    }
  }, [task?.lastAIText, task?.id]);

  if (!task) return null;

  const isRunning = task.status === 'running';
  const isFinished = task.status === 'done' || task.status === 'error';

  const statusText = clipRuntimeText(
    sanitizeUserFacingRuntimeText(task.liveStatusText || '我正在继续处理，请稍候...', 'current'),
    120,
  );

  const duration = task.durationMs ?? (task.endedAt ? Math.max(0, task.endedAt - task.startedAt) : null);
  const durationText = duration !== null ? formatDuration(duration) : '';

  const rounds = task.rounds || [];

  return (
    <div className="actspan-result visible" ref={resultRef} onScroll={handleScroll}>
      {/* 历史轮次 */}
      {rounds.map((round, idx) => (
        <HistoryRound key={idx} round={round} index={idx} />
      ))}

      {/* 当前轮用户消息（仅多轮时显示） */}
      {rounds.length > 0 && task.query && (
        <div className="actspan-user-msg">{task.query}</div>
      )}

      {/* 进展面板 */}
      {(isRunning || isFinished) && (
        <AgentStatePanel
          statusText={statusText}
          isRunning={isRunning}
          isFinished={isFinished}
          durationText={durationText}
        >
          <CallsGroup calls={task.callStack} isRunning={isRunning} />
        </AgentStatePanel>
      )}

      {/* AI 文本回复 — ref 管理 DOM 实现增量更新 */}
      <div
        className="actspan-answer"
        ref={answerRef}
        style={!task.lastAIText ? { display: 'none' } : undefined}
      />

      {task.screenshotArtifacts && <ScreenshotSection shots={task.screenshotArtifacts} />}

      {/* 错误信息 */}
      {task.status === 'error' && task.errorMsg && (
        <div className="actspan-error">⚠ {task.errorMsg}</div>
      )}

      {/* 完成但无文本 */}
      {task.status === 'done' && !task.lastAIText && (
        <div className="actspan-status"><span className="dot" />已完成处理。</div>
      )}
    </div>
  );
};
