import type { FunctionDefinition, ToolExecutionContext } from './types';
import { isCredentialUrl, redactDataPayload, redactSensitive } from './redact';
import { waitForAnySelector, waitForTabComplete, withHiddenTab } from './tab-utils';
import { sendToTabWithRetry } from './tab-message';

const MAX_BINARY_BYTES = 12 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const TRANSFER_TTL_MS = 60_000;
type Transfer = { bytes: Uint8Array; contentType: string; status: number; url: string; taskId?: string; expires: number };
const transfers = new Map<string, Transfer>();
const transferId = () => typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const cleanupTransfers = () => { const now = Date.now(); for (const [id, transfer] of transfers) if (transfer.expires <= now) transfers.delete(id); };
const decodeBase64 = (value: string): Uint8Array => {
  const raw = atob(value);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
};
const encodeBase64 = (bytes: Uint8Array): string => {
  let raw = ''; for (const byte of bytes) raw += String.fromCharCode(byte); return btoa(raw);
};

const fetchBinaryBytes = async (url: string, via: 'extension' | 'page', referer: string | undefined, signal?: AbortSignal): Promise<{ bytes: Uint8Array; contentType: string; status: number; url: string }> => {
  if (via === 'page') {
    const result = await withHiddenTab(url, async (tabId) => {
      await waitForTabComplete(tabId, 24_000, '页面加载超时', signal);
      const injected = await chrome.scripting.executeScript({
        target: { tabId }, world: 'MAIN', args: [url, MAX_BINARY_BYTES],
        func: async (targetUrl: string, limit: number) => {
          const response = await fetch(targetUrl, { credentials: 'include' });
          const body = new Uint8Array(await response.arrayBuffer());
          if (body.byteLength > limit) return { tooLarge: true, status: response.status, statusText: response.statusText, url: response.url };
          let raw = ''; for (const byte of body) raw += String.fromCharCode(byte);
          return { base64: btoa(raw), contentType: response.headers.get('content-type') || 'application/octet-stream', status: response.status, statusText: response.statusText, url: response.url };
        },
      });
      return injected?.[0]?.result;
    }, signal) as any;
    if (!result || result.tooLarge) throw new Error('Binary response exceeds 12MB; use download_file instead.');
    if (result.status < 200 || result.status >= 300) throw new Error(`HTTP ${result.status} ${result.statusText || ''}`.trim());
    return { bytes: decodeBase64(result.base64), contentType: result.contentType, status: result.status, url: result.url || url };
  }
  const response = await fetch(url, { headers: referer ? { Referer: referer } : undefined, signal });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const advertised = Number(response.headers.get('content-length'));
  if (Number.isFinite(advertised) && advertised > MAX_BINARY_BYTES) throw new Error('Binary response exceeds 12MB; use download_file instead.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_BINARY_BYTES) throw new Error('Binary response exceeds 12MB; use download_file instead.');
  return { bytes, contentType: response.headers.get('content-type') || 'application/octet-stream', status: response.status, url: response.url || url };
};

export const startBinaryTransfer = async (params: { url: string; via?: 'extension' | 'page'; referer?: string }, context?: ToolExecutionContext & { taskId?: string }) => {
  cleanupTransfers();
  if (!/^https?:\/\//i.test(params.url)) throw new Error('url must be an http/https link');
  if (isCredentialUrl(params.url)) throw new Error('凭据页面不允许二进制读取');
  const result = await fetchBinaryBytes(params.url, params.via || 'extension', params.referer, context?.signal);
  if (isCredentialUrl(result.url)) throw new Error('凭据页面不允许二进制读取');
  const id = transferId();
  const safeUrl = redactSensitive({ url: result.url }).url;
  transfers.set(id, { bytes: result.bytes, contentType: result.contentType, status: result.status, url: safeUrl, taskId: context?.taskId, expires: Date.now() + TRANSFER_TTL_MS });
  return { transferId: id, url: safeUrl, status: result.status, content_type: result.contentType, bytes: result.bytes.byteLength, chunk_size: CHUNK_BYTES };
};

export const readBinaryTransferChunk = (params: { transferId: string; offset?: number; length?: number }, context?: ToolExecutionContext & { taskId?: string }) => {
  cleanupTransfers();
  const transfer = transfers.get(params.transferId);
  if (!transfer) throw new Error('TRANSFER_NOT_FOUND');
  if (transfer.taskId && transfer.taskId !== context?.taskId) throw new Error('TRANSFER_FORBIDDEN');
  const offset = Math.max(0, Math.floor(Number(params.offset) || 0));
  const length = Math.min(CHUNK_BYTES, Math.max(1, Math.floor(Number(params.length) || CHUNK_BYTES)));
  if (offset > transfer.bytes.byteLength) throw new Error('TRANSFER_OFFSET_INVALID');
  const end = Math.min(transfer.bytes.byteLength, offset + length);
  const done = end >= transfer.bytes.byteLength;
  const data = { transferId: params.transferId, offset, length: end - offset, total: transfer.bytes.byteLength, base64: encodeBase64(transfer.bytes.slice(offset, end)), done, status: transfer.status, content_type: transfer.contentType };
  if (done) transfers.delete(params.transferId); else transfer.expires = Date.now() + TRANSFER_TTL_MS;
  return data;
};

export const releaseBinaryTransfer = (params: { transferId: string }, context?: ToolExecutionContext & { taskId?: string }) => {
  const transfer = transfers.get(params.transferId);
  if (transfer?.taskId && transfer.taskId !== context?.taskId) throw new Error('TRANSFER_FORBIDDEN');
  transfers.delete(params.transferId); return { released: true };
};

export const fetchUrlFunction: FunctionDefinition = {
  name: 'fetch_url',
  description: 'Fetch webpage content or binary data. Binary requests default to extension-worker fetch for cross-origin/CORS-safe access; use via:"page" only when the origin requires page Referer/cookies. Binary inline transfer is capped at 12MB; use download_file for larger files.',
  supportsParallel: true,
  permissionLevel: 'read',
  parameters: { type: 'object', properties: {
    url: { type: 'string', description: 'Full http/https URL' },
    sections: { type: 'array', items: { type: 'string', enum: ['meta', 'content', 'links', 'headings'] } },
    max_content_length: { type: 'number', description: 'Maximum text characters, default 5000, range 500-10000' },
    binary: { type: 'boolean', description: 'Return a bounded binary transfer descriptor' },
    via: { type: 'string', enum: ['extension', 'page'] }, referer: { type: 'string' },
  }, required: ['url'] },
  validate: (params: { url?: string; via?: string; referer?: string }) => {
    if (!params.url) return 'Missing url';
    if (!/^https?:\/\//i.test(params.url)) return 'url must be an http/https link';
    if (params.via && params.via !== 'extension' && params.via !== 'page') return 'via must be extension or page';
    if (params.referer) { try { if (!/^https?:$/.test(new URL(params.referer).protocol)) return 'referer must be http/https'; } catch { return 'referer must be http/https'; } }
    return null;
  },
  execute: async (params: { url: string; sections?: string[]; max_content_length?: number; binary?: boolean; via?: 'extension' | 'page'; referer?: string }, context?: ToolExecutionContext) => {
    const validationError = fetchUrlFunction.validate?.(params); if (validationError) return { success: false, error: validationError };
    const signal = context?.signal;
    try {
      if (params.binary) return { success: true, data: await startBinaryTransfer(params, context as ToolExecutionContext & { taskId?: string }) };
      const requestedLength = params.max_content_length;
      const maxContentLength = requestedLength === undefined || Number.isNaN(requestedLength) ? 5000 : Math.min(Math.max(Math.floor(requestedLength), 500), 10000);
      return await withHiddenTab(params.url, async (tabId) => {
        await waitForTabComplete(tabId, 24_000, '页面加载超时', signal);
        await waitForAnySelector(tabId, ['body', 'main', 'article', '[role="main"]'], 12_000, 280, signal);
        const response = await sendToTabWithRetry<{ success: boolean; data?: any; error?: string }>(
          tabId, '__parse_page_content',
          { sections: params.sections, max_content_length: maxContentLength },
          { signal, deadlineMs: 12_000, timeoutMessage: '页面内容解析超时', frameId: 0 });
        if (!response || !response.success) return { success: false, error: response?.error || '页面内容解析失败' };
        return { success: true, data: redactDataPayload(response.data, response.data?.url || params.url) };
      }, signal);
    } catch (err: any) { return { success: false, error: err.message || '获取页面内容失败' }; }
  },
};
