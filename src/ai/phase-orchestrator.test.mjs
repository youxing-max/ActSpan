import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `
      export { getBrowserState, phaseOrchestrator, extractHandoffArtifact, buildHandoffPrompt } from './src/ai/phase-orchestrator.ts';
      export { DEFAULT_BUDGET, FORCE_HANDOFF_ROUNDS } from './src/ai/loop-config.ts';
      export { TodoManager } from './src/ai/todo-manager.ts';
      export { createTodoFunction } from './src/functions/todo.ts';
      export { taskManager } from './src/background/task-manager.ts';
      export { mcpClient } from './src/functions/registry.ts';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const {
  getBrowserState, phaseOrchestrator, extractHandoffArtifact, buildHandoffPrompt, DEFAULT_BUDGET, FORCE_HANDOFF_ROUNDS,
  TodoManager, createTodoFunction, taskManager, mcpClient,
} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

const tabs = [
  { id: 11, url: 'https://user.example/', title: 'User tab', active: true },
  { id: 42, url: 'https://task.example/result', title: 'Task result', active: false },
];

const call = (id, name = 'todo', args = { action: 'list' }) => ({
  type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`,
  name, arguments: JSON.stringify(args),
});
const message = (text = 'Finished') => ({
  type: 'message', id: 'final', role: 'assistant',
  content: [{ type: 'output_text', text }],
});

const setupApi = (responseFor) => {
  globalThis.chrome = {
    tabs: { query: async (query) => query.lastFocusedWindow ? [tabs[0]] : tabs },
    storage: { local: {
      async get() {
        return {
          actspan_ai_settings: { apiKey: 'test', endpoint: 'https://test.invalid', model: 'test' },
          actspan_migrated_actspan_ai_settings: true,
        };
      },
      async set() {},
    } },
  };
  const requests = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://test.invalid/');
    const body = JSON.parse(init.body);
    const item = responseFor(requests.length, body);
    requests.push(body);
    return new Response([
      `data: ${JSON.stringify({ type: 'response.output_item.done', item })}`,
      'data: {"type":"response.completed"}', '',
    ].join('\n'), { headers: { 'content-type': 'text/event-stream' } });
  };
  mcpClient.callTool = async () => ({ content: [{ type: 'text', text: '{"success":true}' }] });
  return requests;
};

const runPhases = async (overrides = {}, options, tools = [], previousContext) => {
  const todoManager = new TodoManager();
  const events = [];
  const context = await phaseOrchestrator(
    'Finish the task', tools, 'system',
    { ...DEFAULT_BUDGET, maxRounds: 60, maxToolCalls: 100, maxSameSignature: 100, ...overrides },
    11, undefined, (event) => events.push(event), options, previousContext,
    todoManager, createTodoFunction(() => todoManager),
  );
  return { context, events };
};

test('browser state follows the task tab instead of the focused tab', async () => {
  const tabs = [
    { id: 11, url: 'https://user.example/', title: 'User tab', active: true },
    { id: 42, url: 'https://task.example/result', title: 'Task result', active: false },
  ];
  globalThis.chrome = {
    tabs: {
      query: async (query) => query.lastFocusedWindow ? [tabs[0]] : tabs,
    },
  };

  const state = await getBrowserState(42);

  assert.equal(state.activeTabId, 42);
  assert.equal(state.currentUrl, 'https://task.example/result');
});

