import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { ExtensionHub } from '../bridge.js';
import { extensionIdFromKey } from '../install.js';

const origin = `chrome-extension://${extensionIdFromKey()}`;

async function connect(hub) {
    const frames = [];
    const ws = new WebSocket(`ws://127.0.0.1:${hub.wss.address().port}`, { headers: { Origin: origin } });
    ws.on('message', (raw) => frames.push(JSON.parse(raw.toString())));
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', token: hub.token }));
    while (!frames.some((frame) => frame.type === 'hello_ok')) await once(ws, 'message');
    return { ws, frames };
}

async function waitForFrame(frames, predicate, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const frame = frames.find(predicate);
        if (frame) return frame;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return null;
}

test('local timeout tells the extension to abandon the request so it stops executing', async (t) => {
    const hub = new ExtensionHub('secret-token', { port: 0, pairOrigins: [origin] });
    await hub.start();
    t.after(() => hub.stop());
    const { ws, frames } = await connect(hub);
    t.after(() => ws.terminate());

    const pending = hub.call('ping', {}, 60);
    const request = await waitForFrame(frames, (frame) => typeof frame.id === 'string');
    assert.ok(request, 'request frame never reached the extension');
    await assert.rejects(pending, /timed out/);

    const cancel = await waitForFrame(frames, (frame) => frame.type === 'actspan_mcp_cancel');
    assert.ok(cancel, 'no actspan_mcp_cancel frame after local timeout');
    assert.equal(cancel.id, request.id);
    assert.equal(hub.pending.size, 0);
});
