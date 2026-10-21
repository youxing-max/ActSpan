/**
 * 工作流录制 Hook
 * 录制用户在页面上的操作（点击/输入/提交），发送给 background 处理
 * 每步操作后由 background 截图，截图结果关联到步骤数据
 */

import { useCallback, useEffect, useRef } from 'react';
import Channel from '../../../lib/channel';
import { useActspan } from '../context/useActspan';
import { buildTaskTitle } from '../text-utils';
import { getRecorderRecovery } from '../../recorder-recovery';
import { redactRecordedStep, type RecordedFieldMeta } from '../../../lib/recorder-redaction';
import {
  showRecorderOverlay,
  updateRecorderStepCount,
  hideRecorderOverlay,
} from '../../recorder-overlay';


// ============ 选择器工具函数 ============

/** 生成一个尽可能稳定的 CSS 选择器 */
const buildSimpleSelector = (el: Element): string => {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const testId = el.getAttribute('data-testid') || el.getAttribute('data-test');
  if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
  const tag = el.tagName.toLowerCase();
  const name = el.getAttribute('name');
  if (name) return `${tag}[name="${CSS.escape(name)}"]`;
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return `${tag}[aria-label="${CSS.escape(ariaLabel)}"]`;
  const placeholder = el.getAttribute('placeholder');
  if (placeholder) return `${tag}[placeholder="${CSS.escape(placeholder)}"]`;
  const classes = Array.from(el.classList).slice(0, 2);
  if (classes.length > 0) return `${tag}.${classes.map(c => CSS.escape(c)).join('.')}`;
  const parent = el.parentElement;
  if (parent) {
    const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
    const idx = siblings.indexOf(el) + 1;
    return `${tag}:nth-of-type(${idx})`;
  }
  return tag;
};

/** 生成元素的语义描述 */
const getElementSemanticHint = (el: Element): string => {
  const tag = el.tagName.toLowerCase();
  if (tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button') {
    const text = (el.textContent || '').trim().slice(0, 30);
    if (text) return text;
  }
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    return el.getAttribute('placeholder')
      || el.getAttribute('aria-label')
      || el.getAttribute('name')
      || tag;
  }
  return el.getAttribute('aria-label')
    || el.getAttribute('role')
    || tag;
};

// ============ Hook ============

