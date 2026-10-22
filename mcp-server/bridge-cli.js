#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { bridgePaths, ensureBridgeDaemon, stopBridgeDaemon, readMetadata, readCredential, processAlive } from './bridge-lock.js';

const args = process.argv.slice(2);
const FLAGS_WITH_VALUE = new Set(['--port', '--origins-json']);
// 子命令可以出现在 flag 之后（`--port 39999 status`）；不能因为首参是 --flag 就默认 start。
let command = 'start';
for (let i = 0; i < args.length; i += 1) {
    if (FLAGS_WITH_VALUE.has(args[i])) { i += 1; continue; }
    if (args[i].startsWith('-')) continue;
    command = args[i].toLowerCase();
    break;
}
const valueOf = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
};
const hasPort = args.includes('--port');
const port = hasPort ? Number(valueOf('--port')) : 30121;
const hasOrigins = args.includes('--origins-json');
let pairOrigins = [];
let originsError = null;
if (hasOrigins) {
    try {
        const parsed = JSON.parse(valueOf('--origins-json'));
        if (!Array.isArray(parsed) || parsed.some((origin) => typeof origin !== 'string')) throw new Error('must be a JSON string array');
        const invalid = parsed.filter((origin) => !/^chrome-extension:\/\/[a-p]{32}$/.test(origin));
        if (invalid.length) throw new Error(`invalid extension origin(s): ${invalid.join(', ')}`);
        pairOrigins = parsed;
    } catch (error) {
        originsError = `Invalid --origins-json: ${error.message}`;
    }
}

const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

function status() {
    const metadata = readMetadata(port);
    const credential = readCredential(port);
    const alive = processAlive(metadata?.pid);
    return {
        port,
        state: !metadata ? 'not_running' : alive ? 'running' : 'stale',
        pid: metadata?.pid ?? null,
        origins: metadata?.origins ?? [],
        rpcReady: Boolean(credential?.protocol),
        paths: bridgePaths(port),
    };
}

async function main() {
    if (args.includes('--help') || args.includes('-h')) {
        print({ ok: true, usage: 'actspan bridge [start|stop|status|usage] [--port N] [--origins-json JSON]' });
        return;
    }
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        print({ ok: false, error: `Invalid bridge port: ${valueOf('--port') ?? '(missing)'}` });
        process.exitCode = 1;
        return;
    }
    if (originsError) {
        print({ ok: false, error: originsError });
        process.exitCode = 1;
        return;
    }
    if (command === 'status') {
        print({ ok: true, ...status() });
        return;
    }
    if (command === 'usage') {
        // K3：按宿主 slug 的配额/积分归因视图；账本只读，由审计路径同步写入。
        const file = path.join(path.dirname(bridgePaths(port).lockPath), 'usage.json');
        let ledger = { version: 1, hosts: {} };
        try { ledger = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* No attributed calls yet. */ }
        print({ ok: true, command: 'usage', port, path: file, ...ledger });
        return;
    }
    if (command === 'stop') {
        const result = await stopBridgeDaemon({ port });
        print({ ok: result.stopped || result.reason === 'not_running', command: 'stop', port, ...result });
        process.exitCode = result.stopped || result.reason === 'not_running' ? 0 : 1;
        return;
    }
    if (command !== 'start') {
        print({ ok: false, error: `Unknown bridge command: ${command}`, usage: 'actspan bridge [start|stop|status|usage] [--port N] [--origins-json JSON]' });
        process.exitCode = 1;
        return;
    }
    try {
        const credential = await ensureBridgeDaemon({ port, pairOrigins });
        print({ ok: true, command: 'start', ...status(), daemonPid: credential.pid });
    } catch (error) {
        print({ ok: false, command: 'start', port, error: String(error?.message || error) });
        process.exitCode = 1;
    }
}

main().catch((error) => {
    print({ ok: false, error: String(error?.message || error) });
    process.exitCode = 1;
});
