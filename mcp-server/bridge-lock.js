import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
 
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
export const BRIDGE_APP_VERSION = PACKAGE_VERSION;

export const PROTOCOL = 'actspan-bridge-rpc-v1';

/** 锁 mtime 超过这个时长且没有心跳，判为上次崩溃残留。 */
export const STALE_LOCK_MS = 30000;
/** daemon 心跳间隔；必须显著小于 STALE_LOCK_MS。 */
export const LOCK_HEARTBEAT_MS = 10000;
const STARTUP_TIMEOUT_MS = 10000;
const SPAWN_GRACE_MS = 2000;
const STOP_TIMEOUT_MS = 5000;
export const bridgePaths = (port) => {
    // 测试可用 ACTSPAN_STATE_DIR 指向临时目录，避免读写真实 ~/.actspan 与并发测试互相干扰。
    const dir = process.env.ACTSPAN_STATE_DIR || path.join(os.homedir(), '.actspan');
    return {
        dir,
        lockPath: path.join(dir, `bridge-${port}.lock`),
        startLockPath: path.join(dir, `bridge-${port}.start.lock`),
        metadataPath: path.join(dir, `bridge-${port}.json`),
        credentialPath: path.join(dir, `bridge-${port}.rpc`),
        logPath: path.join(dir, `bridge-${port}.log`),
    };
};

export const credentialPath = (port) => bridgePaths(port).credentialPath;

export function processAlive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * 锁的存活判据：pid 已死 → 立刻判残留；否则看 mtime。
 * mtime 由持有者的心跳维持，所以「进程还在但 daemon 卡死」也能在 30s 内自愈。
 */
export function lockIsStale(lockPath, staleMs = STALE_LOCK_MS) {
    let stat;
    try { stat = fs.statSync(lockPath); } catch { return true; }
    const owner = readJson(lockPath);
    if (owner && !processAlive(owner.pid)) return true;
    return Date.now() - stat.mtimeMs > staleMs;
}

export const readMetadata = (port) => readJson(bridgePaths(port).metadataPath);
/** 只接受形状完整的凭据，避免半写文件把客户端引到错误的端口上。 */
export function readCredential(port) {
    const value = readJson(bridgePaths(port).credentialPath);
    if (value?.protocol !== PROTOCOL || !processAlive(value.pid) ||
        !Number.isInteger(value.rpcPort) || value.rpcPort <= 0 || value.rpcPort > 65535 ||
        typeof value.secret !== 'string' || value.secret.length < 16 ||
        typeof value.nonce !== 'string' || value.nonce.length < 16) return null;
    return value;
}

/** O_EXCL 抢启动锁：赢的进程负责 spawn daemon，输的进程只等它起来。 */
export function tryAcquireStartLock(port) {
    const { dir, startLockPath } = bridgePaths(port);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt++) {
        const nonce = randomUUID();
        try {
            fs.writeFileSync(startLockPath, JSON.stringify({ pid: process.pid, nonce, port }), { flag: 'wx', mode: 0o600 });
            return { acquired: true, nonce, path: startLockPath };
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            if (!lockIsStale(startLockPath)) return { acquired: false, path: startLockPath };
            try { fs.unlinkSync(startLockPath); } catch { /* Another process healed it first. */ }
        }
    }
    return { acquired: false, path: startLockPath };
}

/**
 * daemon 接管启动锁：换成自己的 pid，此后由心跳维持新鲜度。
 * 无条件接管是安全的——只有抢到 O_EXCL 的进程才会 spawn daemon，所以此刻的持有者就是本次 spawn 的发起者。
 */
export function takeOverStartLock(port) {
    const { dir, startLockPath } = bridgePaths(port);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const nonce = randomUUID();
    try {
        fs.writeFileSync(startLockPath, JSON.stringify({ pid: process.pid, nonce, port, role: 'daemon' }), { mode: 0o600 });
    } catch { return null; }
    return { acquired: true, nonce, path: startLockPath };
}

export function releaseStartLock(lock) {
    if (!lock?.acquired || !lock.nonce) return;
    try {
        if (readJson(lock.path)?.nonce === lock.nonce) fs.unlinkSync(lock.path);
    } catch { /* Never remove another process's lock. */ }
}

