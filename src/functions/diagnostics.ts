import type { ToolDiagnostic } from './types';

type ToolResultLike = {
  success: boolean;
  error?: string;
  diagnostic?: ToolDiagnostic;
};

const actionName = (toolName: string, params: unknown): string => {
  const action = params && typeof params === 'object' && !Array.isArray(params)
    ? (params as Record<string, unknown>).action
    : undefined;
  return typeof action === 'string' && action.trim()
    ? `${toolName}.${action.trim()}`
    : toolName;
};

const nextStepFor = (action: string): string => {
  if (/(snapshot|skeleton|view|assert|repair)/i.test(action)) {
    return '请检查查询范围和页面状态，必要时缩小 scope_selector 或改用更具体的查询后重试';
  }
  if (/(click|fill|select|type|input|scroll|focus|hover)/i.test(action)) {
    return '请先读取最新页面快照或断言确认目标仍存在，再更换定位或动作策略；不要盲目重复写操作';
  }
  return '请检查参数和当前页面状态，读取这条诊断后调整策略再重试';
};

export const buildToolDiagnostic = (
  toolName: string,
  params: unknown,
  error?: unknown,
): ToolDiagnostic => {
  const action = actionName(toolName, params);
  const observed = typeof error === 'string' && error.trim()
    ? error.trim()
    : '工具未返回成功结果';
  return {
    action,
    observed,
    next: nextStepFor(action),
  };
};

export const withToolDiagnostic = <T extends ToolResultLike>(
  toolName: string,
  params: unknown,
  result: T,
): T => {
  if (result.success || result.diagnostic) return result;
  return {
    ...result,
    error: result.error || `${toolName} 执行失败`,
    diagnostic: buildToolDiagnostic(toolName, params, result.error),
  };
};
