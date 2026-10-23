import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { serverDefinition, planConfig, applyPlan, printPlan, versionReport, discoverConfigs, extensionIdFromKey, pairExtension } from '../install.js';
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
    const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'actspan-home-'));
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    writeFileSync(path.join(fakeHome, '.codex', 'config.toml'), 'model = "o3"\n');
    try {
        const result = spawnSync(process.execPath, ['install.js', '--dry-run'], {
            cwd: new URL('..', import.meta.url),
            env: { ...process.env, HOME: fakeHome, ACTSPAN_API_URL: '', ACTSPAN_API_KEY: '' },
            encoding: 'utf8',
        });
        assert.equal(result.status, 0);
        assert.doesNotMatch(result.stdout, /control plane|ACTSPAN_API_KEY/);
    } finally {
        fs.rmSync(fakeHome, { recursive: true, force: true });
    }
});

test('installer refuses a caller-supplied extension id that drifts from the manifest key', () => {
    const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'actspan-home-'));
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    writeFileSync(path.join(fakeHome, '.codex', 'config.toml'), 'model = "o3"\n');
    try {
        const result = spawnSync(process.execPath, ['install.js', '--dry-run', '--extension-id', 'a'.repeat(32)], {
            cwd: new URL('..', import.meta.url),
            env: { ...process.env, HOME: fakeHome, ACTSPAN_API_URL: '', ACTSPAN_API_KEY: '' },
            encoding: 'utf8',
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /扩展 ID 不匹配/);
    } finally {
        fs.rmSync(fakeHome, { recursive: true, force: true });
    }
});

test('非交互安装没有扩展 ID 时快速失败，不会空等配对', () => {
    const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'actspan-home-'));
    const config = path.join(fakeHome, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    writeFileSync(config, 'model = "o3"\n');
    try {
        const startedAt = Date.now();
        const result = spawnSync(process.execPath, ['install.js', '--apply', '--yes'], {
            cwd: new URL('..', import.meta.url),
            env: { ...process.env, HOME: fakeHome, ACTSPAN_API_URL: '', ACTSPAN_API_KEY: '' },
            encoding: 'utf8',
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /非交互环境/);
        assert.equal(fs.readFileSync(config, 'utf8'), 'model = "o3"\n');
        assert.ok(Date.now() - startedAt < 5000, 'should not wait for the default 120s pairing timeout');
    } finally {
        fs.rmSync(fakeHome, { recursive: true, force: true });
    }
});

test('非法 --pair-timeout 在写配置前被拒绝', () => {
    const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'actspan-home-'));
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    writeFileSync(path.join(fakeHome, '.codex', 'config.toml'), 'model = "o3"\n');
    try {
        const result = spawnSync(process.execPath, ['install.js', '--apply', '--yes', '--pair-timeout', 'abc'], {
            cwd: new URL('..', import.meta.url),
            env: { ...process.env, HOME: fakeHome, ACTSPAN_API_URL: '', ACTSPAN_API_KEY: '' },
            encoding: 'utf8',
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /Invalid --pair-timeout/);
    } finally {
        fs.rmSync(fakeHome, { recursive: true, force: true });
    }
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

test('扫描到的未知配置默认只预览，必须显式 --include-unknown 才写入', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'actspan-unknown-'));
    const nested = path.join(dir, '.unknown-client');
    fs.mkdirSync(nested);
    const file = path.join(nested, 'mcp.json');
    writeFileSync(file, JSON.stringify({ mcpServers: {} }));
    const entry = discoverConfigs({ homeDir: dir, env: {}, platform: 'linux' }).find((item) => item.path === file);
    assert.equal(entry?.known, false);
    const definition = serverDefinition({ extensionId: extensionIdFromKey(), ...CONTROL_PLANE });
    const blocked = planConfig(entry, definition);
    assert.equal(blocked.action, 'manual');
    assert.match(blocked.reason, /include-unknown/);
    assert.equal(applyPlan(blocked).applied, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { mcpServers: {} });

    const allowed = planConfig(entry, definition, { unknownAllowed: true });
    assert.notEqual(allowed.action, 'manual');
    assert.equal(applyPlan(allowed).applied, true);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.actspan.command, process.execPath);
});

