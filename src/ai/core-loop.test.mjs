import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: { contents: `
    export { agenticLoop, buildAgentToolSet } from './src/ai/core-loop.ts';
    export { chatStream } from './src/ai/llm-client.ts';
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { agenticLoop, buildAgentToolSet, chatStream } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

const tool = {
  type: 'function',
  name: 'send_message',
  description: 'test tool',
  parameters: { type: 'object' },
};

const functionCall = (id) => ({
  type: 'function_call',
  id: `fc_${id}`,
  call_id: `call_${id}`,
  name: 'send_message',
  arguments: JSON.stringify({ channel: 'same', text: 'same' }),
});

const sse = (item) => [
  `data: ${JSON.stringify({ type: 'response.output_item.done', item })}`,
  'data: {"type":"response.completed"}',
  '',
].join('\n');

const setupApi = (responses) => {
  globalThis.chrome = {
    storage: {
      local: {
        async get() { return { actspan_ai_settings: { apiKey: 'test', endpoint: 'https://test.invalid', model: 'test' }, actspan_migrated_actspan_ai_settings: true }; },
        async set() {},
      },
    },
  };
  let requestIndex = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const response = responses[Math.min(requestIndex++, responses.length - 1)];
    return new Response(sse(response), { headers: { 'content-type': 'text/event-stream' } });
  };
  return () => requestIndex;
};

test('reports task wall-clock expiry instead of cancellation after multiple rounds', async () => {
  globalThis.chrome = {
    storage: { local: {
      async get() { return { actspan_ai_settings: { apiKey: 'test', endpoint: 'https://test.invalid', model: 'test' } }; },
      async set() {},
    } },
  };
  let requests = 0;
  globalThis.fetch = async (_url, init) => {
    requests++;
    await new Promise(resolve => setTimeout(resolve, 15));
    return new Response(sse(functionCall(requests)), { headers: { 'content-type': 'text/event-stream' } });
  };
  const events = [];
  await agenticLoop(
    [{ role: 'user', content: 'deadline' }], [tool], 'system',
    { maxRounds: 10, maxToolCalls: 20, maxSameSignature: 20, maxContextItems: 300, maxSubtaskDepth: 2, taskDeadlineMs: 5 },
    undefined, undefined, event => events.push(event),
  );
  const errors = events.filter(event => event.type === 'error').map(event => JSON.parse(event.content));
  assert.equal(errors.at(-1).code, 'E_TIMEOUT');
  assert.match(errors.at(-1).message, /任务级墙钟预算已到期/);
  assert.doesNotMatch(errors.at(-1).message, /任务已取消/);
});

test('reports per-call stream timeout as API failure, not task deadline expiry', async () => {
  globalThis.chrome = {
    storage: { local: {
      async get() { return { actspan_ai_settings: { apiKey: 'test', endpoint: 'https://test.invalid', model: 'test' } }; },
      async set() {},
    } },
  };
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback, delay, ...args) => originalSetTimeout(callback, delay === 60_000 ? 0 : delay, ...args));
  globalThis.fetch = async () => new Response(new ReadableStream({ start() {} }), {
    headers: { 'content-type': 'text/event-stream' },
  });
  try {
    const events = [];
    await agenticLoop(
      [{ role: 'user', content: 'per-call timeout' }], [], 'system',
      { maxRounds: 1, maxToolCalls: 1, maxSameSignature: 1, maxContextItems: 30, maxSubtaskDepth: 0, taskDeadlineMs: 1000 },
      undefined, undefined, event => events.push(event),
    );
    const error = events.filter(event => event.type === 'error').map(event => JSON.parse(event.content)).at(-1);
    assert.equal(error.code, 'E_LLM_API');
    assert.match(error.message, /E_TIMEOUT/);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('recognizes Chat Completions delta content and reports unknown SSE shapes', async () => {
  globalThis.chrome = {
    storage: { local: {
      async get() { return { actspan_ai_settings: { apiKey: 'test', endpoint: 'https://test.invalid', model: 'test' } }; },
      async set() {},
    } },
  };
  globalThis.fetch = async () => new Response([
    'data: {"choices":[{"delta":{"content":"hello"}}]}',
    'data: {"mystery":true}',
    'data: [DONE]', '',
  ].join('\n'), { headers: { 'content-type': 'text/event-stream' } });
  const chunks = [];
  for await (const chunk of chatStream([{ role: 'user', content: 'x' }], [], 'system')) chunks.push(chunk);
  assert.equal(chunks.find(chunk => chunk.delta)?.delta, 'hello');
  assert.equal(chunks.at(-1).unrecognizedEventCount, 1);
  globalThis.fetch = async () => new Response([
    'data: {"choices":[{"delta":{"content":"hello"}}]}',
    'data: {"mystery":true}',
    'data: [DONE]', '',
  ].join('\n'), { headers: { 'content-type': 'text/event-stream' } });
  const events = [];
  await agenticLoop(
    [{ role: 'user', content: 'x' }], [], 'system',
    { maxRounds: 1, maxToolCalls: 1, maxSameSignature: 1, maxContextItems: 30, maxSubtaskDepth: 0, taskDeadlineMs: 1000 },
    undefined, undefined, event => events.push(event),
  );
  assert.deepEqual(events.find(event => event.type === 'warning') && JSON.parse(events.find(event => event.type === 'warning').content), {
    code: 'E_SSE_UNRECOGNIZED', count: 1,
  });
});

test('hard-stops the maxSameSignature+1 call and requests a no-tool final response', async () => {
  const getRequestCount = setupApi([
    functionCall(1),
    functionCall(2),
    functionCall(3),
    { type: 'message', id: 'final', role: 'assistant', content: [{ type: 'output_text', text: 'final response' }] },
  ]);
  const events = [];
  const context = await agenticLoop(
    [{ role: 'user', content: 'repeat' }],
    [tool],
    'system',
    { maxRounds: 10, maxToolCalls: 20, maxSameSignature: 2, maxContextItems: 300, maxSubtaskDepth: 2 },
    undefined,
    undefined,
    event => events.push(event),
  );

  assert.equal(events.filter(event => event.type === 'function_call').length, 2);
  assert.equal(getRequestCount(), 4);
  assert.ok(context.some(item => 'type' in item && item.type === 'message' && item.content?.[0]?.text === 'final response'));
  assert.ok(context.some(item => 'role' in item && item.role === 'user' && /基于已有结果给出最终回答/.test(item.content)));
});

test('gives subtask agents the full tool catalog without orchestration-only tools', () => {
  const schemas = [
    { type: 'function', name: 'page', description: 'page', parameters: {} },
    { type: 'function', name: 'cdp_input', description: 'input', parameters: {} },
    { type: 'function', name: 'load_tools', description: 'load', parameters: {} },
    { type: 'function', name: 'agent', description: 'agent', parameters: {} },
    { type: 'function', name: 'todo', description: 'todo', parameters: {} },
    { type: 'function', name: 'compact', description: 'compact', parameters: {} },
  ];

  assert.deepEqual(
    buildAgentToolSet(schemas.slice(0, 2), schemas),
    schemas.slice(0, 3),
  );
});

test('keeps read-only Agent filters scoped to their declared tools', () => {
  const schemas = [
    { type: 'function', name: 'page', description: 'page', parameters: {} },
    { type: 'function', name: 'cdp_input', description: 'input', parameters: {} },
    { type: 'function', name: 'screenshot', description: 'shot', parameters: {} },
  ];

  assert.deepEqual(
    buildAgentToolSet(schemas, schemas, name => name === 'page' || name === 'screenshot').map(tool => tool.name),
    ['page', 'screenshot'],
  );
});
