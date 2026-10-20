import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { stopBridgeDaemon } from '../bridge-lock.js';
import { TOOL_NAMES } from '../catalog.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.ACTSPAN_SCHEMA_PORT || 31923);

// 这两个工具确实不收参数。
const PARAMETERLESS = new Set(['actspan_status', 'actspan_skills_list']);

// 曾经 page_read/page_click/page_type 把参数表发布成空对象：targetSchema 返回的是
// .superRefine() 的 ZodEffects，SDK 的 normalizeObjectSchema 认不出（它只认带 .shape 的
// v3 schema），于是模型看不到 selector/ref/find/text/real/submit，只能靠猜。
test('every tool publishes the parameters it documents', async (t) => {
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(here, '..', 'index.js')],
        cwd: path.join(here, '..'),
        env: {
            ...getDefaultEnvironment(),
            ACTSPAN_BRIDGE_URL: `ws://127.0.0.1:${port}`,
            ACTSPAN_EXTENSION_IDS: '',
            ACTSPAN_API_URL: '',
            ACTSPAN_API_KEY: '',
        },
    });
    const client = new Client({ name: 'actspan-schema', version: '1.0.0' });
    t.after(async () => {
        await client.close();
        await stopBridgeDaemon({ port });
    });
    await client.connect(transport);
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const keysOf = (name) => Object.keys(byName.get(name).inputSchema.properties || {});

    assert.deepEqual([...byName.keys()].sort(), [...TOOL_NAMES].sort());
    for (const name of TOOL_NAMES) {
        assert.equal(byName.get(name).inputSchema.type, 'object', `${name} must publish an object schema`);
        if (PARAMETERLESS.has(name)) continue;
        assert.notEqual(keysOf(name).length, 0, `${name} published an empty parameter schema`);
    }

    // 三个曾经空表的目标工具：模型必须能直接看到定位与动作参数。
    assert.deepEqual(keysOf('actspan_page_read'), ['taskId', 'sessionId', 'tabId', 'selector', 'ref', 'snapshotId', 'find', 'format', 'maxChars']);
    assert.deepEqual(keysOf('actspan_page_click'), ['taskId', 'sessionId', 'tabId', 'selector', 'ref', 'snapshotId', 'find', 'real']);
    assert.deepEqual(keysOf('actspan_page_type'), ['taskId', 'sessionId', 'tabId', 'selector', 'ref', 'snapshotId', 'find', 'text', 'submit', 'real']);

    // 跨字段约束改由 handler 校验，但必须给出可读文案而不是序列化的 ZodError。
    const conflict = await client.callTool({ name: 'actspan_page_read', arguments: { selector: '#a', ref: 'e1' } });
    assert.equal(conflict.isError, true);
    assert.match(conflict.content[0].text, /mutually exclusive/);

    // P6：预算写进描述，不再用 maxItems 承诺一套、执行另一套。
    const steps = byName.get('actspan_act').inputSchema.properties.steps;
    assert.equal(steps.maxItems, undefined);
    assert.match(steps.description, /expanded atomic steps/);
});
