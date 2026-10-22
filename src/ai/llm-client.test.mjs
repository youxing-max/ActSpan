import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `
      export { chatComplete, chatStream, getAISettings } from './src/ai/llm-client.ts';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { chatComplete, chatStream, getAISettings } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

const CHAT_ENDPOINT = 'https://localhost/v1/chat/completions';

const chatSettings = {
  apiKey: 'test-key',
  endpoint: CHAT_ENDPOINT,
  model: 'local-model',
  apiMode: 'chat_completions',
};

const responsesSettings = {
  apiKey: 'test-key',
  endpoint: 'https://api.example/v1/responses',
  model: 'gpt',
};

const installChrome = (settings) => {
  globalThis.chrome = {
    storage: {
      local: {
        async get() {
          return {
            actspan_ai_settings: settings,
            actspan_migrated_actspan_ai_settings: true,
          };
        },
        async set() {},
      },
    },
  };
};

const installFetch = (handler) => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return handler(calls.length - 1);
  };
  return calls;
};

const sseResponse = (rows) => new Response(
  [...rows.map((row) => `data: ${JSON.stringify(row)}`), 'data: [DONE]', ''].join('\n'),
  { headers: { 'content-type': 'text/event-stream' } },
);

const collect = async (generator) => {
  const chunks = [];
  for await (const chunk of generator) chunks.push(chunk);
  return chunks;
};

const tool = {
  type: 'function',
  name: 'send_message',
  description: 'send a message',
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
};

test('chatComplete posts chat/completions messages and parses message + tool_calls', async () => {
  installChrome(chatSettings);
  const calls = installFetch(() => new Response(JSON.stringify({
    id: 'chatcmpl-1',
    choices: [{
      message: {
        role: 'assistant',
        content: 'done',
        tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'page', arguments: '{"op":"get"}' } }],
      },
      finish_reason: 'tool_calls',
    }],
  }), { headers: { 'content-type': 'application/json' } }));

  const result = await chatComplete(
    [
      { role: 'user', content: 'hello' },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'send_message', arguments: '{"text":"hi"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"success":true}' },
    ],
    [tool],
    'you are helpful',
    undefined,
    'required',
  );

  assert.equal(calls[0].url, CHAT_ENDPOINT);
  assert.deepEqual(calls[0].body.messages, [
    { role: 'system', content: 'you are helpful' },
    { role: 'user', content: 'hello' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'send_message', arguments: '{"text":"hi"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '{"success":true}' },
  ]);
  assert.equal(calls[0].body.input, undefined);
  assert.equal(calls[0].body.max_tokens, 16384);
  assert.deepEqual(calls[0].body.tools, [{
    type: 'function',
    function: { name: 'send_message', description: 'send a message', parameters: tool.parameters },
  }]);
  assert.equal(calls[0].body.tool_choice, 'required');

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.output, [
    { type: 'message', id: 'chatcmpl-1', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
    { type: 'function_call', id: 'call_2', call_id: 'call_2', name: 'page', arguments: '{"op":"get"}' },
  ]);
});

test('chatStream streams chat/completions delta content until finish_reason stop', async () => {
  installChrome(chatSettings);
  const calls = installFetch(() => sseResponse([
    { choices: [{ delta: { role: 'assistant', content: 'Hel' } }] },
    { choices: [{ delta: { content: 'lo' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]));

  const chunks = await collect(chatStream([{ role: 'user', content: 'hi' }], undefined, 'system prompt'));

  assert.deepEqual(calls[0].body.messages, [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'hi' },
  ]);
  assert.equal(calls[0].body.stream, true);
  assert.equal(calls[0].body.input, undefined);
  assert.equal(chunks.map((chunk) => chunk.delta || '').join(''), 'Hello');
  assert.equal(chunks.at(-1).done, true);
  assert.equal(chunks.at(-1).unrecognizedEventCount, 0);
});

test('chatStream emits an assistant message output item so replies survive in context', async () => {
  installChrome(chatSettings);
  installFetch(() => sseResponse([
    { choices: [{ delta: { role: 'assistant', content: '最终' } }] },
    { choices: [{ delta: { content: '回答' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]));

  const chunks = await collect(chatStream([{ role: 'user', content: 'hi' }]));
  const message = chunks.map((chunk) => chunk.outputItem).find((item) => item?.type === 'message');

  assert.equal(message?.role, 'assistant');
  assert.deepEqual(message?.content, [{ type: 'output_text', text: '最终回答' }]);
  assert.match(message.id, /^chat_msg_/);
});

test('chatStream aggregates fragmented tool_calls into one function_call output item', async () => {
  installChrome(chatSettings);
  installFetch(() => sseResponse([
    {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_9',
            type: 'function',
            function: { name: 'pa', arguments: '{"op":' },
          }],
        },
      }],
    },
    {
      choices: [{
        delta: {
          tool_calls: [{ index: 0, function: { name: 'ge', arguments: '"get"}' } }],
        },
      }],
    },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]));

  const chunks = await collect(chatStream(
    [{ role: 'user', content: 'open page' }],
    [tool],
    'system prompt',
  ));

  const callItems = chunks.filter((chunk) => chunk.outputItem);
  assert.equal(callItems.length, 1);
  assert.deepEqual(callItems[0].outputItem, {
    type: 'function_call',
    id: 'call_9',
    call_id: 'call_9',
    name: 'page',
    arguments: '{"op":"get"}',
  });
  assert.deepEqual(JSON.parse(callItems[0].outputItem.arguments), { op: 'get' });
  assert.equal(chunks.at(-1).done, true);
  assert.equal(chunks.at(-1).unrecognizedEventCount, 0);
});

test('default apiMode keeps the Responses request shape', async () => {
  installChrome(responsesSettings);
  const calls = installFetch(() => new Response(JSON.stringify({
    output: [{ type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
    status: 'completed',
  }), { headers: { 'content-type': 'application/json' } }));

  const settings = await getAISettings();
  assert.equal(settings.apiMode, 'responses');

  const result = await chatComplete([{ role: 'user', content: 'hi' }], [tool], 'sys');

  assert.equal(calls[0].body.messages, undefined);
  assert.equal(calls[0].body.input.length, 2);
  assert.equal(calls[0].body.input[0].role, 'developer');
  assert.equal(calls[0].body.max_output_tokens, 16384);
  assert.equal(calls[0].body.instructions, 'sys');
  assert.deepEqual(calls[0].body.tools, [tool]);
  assert.equal(calls[0].body.parallel_tool_calls, false);
  assert.deepEqual(result.output, [
    { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
  ]);
});

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('chatComplete forwards input_image parts as chat/completions image_url content', async () => {
  installChrome(chatSettings);
  const calls = installFetch(() => new Response(JSON.stringify({
    id: 'chatcmpl-img',
    choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  }), { headers: { 'content-type': 'application/json' } }));

  await chatComplete([
    {
      role: 'user',
      content: [
        { type: 'input_text', text: 'what is this?' },
        { type: 'input_image', image_url: PNG_DATA_URL },
      ],
    },
  ]);

  assert.deepEqual(calls[0].body.messages, [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: PNG_DATA_URL } },
      ],
    },
  ]);
});

test('chatComplete keeps pure-text part arrays as plain string content', async () => {
  installChrome(chatSettings);
  const calls = installFetch(() => new Response(JSON.stringify({
    id: 'chatcmpl-text',
    choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  }), { headers: { 'content-type': 'application/json' } }));

  await chatComplete([
    {
      role: 'user',
      content: [
        { type: 'input_text', text: 'line one' },
        { type: 'input_text', text: 'line two' },
      ],
    },
  ]);

  assert.deepEqual(calls[0].body.messages, [
    { role: 'user', content: 'line one\nline two' },
  ]);
});

test('chatStream treats standard Responses lifecycle events as recognized', async () => {
  installChrome(responsesSettings);
  installFetch(() => sseResponse([
    { type: 'response.created' },
    { type: 'response.in_progress' },
    { type: 'response.output_item.added', item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] } },
    { type: 'response.content_part.added' },
    { type: 'response.output_text.delta', delta: 'OK' },
    { type: 'response.output_text.done' },
    { type: 'response.content_part.done' },
    {
      type: 'response.output_item.done',
      item: { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] },
    },
    { type: 'response.completed' },
  ]));

  const chunks = await collect(chatStream([{ role: 'user', content: 'hi' }]));

  assert.equal(chunks.map((chunk) => chunk.delta || '').join(''), 'OK');
  assert.equal(chunks.at(-1).done, true);
  assert.equal(chunks.at(-1).unrecognizedEventCount, 0);
});

test('chatStream accepts data: without a space and skips SSE comment lines', async () => {
  installChrome(chatSettings);
  globalThis.fetch = async () => new Response([
    ': keep-alive',
    'data:{"choices":[{"delta":{"role":"assistant","content":"OK"}}]}',
    'data:{"choices":[{"delta":{},"finish_reason":"stop"}]}',
    'data:[DONE]',
    '',
  ].join('\n'), { headers: { 'content-type': 'text/event-stream' } });

  const chunks = await collect(chatStream([{ role: 'user', content: 'hi' }]));
  assert.equal(chunks.map((chunk) => chunk.delta || '').join(''), 'OK');
  assert.equal(chunks.at(-1).done, true);
  assert.equal(chunks.at(-1).unrecognizedEventCount, 0);
});