test('非对象的 mcpServers 被判为 unsupported，绝不展开成数字键', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'actspan-shape-'));
    const definition = serverDefinition({ extensionId: extensionIdFromKey(), ...CONTROL_PLANE });
    for (const value of [[{ command: 'node' }], 'oops', null]) {
        const file = path.join(dir, `mcp-${typeof value}-${Array.isArray(value) ? 'array' : String(value)}.json`);
        const original = JSON.stringify({ mcpServers: value }, null, 2);
        writeFileSync(file, original);
        const plan = planConfig({ path: file, exists: true, format: 'json' }, definition);
        assert.equal(plan.action, 'manual');
        assert.match(plan.reason, /mcpServers 不是普通对象/);
        assert.equal(applyPlan(plan).applied, false);
        assert.equal(fs.readFileSync(file, 'utf8'), original);
    }
});

test('旧 actspan 配置与当前安装不一致时要求 --force 才更新', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'actspan-stale-'));
    const file = path.join(dir, 'mcp.json');
    writeFileSync(file, JSON.stringify({ mcpServers: { actspan: { command: 'old-node', args: ['old.js'] } } }, null, 2));
    const definition = serverDefinition({ extensionId: extensionIdFromKey(), ...CONTROL_PLANE });
    const stale = planConfig({ path: file, exists: true, format: 'json' }, definition);
    assert.equal(stale.action, 'manual');
    assert.match(stale.reason, /--force/);
    assert.equal(applyPlan(stale).applied, false);

    const forced = planConfig({ path: file, exists: true, format: 'json' }, definition, { force: true });
    assert.equal(forced.action, 'merge');
    assert.equal(applyPlan(forced, { now: 456 }).applied, true);
    const written = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.actspan;
    assert.deepEqual(written, definition);
    assert.equal(fs.existsSync(`${file}.bak-456`), true);
});

const canCreateSymlink = (() => {
    try {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'actspan-symlink-probe-'));
        fs.symlinkSync(path.join(dir, 'a'), path.join(dir, 'b'));
        fs.rmSync(dir, { recursive: true, force: true });
        return true;
    } catch {
        return false;
    }
})();

test('原子写入保留 dotfiles 符号链接并更新真实目标', { skip: canCreateSymlink ? false : '当前账户不允许创建符号链接（Windows 需开发者模式或管理员权限）' }, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'actspan-symlink-'));
    const real = path.join(dir, 'dotfiles-config.toml');
    const link = path.join(dir, 'config.toml');
    writeFileSync(real, '[other]\nkey = "value"\n');
    fs.symlinkSync(real, link);
    const definition = serverDefinition({ extensionId: extensionIdFromKey(), ...CONTROL_PLANE });
    const plan = planConfig({ path: link, exists: true, format: 'toml' }, definition);
    assert.equal(applyPlan(plan, { now: 789 }).applied, true);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(link), fs.realpathSync(real));
    const updated = fs.readFileSync(real, 'utf8');
    assert.match(updated, /\[other\]/);
    assert.match(updated, /\[mcp_servers\.actspan\]/);
});

test('损坏配置导致 0 写入时 CLI 以非零退出', () => {
    const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'actspan-home-'));
    // Windows 走 %APPDATA% 且 os.homedir() 只认 USERPROFILE；只改 HOME 会写到真实目录。
    const fakeAppData = path.join(fakeHome, 'AppData', 'Roaming');
    const cursorDir = process.platform === 'win32'
        ? path.join(fakeAppData, 'Cursor', 'User')
        : path.join(fakeHome, 'Library', 'Application Support', 'Cursor', 'User');
    fs.mkdirSync(cursorDir, { recursive: true });
    writeFileSync(path.join(cursorDir, 'mcp.json'), '{bad');
    const result = spawnSync(process.execPath, ['install.js', '--apply', '--yes', '--extension-id', extensionIdFromKey()], {
        cwd: new URL('..', import.meta.url),
        env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, APPDATA: fakeAppData, ACTSPAN_API_URL: '', ACTSPAN_API_KEY: '' },
        encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /没有写入任何配置/);
});

