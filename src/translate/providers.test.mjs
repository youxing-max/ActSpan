/**
 * 翻译模块单测：签名正确性、请求构造、响应解析
 *
 * 签名部分用 node:crypto 做独立实现交叉校验，避免「自己验自己」。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `
      export { md5Hex, sha256Hex } from './src/translate/signing.ts';
      export {
        buildDeepLRequest,
        buildGoogleRequest,
        buildYoudaoRequest,
        buildBaiduRequest,
        parseProviderResponse,
      } from './src/translate/providers.ts';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});

const mod = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const {
  md5Hex,
  sha256Hex,
  buildDeepLRequest,
  buildGoogleRequest,
  buildYoudaoRequest,
  buildBaiduRequest,
  parseProviderResponse,
} = mod;

const nodeMd5 = (value) => createHash('md5').update(value, 'utf8').digest('hex');
const nodeSha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

test('md5Hex 与标准向量一致', () => {
  assert.equal(md5Hex(''), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(md5Hex('abc'), '900150983cd24fb0d6963f7d28e17f72');
  // 跨块（>64 字节）也要正确
  const long = 'a'.repeat(200);
  assert.equal(md5Hex(long), nodeMd5(long));
});

test('md5Hex 处理中文（UTF-8 多字节）', () => {
  const value = '你好，世界';
  assert.equal(md5Hex(value), nodeMd5(value));
});

test('sha256Hex 与标准向量一致', async () => {
  assert.equal(
    await sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  const value = '有道翻译测试';
  assert.equal(await sha256Hex(value), nodeSha256(value));
});

test('百度请求使用官方示例签名', () => {
  // 百度开放平台文档示例：appid=2015063000000001 q=apple salt=1435660288 key=12345678
  const request = buildBaiduRequest(
    { appId: '2015063000000001', appSecret: '12345678' },
    'apple',
    'en',
    'zh',
    1435660288,
  );
  assert.equal(request.url, 'https://fanyi-api.baidu.com/api/trans/vip/translate');
  assert.equal(request.init.method, 'POST');
  const params = new URLSearchParams(request.init.body);
  assert.equal(params.get('q'), 'apple');
  assert.equal(params.get('from'), 'en');
  assert.equal(params.get('to'), 'zh');
  assert.equal(params.get('appid'), '2015063000000001');
  assert.equal(params.get('salt'), '1435660288');
  assert.equal(params.get('sign'), 'f89f9594663708c1605f3d736d01d2d4');
});

test('百度语言映射：日语用 jp、韩语用 kor', () => {
  const toJapanese = new URLSearchParams(buildBaiduRequest({ appId: 'a', appSecret: 'b' }, 'x', 'zh', 'ja').init.body);
  assert.equal(toJapanese.get('to'), 'jp');
  const toKorean = new URLSearchParams(buildBaiduRequest({ appId: 'a', appSecret: 'b' }, 'x', 'zh', 'ko').init.body);
  assert.equal(toKorean.get('to'), 'kor');
  // 自动检测
  const auto = new URLSearchParams(buildBaiduRequest({ appId: 'a', appSecret: 'b' }, 'x', 'auto', 'en').init.body);
  assert.equal(auto.get('from'), 'auto');
});

test('有道 v3 签名遵循 appKey+截断q+salt+curtime+secret', async () => {
  const now = 1_700_000_000_000;
  const request = await buildYoudaoRequest(
    { appId: 'app-key', appSecret: 'app-secret' },
    'hello world',
    'en',
    'zh',
    now,
  );
  const params = new URLSearchParams(request.init.body);
  assert.equal(params.get('signType'), 'v3');
  assert.equal(params.get('appKey'), 'app-key');
  assert.equal(params.get('salt'), String(now));
  assert.equal(params.get('curtime'), String(Math.floor(now / 1000)));
  const expected = nodeSha256(`app-keyhello world${now}${Math.floor(now / 1000)}app-secret`);
  assert.equal(params.get('sign'), expected);
  assert.equal(params.get('from'), 'en');
  assert.equal(params.get('to'), 'zh-CHS');
});

test('有道长文本按「前10+长度+后10」截断后参与签名', async () => {
  const longText = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const now = 1_700_000_000_000;
  const request = await buildYoudaoRequest({ appId: 'k', appSecret: 's' }, longText, 'auto', 'en', now);
  const params = new URLSearchParams(request.init.body);
  const truncated = `${longText.slice(0, 10)}${longText.length}${longText.slice(-10)}`;
  assert.equal(
    params.get('sign'),
    nodeSha256(`k${truncated}${now}${Math.floor(now / 1000)}s`),
  );
  assert.equal(params.get('q'), longText, '发送的正文仍必须是完整原文');
  assert.equal(params.get('from'), 'auto');
});

test('DeepL 请求区分免费版并在自动检测时省略 source_lang', () => {
  const free = buildDeepLRequest({ apiKey: 'x:fx', useFreeApi: true }, 'hi', 'auto', 'zh');
  assert.equal(free.url, 'https://api-free.deepl.com/v2/translate');
  assert.equal(free.init.headers.Authorization, 'DeepL-Auth-Key x:fx');
  const freeBody = JSON.parse(free.init.body);
  assert.deepEqual(freeBody, { text: ['hi'], target_lang: 'ZH' });

  const pro = buildDeepLRequest({ apiKey: 'x' }, 'hi', 'en', 'ja');
  assert.equal(pro.url, 'https://api.deepl.com/v2/translate');
  assert.equal(JSON.parse(pro.init.body).source_lang, 'EN');
});

test('Google 请求把 Key 放 query 且目标语言用 zh-CN', () => {
  const request = buildGoogleRequest({ apiKey: 'k 1' }, 'hi', 'auto', 'zh');
  assert.match(request.url, /key=k%201$/);
  const body = JSON.parse(request.init.body);
  assert.deepEqual(body, { q: ['hi'], target: 'zh-CN', format: 'text' });
});

test('parseProviderResponse 解析各供应商成功响应', () => {
  assert.equal(parseProviderResponse('deepl', { translations: [{ text: '你好' }] }), '你好');
  assert.equal(
    parseProviderResponse('google', { data: { translations: [{ translatedText: 'a &amp; b &quot;c&quot;' }] } }),
    'a & b "c"',
  );
  assert.equal(parseProviderResponse('youdao', { errorCode: '0', translation: ['译文'] }), '译文');
  assert.equal(
    parseProviderResponse('baidu', { trans_result: [{ dst: '第一行' }, { dst: '第二行' }] }),
    '第一行\n第二行',
  );
});

test('parseProviderResponse 对错误响应抛出可读异常', () => {
  assert.throws(() => parseProviderResponse('youdao', { errorCode: '108' }), /errorCode=108/);
  assert.throws(() => parseProviderResponse('baidu', { error_code: '54003' }), /error_code=54003/);
  assert.throws(() => parseProviderResponse('deepl', {}), /DeepL 返回异常/);
});