export const useRecorder = () => {
  const { state, dispatch } = useActspan();
  const stateRef = useRef(state);
  stateRef.current = state;

  // 录制中的可变状态（不触发 re-render）
  const stepCountRef = useRef(0);
  const inputDebounceTimerRef = useRef<number | null>(null);
  const lastInputTargetRef = useRef<Element | null>(null);
  const lastInputValueRef = useRef('');
  const lastInputMetaRef = useRef<RecordedFieldMeta>({});


  /** 提交未完成的输入步骤 */
  const flushInputStep = useCallback(() => {
    const target = lastInputTargetRef.current;
    const value = lastInputValueRef.current;
    if (!target || !value) return;

    const isSelect = target.tagName === 'SELECT';
    stepCountRef.current++;
    const step = {
      seq: stepCountRef.current,
      action: isSelect ? 'select' : 'type',
      selector: buildSimpleSelector(target),
      selectorCandidates: [buildSimpleSelector(target)],
      semanticHint: getElementSemanticHint(target),
      tag: target.tagName.toLowerCase(),
      value,
      url: window.location.href,
      timestamp: Date.now(),
    };
    // 密码、验证码、银行卡等字段只保留「已填写」标记，原文不离开页面
    Channel.send('__recorder_step', redactRecordedStep(step, lastInputMetaRef.current));
    lastInputTargetRef.current = null;
    lastInputValueRef.current = '';
    lastInputMetaRef.current = {};
    dispatch({ type: 'SET_RECORDING', payload: { isRecording: true, stepCount: stepCountRef.current } });
    updateRecorderStepCount(stepCountRef.current);
  }, [dispatch]);

  // 事件处理器 refs（需要在 addEventListener 中保持稳定引用）
  const handlersRef = useRef<{
    click: (e: MouseEvent) => void;
    input: (e: Event) => void;
    submit: (e: Event) => void;
  } | null>(null);

  // 初始化事件处理器
  if (!handlersRef.current) {
    handlersRef.current = {
      click: (e: MouseEvent) => {
        if (!stateRef.current.isRecording) return;
        const target = e.target as Element;
        if (!target || target.closest('#actspan-root') || target.closest('#actspan-recorder-overlay')) return;

        const selector = buildSimpleSelector(target);
        const semanticHint = getElementSemanticHint(target);

        stepCountRef.current++;
        Channel.send('__recorder_step', {
          seq: stepCountRef.current,
          action: 'click',
          selector,
          selectorCandidates: [selector],
          semanticHint,
          tag: target.tagName.toLowerCase(),
          url: window.location.href,
          timestamp: Date.now(),
        });
        dispatch({ type: 'SET_RECORDING', payload: { isRecording: true, stepCount: stepCountRef.current } });
        updateRecorderStepCount(stepCountRef.current);
      },

      input: (e: Event) => {
        if (!stateRef.current.isRecording) return;
        const target = e.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        if (!target || target.closest('#actspan-root') || target.closest('#actspan-recorder-overlay')) return;

        if (target !== lastInputTargetRef.current && lastInputTargetRef.current && lastInputValueRef.current) {
          flushInputStep();
        }

        lastInputTargetRef.current = target;
        lastInputValueRef.current = target.value || '';
        lastInputMetaRef.current = {
          tag: target.tagName.toLowerCase(),
          selector: buildSimpleSelector(target),
          semanticHint: getElementSemanticHint(target),
          inputType: (target as HTMLInputElement).type,
          autocomplete: target.getAttribute('autocomplete') || undefined,
        };

        if (inputDebounceTimerRef.current) window.clearTimeout(inputDebounceTimerRef.current);
        inputDebounceTimerRef.current = window.setTimeout(() => {
          flushInputStep();
        }, 800);
      },

      submit: (e: Event) => {
        if (!stateRef.current.isRecording) return;
        const form = e.target as HTMLFormElement;
        if (!form || form.closest('#actspan-root')) return;

        flushInputStep();

        stepCountRef.current++;
        Channel.send('__recorder_step', {
          seq: stepCountRef.current,
          action: 'submit',
          selector: buildSimpleSelector(form),
          selectorCandidates: [buildSimpleSelector(form)],
          semanticHint: '提交表单',
          tag: 'form',
          url: window.location.href,
          timestamp: Date.now(),
        });
        dispatch({ type: 'SET_RECORDING', payload: { isRecording: true, stepCount: stepCountRef.current } });
        updateRecorderStepCount(stepCountRef.current);
      },
    };
  }

  /** 注册事件捕获 */
  const startCapture = useCallback(() => {
    const h = handlersRef.current!;
    document.addEventListener('click', h.click, true);
    document.addEventListener('input', h.input, true);
    document.addEventListener('change', h.input, true);
    document.addEventListener('submit', h.submit, true);
  }, []);

  /** 注销事件捕获 */
  const stopCapture = useCallback(() => {
    const h = handlersRef.current!;
    document.removeEventListener('click', h.click, true);
    document.removeEventListener('input', h.input, true);
    document.removeEventListener('change', h.input, true);
    document.removeEventListener('submit', h.submit, true);
    if (inputDebounceTimerRef.current) {
      window.clearTimeout(inputDebounceTimerRef.current);
      inputDebounceTimerRef.current = null;
    }
    lastInputTargetRef.current = null;
    lastInputValueRef.current = '';
    lastInputMetaRef.current = {};
  }, []);

  /** 提交录制给 background AI 审计 */
  const submitRecording = useCallback(() => {
    dispatch({ type: 'SET_RECORDER_AUDITING', payload: true });
    Channel.send('__recorder_submit', {}, (resp: any) => {
      if (!stateRef.current.isRecorderAuditing) return;
      dispatch({ type: 'SET_RECORDER_AUDITING', payload: false });
      if (!resp?.success) {
        console.warn('[Actspan] 录制审计失败:', resp?.error);
      }
    });
  }, [dispatch]);

  /** 完成录制（停止 + 提交审计） */
  const stopRecording = useCallback(() => {
    flushInputStep();
    stopCapture();
    hideRecorderOverlay();
    Channel.send('__recorder_stop', {}, () => {
      dispatch({ type: 'SET_RECORDING', payload: { isRecording: false, stepCount: 0 } });
      submitRecording();
    });
  }, [dispatch, flushInputStep, stopCapture, submitRecording]);

  /** 取消录制（丢弃所有步骤，不提交审计） */
  const cancelRecording = useCallback(() => {
    stopCapture();
    hideRecorderOverlay();
    Channel.send('__recorder_stop', {}, () => {
      dispatch({ type: 'SET_RECORDING', payload: { isRecording: false, stepCount: 0 } });
    });
    // 清理 background 录制状态
    Channel.send('__recorder_cancel_audit', {});
  }, [dispatch, stopCapture]);

  /** 取消审计（释放 AI 处理） */
  const cancelAuditing = useCallback(() => {
    dispatch({ type: 'SET_RECORDER_AUDITING', payload: false });
    Channel.send('__recorder_cancel_audit', {});
  }, [dispatch]);

  /** 开始录制 */
  const startRecording = useCallback(() => {
    const s = stateRef.current;
    if (s.isRecording || s.currentTask?.status === 'running' || s.isRecorderAuditing) return;

    Channel.send('__recorder_start', { tabId: 0, url: window.location.href }, (resp: any) => {
      if (resp?.error) {
        console.warn('[Actspan] 开始录制失败:', resp.error);
        return;
      }
      stepCountRef.current = 0;
      dispatch({ type: 'SET_RECORDING', payload: { isRecording: true, stepCount: 0 } });
      startCapture();
      // 传入完成和取消回调供 overlay 按钮使用
      showRecorderOverlay(
        () => stopRecordingRef.current?.(),
        () => cancelRecordingRef.current?.(),
      );
      updateRecorderStepCount(0);
    });
  }, [dispatch, startCapture]);

  // 用 ref 保存录制完成和取消回调
  const stopRecordingRef = useRef(stopRecording);
  stopRecordingRef.current = stopRecording;
  const cancelRecordingRef = useRef(cancelRecording);
  cancelRecordingRef.current = cancelRecording;

  // 页面导航后 content script 会重载，从 background 恢复录制状态
  useEffect(() => {
    let mounted = true;
    Channel.send('__recorder_state', {}, (rawState: unknown) => {
      if (!mounted || stateRef.current.isRecording) return;

      const recovery = getRecorderRecovery(rawState);
      if (!recovery) return;

      stepCountRef.current = recovery.stepCount;
      dispatch({ type: 'SET_RECORDING', payload: { isRecording: true, stepCount: recovery.stepCount } });
      startCapture();
      showRecorderOverlay(
        () => stopRecordingRef.current?.(),
        () => cancelRecordingRef.current?.(),
        recovery.startedAt,
      );
      updateRecorderStepCount(recovery.stepCount);
    });

    return () => {
      mounted = false;
    };
  }, [dispatch, startCapture]);

  // 录制所有权转移到由当前页面打开的新 Tab 后，旧页面只清理本地 UI。
  // background 中的步骤和计时继续保留，不重新发送 __recorder_start。
  useEffect(() => {
    const handler = () => {
      stopCapture();
      hideRecorderOverlay();
      dispatch({ type: 'SET_RECORDING', payload: { isRecording: false, stepCount: 0 } });
    };
    Channel.on('__recorder_transfer', handler);
    return () => {
      Channel.off('__recorder_transfer', handler);
    };
  }, [dispatch, stopCapture]);


  // 监听审计完成事件
  useEffect(() => {
    const handler = (data: any) => {
      dispatch({ type: 'SET_RECORDER_AUDITING', payload: false });

      if (!data?.sessionId) {
        console.warn('[Actspan] 审计失败:', data?.error);
        return;
      }

      // 创建本地任务以接收后续的对话流式事件
      dispatch({
        type: 'SET_TASK',
        payload: {
          id: data.sessionId,
          query: '录制并保存的工作流',
          title: buildTaskTitle('录制并保存的工作流'),
          status: 'running',
          resultHtml: '',
          callStack: [],
          errorMsg: '',
          lastAIText: '',
          agentPhase: 'plan',
          agentRound: 0,
          failureCode: '',
          liveStatusText: '',
          startedAt: Date.now(),
          endedAt: null,
          durationMs: null,
          taskKind: 'aux',
        },
      });

      // 打开面板展示审计结果
      dispatch({ type: 'TOGGLE_OPEN', payload: true });
      // 主界面位于 Side Panel；审计结束后主动打开，避免完成事件只更新不可见的 content 状态。
      Channel.send('__open_side_panel', {});
    };

    Channel.on('__recorder_audit_done', handler);
    return () => {
      Channel.off('__recorder_audit_done', handler);
    };
  }, [dispatch]);

  // 组件卸载时清理事件捕获和 overlay
  useEffect(() => {
    return () => {
      stopCapture();
      hideRecorderOverlay();
    };
  }, [stopCapture]);

  return { startRecording, stopRecording, cancelAuditing };
};
