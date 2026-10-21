/**
 * 录制步骤脱敏
 *
 * 录制的工作流会发送给第三方 LLM 审计并持久化，密码、验证码、银行卡等
 * 字段的字面值绝不能离开页面。content 侧按真实 DOM 属性识别，background
 * 侧再按选择器/语义提示兜底（不信任 content 传入的数据）。
 */

export const REDACTED_RECORDED_VALUE = '[已填写，值已隐藏]';

/** 字段名/属性中的敏感关键词（英文 + 中文提示词） */
const SENSITIVE_NAME_PATTERN = /(?:password|passwd|pwd|passcode|pass[-_ ]?code|otp|one[-_ ]?time|verification[-_ ]?code|auth[-_ ]?code|security[-_ ]?code|credit[-_ ]?card|card[-_ ]?number|cc[-_ ]?(?:number|name|exp|csc|cvv)|cvc|cvv|ssn|social[-_ ]?security|iban|bank[-_ ]?account|api[-_ ]?key|secret|private[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|密码|口令|验证码|动态码|短信码|银行卡|卡号|安全码|身份证|密钥)/i;

/** autocomplete 中的敏感令牌 */
const SENSITIVE_AUTOCOMPLETE_PATTERN = /(?:current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year|cc-name)/i;

export interface RecordedFieldMeta {
  tag?: string;
  selector?: string;
  semanticHint?: string;
  /** DOM 的 input type（仅 content 侧可提供） */
  inputType?: string;
  /** DOM 的 autocomplete 属性（仅 content 侧可提供） */
  autocomplete?: string;
}

/** 判断被录制的字段是否属于敏感字段 */
export const isSensitiveRecordedField = (meta: RecordedFieldMeta): boolean => {
  const inputType = (meta.inputType || '').toLowerCase();
  if (inputType === 'password') return true;
  if (meta.autocomplete && SENSITIVE_AUTOCOMPLETE_PATTERN.test(meta.autocomplete)) return true;
  return [meta.tag, meta.selector, meta.semanticHint]
    .some((value) => typeof value === 'string' && SENSITIVE_NAME_PATTERN.test(value));
};

/**
 * 对包含 value 的录制步骤脱敏；非敏感步骤原样返回。
 * 使用宽松结构，content 与 background 两侧都能复用。
 */
export const redactRecordedStep = <T extends { value?: unknown }>(
  step: T,
  meta: RecordedFieldMeta,
): T => {
  if (step.value === undefined || step.value === null || step.value === '') return step;
  if (!isSensitiveRecordedField(meta)) return step;
  return { ...step, value: REDACTED_RECORDED_VALUE };
};
