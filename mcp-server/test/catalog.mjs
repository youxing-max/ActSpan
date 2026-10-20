import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
    RegistryCatalog,
    TOOL_NAMES,
    normalizeTaskHandle,
    validateConfig,
} from '../catalog.js';
import { extensionIdFromKey } from '../install.js';
import { stopBridgeDaemon } from '../bridge-lock.js';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('exports the fixed Actspan tool catalog', () => {
    assert.deepEqual(TOOL_NAMES, [
        'actspan_status',
        'actspan_status_update',
        'actspan_feishu_push',
        'actspan_tabs_list',
        'actspan_tabs_select',
        'actspan_tab_open',
        'actspan_tab_close',
        'actspan_tab_navigate',
        'actspan_page_snapshot',
        'actspan_page_read',
        'actspan_page_click',
        'actspan_page_type',
        'actspan_page_eval',
        'actspan_screenshot',
        'actspan_adopt',
        'actspan_act',
        'actspan_page_select',
        'actspan_page_upload',
        'actspan_page_key',
        'actspan_page_wait',
        'actspan_page_scroll',
        'actspan_network_list',
        'actspan_network_detail',
        'actspan_network_query',
        'actspan_data_fetch',
        'actspan_data_paginate',
        'actspan_data_download',
        'actspan_skills_list',
        'actspan_skill_detail',
        'actspan_workflow_run',
        'actspan_agent_submit',
        'actspan_agent_status',
        'actspan_agent_result',
        'actspan_agent_cancel',
    ]);
});

test('rejects an invalid local bridge URL without exposing values', () => {
    const invalid = validateConfig({ ACTSPAN_BRIDGE_URL: 'ws://evil.example:30121' });
    assert.equal(invalid.valid, false);
    assert.match(invalid.errors.join('\n'), /\[local bridge\]/);
    assert.match(invalid.errors.join('\n'), /ACTSPAN_BRIDGE_URL/);
    assert.doesNotMatch(invalid.errors.join('\n'), /secret|sk-/i);

    const valid = validateConfig({
        ACTSPAN_BRIDGE_URL: 'ws://127.0.0.1:30121',
        ACTSPAN_EXTENSION_IDS: extensionIdFromKey(),
    });
    assert.equal(valid.valid, true);
});

test('treats the control plane as optional and validates it only when enabled', () => {
    const localOnly = validateConfig({ ACTSPAN_EXTENSION_IDS: extensionIdFromKey() });
    assert.equal(localOnly.valid, true);
    assert.equal(localOnly.config.controlPlane, false);

    const halfConfigured = validateConfig({ ACTSPAN_API_URL: 'http://api.example.com', ACTSPAN_API_KEY: '' });
    assert.equal(halfConfigured.valid, false);
    assert.match(halfConfigured.errors.join('\n'), /\[control plane\]/);
    assert.match(halfConfigured.errors.join('\n'), /ACTSPAN_API_URL/);
    assert.match(halfConfigured.errors.join('\n'), /ACTSPAN_API_KEY/);

    const enabled = validateConfig({
        ACTSPAN_API_URL: 'https://api.example.com',
        ACTSPAN_API_KEY: 'secret-value',
        ACTSPAN_EXTENSION_IDS: extensionIdFromKey(),
    });
    assert.equal(enabled.valid, true);
    assert.equal(enabled.config.controlPlane, true);
    assert.equal(enabled.config.apiKey, 'secret-value');
});

test('starts without an allowlist but reports pairing as required', () => {
    const missing = validateConfig({});
    assert.equal(missing.valid, true);
    assert.equal(missing.config.pairingRequired, true);
    assert.deepEqual(missing.config.pairOrigins, []);
});

test('publishes the fixed npm entrypoint and runtime versions', () => {
    assert.equal(packageJson.name, '@actspan/mcp-server');
    assert.equal(packageJson.bin['actspan-mcp'], './index.js');
    assert.equal(packageJson.dependencies.ws, '8.18.0');
    assert.match(packageJson.engines.node, />=/);
});

test('invalid startup configuration writes diagnostics to stderr, not MCP stdout', () => {
    const result = spawnSync(process.execPath, ['index.js'], {
        cwd: new URL('..', import.meta.url),
        env: { ...process.env, ACTSPAN_API_URL: 'http://api.example.com', ACTSPAN_API_KEY: '' },
        encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /ACTSPAN_API_URL/);
    assert.match(result.stderr, /ACTSPAN_API_KEY/);
});

test('a zero-env MCP process starts and reports pairing_required without an allowlist', async (t) => {
    // 必须用独立端口：默认端口上可能已经跑着别的实例（或另一份验收用的守护进程），
    // 那时进程会因为 allowlist 不匹配退出 1，测试就误判成启动失败。
    const port = Number(process.env.ACTSPAN_CATALOG_PORT || 31927);
    t.after(() => stopBridgeDaemon({ port }));
    const result = spawnSync(process.execPath, ['index.js'], {
        cwd: new URL('..', import.meta.url),
        env: { ...process.env, ACTSPAN_BRIDGE_URL: `ws://127.0.0.1:${port}`, ACTSPAN_EXTENSION_IDS: '', ACTSPAN_API_URL: '', ACTSPAN_API_KEY: '' },
        input: '',
        encoding: 'utf8',
        timeout: 20000,
    });
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stderr, /Invalid configuration/);
});

test('fetches the next registry revision instead of serving stale catalog data', async () => {
    const snapshots = [
        { revision: 4, skills: [{ name: 'one' }], updatedAt: 10 },
        { revision: 5, skills: [{ name: 'two' }], updatedAt: 11 },
    ];
    const calls = [];
    const hub = { call: async (...args) => { calls.push(args); return snapshots.shift(); } };
    const catalog = new RegistryCatalog(hub);
    assert.equal((await catalog.list()).revision, 4);
    assert.equal((await catalog.list()).revision, 5);
    assert.equal(calls.length, 2);
    assert.equal(calls[1][0], 'registry.list');
});

test('normalizes an asynchronous workflow task handle', () => {
    assert.deepEqual(normalizeTaskHandle({ taskId: 'task-1', sessionId: 'session-1', registryRevision: 7, state: 'queued' }), {
        taskId: 'task-1', sessionId: 'session-1', registryRevision: 7, state: 'queued',
    });
    assert.throws(() => normalizeTaskHandle({ state: 'running' }), /taskId and sessionId/);
});
