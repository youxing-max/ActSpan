import assert from 'node:assert/strict';
import test from 'node:test';
import {
    compareProtocolVersions,
    createStableSessionId,
    deriveSessionIdentity,
    normalizeHostIdentity,
} from '../identity.js';

test('compares numeric three-part versions and keeps patch changes silent', () => {
    assert.deepEqual(compareProtocolVersions(
        { protocol: 7, version: '1.2.3' },
        { protocol: 7, version: '1.2.9' },
    ), {
        compatible: true,
        status: 'compatible',
        warning: null,
        localBehind: false,
        remoteBehind: false,
    });
    assert.equal(compareProtocolVersions({ protocol: 7, version: '1.10.0' }, { protocol: 7, version: '1.2.0' }).status, 'remote_minor_behind');
    assert.equal(compareProtocolVersions({ protocol: 7, version: '1.2.0' }, { protocol: 7, version: '1.10.0' }).status, 'local_minor_behind');
});

test('reports protocol incompatibility and does not warn for missing version fields', () => {
    const incompatible = compareProtocolVersions({ protocol: 7, version: '1.2.3' }, { protocol: 8, version: '1.2.3' });
    assert.equal(incompatible.compatible, false);
    assert.equal(incompatible.status, 'incompatible_protocol');
    assert.match(incompatible.warning, /protocol/i);

    const unknown = compareProtocolVersions({ protocol: 7 }, { protocol: 7, version: '1.2.3' });
    assert.equal(unknown.compatible, true);
    assert.equal(unknown.status, 'unknown');
    assert.equal(unknown.warning, null);
});

test('prefers specific self-reported hosts, maps aliases, and preserves unknown names', () => {
    const table = {
        cursor: { display: 'Cursor', aliases: ['Cursor MCP client'] },
        codex: { display: 'Codex', aliases: ['OpenAI Codex'] },
    };
    assert.deepEqual(normalizeHostIdentity('Cursor MCP client', 'Codex', table), {
        slug: 'cursor', display: 'Cursor', source: 'self', reported: 'Cursor MCP client',
    });
    assert.equal(normalizeHostIdentity('MCP client', 'OpenAI Codex', table).slug, 'codex');
    const unknown = normalizeHostIdentity('My Private Host', 'Cursor', table);
    assert.equal(unknown.slug, 'my-private-host');
    assert.equal(unknown.display, 'My Private Host');
    assert.equal(unknown.source, 'self');
    const branded = normalizeHostIdentity('Acme Client', 'Cursor', table);
    assert.equal(branded.slug, 'acme-client');
    assert.equal(branded.display, 'Acme Client');
});

test('derives deterministic identity from sid alone, including no-colon ids', () => {
    const first = deriveSessionIdentity('codex:4242');
    assert.deepEqual(first, deriveSessionIdentity('codex:4242', 'wrong-client'));
    assert.equal(first.shortCode, '4242');
    assert.ok(first.emoji);
    assert.match(first.groupColor, /^(grey|blue|red|yellow|green|pink|purple|cyan|orange)$/);
    assert.doesNotThrow(() => deriveSessionIdentity('custom-session-without-colon'));
    assert.notDeepEqual(first, deriveSessionIdentity('codex:4243'));
});

test('creates prefixed, collision-resistant session ids without embedding credentials', () => {
    const a = createStableSessionId('Codex MCP client', 4242, 1700000000000);
    const b = createStableSessionId('Codex MCP client', 4242, 1700000000000);
    assert.match(a, /^codex:4242:/);
    assert.notEqual(a, b);
    assert.doesNotMatch(a, /secret|token|key/i);
});
