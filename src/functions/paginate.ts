import type { FunctionDefinition, FunctionResult, ToolExecutionContext } from './types';
import { isCredentialUrl, redactDataPayload, redactSensitive } from './redact';

const canonical = (value: unknown): string => JSON.stringify(value, Object.keys((value && typeof value === 'object' && !Array.isArray(value)) ? value as object : {}).sort());
const pathValue = (value: any, path?: string): unknown => {
  if (!path) return undefined;
  return path.split('.').filter(Boolean).reduce((current, key) => current == null ? undefined : current[key], value);
};
const withQuery = (url: string, params: Record<string, unknown>): string => {
  const next = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) next.searchParams.set(key, String(value));
  }
  return next.toString();
};

export const paginateFunction: FunctionDefinition = {
  name: 'paginate',
  description: 'Fetch JSON API pages without guessing pagination. Provide param for page-number mode or cursorParam for cursor mode. Stops with an explicit reason: identical_response, non_2xx, max_pages, normal_end, or credential_page (a credential/token URL is never returned). Reports observed response page size rather than trusting requested values. savePath is handled by the MCP server as explicit NDJSON, never by the extension.',
  supportsParallel: false,
  permissionLevel: 'read',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      params: { type: 'object' },
      param: { type: 'string', description: 'Page-number query parameter; required for page mode' },
      cursorParam: { type: 'string', description: 'Cursor query parameter; required for cursor mode' },
      cursorPath: { type: 'string', description: 'Dot path to next cursor in response JSON' },
      maxPages: { type: 'number', minimum: 1, maximum: 100, default: 10 },
      savePath: { type: 'string', description: 'Server-side explicit NDJSON path; never interpreted by extension' },
    },
    required: ['url'],
  },
  validate: (params: any): string | null => {
    if (!params?.url || !/^https?:\/\//i.test(params.url)) return 'url must be an http/https link';
    if (!params.param && !params.cursorParam) return 'Provide param for page pagination or cursorParam for cursor pagination; no pagination parameter was guessed';
    if (params.param && params.cursorParam) return 'param and cursorParam are mutually exclusive';
    if (params.cursorParam && !params.cursorPath) return 'cursorParam requires cursorPath';
    if (params.savePath !== undefined && (typeof params.savePath !== 'string' || !params.savePath.trim())) return 'savePath must be an explicit non-empty path';
    return null;
  },
  execute: async (params: any, context?: ToolExecutionContext): Promise<FunctionResult> => {
    const validationError = paginateFunction.validate?.(params);
    if (validationError) return { success: false, error: validationError };
    const maxPages = Math.min(100, Math.max(1, Math.floor(Number(params.maxPages) || 10)));
    const baseParams = params.params && typeof params.params === 'object' && !Array.isArray(params.params) ? { ...params.params } : {};
    const pages: Array<{ page: number; status: number; data: unknown; requested: Record<string, unknown>; actual_page_size?: number }> = [];
    let cursor = params.cursorParam ? baseParams[params.cursorParam] : undefined;
    let previous = '';
    let stopReason = 'normal_end';
    try {
      for (let index = 0; index < maxPages; index += 1) {
        if (context?.signal?.aborted) return { success: false, error: '操作已取消' };
        const requested = { ...baseParams };
        if (params.param) requested[params.param] = Number(baseParams[params.param] || 1) + index;
        if (params.cursorParam && cursor !== undefined) requested[params.cursorParam] = cursor;
        const response = await fetch(withQuery(params.url, requested), { signal: context?.signal, credentials: 'include' });
        const text = await response.text();
        if (!response.ok) { stopReason = 'non_2xx'; break; }
        if (!text.trim()) { stopReason = 'normal_end'; break; }
        let data: unknown;
        try { data = JSON.parse(text); } catch { data = text; }
        const signature = canonical(data);
        if (previous && signature === previous) { stopReason = 'identical_response'; break; }
        previous = signature;
        const observedSize = [pathValue(data, 'page.ps'), pathValue(data, 'page.pageSize'), pathValue(data, 'page.size'), pathValue(data, 'ps'), pathValue(data, 'page_size'), Array.isArray(data) ? data.length : pathValue(data, 'items') && Array.isArray(pathValue(data, 'items')) ? (pathValue(data, 'items') as unknown[]).length : undefined].find((value) => typeof value === 'number') as number | undefined;
        const pageUrl = response.url || params.url;
        pages.push({ page: index + 1, status: response.status, data: redactDataPayload(data, pageUrl), requested: redactSensitive(requested), ...(observedSize === undefined ? {} : { actual_page_size: observedSize }) });
        if (isCredentialUrl(pageUrl)) { stopReason = 'credential_page'; break; }
        if (params.cursorParam) {
          const next = pathValue(data, params.cursorPath);
          if (next === undefined || next === null || next === '') { stopReason = 'normal_end'; break; }
          cursor = next;
        } else if (Array.isArray(data) && data.length === 0) {
          stopReason = 'normal_end'; break;
        }
        if (index === maxPages - 1) stopReason = 'max_pages';
      }
      return { success: true, data: { pages, page_count: pages.length, stop_reason: stopReason, ...(params.savePath ? { save_path: params.savePath } : {}) } };
    } catch (err: any) {
      return { success: false, error: err?.message || '分页请求失败' };
    }
  },
};

export { pathValue, withQuery };

export const fetchPaginatedPage = async (params: any, context?: ToolExecutionContext): Promise<FunctionResult> => {
  const validationError = paginateFunction.validate?.(params);
  if (validationError) return { success: false, error: validationError };
  const requested = { ...(params.params && typeof params.params === 'object' ? params.params : {}) } as Record<string, unknown>;
  if (params.param) requested[params.param] = Number(params.page || requested[params.param] || 1);
  if (params.cursorParam && params.cursor !== undefined) requested[params.cursorParam] = params.cursor;
  try {
    const response = await fetch(withQuery(params.url, requested), { signal: context?.signal, credentials: 'include' });
    const text = await response.text();
    if (!response.ok) return { success: true, data: { ok: false, status: response.status, stop_reason: 'non_2xx' } };
    if (new TextEncoder().encode(text).byteLength > 64 * 1024) return { success: false, error: 'PAGE_TOO_LARGE' };
    let data: unknown; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    const pageUrl = response.url || params.url;
    if (isCredentialUrl(pageUrl)) return { success: true, data: { ok: false, status: response.status, stop_reason: 'credential_page' } };
    const nextCursor = params.cursorParam ? pathValue(data, params.cursorPath) : undefined;
    const observedSize = [pathValue(data, 'page.ps'), pathValue(data, 'page.pageSize'), pathValue(data, 'page.size'), Array.isArray(data) ? data.length : undefined].find((value) => typeof value === 'number');
    return { success: true, data: { ok: true, status: response.status, data: redactDataPayload(data, pageUrl), nextCursor, actual_page_size: observedSize } };
  } catch (err: any) { return { success: false, error: err?.message || '分页请求失败' }; }
};
 
