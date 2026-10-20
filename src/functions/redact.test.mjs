import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({ stdin: { contents: `export { redactSensitive, redactPageContent, redactDataPayload, isCredentialUrl } from './src/functions/redact.ts';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node' });
const { redactSensitive, redactPageContent, redactDataPayload, isCredentialUrl } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

test('递归按 key 脱敏并保留定位信息', () => {
  const input = { text: '登录 password=secret', fill: { fields: { password: 'secret', selector: '#password', path: '/login', url: 'https://example.test/a?token=x' } }, steps: [{ text: 'token=abc' }] };
  const out = redactSensitive(input);
  assert.match(out.text, /\[REDACTED\]/);
  assert.equal(out.fill.fields.password, '[REDACTED]');
  assert.equal(out.fill.fields.selector, '#password');
  assert.equal(out.fill.fields.path, '/login');
  assert.equal(out.fill.fields.url, 'https://example.test/a?token=%5BREDACTED%5D');
  assert.match(out.steps[0].text, /\[REDACTED\]/);
});

test('循环引用、base64 和长 eval 安全处理', () => {
  const circular = {}; circular.self = circular;
  const out = redactSensitive({ circular, payload: 'A'.repeat(200), expression: 'x'.repeat(500) });
  assert.equal(out.circular.self, '[循环引用]');
  assert.match(out.payload, /^\[base64 \d+ bytes\]$/);
  assert.match(out.expression, /截断/);
});

test('凭据组跨空行掩码但孤立 commit hash 保留', () => {
  const text = ['说明', 'alpha123456789', '', 'bravo123456789', 'charlie123456789', '正文', '0123456789abcdef0123456789abcdef01234567'].join('\n');
  const out = redactSensitive({ text }).text;
  assert.doesNotMatch(out, /alpha123456789|bravo123456789|charlie123456789/);
  assert.match(out, /说明/);
  assert.match(out, /正文/);
  assert.match(out, /0123456789abcdef0123456789abcdef01234567/);
});

test('正文新密码和手机号脱敏但长数字 ID 保留', () => {
  const out = redactSensitive({ text: 'new password=R4ndom!Pass 新密码：N3w!Secret 手机 13812345678 订单 123456789012345678' }).text;
  assert.match(out, /password=\[REDACTED\]/);
  assert.match(out, /新密码：\[REDACTED\]/);
  assert.match(out, /\[REDACTED PHONE\]/);
  assert.match(out, /123456789012345678/);
  assert.doesNotMatch(out, /R4ndom!Pass|N3w!Secret|13812345678/);
});

test('同页两组凭据各自脱敏且中间正文保留', () => {
  const first = ['alpha123456789', 'bravo123456789', 'charlie123456789'];
  const second = ['delta123456789', 'echo1234567890', 'foxtrot12345678'];
  const out = redactSensitive({ text: [...first, '第一组结束', ...second].join('\n') }).text;
  for (const secret of [...first, ...second]) assert.doesNotMatch(out, new RegExp(secret));
  assert.match(out, /第一组结束/);
});

test('凭据 URL 整页降级且普通页面不误判', () => {
  assert.equal(isCredentialUrl('https://example.test/account/recovery-codes?token=x'), true);
  assert.equal(isCredentialUrl('https://example.test/articles/tokenization'), false);
  assert.equal(isCredentialUrl('https://example.test/dashboard'), false);
  const masked = redactPageContent('secret words', 'https://example.test/account/recovery-codes');
  assert.deepEqual(masked, { content: '[凭据页面已掩码]', warning: '凭据页面内容不要转述' });
  assert.equal(redactPageContent('普通正文', 'https://example.test/dashboard'), '普通正文');
});

test('data URI base64 只记录大小', () => {
  const out = redactSensitive({ payload: `data:image/png;base64,${'A'.repeat(200)}` });
  assert.match(out.payload, /^\[base64 \d+ bytes\]$/);
});

test('数据工具出口对凭据 URL 整页掩码且普通页面原样保留', () => {
  const credential = redactDataPayload({ content: 'recovery code A1B2C3D4', links: [{ text: 'x', url: 'https://example.test/a' }] }, 'https://example.test/account/recovery-codes');
  assert.deepEqual(credential, { content: '[凭据页面已掩码]', warning: '凭据页面内容不要转述' });
  const ordinary = redactDataPayload({ content: '普通正文', title: '示例' }, 'https://example.test/dashboard');
  assert.equal(ordinary.content, '普通正文');
  assert.equal(ordinary.title, '示例');
});

test('结构化 JSON 字符串按 key 脱敏且普通文本不被改写', () => {
  const json = redactSensitive({ body: '{"token":"clear-secret","password":"clear-pass","items":[1,2]}' }).body;
  assert.doesNotMatch(json, /clear-secret|clear-pass/);
  assert.match(json, /\[REDACTED\]/);
  assert.match(json, /"items":\[1,2\]/);
  const prose = '{"这不是 JSON';
  assert.equal(redactSensitive({ body: prose }).body, prose);
  const clean = '{"page":{"ps":10},"items":[{"id":1}]}';
  assert.equal(redactSensitive({ body: clean }).body, clean);
});

test('敏感 key 下的数字、布尔与嵌套对象整体掩码', () => {
  const out = redactSensitive({ authorization: { scheme: 'Bearer', credentials: 'SECRET' }, token: { raw: 'SECRET' }, attempts: 3, ok: true });
  assert.equal(out.authorization, '[REDACTED]');
  assert.equal(out.token, '[REDACTED]');
  assert.equal(out.attempts, 3);
  assert.equal(out.ok, true);
  const numeric = redactSensitive({ passcode: 123456, cookie: true });
  assert.equal(numeric.passcode, '[REDACTED]');
  assert.equal(numeric.cookie, '[REDACTED]');
});

test('查询串与片段里的 access/refresh token 都被掩码', () => {
  const query = redactSensitive({ url: 'https://example.test/cb?access_token=aaa&refresh_token=bbb&page=2' }).url;
  assert.doesNotMatch(query, /aaa|bbb/);
  assert.match(query, /page=2/);
  const fragment = redactSensitive({ url: 'https://example.test/cb#access_token=ccc&state=ok' }).url;
  assert.doesNotMatch(fragment, /ccc/);
  assert.match(fragment, /state=ok/);
});
