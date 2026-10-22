import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: { contents: `export { isPrivateHostname, isBlockedFetchUrl, isSafeNavigableUrl } from './src/lib/ssrf-guard.ts';`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { isPrivateHostname, isBlockedFetchUrl, isSafeNavigableUrl } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

test('IPv4 与常见内网主机被判定为私有', () => {
  for (const host of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '169.254.1.1', '0.0.0.0', 'localhost', 'foo.local']) {
    assert.equal(isPrivateHostname(host), true, host);
  }
  for (const host of ['example.com', '8.8.8.8', '172.32.0.1', '1.1.1.1']) {
    assert.equal(isPrivateHostname(host), false, host);
  }
});

test('IPv6 映射/环回/ULA/链路本地均被拦截', () => {
  for (const host of ['::1', '::', '[::1]', '::ffff:7f00:1', '::ffff:127.0.0.1', '::127.0.0.1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe90::1']) {
    assert.equal(isPrivateHostname(host), true, host);
  }
  for (const host of ['2001:4860:4860::8888', '::ffff:8.8.8.8', '2606:4700::1111']) {
    assert.equal(isPrivateHostname(host), false, host);
  }
});

test('通配 DNS 域被拦截', () => {
  for (const url of [
    'http://127.0.0.1.nip.io:8080/admin',
    'http://localtest.me/',
    'http://169.254.169.254.sslip.io/latest/meta-data',
    'https://xip.io/',
    'http://foo.vcap.me/',
  ]) {
    assert.equal(isBlockedFetchUrl(url), true, url);
  }
  assert.equal(isBlockedFetchUrl('https://example.com/'), false);
});

test('URL 守卫拒绝私有地址与非 http(s) 协议，但允许 about:blank 导航', () => {
  assert.equal(isBlockedFetchUrl('http://[::ffff:7f00:1]/secret'), true);
  assert.equal(isBlockedFetchUrl('http://127.0.0.1:9222/json'), true);
  assert.equal(isBlockedFetchUrl('file:///etc/passwd'), true);
  assert.equal(isBlockedFetchUrl('https://example.com/page'), false);
  assert.equal(isSafeNavigableUrl('about:blank'), true);
  assert.equal(isSafeNavigableUrl('javascript:alert(1)'), false);
});
