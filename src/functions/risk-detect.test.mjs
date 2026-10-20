import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({ stdin: { contents: `export { CHALLENGE_MESSAGE, detectChallenge, hostOf, detectReadDrift, createReadDriftTracker } from './src/functions/risk-detect.ts';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node' });
const { CHALLENGE_MESSAGE, detectChallenge, hostOf, detectReadDrift, createReadDriftTracker } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

test('挑战 iframe 去 query 且 frames 优先于 overlay', () => {
  const result = detectChallenge({ frames: [{ src: 'https://challenges.cloudflare.com/turnstile/v0/api.js?token=secret' }], overlays: ['请完成安全验证后继续'] });
  assert.equal(result.detected, true);
  assert.equal(result.source, 'frame');
  assert.equal(result.host, 'challenges.cloudflare.com');
  assert.equal(result.message, CHALLENGE_MESSAGE);
});

test('仅顶层成句 overlay 命中，普通 iframe/正文不命中', () => {
  assert.equal(detectChallenge({ frames: [{ src: 'https://ads.example.test/frame' }], overlays: ['验证'] }).detected, false);
  assert.equal(detectChallenge({ overlays: ['请完成验证后继续访问'] }).detected, true);
  assert.equal(hostOf(undefined), '');
  assert.equal(hostOf('not a url'), '');
});

test('读取漂移按 session 去重且自导航不告警', () => {
  assert.equal(detectReadDrift('https://a.test/start?x=1', 'https://a.test/next'), true);
  assert.equal(detectReadDrift('https://a.test/start', 'https://a.test/next', true), false);
  const tracker = createReadDriftTracker();
  tracker.setBaseline('s1', 'https://a.test/start');
  assert.equal(tracker.check('s1', 'https://a.test/next'), true);
  assert.equal(tracker.check('s1', 'https://a.test/other'), false);
  assert.equal(tracker.check('s2', 'https://a.test/next'), false);
});
