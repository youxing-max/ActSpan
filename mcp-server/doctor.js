#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { fileURLToPath } from 'node:url';
import { extensionIdFromKey, versionReport } from './install.js';

const defaultMetadata = (port) => path.join(os.homedir(), '.actspan', `bridge-${port}.json`);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
export function readMetadata({ port = 30121, metadataPath = defaultMetadata(port) } = {}) {
    try { return { path: metadataPath, value: JSON.parse(fs.readFileSync(metadataPath, 'utf8')) }; }
    catch (error) { return { path: metadataPath, value: null, error: error.code === 'ENOENT' ? 'bridge metadata not found' : `bridge metadata unreadable: ${error.message}` }; }
}
export function processAlive(pid) {
    if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return false;
    try { process.kill(Number(pid), 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
export function ownerStatus(metadata) {
    if (!metadata?.value) return { state: 'not_running', message: metadata?.error || 'bridge metadata not found' };
    if (!processAlive(metadata.value.pid)) return { state: 'stale', message: `bridge.json 记录的 pid ${metadata.value.pid} 已经没了` };
    return { state: 'running', pid: metadata.value.pid, port: metadata.value.port, origins: metadata.value.origins || [] };
}

function wsRequest({ port, origin, frame, timeoutMs = 3000 }) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Origin: origin } });
        const timer = setTimeout(() => { socket.terminate(); reject(new Error('bridge handshake timed out')); }, timeoutMs);
        let settled = false;
        const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); socket.terminate(); fn(value); };
        socket.on('open', () => socket.send(JSON.stringify(frame)));
        socket.on('message', (raw) => { try { finish(resolve, JSON.parse(raw.toString())); } catch { finish(reject, new Error('bridge returned invalid handshake')); } });
        socket.on('error', (error) => finish(reject, error));
        socket.on('close', () => { if (!settled) finish(reject, new Error('bridge closed the handshake')); });
    });
}
export async function probeBridge({ port = 30121, timeoutMs = 3000 } = {}) {
    try {
        // owner 信息受 0600 元数据里的 nonce 保护；doctor 与 bridge 同用户，可读取同一文件。
        const nonce = readMetadata({ port }).value?.nonce;
        const owner = await wsRequest({ port, origin: 'actspan-mcp://owner-probe', frame: { type: 'owner.info', nonce }, timeoutMs });
        if (owner.type !== 'owner_info') return { state: 'error', message: '桥返回了异常的 owner_info 响应' };
        if (owner.connected === true) return { state: 'online', message: '握手正常 · 扩展在线' };
        return { state: 'hub_listening', message: owner.connected === false
            ? 'hub_listening：桥在监听，但扩展未连接'
            : 'hub_listening：桥在监听；当前桥版本未提供扩展在线状态，无法诚实判定握手成功' };
    } catch (error) {
        return { state: 'error', message: `桥探测失败：${error.message}` };
    }
}
export function identityCheck({ extensionId, origins = [] } = {}) {
    const canonicalId = extensionIdFromKey();
    const canonicalOrigin = `chrome-extension://${canonicalId}`;
    if (extensionId && extensionId !== canonicalId) return { canonicalId, canonicalOrigin, match: false,
        message: `扩展 ID 不匹配：配置/请求的是 chrome-extension://${extensionId}，但当前 manifest key 推导出的规范 ID 是 ${canonicalOrigin}。请用规范 ID 重新运行 actspan-install，否则 Bridge 会拒绝配对。` };
    if (!extensionId && origins.length && !origins.includes(canonicalOrigin)) return { canonicalId, canonicalOrigin, match: false,
        message: `运行中的桥 allowlist（${origins.join(', ')}）不含当前 manifest key 推导出的规范 ID ${canonicalOrigin}；这是旧的或错误的 allowlist，请重新运行 actspan-install。` };
    return { canonicalId, canonicalOrigin, match: true, message: null };
}

export function startBridge({ port = 30121, extensionId, logPath = path.join(os.homedir(), '.actspan', 'doctor-bridge.log') } = {}) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    const log = fs.openSync(logPath, 'a', 0o600);
    const env = { ...process.env, ACTSPAN_BRIDGE_URL: `ws://127.0.0.1:${port}`, ...(extensionId ? { ACTSPAN_EXTENSION_IDS: extensionId } : {}) };
    const child = spawn(process.execPath, [path.join(ROOT, 'index.js'), 'mcp', '--client', 'doctor'], { cwd: ROOT, env, detached: true, stdio: ['ignore', log, log], windowsHide: true });
    child.unref(); fs.closeSync(log);
    return { pid: child.pid, logPath };
}

const validPort = (value) => Number.isInteger(value) && value > 0 && value <= 65535;
export async function runDoctor({ port = 30121, metadataPath, start = false, yes = false, extensionId, output = console.log } = {}) {
    if (!validPort(port)) throw new Error(`Invalid port: ${port}（需要 1–65535 的整数）`);
    const version = versionReport();
    let started = null;
    const metadata = readMetadata({ port, metadataPath: metadataPath || defaultMetadata(port) });
    let status = ownerStatus(metadata);
    if (status.state !== 'running' && start) {
        if (!yes) throw new Error('不会启动桥进程：请使用 --start --yes 明确确认');
        const identity = identityCheck({ extensionId });
        if (!identity.match) throw new Error(identity.message);
        const startedInfo = startBridge({ port, extensionId: identity.canonicalId });
        started = startedInfo;
        output(`已请求启动桥（pid ${startedInfo.pid}）；日志写入 ${startedInfo.logPath}`);
        await new Promise((resolve) => setTimeout(resolve, 300));
        status = ownerStatus(readMetadata({ port, metadataPath: metadata.path }));
    }
    const identity = identityCheck({ extensionId, origins: status.state === 'running' ? status.origins : [] });
    if (!identity.match) output(identity.message);
    if (status.state === 'stale') output(status.message);
    if (status.state === 'not_running') output(`桥未运行：${status.message}`);
    if (status.state === 'running') {
        const origin = extensionId ? `chrome-extension://${extensionId}` : status.origins?.[0];
        status = { ...status, probe: await probeBridge({ port: status.port || port, origin }) };
        output(status.probe.message);
    }
    return { version, identity, status, ...(started ? { started } : {}) };
}

function parseArgs(argv) {
    const options = {};
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--start') options.start = true;
        else if (arg === '--yes') options.yes = true;
        else if (arg === '--port') {
            const raw = argv[++i];
            const value = Number(raw);
            if (!Number.isInteger(value) || value <= 0 || value > 65535) {
                options.error = `Invalid port: ${raw ?? '(missing)'}（需要 1–65535 的整数）`;
                return options;
            }
            options.port = value;
        } else if (arg === '--extension-id') options.extensionId = argv[++i];
        else if (arg === '--json') options.json = true;
        else if (arg === '--help' || arg === '-h') options.help = true;
    }
    return options;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const options = parseArgs(process.argv.slice(2));
    if (options.error) {
        process.stderr.write(`actspan doctor: ${options.error}\n`);
        process.exitCode = 1;
    } else if (options.help) {
        console.log('Usage: actspan-doctor [--start --yes] [--port PORT] [--extension-id ID] [--json]');
    } else {
        // --json 的 stdout 必须只有 JSON；人类提示走 stderr，不能污染机器可读输出。
        const human = options.json ? (line) => process.stderr.write(`${line}\n`) : console.log;
        runDoctor({ ...options, output: human }).then((result) => {
            if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
        }).catch((error) => {
            process.stderr.write(`actspan doctor: ${error.message}\n`);
            process.exitCode = 1;
        });
    }
}
