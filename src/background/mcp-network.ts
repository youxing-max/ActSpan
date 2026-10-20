import { inspectNetworkCapture } from '../functions/cdp-network';
import type { TaskContext } from './task-types';

/** The bridge resolves and authorizes the task tab before entering this dispatcher. */
export async function handleMcpNetwork(method: string, params: Record<string, unknown>, context: TaskContext, tabId: number) {
  const mode = method.slice('network.'.length);
  if (!['list', 'detail', 'query'].includes(mode) || !method.startsWith('network.')) {
    throw new Error(`Unsupported network operation: ${method}`);
  }
  if (!Number.isInteger(tabId) || tabId <= 0 || (context.tabId !== undefined && context.tabId !== tabId) || (params.tabId !== undefined && params.tabId !== tabId)) {
    throw new Error('Network inspection requires a task-authorized tabId');
  }
  if (params.index !== undefined && (!Number.isInteger(params.index) || (params.index as number) < 0)) {
    throw new Error('index must be a nonnegative integer counting backward from the newest matching response');
  }
  if (params.limit !== undefined && (!Number.isInteger(params.limit) || (params.limit as number) < 1 || (params.limit as number) > 2000)) {
    throw new Error('limit must be an integer between 1 and 2000');
  }
  if (params.urlFilter !== undefined && (typeof params.urlFilter !== 'string' || !params.urlFilter.trim())) {
    throw new Error('urlFilter must be a non-empty string');
  }
  if (params.requestId !== undefined && (typeof params.requestId !== 'string' || !params.requestId.trim())) {
    throw new Error('requestId must be a non-empty string');
  }
  if (params.reload !== undefined && typeof params.reload !== 'boolean') throw new Error('reload must be boolean');
  if (params.includeBody !== undefined && typeof params.includeBody !== 'boolean') throw new Error('includeBody must be boolean');
  if (mode === 'query' && !params.urlFilter) throw new Error('Query requires urlFilter from a previously observed request; list first, never guess an endpoint');
  if (mode === 'detail' && !params.urlFilter && !params.requestId) throw new Error('Detail requires requestId or urlFilter from a previously observed request');
  if (params.requestId && params.urlFilter) throw new Error('Select a request by requestId or urlFilter, not both');
  if (params.requestId && params.reload) throw new Error('Reload cannot retrieve an old requestId; use urlFilter instead');
  return inspectNetworkCapture(tabId, {
    mode: mode as 'list' | 'detail' | 'query',
    urlFilter: params.urlFilter as string | undefined,
    requestId: params.requestId as string | undefined,
    index: params.index as number | undefined,
    limit: params.limit as number | undefined,
    reload: params.reload as boolean | undefined,
    includeBody: params.includeBody as boolean | undefined,
  }, context.signal);
}
