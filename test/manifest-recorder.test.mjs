import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('public/manifest.json', 'utf8'));

test('declares the content script and navigation permission used by recording recovery', () => {
  assert.ok(manifest.permissions.includes('webNavigation'));
  // all_frames 是 G5 的前提：跨源 iframe 内的元素要进快照，内容脚本必须注入每个框架。
  assert.deepEqual(manifest.content_scripts, [{
    matches: ['<all_urls>'],
    js: ['content.js'],
    all_frames: true,
    run_at: 'document_idle',
  }]);
});
