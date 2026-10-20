import assert from 'node:assert/strict';
import test from 'node:test';
import { registerStatusTool, STATUS_UPDATE_DESCRIPTION } from '../status-tool.js';

test('registers actspan_status_update with the required concise instruction', () => {
  const registrations = [];
  let bridgeCall;
  registerStatusTool({
    registerTool: (...args) => registrations.push(args),
    taskParams: {},
    callBridge: (...args) => { bridgeCall = args; return { acknowledged: true }; },
    run: (fn) => fn,
  });
  assert.equal(registrations.length, 1);
  const [name, definition, handler] = registrations[0];
  assert.equal(name, 'actspan_status_update');
  assert.equal(definition.description, STATUS_UPDATE_DESCRIPTION);
  assert.match(definition.description, /^One short sentence telling the user what you are about to do/);
  assert.equal(definition.inputSchema.text.safeParse('x'.repeat(80)).success, true);
  assert.equal(definition.inputSchema.text.safeParse('x'.repeat(81)).success, false);
  handler({ text: '准备查看结果', taskId: 'task-1', sessionId: 'session-1' });
  assert.equal(bridgeCall[0], 'page.status_update');
  assert.equal(bridgeCall[1].text, '准备查看结果');
});
