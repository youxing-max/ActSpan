import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { serverDefinition, planConfig, applyPlan, printPlan, runInstall, versionReport, discoverConfigs, extensionIdFromKey, pairExtension } from '../install.js';
import { validateConfig } from '../catalog.js';

const CONTROL_PLANE = { apiUrl: 'https://api.example.com', apiKey: 'installer-key' };

test('installer keeps package and extension versions consistent', () => {
    assert.equal(versionReport().consistent, true);
});

test('public manifest and publishable package share version and stable identity', () => {
    const manifest = JSON.parse(fs.readFileSync(new URL('../../public/manifest.json', import.meta.url), 'utf8'));
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(versionReport().consistent, true);
    assert.equal(manifest.version, pkg.version);
    assert.equal(manifest.key, pkg.actspan.extensionKey);
    const id = extensionIdFromKey();
    assert.match(id, /^[a-p]{32}$/);
    assert.equal(extensionIdFromKey(), id);
});

test('loopback onboarding hands the extension URL to the address bar and accepts only the manifest-derived id', async () => {
    let port;
    const paired = pairExtension({ open: false, timeoutMs: 3000, output: (text) => { port = Number(text.match(/端口 (\d+)/)?.[1]); } });
    while (!port) await new Promise((resolve) => setTimeout(resolve, 5));
    const guide = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.doesNotMatch(guide, /href="chrome-extension:/);
    const pasted = guide.match(/<pre id="pair-url">([^<]+)<\/pre>/)?.[1];
    assert.ok(pasted, 'guide must print the exact extension URL for the address bar');
    const target = new URL(pasted.replaceAll('&amp;', '&'));
    assert.equal(target.protocol, 'chrome-extension:');
    assert.equal(target.pathname, '/welcome.html');
    const headers = { 'x-actspan-pairing': target.searchParams.get('pair_nonce') };
    const rejected = await fetch(`http://127.0.0.1:${port}/pair`, {
        method: 'POST', headers, body: JSON.stringify({ extensionId: 'a'.repeat(32) }),
    });
    assert.equal(rejected.status, 400);
    const response = await fetch(`http://127.0.0.1:${port}/pair`, {
        method: 'POST', headers, body: JSON.stringify({ extensionId: extensionIdFromKey() }),
    });
    assert.equal(response.status, 204);
    assert.deepEqual(await paired, { extensionId: extensionIdFromKey() });
});

test('generated definition carries the control-plane config the server validates', () => {
    const definition = serverDefinition({ extensionId: extensionIdFromKey(), fromNpm: true, ...CONTROL_PLANE });
    assert.match(definition.env.ACTSPAN_BRIDGE_URL, /^ws:\/\/127\.0\.0\.1:/);
    assert.equal(definition.env.ACTSPAN_EXTENSION_IDS, extensionIdFromKey());
    assert.equal(definition.env.ACTSPAN_API_URL, CONTROL_PLANE.apiUrl);
    assert.equal(definition.env.ACTSPAN_API_KEY, CONTROL_PLANE.apiKey);
    assert.equal(validateConfig(definition.env).valid, true);
    assert.equal(Object.keys(definition.env).some((key) => /token/i.test(key)), false);
});

test('installer emits a local-only definition the server accepts when no control plane is configured', () => {
    const definition = serverDefinition({ extensionId: extensionIdFromKey() });
    assert.equal(definition.env.ACTSPAN_API_URL, undefined);
    assert.equal(definition.env.ACTSPAN_API_KEY, undefined);
    const checked = validateConfig(definition.env);
    assert.equal(checked.valid, true);
    assert.equal(checked.config.controlPlane, false);
    assert.equal(checked.config.pairingRequired, false);
});

test('installer refuses to emit a definition the server would reject', () => {
    assert.throws(() => serverDefinition({ extensionId: 'a'.repeat(32), apiUrl: 'http://api.example.com', apiKey: 'k' }), /control plane/);
    assert.throws(() => serverDefinition({ extensionId: 'not-an-id', ...CONTROL_PLANE }), /ACTSPAN_EXTENSION_IDS/);
});

test('installer CLI runs local-only without the control-plane environment', () => {
    const result = spawnSync(process.execPath, ['install.js', '--dry-run'], {
        cwd: new URL('..', import.meta.url),
        env: { ...process.env, ACTSPAN_API_URL: '', ACTSPAN_API_KEY: '' },
        encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /control plane|ACTSPAN_API_KEY/);
});

test('installer refuses a caller-supplied extension id that drifts from the manifest key', async () => {
    await assert.rejects(() => runInstall({ dryRun: true, extensionId: 'a'.repeat(32) }), /扩展 ID 不匹配/);
});

test('JSON install creates a timestamped backup before merge and writes a server-valid definition', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'actspan-install-'));
    const file = path.join(dir, 'mcp.json');
    writeFileSync(file, JSON.stringify({ mcpServers: { existing: { command: 'node' } } }));
    const plan = planConfig({ path: file, exists: true, format: 'json' }, serverDefinition({ extensionId: extensionIdFromKey(), ...CONTROL_PLANE }));
    const result = applyPlan(plan, { now: 123 });
    assert.equal(result.applied, true);
    assert.equal(fs.existsSync(`${file}.bak-123`), true);
    const written = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.actspan;
    assert.equal(written.env.ACTSPAN_EXTENSION_IDS, extensionIdFromKey());
    assert.equal(validateConfig(written.env).valid, true);
});

test('manual plan preview never prints the control-plane key', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'actspan-install-'));
    const file = path.join(dir, 'mcp.json');
    writeFileSync(file, JSON.stringify({ mcp: [['actspan', 'node']] }));
    const plan = planConfig({ path: file, exists: true, format: 'json' }, serverDefinition({ extensionId: extensionIdFromKey(), ...CONTROL_PLANE }));
    const lines = [];
    printPlan(plan, (text) => lines.push(text));
    assert.equal(plan.action, 'manual');
    assert.equal(applyPlan(plan).applied, false);
    assert.equal(lines.join('\n').includes(CONTROL_PLANE.apiKey), false);
    assert.match(lines.join('\n'), /\[redacted\]/);
});

test('discovery deduplicates known and home-scanned paths', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'actspan-home-'));
    const nested = path.join(dir, '.client');
    fs.mkdirSync(nested);
    writeFileSync(path.join(nested, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
    const found = discoverConfigs({ homeDir: dir, env: {}, platform: 'linux' });
    assert.equal(new Set(found.map((entry) => entry.path.toLowerCase())).size, found.length);
});
