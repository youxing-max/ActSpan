import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `export { MCPServer } from './src/mcp/server.ts';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { MCPServer } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

test('returns structured diagnostics for failed tool executions', async () => {
  const server = new MCPServer();
  server.registerTool({
    name: 'probe',
    description: 'probe',
    parameters: { type: 'object', properties: {} },
    supportsParallel: false,
    execute: async () => ({ success: false, error: '未找到目标元素' }),
  });

  const response = await server.handleRequest('tools/call', {
    name: 'probe',
    arguments: {},
  });
  const result = JSON.parse(response.content[0].text);

  assert.equal(response.isError, true);
  assert.match(result.diagnostic.action, /probe/);
  assert.match(result.diagnostic.observed, /未找到目标元素/);
  assert.match(result.diagnostic.next, /检查|改用|重试/);
});

test('returns diagnostics when a tool throws during execution', async () => {
  const server = new MCPServer();
  server.registerTool({
    name: 'explode',
    description: 'explode',
    parameters: { type: 'object', properties: {} },
    supportsParallel: false,
    execute: async () => { throw new Error('调试器未连接'); },
  });

  const response = await server.handleRequest('tools/call', {
    name: 'explode',
    arguments: {},
  });
  const result = JSON.parse(response.content[0].text);

  assert.equal(response.isError, true);
  assert.match(result.diagnostic.action, /explode/);
  assert.match(result.diagnostic.observed, /调试器未连接/);
  assert.match(result.diagnostic.next, /检查|改用|重试/);
});

test('returns diagnostics for unknown tools', async () => {
  const server = new MCPServer();
  const response = await server.handleRequest('tools/call', {
    name: 'missing_tool',
    arguments: {},
  });
  const result = JSON.parse(response.content[0].text);

  assert.equal(response.isError, true);
  assert.match(result.diagnostic.action, /missing_tool/);
  assert.match(result.diagnostic.observed, /不存在/);
  assert.match(result.diagnostic.next, /检查|改用|重试/);
});

const tool = (name, execute = async () => ({ success: true, data: name })) => ({
  name,
  description: `${name} description`,
  parameters: {
    type: 'object',
    properties: { keyword: { type: 'string', minLength: 2 } },
    required: ['keyword'],
  },
  supportsParallel: true,
  execute,
});

test('lists complete MCP tool schemas and supports manifest replacement', async () => {
  const server = new MCPServer();
  server.registerTool(tool('first'));
  let listed = await server.handleRequest('tools/list');
  assert.deepEqual(listed.tools[0], {
    name: 'first',
    description: 'first description',
    inputSchema: tool('first').parameters,
    supportsParallel: true,
  });

  server.replaceManifest({ tools: [tool('second')] });
  listed = await server.handleRequest('tools/list');
  assert.deepEqual(listed.tools.map(({ name }) => name), ['second']);
  assert.equal(server.hasTool('first'), false);
  assert.equal(server.unregisterTool('second'), true);
});

test('returns structured errors for invalid params and unknown methods', async () => {
  const server = new MCPServer();
  server.registerTool(tool('validate'));
  const invalid = await server.handleRequest('tools/call', { name: 'validate', arguments: { keyword: 'x' } });
  assert.equal(invalid.isError, true);
  assert.match(JSON.parse(invalid.content[0].text).error, /参数校验失败/);

  const unknown = await server.handleRequest('unknown/method');
  assert.equal(unknown.error.code, -32601);
  assert.match(unknown.error.message, /不支持/);
});

test('passes AbortSignal to handlers and returns cancellation result', async () => {
  const server = new MCPServer();
  let observedSignal;
  server.registerTool(tool('slow', async (_args, context) => {
    observedSignal = context.signal;
    await new Promise(resolve => setTimeout(resolve, 100));
    return { success: true };
  }));
  const controller = new AbortController();
  const pending = server.handleRequest('tools/call', { name: 'slow', arguments: { keyword: 'ok' } }, controller.signal);
  controller.abort();
  const result = await pending;
  assert.equal(observedSignal, controller.signal);
  assert.equal(result.isError, true);
  assert.match(JSON.parse(result.content[0].text).error, /aborted/);
});

test('passes exact task ownership metadata to tool handlers', async () => {
  const server = new MCPServer();
  let observedContext;
  server.registerTool(tool('owned', async (_args, context) => {
    observedContext = context;
    return { success: true };
  }));
  await server.handleRequest('tools/call', {
    name: 'owned',
    arguments: { keyword: 'ok' },
    _meta: {
      clientId: 'client-a',
      requestId: 'request-a',
      taskId: 'task-a',
      sessionId: 'session-a',
      owner: 'extension-agent',
      tabId: 42,
    },
  });
  assert.deepEqual({
    clientId: observedContext.clientId,
    requestId: observedContext.requestId,
    taskId: observedContext.taskId,
    sessionId: observedContext.sessionId,
    owner: observedContext.owner,
    tabId: observedContext.tabId,
  }, {
    clientId: 'client-a',
    requestId: 'request-a',
    taskId: 'task-a',
    sessionId: 'session-a',
    owner: 'extension-agent',
    tabId: 42,
  });
});
