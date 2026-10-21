import test from 'node:test';
import assert from 'node:assert/strict';
import { bookmarkOpsFunction } from './bookmark-ops.ts';

const createCalls = [];

globalThis.chrome = {
  tabs: { get: async () => undefined, query: async () => [] },
  bookmarks: {
    create: async (payload) => {
      createCalls.push(payload);
      return { id: '1', parentId: payload.parentId || 'other', index: 0, title: payload.title, url: payload.url };
    },
    update: async (id, payload) => ({ id, title: payload.title, url: payload.url }),
  },
};

test('write and bulk-export actions require approval', () => {
  const permissions = bookmarkOpsFunction.actionPermissions || {};
  for (const action of ['add', 'update', 'move', 'create_folder', 'delete', 'getAll', 'get_all', 'search', 'recent', 'list']) {
    assert.equal(permissions[action], 'sensitive', `${action} 应为 sensitive`);
  }
  assert.equal(permissions.get, undefined);
});

test('rejects non-http(s) bookmark URLs', async () => {
  const result = await bookmarkOpsFunction.execute({ action: 'add', url: 'javascript:alert(1)', title: 'x' });
  assert.equal(result.success, false);
  assert.match(result.error, /http\/https/);
  assert.equal(createCalls.length, 0);

  const update = await bookmarkOpsFunction.execute({ action: 'update', bookmark_id: '1', url: 'file:///etc/passwd' });
  assert.equal(update.success, false);
  assert.match(update.error, /http\/https/);
});

test('normalizes title and keeps https URL', async () => {
  createCalls.length = 0;
  const result = await bookmarkOpsFunction.execute({
    action: 'add',
    url: 'https://example.com/page',
    title: '  标题\u0000  ',
  });
  assert.equal(result.success, true);
  assert.equal(createCalls[0].url, 'https://example.com/page');
  assert.equal(createCalls[0].title, '标题');
});
