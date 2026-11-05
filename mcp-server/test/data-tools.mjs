import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import registerDataTools from '../data-tools.js';

const setup = callBridge => {
    const handlers = new Map();
    registerDataTools({ registerTool: (name, _definition, handler) => handlers.set(name, handler), callBridge,
        run: handler => handler, taskParams: {}, tabIdParam: {} });
    return handlers;
};

test('pagination starts at the requested page, including zero', async () => {
    for (const start of [0, 5]) {
        const requested = [];
        const handlers = setup(async (_method, args) => {
            requested.push(args.page);
            return { ok: true, data: [{ id: args.page }] };
        });
        const result = await handlers.get('actspan_data_paginate')({ url: 'https://api.test/items', param: 'page', params: { page: start }, maxPages: 2 });
        assert.deepEqual(requested, [start, start + 1]);
        assert.equal(result.page_count, 2);
    }
});

for (const nested of [false, true]) {
    test(`pagination stops and saves once when ${nested ? 'nested' : 'array'} rows only reorder object keys`, async () => {
        const directory = await mkdtemp(join(tmpdir(), 'actspan-data-pages-'));
        const savePath = join(directory, 'pages.ndjson');
        const first = [{ id: 7, title: 'same', detail: { active: true, label: 'row' } }];
        const reordered = [{ detail: { label: 'row', active: true }, title: 'same', id: 7 }];
        const data = rows => nested ? { items: rows } : rows;
        let calls = 0;
        const handlers = setup(async () => ({ ok: true, data: data(++calls % 2 === 1 ? first : reordered) }));
        try {
            const result = await handlers.get('actspan_data_paginate')({ url: 'https://api.test/items', param: 'page', maxPages: 3, savePath });
            assert.equal(result.stop_reason, 'identical_response');
            assert.equal(result.page_count, 1);
            assert.equal(calls, 2);
            assert.equal(result.saved, savePath);
            assert.equal(await readFile(savePath, 'utf8'), `${JSON.stringify(data(first))}\n`);
        } finally { await rm(savePath, { force: true }); await rmdir(directory); }
    });
}

test('pagination preserves array order when comparing response data', async () => {
    let calls = 0;
    const handlers = setup(async () => ({ ok: true, data: { items: ++calls === 1 ? [{ id: 1 }, { id: 2 }] : [{ id: 2 }, { id: 1 }] } }));
    const result = await handlers.get('actspan_data_paginate')({ url: 'https://api.test/items', param: 'page', maxPages: 2 });
    assert.equal(result.stop_reason, 'max_pages');
    assert.equal(result.page_count, 2);
});

test('fetch validates savePath and binary compatibility before calling the bridge', async () => {
    const calls = [];
    const handlers = setup(async method => { calls.push(method); return { transferId: 'unused', bytes: 1 }; });
    for (const [args, error] of [
        [{ binary: true, savePath: '../blocked.bin' }, /traversal/],
        [{ binary: true, savePath: '' }, /non-empty/],
        [{ binary: false, savePath: 'unused.txt' }, /binary fetch only/],
    ]) {
        await assert.rejects(handlers.get('actspan_data_fetch')({ url: 'https://api.test/file', ...args }), error);
    }
    assert.deepEqual(calls, []);
});

test('binary save releases the transfer when the initial file write fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'actspan-binary-write-'));
    const savePath = join(directory, 'absent', 'payload.bin');
    const calls = [];
    const handlers = setup(async (method, args) => {
        calls.push({ method, args });
        if (method === 'data.fetch') return { transferId: 'write-failure', bytes: 1 };
        if (method === 'data.fetch_release') throw new Error('cleanup also failed');
        throw new Error(`Unexpected bridge call: ${method}`);
    });
    try {
        await assert.rejects(handlers.get('actspan_data_fetch')({ url: 'https://cdn.test/file', binary: true, savePath }), { code: 'ENOENT' });
        assert.deepEqual(calls.map(call => call.method), ['data.fetch', 'data.fetch_release']);
        assert.equal(calls[1].args.transferId, 'write-failure');
    } finally { await rmdir(directory); }
});

test('pagination validates savePath before calling the bridge', async () => {
    const calls = [];
    const handlers = setup(async method => { calls.push(method); return { ok: false, status: 503 }; });
    await assert.rejects(handlers.get('actspan_data_paginate')({ url: 'https://api.test/items', param: 'page', savePath: '../blocked.ndjson' }), /traversal/);
    assert.deepEqual(calls, []);
});

test('pagination reports saved only after writing and preserves an existing file on zero pages', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'actspan-data-tools-'));
    const savePath = join(directory, 'pages.ndjson');
    try {
        await writeFile(savePath, 'existing content');
        const failed = setup(async () => ({ ok: false, status: 503, stop_reason: 'non_2xx' }));
        const empty = await failed.get('actspan_data_paginate')({ url: 'https://api.test/items', param: 'page', savePath });
        assert.equal(empty.page_count, 0);
        assert.equal(empty.stop_reason, 'non_2xx');
        assert.equal(Object.hasOwn(empty, 'saved'), false);
        assert.equal(await readFile(savePath, 'utf8'), 'existing content');
        const successful = setup(async () => ({ ok: true, data: [{ id: 1 }] }));
        const saved = await successful.get('actspan_data_paginate')({ url: 'https://api.test/items', param: 'page', maxPages: 1, savePath });
        assert.equal(saved.saved, savePath);
        assert.equal(await readFile(savePath, 'utf8'), '[{"id":1}]\n');
    } finally { await rm(savePath, { force: true }); await rmdir(directory); }
});