export function touchStartLock(port) {
    try {
        const now = new Date();
        fs.utimesSync(bridgePaths(port).startLockPath, now, now);
    } catch { /* Lock may already be gone. */ }
}

/** 心跳同时刷新启动锁与 WS 端口锁，让两把锁的 mtime 都能判「持有者还活着」。 */
export function startLockHeartbeat(port, intervalMs = LOCK_HEARTBEAT_MS) {
    const { startLockPath, lockPath } = bridgePaths(port);
    const beat = () => {
        const now = new Date();
        for (const file of [startLockPath, lockPath]) {
            try { fs.utimesSync(file, now, now); } catch { /* Lock may already be gone. */ }
        }
    };
    const timer = setInterval(beat, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
}

export function spawnBridgeDaemon({ port, pairOrigins = [] }) {
    const { dir, logPath } = bridgePaths(port);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const daemonPath = fileURLToPath(new URL('./bridge-daemon.js', import.meta.url));
    const log = fs.openSync(logPath, 'a', 0o600);
    try {
        const child = spawn(process.execPath,
            [daemonPath, '--port', String(port), '--origins-json', JSON.stringify(pairOrigins)],
            { detached: true, stdio: ['ignore', log, log], windowsHide: true });
        child.unref();
        return child.pid;
    } finally {
        fs.closeSync(log);
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 拿到可用 daemon 的凭据：抢到锁就 spawn 一次，没抢到就轮询等它起来。
 * spawn 宽限期内没起来（端口被占等）就交还锁，让下一个进程重试。
 */
export async function ensureBridgeDaemon({ port, pairOrigins = [], timeoutMs = STARTUP_TIMEOUT_MS, spawnGraceMs = SPAWN_GRACE_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    const origins = [...new Set(pairOrigins)].sort();
    let lock = { acquired: false };
    let spawnDeadline = 0;
    let restartRequested = false;
    while (Date.now() < deadline) {
        const credential = readCredential(port);
        if (credential) {
            if (JSON.stringify([...new Set(credential.origins || [])].sort()) !== JSON.stringify(origins)) {
                releaseStartLock(lock);
                throw new Error(`Bridge port ${port} is owned by an incompatible extension allowlist`);
            }
            if (credential.appVersion !== PACKAGE_VERSION) {
                if (!restartRequested) {
                    restartRequested = true;
                    if (readMetadata(port)?.pid) await stopBridgeDaemon({ port });
                    // bridge.json 可能比凭据先消失；凭据本身是 0600 且由 daemon 自己写入，仍可据此优雅退役。
                    else await requestGracefulStop(credential, STOP_TIMEOUT_MS);
                }
                await sleep(50);
                continue;
            }
            releaseStartLock(lock);
            return credential;
        }
        if (!lock.acquired) lock = tryAcquireStartLock(port);
        if (lock.acquired && !spawnDeadline) {
            spawnBridgeDaemon({ port, pairOrigins: origins });
            spawnDeadline = Date.now() + spawnGraceMs;
        }
        // spawn 后宽限期内没起来（端口被占、启动即崩）就交还锁，让下一个进程重试。
        if (lock.acquired && Date.now() >= spawnDeadline) {
            releaseStartLock(lock);
            lock = { acquired: false };
            spawnDeadline = 0;
        }
        await sleep(50);
    }
    releaseStartLock(lock);
    throw new Error(`Bridge daemon did not become ready on port ${port}`);
}

/**
 * 通过 daemon 自己的 IPC 请求优雅退出：daemon 会先把在途命令回成错误再退。
 * 只有 bridge.json 里那个 pid 会被停；IPC 不可达（daemon 卡死）时才退回 SIGTERM。
 */
async function requestGracefulStop(credential, timeoutMs) {
    return new Promise((resolve) => {
        const socket = net.createConnection({ host: '127.0.0.1', port: credential.rpcPort });
        const id = randomUUID();
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { socket.destroy(); } catch { /* already gone */ }
            resolve(value);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        socket.setNoDelay(true);
        socket.on('error', () => finish(false));
        socket.on('close', () => finish(false));
        socket.on('connect', () => {
            socket.write(`${JSON.stringify({ type: 'auth', protocol: PROTOCOL, secret: credential.secret,
                clientId: 'actspan-bridge-cli', sessionId: 'actspan-bridge-cli', role: 'operator' })}\n`);
            socket.write(`${JSON.stringify({ type: 'call', id, method: 'status.shutdown', params: {} })}\n`);
        });
        let buffered = '';
        socket.on('data', (chunk) => {
            buffered += chunk.toString('utf8');
            let end;
            while ((end = buffered.indexOf('\n')) >= 0) {
                const line = buffered.slice(0, end);
                buffered = buffered.slice(end + 1);
                if (!line) continue;
                let message;
                try { message = JSON.parse(line); } catch { continue; }
                if (message?.type === 'result' && message.id === id) finish(message.ok === true);
            }
        });
    });
}

/** PID 可能被系统复用：发信号前确认命令行确实是 bridge daemon，避免杀掉无关进程。
 *  返回 'bridge' | 'not_bridge' | 'unknown'。'unknown' = 检测手段本身失败（超时等），
 *  调用方应区分处理，而不是当成 'not_bridge' 跳过。 */
function isBridgeProcess(pid) {
    try {
        const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
        if (cmdline.trim()) return /bridge(?:-daemon)?\.js\b/.test(cmdline) ? 'bridge' : 'not_bridge';
    } catch { /* 非 Linux 或进程已退出，继续用 ps 兜底 */ }
    try {
        const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 1000 });
        if (command.trim()) return /bridge(?:-daemon)?\.js\b/.test(command) ? 'bridge' : 'not_bridge';
    } catch { /* 非 POSIX 或无 ps，继续按平台兜底 */ }
    if (process.platform === 'win32') {
        // Get-CimInstance 冷启动 1.5–2s，并行负载下可能超过 5s。
        // 第一次超时时用更大预算重试一次；两次都失败才视为「无法确认」。
        for (const timeout of [5000, 15000]) {
            try {
                const command = execFileSync('powershell.exe', ['-NoProfile', '-Command',
                    `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: 'utf8', timeout });
                return /bridge(?:-daemon)?\.js\b/.test(command) ? 'bridge' : 'not_bridge';
            } catch (err) {
                if (timeout === 15000) return 'unknown';
                // 只有超时类错误才值得重试；进程不存在等错误直接判 not_bridge。
                if (err.code !== 'ETIMEDOUT' && !err.killed) return 'not_bridge';
            }
        }
    }
    return 'unknown';
}

/** E5：只认 bridge.json 里那个 pid；先走优雅退出，退不掉才发 SIGTERM。 */
export async function stopBridgeDaemon({ port, timeoutMs = STOP_TIMEOUT_MS } = {}) {
    const metadata = readMetadata(port);
    if (!metadata || !processAlive(metadata.pid)) return { stopped: false, reason: 'not_running', pid: metadata?.pid ?? null };
    const pid = metadata.pid;
    const deadline = Date.now() + timeoutMs;
    const credential = readCredential(port);
    if (credential && credential.pid === pid && await requestGracefulStop(credential, Math.min(1000, timeoutMs))) {
        while (Date.now() < deadline) {
            if (!processAlive(pid)) return { stopped: true, pid, graceful: true };
            await sleep(50);
        }
        return { stopped: false, reason: 'timeout', pid };
    }
    // 走到 SIGTERM 前必须确认命令行确实是 bridge；PID 可能已被系统复用。
    const check = isBridgeProcess(pid);
    if (check === 'not_bridge') return { stopped: false, reason: 'pid_mismatch', pid };
    if (check === 'unknown') return { stopped: false, reason: 'pid_unverified', pid };
    try {
        process.kill(pid, 'SIGTERM');
    } catch (error) {
        if (error.code === 'ESRCH') return { stopped: false, reason: 'not_running', pid };
        throw error;
    }
    while (Date.now() < deadline) {
        if (!processAlive(pid)) return { stopped: true, pid, graceful: false };
        await sleep(50);
    }
    return { stopped: false, reason: 'timeout', pid };
}
