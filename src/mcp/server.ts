/**
 * MCP Server 实现
 * 管理工具注册，处理 tools/list 和 tools/call 请求
 * 内部使用 FunctionDefinition 作为工具实现载体
 */

import type { FunctionDefinition } from '../functions/types';
import { buildToolDiagnostic, withToolDiagnostic } from '../functions/diagnostics';

import { validateSchema } from './validator';
import type {
  MCPTool,
  MCPToolCallRequest,
  MCPToolCallResult,
  MCPListToolsResponse,
  MCPErrorResponse,
  MCPMethod,
  MCPToolManifest,
} from './types';

type MCPRequestResult = MCPListToolsResponse | MCPToolCallResult | MCPErrorResponse;

const protocolError = (code: number, message: string, data?: Record<string, unknown>): MCPErrorResponse => ({
  error: { code, message, ...(data ? { data } : {}) },
});


export class MCPServer {
  /** 已注册的工具函数映射（name → FunctionDefinition） */
  private tools: Map<string, FunctionDefinition> = new Map();

  /**
   * 注册一个工具函数
   * @param tool 工具函数定义
   */
  registerTool(tool: FunctionDefinition): void {
    this.tools.set(tool.name, tool);
  }
  /** 批量注册工具；同名工具按 manifest 顺序覆盖。 */
  registerTools(tools: FunctionDefinition[]): void {
    for (const tool of tools) this.registerTool(tool);
  }

  /** 用一个 manifest 替换当前工具集合。 */
  replaceManifest(manifest: MCPToolManifest | FunctionDefinition[]): void {
    const tools = Array.isArray(manifest) ? manifest : manifest.tools;
    this.tools.clear();
    this.registerTools(tools);
  }

  /**
   * 取消注册工具
   * @param name 工具名
   */
  unregisterTool(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * 判断工具是否存在
   * @param name 工具名
   */
  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * 处理 MCP 请求
   * @param method 请求方法（tools/list 或 tools/call）
   * @param params 请求参数
   * @returns 响应结果
   */
  async handleRequest(method: MCPMethod | string, params?: unknown, signal?: AbortSignal): Promise<MCPRequestResult> {
    switch (method) {
      case 'tools/list':
        return this.handleListTools();
      case 'tools/call':
        return this.handleCallTool(params, signal);
      default:
        return protocolError(-32601, `不支持的 MCP 方法: ${method}`, { method });
    }
  }

  /**
   * 处理 tools/list 请求
   * 返回所有已注册工具的 MCP 格式定义
   */
  private handleListTools(): MCPListToolsResponse {
    const tools: MCPTool[] = [];
    for (const [, funcDef] of this.tools) {
      tools.push({
        name: funcDef.name,
        description: funcDef.description,
        inputSchema: funcDef.parameters,
        supportsParallel: funcDef.supportsParallel === true,
      });
    }
    return { tools };
  }

  /** 处理 tools/call 请求并校验 JSON-RPC 参数形状。 */
  private async handleCallTool(rawRequest: unknown, inheritedSignal?: AbortSignal): Promise<MCPToolCallResult> {
    if (!rawRequest || typeof rawRequest !== 'object' || Array.isArray(rawRequest)) {
      return {
        content: [{ type: 'text', text: JSON.stringify(protocolError(-32602, 'tools/call 参数必须是对象')) }],
        isError: true,
      };
    }
    const request = rawRequest as MCPToolCallRequest;
    const { name, arguments: rawArgs, _meta } = request;
    if (typeof name !== 'string' || !name.trim()) {
      return {
        content: [{ type: 'text', text: JSON.stringify(protocolError(-32602, 'tools/call 缺少工具名')) }],
        isError: true,
      };
    }
    if (rawArgs !== undefined && (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs))) {
      return {
        content: [{ type: 'text', text: JSON.stringify(protocolError(-32602, 'tools/call arguments 必须是对象')) }],
        isError: true,
      };
    }
    const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
    const signal = request.signal || inheritedSignal;
    const failure = (error: string, extra: Record<string, unknown> = {}): MCPToolCallResult => ({
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: false,
          error,
          ...extra,
          diagnostic: buildToolDiagnostic(name, args, error),
        }),
      }],
      isError: true,
    });

    const funcDef = this.tools.get(name);
    if (!funcDef) return failure(`工具 ${name} 不存在`);

    // Preserve task ownership metadata for tools that must bind effects to one exact session.
    const context = {
      ...(typeof _meta?.clientId === 'string' ? { clientId: _meta.clientId } : {}),
      ...(typeof _meta?.requestId === 'string' ? { requestId: _meta.requestId } : {}),
      ...(typeof _meta?.taskId === 'string' ? { taskId: _meta.taskId } : {}),
      ...(typeof _meta?.sessionId === 'string' ? { sessionId: _meta.sessionId } : {}),
      ...(_meta?.owner === 'ide-agent' || _meta?.owner === 'extension-agent' || _meta?.owner === 'user' ? { owner: _meta.owner } : {}),
      ...(typeof _meta?.tabId === 'number' ? { tabId: _meta.tabId } : {}),
      ...(_meta?.isolatedDebug === true ? { isolatedDebug: true } : {}),
      ...(_meta?.debugTabIds instanceof Set ? { debugTabIds: _meta.debugTabIds as Set<number> } : {}),
      signal,
    };
    if (signal?.aborted) {
      return failure('aborted by user', { code: 'E_CANCELLED', retryable: true });
    }

    const schemaValidation = validateSchema(funcDef.parameters, args, 'arguments');
    if (!schemaValidation.valid) {
      return failure(
        `参数校验失败: ${schemaValidation.errors.slice(0, 3).join('; ')}`,
        { code: 'E_TOOL_PARAM_INVALID', retryable: false },
      );
    }

    if (typeof funcDef.validate === 'function') {
      const customError = funcDef.validate(args);
      if (customError) {
        return failure(`参数校验失败: ${customError}`, { code: 'E_TOOL_PARAM_INVALID', retryable: false });
      }
    }

    try {
      let result;
      const executePromise = funcDef.execute(args, context);
      if (signal) {
        result = await new Promise<Awaited<typeof executePromise>>((resolve, reject) => {
          const onAbort = () => {
            const abortError = new Error('aborted');
            abortError.name = 'AbortError';
            reject(abortError);
          };
          signal.addEventListener('abort', onAbort, { once: true });
          executePromise.then(resolve, reject).finally(() => {
            signal.removeEventListener('abort', onAbort);
          });
        });
      } else {
        result = await executePromise;
      }
      const diagnosedResult = withToolDiagnostic(name, args, result);
      return {
        content: [{ type: 'text', text: JSON.stringify(diagnosedResult) }],
        isError: !diagnosedResult.success,
      };
    } catch (err: any) {
      if (err?.name === 'AbortError' || signal?.aborted) {
        return failure('aborted by user', { code: 'E_CANCELLED', retryable: true });
      }
      return failure(err?.message || '工具执行出错');
    }
  }
}

