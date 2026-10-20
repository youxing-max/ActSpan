#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { bridgePaths, ensureBridgeDaemon, stopBridgeDaemon, readMetadata, readCredential, processAlive } from './bridge-lock.js';

const args = process.argv.slice(2);
const command = (args[0] && !args[0].startsWith('--') ? args[0] : 'start').toLowerCase();
const valueOf = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
};
const port = Number(valueOf('--port') ?? 30121);
let pairOrigins = [];
try { pairOrigins = JSON.parse(valueOf('--origins-json') ?? '[]'); } catch { pairOrigins = []; }

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
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        print({ ok: false, error: `Invalid bridge port: ${port}` });
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
        print({ ok: false, error: `Unknown bridge command: ${command}`, usage: 'actspan bridge [start|stop|status|usage] [--port N] [--origins-json [...]]' });
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
