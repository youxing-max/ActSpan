/** 规范的非数组对象守卫：字段仍是 `unknown`，由调用方按需收窄。 */
export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
