import { fetchUrlFunction, readBinaryTransferChunk, releaseBinaryTransfer } from '../functions/fetch-url';
import { downloadFileFunction } from '../functions/download-file';
import { fetchPaginatedPage, paginateFunction } from '../functions/paginate';
import type { TaskContext } from './task-types';
import type { ToolExecutionContext } from '../functions/types';

type Register = (name: string, handler: (input: Record<string, unknown>, context: TaskContext) => Promise<unknown>, policy?: any) => unknown;
const toolContext = (input: Record<string, unknown>, context: TaskContext) => ({ ...context, tabId: typeof input.tabId === 'number' ? input.tabId : typeof input.tab_id === 'number' ? input.tab_id : context.tabId } as ToolExecutionContext & { taskId?: string });
const execute = async (definition: any, input: Record<string, unknown>, context: TaskContext) => {
  const result = await definition.execute(input, toolContext(input, context));
  if (!result?.success) throw new Error(result?.error || `数据工具执行失败: ${definition.name}`);
  return result.data;
};
/** 注册层策略：不得低于工具自身声明。 */
export const DATA_CAPABILITY_POLICIES = {
  'data.fetch': 'sensitive',
  'data.fetch_chunk': 'read',
  'data.fetch_release': 'read',
  'data.paginate': 'sensitive',
  'data.paginate_page': 'sensitive',
  'data.download': 'sensitive',
} as const;
export const registerDataCapabilityHandlers = (registerCapabilityHandler: Register): void => {
  // 注册值不得低于工具自身声明：fetch_url/download_file 是 sensitive，
  // paginate 会携带目标站点登录态，同样按 sensitive 处理。
  registerCapabilityHandler('data.fetch', (input, context) => execute(fetchUrlFunction, input, context), DATA_CAPABILITY_POLICIES['data.fetch']);
  registerCapabilityHandler('data.fetch_chunk', async (input, context) => readBinaryTransferChunk(input as any, toolContext(input, context) as any), DATA_CAPABILITY_POLICIES['data.fetch_chunk']);
  registerCapabilityHandler('data.fetch_release', async (input, context) => releaseBinaryTransfer(input as any, toolContext(input, context) as any), DATA_CAPABILITY_POLICIES['data.fetch_release']);
  registerCapabilityHandler('data.paginate', (input, context) => execute({ ...paginateFunction, execute: fetchPaginatedPage }, input, context), DATA_CAPABILITY_POLICIES['data.paginate']);
  registerCapabilityHandler('data.paginate_page', (input, context) => execute({ ...paginateFunction, execute: fetchPaginatedPage }, input, context), DATA_CAPABILITY_POLICIES['data.paginate_page']);
  registerCapabilityHandler('data.download', (input, context) => execute(downloadFileFunction, input, context), DATA_CAPABILITY_POLICIES['data.download']);
};
