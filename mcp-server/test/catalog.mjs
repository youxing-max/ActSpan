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

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('exports the fixed Actspan tool catalog', () => {
    assert.deepEqual(TOOL_NAMES, [
        'actspan_status',
        'actspan_feishu_push',
        'actspan_tabs_list',
        'actspan_tab_open',
        'actspan_tab_close',
        'actspan_tab_navigate',
        'actspan_page_read',
        'actspan_page_click',
        'actspan_page_type',
        'actspan_page_eval',
        'actspan_screenshot',
        'actspan_skills_list',
        'actspan_skill_detail',
        'actspan_workflow_run',
        'actspan_agent_submit',
        'actspan_agent_status',
        'actspan_agent_result',
        'actspan_agent_cancel',
    ]);
});

test('rejects missing and insecure MCP configuration without exposing values', () => {
    const invalid = validateConfig({ ACTSPAN_API_URL: 'http://api.example.com', ACTSPAN_API_KEY: '' });
    assert.equal(invalid.valid, false);
    assert.match(invalid.errors.join('\n'), /ACTSPAN_API_URL/);
    assert.match(invalid.errors.join('\n'), /ACTSPAN_API_KEY/);
    assert.doesNotMatch(invalid.errors.join('\n'), /secret|sk-/i);

    const valid = validateConfig({
        ACTSPAN_API_URL: 'https://api.example.com',
        ACTSPAN_API_KEY: 'secret-value',
        ACTSPAN_BRIDGE_URL: 'ws://127.0.0.1:30121',
        ACTSPAN_EXTENSION_IDS: 'afadkcbnpkhbofmbmlhjcppegjhkckdi',
    });
    assert.equal(valid.valid, true);
    assert.equal(valid.config.apiKey, 'secret-value');
});
test('requires an extension allowlist for automatic pairing', () => {
    const missing = validateConfig({
        ACTSPAN_API_URL: 'https://api.example.com',
        ACTSPAN_API_KEY: 'secret-value',
    });
    assert.equal(missing.valid, false);
    assert.match(missing.errors.join('\n'), /ACTSPAN_EXTENSION_IDS/);
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