test('handoffs retain a draft and later user intent across two phases without nesting prompts or images', async () => {
  const draft = 'Summary and comment draft: verify the process path and signature before removing malware.';
  const instruction = 'Submit the existing draft only; do not compose a different comment.';
  const requests = setupApi(index => index < FORCE_HANDOFF_ROUNDS * 2 ? call(index) : message());
  const { events } = await runPhases({}, undefined, [], [
    { role: 'user', content: 'Summarize this article and prepare a comment.' },
    { role: 'assistant', content: [{ type: 'output_text', text: draft }] },
    { role: 'user', content: instruction },
    ...Array.from({ length: 25 }, (_, i) => ({ role: 'assistant', content: `Still inspecting the entry control, attempt ${i}.` })),
    { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,RAW_PIXELS' }] },
  ]);
  assert.equal(events.filter(event => event.type === 'phase_handoff').length, 2);
  for (const index of [FORCE_HANDOFF_ROUNDS, FORCE_HANDOFF_ROUNDS * 2]) {
    const input = JSON.stringify(requests[index].input);
    assert.ok(input.includes(draft));
    assert.ok(input.includes(instruction));
    assert.ok(!input.includes('RAW_PIXELS'));
    assert.equal(input.split('## 任务接续').length - 1, 1);
  }
});

test('handoff separates live todos from collected data and carries actionable failures forward', async () => {
  setupApi(() => message());
  const todoManager = new TodoManager();
  todoManager.addBatch(['Summarize article', 'Open comments', 'Submit comment']);
  todoManager.update(1, 'completed', 'Summary is in the conversation');
  const context = [
    call('todos', 'todo', { action: 'list' }),
    { type: 'function_call_output', call_id: 'call_todos', output: JSON.stringify({ success: true, data: { items: [{ id: 1, status: 'pending' }] } }) },
    call('bad-click', 'cdp_input', { action: 'click', selector: '#comment-entry', value: 'PRIVATE_INPUT_MUST_NOT_BE_CARRIED' }),
    { type: 'function_call_output', call_id: 'call_bad-click', output: JSON.stringify({ success: false, error: 'selector is not supported; use page snapshot and snapshot_id' }) },
    { role: 'assistant', content: 'Comment draft: check the process signature.' },
  ];
  const artifact = await extractHandoffArtifact(context, todoManager, 42, 'Finish the comment', 0);
  assert.equal(Object.keys(artifact.collectedData).length, 0);
  assert.match(buildHandoffPrompt(artifact), /cdp_input.*#comment-entry/);
  assert.match(buildHandoffPrompt(artifact), /snapshot_id/);
  assert.doesNotMatch(buildHandoffPrompt(artifact), /PRIVATE_INPUT_MUST_NOT_BE_CARRIED/);
  const next = await extractHandoffArtifact([], todoManager, 42, 'Finish the comment', 1, artifact);
  assert.match(buildHandoffPrompt(next), /#comment-entry/);
  assert.equal(next.recentMessages[0].content, 'Comment draft: check the process signature.');
});

test('retained conversation is bounded and keeps the latest repeated user instruction last', async () => {
  setupApi(() => message());
  const instruction = { role: 'user', content: 'Do not submit anything.' };
  const artifact = await extractHandoffArtifact([
    instruction,
    ...Array.from({ length: 8 }, (_, i) => ({ role: 'assistant', content: `${i}: ${'x'.repeat(7000)}` })),
    instruction,
  ], new TodoManager(), 42, 'Prepare only', 0);
  assert.deepEqual(artifact.recentMessages.at(-1), instruction);
  assert.ok(artifact.recentMessages.reduce((sum, item) => sum + item.content.length, 0) <= 16000);
  assert.ok(artifact.recentMessages.every(item => item.content.length <= 6000));
});

test('a forced handoff gives the next phase its own rounds without empty handoffs', async () => {
  const requests = setupApi((index) => index < FORCE_HANDOFF_ROUNDS ? call(index) : message());
  const { context, events } = await runPhases();

  assert.equal(requests.length, FORCE_HANDOFF_ROUNDS + 1);
  assert.equal(events.filter(event => event.type === 'phase_handoff').length, 1);
  assert.equal(events.some(event => event.type === 'error'), false);
  assert.equal(context.at(-1).content[0].text, 'Finished');
});

for (const limit of ['maxRounds', 'maxToolCalls']) {
  test(`handoffs preserve the cumulative ${limit} budget`, async () => {
    const total = FORCE_HANDOFF_ROUNDS + 2;
    const requests = setupApi((index, body) => body.tools?.length ? call(index) : message());
    const tools = [{ type: 'function', name: 'todo', description: 'todo', parameters: {} }];
    const { events } = await runPhases({ [limit]: total }, undefined, tools);

    assert.equal(requests.length, total + 1);
    assert.equal(events.filter(event => event.type === 'phase_handoff').length, 1);
    assert.equal(requests.at(-1).tools, undefined);
    assert.equal(events.some(event => event.type === 'error'), false);
  });
}

test('handoff and review follow the new task tab and preserve tool identity and denials', async () => {
  const requests = setupApi((index) => {
    if (index === 0) return call(index, 'tab_navigate', { action: 'open', url: tabs[1].url });
    if (index === 1) return call(index, 'cdp_input', { action: 'click' });
    if (index === 2) return call(index, 'todo', { action: 'create', items: ['Open the panel', 'Fill the form', 'Submit the form'] });
    if (index === 3) return call(index, 'todo', { action: 'update', id: 1, status: 'completed' });
    if (index === FORCE_HANDOFF_ROUNDS - 1) return call(index, 'todo', { action: 'update', id: 2, status: 'completed' });
    if (index < FORCE_HANDOFF_ROUNDS) return call(index);
    if (index === FORCE_HANDOFF_ROUNDS) return call(index, 'page', { action: 'read' });
    if (index === FORCE_HANDOFF_ROUNDS + 1) return call(index, 'screenshot', {});
    if (index === FORCE_HANDOFF_ROUNDS + 2) return message('### 审查结果：通过');
    return message();
  });
  const task = taskManager.create({ taskId: 'phase-tab', sessionId: 'phase-session', owner: 'extension-agent', clientId: 'phase-client' });
  taskManager.update(task.taskId, { activeTabId: 11 });
  const toolContext = { taskId: task.taskId, sessionId: task.sessionId, owner: task.owner, clientId: task.clientId, requestId: 'phase-request' };
  const calls = [];
  mcpClient.callTool = async (name, args, context) => {
    calls.push({ name, args, context });
    if (name === 'tab_navigate') taskManager.update(task.taskId, { activeTabId: 42 });
    return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
  };
  const tools = ['todo', 'tab_navigate', 'cdp_input', 'page', 'screenshot'].map(name => ({
    type: 'function', name, description: name, parameters: {},
  }));

  const { events } = await runPhases({}, { toolContext, disallowTools: ['page'] }, tools);

  assert.equal(calls.some(item => item.name === 'page'), false);
  const screenshot = calls.find(item => item.name === 'screenshot');
  assert.ok(screenshot);
  for (const [key, value] of Object.entries({ ...toolContext, tabId: 42 })) {
    assert.equal(screenshot.context[key], value, key);
  }
  const reviewPrompt = requests[FORCE_HANDOFF_ROUNDS].input.find(item => item.role === 'user').content;
  assert.match(reviewPrompt, /https:\/\/task\.example\/result/);
  const handoffPrompt = requests.at(-1).input.find(item => item.role === 'user').content;
  assert.match(handoffPrompt, /当前页面：https:\/\/task\.example\/result/);
  assert.equal(JSON.parse(events.find(event => event.type === 'phase_handoff').content).reason, 'todo_completed');
  assert.equal(events.filter(event => event.type === 'review_completed').length, 1);
  assert.equal(events.some(event => event.type === 'error'), false);
});

for (const hasPlan of [false, true]) {
  test(`round-limit handoff continues unfinished form work without a review (plan=${hasPlan})`, async () => {
    const requests = setupApi((index) => {
      if (index === 0) return call(index, 'cdp_input', { action: 'click' });
      if (index === 1 && hasPlan) return call(index, 'todo', { action: 'create', items: ['Submit the form'] });
      if (index < FORCE_HANDOFF_ROUNDS) return call(index);
      return message('Form work continues in the next phase');
    });
    const { events } = await runPhases({}, undefined, ['todo', 'cdp_input'].map(name => ({
      type: 'function', name, description: name, parameters: {},
    })));
    assert.equal(requests.length, FORCE_HANDOFF_ROUNDS + 1);
    assert.equal(events.filter(event => event.type === 'phase_handoff').length, 1);
    assert.equal(events.some(event => event.type === 'review_started'), false);
    assert.equal(events.some(event => event.type === 'error'), false);
  });
}

test('token-budget handoff continues unfinished work without a review', async () => {
  const requests = setupApi(() => message('Continue the form in the next phase'));
  const previousContext = [
    call('prior-write', 'cdp_input', { action: 'click' }),
    { type: 'function_call_output', call_id: 'call_prior-write', output: '{"success":true}' },
    ...Array.from({ length: 16 }, () => ({ role: 'assistant', content: 'Observed form context' })),
    { role: 'assistant', content: 'x'.repeat(200000) },
  ];
  const { events } = await runPhases({}, undefined, [{
    type: 'function', name: 'cdp_input', description: 'click', parameters: {},
  }], previousContext);
  assert.equal(requests.length, 1);
  assert.equal(events.filter(event => event.type === 'phase_handoff').length, 1);
  assert.equal(JSON.parse(events.find(event => event.type === 'phase_handoff').content).reason, 'token_budget');
  assert.equal(events.some(event => event.type === 'review_started'), false);
  assert.equal(events.some(event => event.type === 'error'), false);
});
