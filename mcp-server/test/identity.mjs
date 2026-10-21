import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    compareProtocolVersions,
    createStableClientId,
    createStableSessionId,
    deriveSessionIdentity,
    normalizeHostIdentity,
} from '../identity.js';

const IDENTITY_URL = new URL('../identity.js', import.meta.url).href;

/** A private `~/.actspan/client-ids.json` stand-in so tests never touch the real home dir. */
function scratchClientIds(t) {
    const dir = mkdtempSync(path.join(tmpdir(), 'actspan-identity-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, '.actspan', 'client-ids.json');
}

/** Runs the identity module in a fresh process: the closest stand-in for an MCP server restart. */
function identityFromAnotherProcess(file, host) {
    const script = `import { createStableClientId, createStableSessionId } from ${JSON.stringify(IDENTITY_URL)};
process.stdout.write(JSON.stringify({
    clientId: createStableClientId(${JSON.stringify(host)}, { file: ${JSON.stringify(file)} }),
    sessionId: createStableSessionId(${JSON.stringify(host)}),
}));`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
}

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

test('derives one stable session id per host and keeps hosts apart', () => {
    const first = createStableSessionId('Codex MCP client');
    const second = createStableSessionId('codex');
    assert.equal(first, second);
    assert.match(first, /^codex:[a-z0-9]+$/);
    assert.notEqual(first, createStableSessionId('Cursor'));
    assert.doesNotMatch(first, /secret|token|key/i);
    // deriveSessionIdentity shows the trailing segment as the short session code, so it must
    // be host-specific and never the bare word `stable`.
    assert.equal(deriveSessionIdentity(first).shortCode, first.slice('codex:'.length));
});

test('reuses one persisted clientId per host slug across process starts', (t) => {
    const file = scratchClientIds(t);
    const first = createStableClientId('Codex MCP client', { file });
    const second = createStableClientId('Codex MCP client', { file });
    assert.equal(first, second);
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(stored.hosts), ['codex']);
    assert.equal(stored.hosts.codex, first);
});

test('isolates client ids by host slug so one host never borrows another identity', (t) => {
    const file = scratchClientIds(t);
    const codex = createStableClientId('codex', { file });
    const cursor = createStableClientId('cursor', { file });
    assert.notEqual(codex, cursor);
    assert.equal(createStableClientId('cursor', { file }), cursor);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8')).hosts).sort(), ['codex', 'cursor']);
});

test('a restarted MCP process reads back the same clientId and sessionId', (t) => {
    const file = scratchClientIds(t);
    const first = identityFromAnotherProcess(file, 'cursor');
    const second = identityFromAnotherProcess(file, 'cursor');
    assert.deepEqual(second, first);
    assert.equal(createStableClientId('cursor', { file }), first.clientId);
    assert.equal(createStableSessionId('cursor'), first.sessionId);
    // Another host started in between must not disturb the cursor bucket.
    const other = identityFromAnotherProcess(file, 'codex');
    assert.notEqual(other.clientId, first.clientId);
    assert.equal(identityFromAnotherProcess(file, 'cursor').clientId, first.clientId);
});
