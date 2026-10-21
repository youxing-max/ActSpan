/**
 * CDP JS 执行工具（含 iframe 穿透）
 * 通过 chrome.debugger 在页面中执行 JavaScript 代码
 * 不传 frame_id 时在主 frame 执行（替代原 js_execute）
 * 传 frame_id 时在指定 iframe 中执行（跨域穿透）
 */

import type { FunctionDefinition, FunctionResult, ToolExecutionContext } from './types';
import { CDPSessionManager } from '../lib/cdp-session';

/** 获取当前活动标签页 ID */
const getActiveTabId = (): Promise<number | null> => {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs?.[0]?.id ?? null);
    });
  });
};

/** 将 CDP FrameTree 递归扁平化为列表 */
interface FlatFrame {
  frame_id: string;
  parent_frame_id: string;
  url: string;
  name: string;
  security_origin: string;
  is_main: boolean;
}

const flattenFrameTree = (
  frameTree: any,
  parentFrameId: string = '',
  isMain: boolean = true,
): FlatFrame[] => {
  const result: FlatFrame[] = [];
  const frame = frameTree?.frame;
  if (!frame) return result;

  result.push({
    frame_id: frame.id || '',
    parent_frame_id: parentFrameId,
    url: frame.url || '',
    name: frame.name || '',
    security_origin: frame.securityOrigin || '',
    is_main: isMain,
  });

  const children = frameTree.childFrames;
  if (Array.isArray(children)) {
    for (const child of children) {
      result.push(...flattenFrameTree(child, frame.id, false));
    }
  }

  return result;
};

/** 检测代码是否包含 return 语句，如果包含则包装为 IIFE */
const wrapExpressionIfNeeded = (code: string): string => {
  const trimmed = code.trim();
  // 检测是否包含 return 语句（排除字符串内的 return）
  if (/(?:^|\n)\s*return\s/m.test(trimmed)) {
    return `(function() { ${trimmed} })()`;
  }
  return trimmed;
};

/** V8 throwOnSideEffect 拒绝后的下一步不能靠 agent 猜：错误文案直接给出只读替代工具。 */
const SIDE_EFFECT_REJECTION_HINT = '该表达式无法被证明无副作用，cdp_frame.evaluate 只放行只读表达式。'
  + '读取页面状态请改用 page 的 view/snapshot，或 cdp_dom 的只读查询（query_selector/get_text/get_attributes）；'
  + '页面写入请改用 cdp_input 的 click/click_text/fill/key_press，或 page.click/page.type。';

interface EvaluationExceptionDetails {
  text?: string;
  exception?: { description?: string };
}

const describeEvaluationFailure = (exceptionDetails?: EvaluationExceptionDetails): string => {
  const detail = exceptionDetails?.exception?.description || exceptionDetails?.text || 'JS 执行异常';
  return /side.?effect|副作用/i.test(detail) ? `${detail}：${SIDE_EFFECT_REJECTION_HINT}` : detail;
};

