import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

globalThis.chrome = {};
const bundle = await build({
  stdin: {
    contents: `export { cdpNetworkFunction, inspectNetworkCapture } from './src/functions/cdp-network.ts';
      export { CDPSessionManager } from './src/lib/cdp-session.ts';`,
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { cdpNetworkFunction, inspectNetworkCapture, CDPSessionManager } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`
);
const MAX_BODY_SIZE = 50 * 1024;
const params = { action: 'get_body', request_id: 'fixture', tab_id: 91 };

function mockCapture(t, mimeType = 'application/json') {
  t.mock.method(CDPSessionManager, 'ensureNetworkListening', async () => ({ success: true }));
  t.mock.method(CDPSessionManager, 'getNetworkEvents', () => [{
    requestId: 'fixture', method: 'GET', url: 'https://example.test/api/items',
    resourceType: 'xhr', statusCode: 200, mimeType, timestamp: 1,
  }]);
}

test('oversized JSON is redacted before truncation through direct and capture reads', async (t) => {
  const body = JSON.stringify({
    token: 'synthetic-secret-fixture', nested: { password: 'synthetic-password-fixture' },
    padding: 'ordinary response data. '.repeat(3000),
  });
  t.mock.method(CDPSessionManager, 'sendCommand', async () => ({ success: true, result: { body, base64Encoded: false } }));
  mockCapture(t);
  const direct = await cdpNetworkFunction.execute(params);
  assert.equal(direct.success, true);
  const captured = await inspectNetworkCapture(91, { mode: 'query', urlFilter: '/api/items' });
  for (const result of [direct.data, captured]) {
    assert.equal(/synthetic-secret-fixture|synthetic-password-fixture/.test(result.body), false, 'credentials must be redacted before truncation');
    assert.match(result.body, /"token":"\[REDACTED\]"/);
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(result.body, 'utf8') <= MAX_BODY_SIZE);
    assert.equal(result.original_length, body.length);
  }
});

test('text response limit counts UTF-8 bytes and keeps complete Chinese and emoji characters', async (t) => {
  let body;
  t.mock.method(CDPSessionManager, 'sendCommand', async () => ({ success: true, result: { body, base64Encoded: false } }));
  mockCapture(t, 'text/plain');
  for (const [source, expected] of [
    ['中'.repeat(30000), '中'.repeat(17066)],
    ['中'.repeat(17065) + '😀'.repeat(10), '中'.repeat(17065) + '😀'],
    ['😀'.repeat(12800), '😀'.repeat(12800)],
  ]) {
    body = source;
    const result = await inspectNetworkCapture(91, { mode: 'query', urlFilter: '/api/items' });
    assert.equal(result.body.length, expected.length);
    assert.equal(result.body === expected, true, 'response must end on a complete UTF-8 character');
    assert.equal(result.truncated, source !== expected);
    assert.ok(Buffer.byteLength(result.body, 'utf8') <= MAX_BODY_SIZE);
    assert.doesNotMatch(result.body, /\uFFFD/);
  }
});

test('cancelling a pending response body prevents direct and capture reads from returning it', async (t) => {
  mockCapture(t);
  for (const inspect of [false, true]) {
    const controller = new AbortController();
    let release;
    let notifyStarted;
    const started = new Promise((resolve) => { notifyStarted = resolve; });
    const send = t.mock.method(CDPSessionManager, 'sendCommand', async () => {
      notifyStarted();
      return await new Promise((resolve) => { release = resolve; });
    });
    const reading = inspect
      ? inspectNetworkCapture(91, { mode: 'query', urlFilter: '/api/items' }, controller.signal)
      : cdpNetworkFunction.execute(params, { signal: controller.signal });
    await started;
    controller.abort();
    release({ success: true, result: { body: 'cancelled response body', base64Encoded: false } });
    if (inspect) await assert.rejects(reading, /cancelled/i);
    else {
      const result = await reading;
      assert.equal(result.success, false);
      assert.match(result.error, /取消/);
      assert.equal(result.data, undefined);
    }
    send.mock.restore();
  }
});
