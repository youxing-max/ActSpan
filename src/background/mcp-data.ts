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
export const registerDataCapabilityHandlers = (registerCapabilityHandler: Register): void => {
  registerCapabilityHandler('data.fetch', (input, context) => execute(fetchUrlFunction, input, context), 'read');
  registerCapabilityHandler('data.fetch_chunk', async (input, context) => readBinaryTransferChunk(input as any, toolContext(input, context) as any), 'read');
  registerCapabilityHandler('data.fetch_release', async (input, context) => releaseBinaryTransfer(input as any, toolContext(input, context) as any), 'read');
  registerCapabilityHandler('data.paginate', (input, context) => execute({ ...paginateFunction, execute: fetchPaginatedPage }, input, context), 'read');
  registerCapabilityHandler('data.paginate_page', (input, context) => execute({ ...paginateFunction, execute: fetchPaginatedPage }, input, context), 'read');
  registerCapabilityHandler('data.download', (input, context) => execute(downloadFileFunction, input, context), 'interact');
};
