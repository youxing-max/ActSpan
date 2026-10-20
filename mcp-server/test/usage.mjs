import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createUsageLedger, readUsage, USAGE_LEDGER_VERSION } from '../usage.js';

function scratch(t) {
    const dir = mkdtempSync(path.join(tmpdir(), 'actspan-usage-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, 'usage.json');
}

test('K3 usage attribution round-trips per host and per tool', (t) => {
    const file = scratch(t);
    const ledger = createUsageLedger({ path: file });
    ledger.record({ host: 'cursor', tool: 'page.click', sessionId: 's1', at: 1000 });
    ledger.record({ host: 'cursor', tool: 'page.click', sessionId: 's2', at: 2000 });
    ledger.record({ host: 'codex', tool: 'tabs.list', sessionId: 's3', at: 3000 });

    assert.deepEqual(ledger.hostReport('cursor'), {
        host: 'cursor', calls: 2, firstAt: 1000, lastAt: 2000, tools: { 'page.click': 2 },
    });
    const onDisk = readUsage(file);
    assert.equal(onDisk.version, USAGE_LEDGER_VERSION);
    assert.deepEqual(Object.keys(onDisk.hosts).sort(), ['codex', 'cursor']);
    assert.equal(onDisk.hosts.codex.calls, 1);
    assert.deepEqual(onDisk.hosts.cursor.sessions, { s1: 1, s2: 1 });
});

test('K3 unknown hosts report zero instead of inventing a bucket', (t) => {
    const file = scratch(t);
    const ledger = createUsageLedger({ path: file });
    assert.deepEqual(ledger.hostReport('nobody'), { host: 'nobody', calls: 0, firstAt: null, lastAt: null, tools: {} });
    assert.deepEqual(readUsage(file).hosts, {});
    assert.equal(existsSync(file), false);
});

test('K3 attribution survives a second daemon on another port', (t) => {
    const file = scratch(t);
    // Two ledgers over one file stand in for two daemons sharing the global `~/.actspan` ledger.
    const first = createUsageLedger({ path: file });
    const second = createUsageLedger({ path: file });
    first.record({ host: 'cursor', tool: 'page.click', at: 1000 });
    second.record({ host: 'codex', tool: 'tabs.list', at: 2000 });
    first.record({ host: 'cursor', tool: 'page.click', at: 3000 });

    const hosts = readUsage(file).hosts;
    assert.equal(hosts.cursor.calls, 2);
    assert.equal(hosts.codex.calls, 1);
});

test('K3 tool and session counters stay bounded', (t) => {
    const file = scratch(t);
    const ledger = createUsageLedger({ path: file });
    for (let index = 0; index < 40; index += 1) ledger.record({ host: 'cursor', tool: `tool.${index}`, sessionId: `s${index}`, at: index });
    const entry = readUsage(file).hosts.cursor;
    assert.equal(entry.calls, 40);
    assert.equal(Object.keys(entry.tools).length, 32);
    assert.equal(Object.keys(entry.sessions).length, 16);
    // The newest key survives eviction, so the quota view never loses the live call.
    assert.equal(entry.tools['tool.39'], 1);
    assert.equal(entry.sessions.s39, 1);
});

// 整数样的键在 Object.keys 里排最前：若把「刚记的键」当成最旧的删掉再写回，上限就永远多出一个。
test('K3 integer-like session keys still respect the bound', (t) => {
    const file = scratch(t);
    const ledger = createUsageLedger({ path: file });
    for (let index = 0; index < 40; index += 1) ledger.record({ host: 'cursor', tool: `${index}`, sessionId: `${index}`, at: index });
    const entry = readUsage(file).hosts.cursor;
    assert.equal(Object.keys(entry.sessions).length, 16);
    assert.equal(Object.keys(entry.tools).length, 32);
    assert.equal(entry.sessions['39'], 1);
    assert.equal(entry.tools['39'], 1);
});

test('K3 host table stays bounded and keeps the active host', (t) => {
    const file = scratch(t);
    const ledger = createUsageLedger({ path: file });
    for (let index = 0; index < 70; index += 1) ledger.record({ host: `host-${index}`, tool: 'page.click', at: index });
    const hosts = readUsage(file).hosts;
    assert.equal(Object.keys(hosts).length, 64);
    assert.equal(hosts['host-69'].calls, 1);
    assert.equal(hosts['host-0'], undefined);
});

test('K3 a corrupt ledger degrades to empty instead of throwing', (t) => {
    const file = scratch(t);
    writeFileSync(file, '{ not json');
    const ledger = createUsageLedger({ path: file });
    assert.deepEqual(ledger.snapshot().hosts, {});
    ledger.record({ host: 'cursor', tool: 'page.click', at: 1000 });
    assert.equal(readUsage(file).hosts.cursor.calls, 1);
    assert.equal(readUsage(file).version, USAGE_LEDGER_VERSION);
});

test('K3 a rejected version is discarded rather than misread', (t) => {
    const file = scratch(t);
    writeFileSync(file, JSON.stringify({ version: 99, hosts: { cursor: { calls: 5 } } }));
    assert.deepEqual(readUsage(file).hosts, {});
});

test('K3 writes are atomic and leave no temp file behind', (t) => {
    const file = scratch(t);
    const ledger = createUsageLedger({ path: file });
    ledger.record({ host: 'cursor', tool: 'page.click', at: 1000 });
    assert.deepEqual(readdirSync(path.dirname(file)), ['usage.json']);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).hosts.cursor.calls, 1);
    assert.ok(statSync(file).size > 0);
});

test('K3 an unwritable ledger reports failure without throwing', (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'actspan-usage-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    // A regular file where the ledger directory belongs makes both mkdir and rename fail.
    const blocker = path.join(dir, 'blocker');
    writeFileSync(blocker, 'not a directory');
    const ledger = createUsageLedger({ path: path.join(blocker, 'usage.json') });
    assert.equal(ledger.record({ host: 'cursor', tool: 'page.click', at: 1 }), false);
    assert.deepEqual(ledger.snapshot().hosts, {});
});