export const cdpFrameFunction: FunctionDefinition = {
  name: 'cdp_frame',
  description: [
    'Execute JavaScript code in the page and return the result. Code runs in the page context with access to the DOM and global variables.',
    'Evaluation is side-effect-free only: Runtime.evaluate runs with V8 throwOnSideEffect, so DOM writes and other observable mutations are rejected. Use cdp_input (click/click_text/fill/key_press) for page writes.',
    'Supports return statements and async/await.',
    'When frame_id is provided, executes in the specified iframe (cross-origin penetration).',
    'Other operations: list=list all frames, snapshot=get frame text content.',
  ].join(' ') + '\n\n⚠️ Do NOT use this tool for:\n- Reading localStorage / sessionStorage (use cdp_dom storage_get_items)\n- Reading or manipulating Cookies (use cdp_network get_cookies / set_cookie)\n- Simple DOM queries (use cdp_dom query_selector)\n- Click or input operations (use cdp_input)\n- Do not bypass dedicated tools for sensitive data by executing JS; those tools have user authorization flows\n- Only use when custom JavaScript execution is truly needed and no dedicated tool is available',
  supportsParallel: true,
  permissionLevel: 'interact',
  // evaluate 能读取 document.cookie / storage / 全局变量；throwOnSideEffect 只拦写入，
  // 不是安全边界，因此必须走敏感审批，避免绕过专用工具的授权流程。
  // snapshot 内部复用 evaluate 读取跨域 iframe 文本，同样必须单独审批。
  actionPermissions: { evaluate: 'sensitive', snapshot: 'sensitive' },
  approvalMessageTemplate: {
    evaluate: 'AI 正在页面上下文中执行自定义 JavaScript，可能读取当前站点数据。是否允许？',
    snapshot: 'AI 正在请求读取 iframe 的正文内容（可能包含跨域敏感数据）',
  },
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'evaluate', 'snapshot'],
        description: 'Action type: list=list all frames, evaluate=execute JS code (main frame by default, provide frame_id to target an iframe), snapshot=get frame text content',
      },
      frame_id: {
        type: 'string',
        description: 'Frame ID (returned by the list action). If not provided for evaluate, executes in the main frame. Required for snapshot.',
      },
      expression: {
        type: 'string',
        description: 'JavaScript code to execute. Supports return statements (auto-wrapped as IIFE). e.g. "return document.title" or "return document.querySelectorAll(\'a\').length"',
      },
      code: {
        type: 'string',
        description: 'Alias for expression, equivalent to expression. When both are provided, expression takes priority.',
      },
      max_length: {
        type: 'number',
        description: 'Maximum length (in characters) of text returned by snapshot, default 3000.',
      },
      tab_id: {
        type: 'number',
        description: 'Target tab ID. Uses the current active tab if not provided.',
      },
    },
    required: ['action'],
  },

  validate: (params: any): string | null => {
    const { action } = params || {};
    if (!action) return 'Missing action parameter';
    if (!['list', 'evaluate', 'snapshot'].includes(action)) {
      return `Unsupported action: ${action}`;
    }
    if (action === 'evaluate') {
      // expression 和 code 都可以，至少一个
      if (!params.expression && !params.code) return 'evaluate action requires expression or code parameter';
    }
    if (action === 'snapshot') {
      if (!params.frame_id) return 'snapshot action requires frame_id parameter';
    }
    return null;
  },

  execute: async (
    params: {
      action: string;
      frame_id?: string;
      expression?: string;
      code?: string;
      max_length?: number;
      tab_id?: number;
    },
    context?: ToolExecutionContext,
  ): Promise<FunctionResult> => {
    const { action, frame_id, max_length = 3000, tab_id } = params;
    // expression 优先，code 作为别名
    const rawExpression = params.expression || params.code || '';

    // 检查取消信号
    if (context?.signal?.aborted) {
      return { success: false, error: '操作已取消' };
    }

    // 确定目标 tabId
    let tabId: number;
    if (typeof tab_id === 'number' && tab_id > 0) {
      tabId = tab_id;
    } else if (typeof context?.tabId === 'number' && context.tabId > 0) {
      tabId = context.tabId;
    } else {
      const activeTabId = await getActiveTabId();
      if (!activeTabId) {
        return { success: false, error: '无法确定目标标签页' };
      }
      tabId = activeTabId;
    }

    switch (action) {
      case 'list': {
        const result = await CDPSessionManager.sendCommand(tabId, 'Page.getFrameTree');
        if (!result.success) {
          return { success: false, error: `获取 frame 树失败: ${result.error}` };
        }
        const frames = flattenFrameTree(result.result?.frameTree);
        return {
          success: true,
          data: {
            frames,
            total: frames.length,
            message: `共 ${frames.length} 个 frame（1 个主 frame + ${frames.length - 1} 个子 iframe）`,
          },
        };
      }

      case 'evaluate': {
        // 静态拦截敏感读取入口：评估表达式不得直接触碰 cookie/storage，
        // 这些数据只能通过带审批的专用工具读取。
        if (/\b(?:document\s*\.\s*cookie|localStorage|sessionStorage|indexedDB)\b/.test(rawExpression)) {
          return {
            success: false,
            error: '不允许通过 evaluate 读取 cookie/storage；请使用 cdp_dom storage_get_items 或 cdp_network get_cookies（需用户授权）。',
          };
        }

        // 自动检测 return 语句并包装为 IIFE
        const finalExpression = wrapExpressionIfNeeded(rawExpression);

        if (frame_id) {
          // ——— 指定 frame 中执行（iframe 穿透） ———
          let contextId = CDPSessionManager.getFrameContextId(tabId, frame_id);

          if (contextId === null) {
            // 验证 frame_id 是否有效
            const treeResult = await CDPSessionManager.sendCommand(tabId, 'Page.getFrameTree');
            if (!treeResult.success) {
              return { success: false, error: `无法验证 frame: ${treeResult.error}` };
            }
            const frames = flattenFrameTree(treeResult.result?.frameTree);
            const targetFrame = frames.find((f) => f.frame_id === frame_id);
            if (!targetFrame) {
              return { success: false, error: `未找到 frame_id: ${frame_id}` };
            }

            // 等待短暂时间再重试（context 可能还没有创建完毕）
            await new Promise((r) => setTimeout(r, 200));
            contextId = CDPSessionManager.getFrameContextId(tabId, frame_id);

            if (contextId === null) {
              return {
                success: false,
                error: `无法获取 frame ${frame_id} 的执行上下文。可能是跨域 iframe 尚未加载完成，请稍后重试。`,
              };
            }
          }

          const evalResult = await CDPSessionManager.sendCommand(tabId, 'Runtime.evaluate', {
            expression: finalExpression,
            contextId,
            returnByValue: true,
            awaitPromise: true,
            timeout: 10_000,
            // 与 page.eval 同一套 V8 副作用拦截：任何写副作用都会让整次求值被拒。
            throwOnSideEffect: true,
          });

          if (!evalResult.success) {
            return { success: false, error: `JS 执行失败: ${evalResult.error}` };
          }

          const remoteResult = evalResult.result?.result;
          if (remoteResult?.subtype === 'error') {
            return { success: false, error: remoteResult.description || 'JS 执行出错' };
          }

          const exceptionDetails = evalResult.result?.exceptionDetails;
          if (exceptionDetails) {
            return { success: false, error: describeEvaluationFailure(exceptionDetails) };
          }

          return {
            success: true,
            data: {
              value: remoteResult?.value,
              type: remoteResult?.type,
              frame_id,
              message: `在 frame ${frame_id} 中执行成功`,
            },
          };
        } else {
          // ——— 主 frame 执行（替代原 js_execute） ———
          const evalResult = await CDPSessionManager.sendCommand(tabId, 'Runtime.evaluate', {
            expression: finalExpression,
            returnByValue: true,
            awaitPromise: true,
            timeout: 10_000,
            // 与 page.eval 同一套 V8 副作用拦截：任何写副作用都会让整次求值被拒。
            throwOnSideEffect: true,
          });

          if (!evalResult.success) {
            return { success: false, error: `JS 执行失败: ${evalResult.error}` };
          }

          const remoteResult = evalResult.result?.result;
          if (remoteResult?.subtype === 'error') {
            return { success: false, error: remoteResult.description || 'JS 执行出错' };
          }

          const exceptionDetails = evalResult.result?.exceptionDetails;
          if (exceptionDetails) {
            return { success: false, error: describeEvaluationFailure(exceptionDetails) };
          }

          return {
            success: true,
            data: {
              result: remoteResult?.value,
              type: remoteResult?.type,
              message: '在主 frame 中执行成功',
            },
          };
        }
      }

      case 'snapshot': {
        // 复用 evaluate 逻辑，执行固定的 innerText 表达式
        const snapshotExpression = 'document.body?.innerText || ""';
        const snapshotResult = await cdpFrameFunction.execute(
          {
            action: 'evaluate',
            frame_id,
            expression: snapshotExpression,
            tab_id,
          },
          context,
        );

        if (!snapshotResult.success) {
          return snapshotResult;
        }

        let text = String(snapshotResult.data?.value || '');
        const originalLength = text.length;
        const maxLen = Math.max(100, Math.min(10000, Math.floor(max_length)));
        if (text.length > maxLen) {
          text = text.substring(0, maxLen) + '…（已截断）';
        }

        return {
          success: true,
          data: {
            text,
            original_length: originalLength,
            truncated: originalLength > maxLen,
            frame_id,
            message: `获取 frame ${frame_id} 文本内容（${originalLength} 字符${originalLength > maxLen ? '，已截断至 ' + maxLen : ''}）`,
          },
        };
      }

      default:
        return { success: false, error: `未知操作: ${action}` };
    }
  },
};
