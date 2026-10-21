import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `
      export { isSensitiveRecordedField, redactRecordedStep, REDACTED_RECORDED_VALUE } from './src/lib/recorder-redaction.ts';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { isSensitiveRecordedField, redactRecordedStep, REDACTED_RECORDED_VALUE } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`
);

test('detects password, otp and card fields from DOM metadata', () => {
  assert.equal(isSensitiveRecordedField({ inputType: 'password' }), true);
  assert.equal(isSensitiveRecordedField({ autocomplete: 'one-time-code' }), true);
  assert.equal(isSensitiveRecordedField({ autocomplete: 'cc-number' }), true);
  assert.equal(isSensitiveRecordedField({ selector: '#user-password' }), true);
  assert.equal(isSensitiveRecordedField({ selector: 'input[name="otp"]' }), true);
  assert.equal(isSensitiveRecordedField({ semanticHint: '银行卡号' }), true);
  assert.equal(isSensitiveRecordedField({ semanticHint: '请输入密码' }), true);
  assert.equal(isSensitiveRecordedField({ semanticHint: 'card number' }), true);
  assert.equal(isSensitiveRecordedField({ selector: '#username', inputType: 'text' }), false);
});

test('redacts sensitive values but keeps ordinary input and empty values', () => {
  const secret = { seq: 1, action: 'type', selector: '#password', value: 'hunter2' };
  assert.deepEqual(redactRecordedStep(secret, { selector: '#password' }), {
    seq: 1, action: 'type', selector: '#password', value: REDACTED_RECORDED_VALUE,
  });

  const normal = { seq: 2, action: 'type', selector: '#search', value: '鞋子' };
  assert.deepEqual(redactRecordedStep(normal, { selector: '#search', inputType: 'text' }), normal);

  const empty = { seq: 3, action: 'type', selector: '#password', value: '' };
  assert.deepEqual(redactRecordedStep(empty, { selector: '#password' }), empty);
});
