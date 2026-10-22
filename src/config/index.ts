/** Actspan 配置 */

/** 最大日志数 */
export const MAX_LOG_NUM = 1000;

/** 日志等级 */
export const LOG_LEVEL: 'WARN' | 'ERROR' | 'DEBUG' = 'DEBUG';

/** 应用版本 */
export const VERSION = process.env.APP_VERSION;

/** AI 相关配置 */
export const AI_CONFIG = {
  /** 最大函数调用轮数（防止无限循环） */
  MAX_FUNCTION_ROUNDS: 50,
  /** 单轮会话允许的最大工具调用数（防止长循环） */
  MAX_TOOL_CALLS: 120,
  /** 相同工具+参数的最大重复次数（防止死循环） */
  MAX_SAME_TOOL_CALLS: 5,
  /** OMP anyrouter 的 OpenAI Responses 完整请求地址 */
  DEFAULT_ENDPOINT: 'https://ai-api-gateway.app.baizhi.cloud/api/openai/v1/responses',
  /** 设置页 Endpoint 输入框的占位示例（不是实际默认请求地址） */
  ENDPOINT_PLACEHOLDER: 'https://example/api/openai/v1/responses',
  /** OMP anyrouter 当前默认模型 */
  DEFAULT_MODEL: 'gpt-6.1-sol',
};