test('损坏配置旁边还有可写目标时 CLI 仍以非零退出', () => {
    // 只覆盖「0 写入」会让部分成功变成 exit 0：一个目标写成了，损坏的目标就被静默当成成功。
    const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'actspan-home-'));
    const fakeAppData = path.join(fakeHome, 'AppData', 'Roaming');
    const cursorDir = process.platform === 'win32'
        ? path.join(fakeAppData, 'Cursor', 'User')
        : path.join(fakeHome, 'Library', 'Application Support', 'Cursor', 'User');
    fs.mkdirSync(cursorDir, { recursive: true });
    writeFileSync(path.join(cursorDir, 'mcp.json'), '{bad');
    const codexConfig = path.join(fakeHome, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(codexConfig), { recursive: true });
    writeFileSync(codexConfig, 'model = "o3"\n');
    const result = spawnSync(process.execPath, ['install.js', '--apply', '--yes', '--extension-id', extensionIdFromKey()], {
        cwd: new URL('..', import.meta.url),
        env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, APPDATA: fakeAppData, ACTSPAN_API_URL: '', ACTSPAN_API_KEY: '' },
        encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /需要人工处理或使用 --force/);
    // 可写目标确实写成了，说明这里测的是「部分成功也不能报成功」。
    assert.match(fs.readFileSync(codexConfig, 'utf8'), /\[mcp_servers\.actspan\]/);
    assert.equal(fs.readFileSync(path.join(cursorDir, 'mcp.json'), 'utf8'), '{bad');
});

test('TOML 首次写入后二次安装应 skip，--force 不产生重复 env 表', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'actspan-toml-idem-'));
    const file = path.join(dir, 'config.toml');
    writeFileSync(file, '[other]\nx = 1\n');
    const definition = serverDefinition({ extensionId: extensionIdFromKey(), ...CONTROL_PLANE });
    const first = planConfig({ path: file, exists: true, format: 'toml' }, definition);
    assert.equal(first.action, 'append');
    assert.equal(applyPlan(first, { now: 111 }).applied, true);

    const second = planConfig({ path: file, exists: true, format: 'toml' }, definition);
    assert.equal(second.action, 'skip', second.reason);

    const changed = { ...definition, command: '/tmp/new-node' };
    const forced = planConfig({ path: file, exists: true, format: 'toml' }, changed, { force: true });
    assert.equal(forced.action, 'merge');
    assert.equal(applyPlan(forced, { now: 222 }).applied, true);
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /command = "\/tmp\/new-node"/);
    assert.equal((text.match(/^\[mcp_servers\.actspan\]$/gm) || []).length, 1);
    assert.equal((text.match(/^\[mcp_servers\.actspan\.env\]$/gm) || []).length, 1);
    assert.match(text, /\[other\]\nx = 1/);
});

test('TOML 旧 actspan 段在 --force 时原位替换并保留其它表', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'actspan-toml-stale-'));
    const file = path.join(dir, 'config.toml');
    writeFileSync(file, '[other]\nx = 1\n\n[mcp_servers.actspan]\ncommand = "old"\nargs = ["old.js"]\n\n[after]\ny = 2\n');
    const definition = serverDefinition({ extensionId: extensionIdFromKey(), ...CONTROL_PLANE });
    assert.equal(planConfig({ path: file, exists: true, format: 'toml' }, definition).action, 'manual');
    const forced = planConfig({ path: file, exists: true, format: 'toml' }, definition, { force: true });
    assert.equal(forced.action, 'merge');
    assert.equal(applyPlan(forced, { now: 321 }).applied, true);
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /\[other\]\nx = 1/);
    assert.match(text, /\[after\]\ny = 2/);
    // 写出用 JSON.stringify 做 TOML 转义，Windows 路径里的 \ 会变成 \\；断言必须按转义后的字面量比。
    const escapedCommand = JSON.stringify(definition.command).slice(1, -1);
    assert.match(text, new RegExp(`command = "${escapedCommand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
    assert.equal((text.match(/\[mcp_servers\.actspan\]/g) || []).length, 1);
});
