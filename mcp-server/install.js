#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateConfig } from './catalog.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'));
const AGENTS = JSON.parse(fs.readFileSync(path.join(HERE, 'agents.json'), 'utf8')).agents;
const EXTENSION_VERSION = PACKAGE.actspan.extensionVersion;
export function extensionIdFromKey(key = PACKAGE.actspan.extensionKey) { const digest = createHash('sha256').update(Buffer.from(key, 'base64')).digest().subarray(0, 16); return [...digest].flatMap((byte) => [byte >> 4, byte & 15]).map((nibble) => String.fromCharCode(97 + nibble)).join(''); }
export const VERSION = PACKAGE.version;
const home = os.homedir();

export function expandPath(value, env = process.env) {
    return path.resolve(String(value).replace(/^~(?=$|[\\/])/, home).replace(/%([^%]+)%/g, (_, key) => env[key] || `%${key}%`).replace(/^\$HOME(?=$|[\\/])/, home).replace(/^\$XDG_CONFIG_HOME(?=$|[\\/])/, env.XDG_CONFIG_HOME || path.join(home, '.config')));
}
export function platformPaths(agent, platform = process.platform, env = process.env) { const paths = agent.paths || {}; return (paths[platform] || paths.linux || []).map((candidate) => expandPath(candidate, env)); }
const pathKey = (file) => path.resolve(file).toLowerCase();
function walkJsonCandidates(root, maxDepth = 3, depth = 0, result = []) {
    if (depth > maxDepth || result.length >= 500) return result;
    let entries; try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return result; }
    for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const full = path.join(root, entry.name);
        if (entry.isFile() && /\.json$/i.test(entry.name)) {
            try { const parsed = JSON.parse(fs.readFileSync(full, 'utf8')); if (parsed?.mcpServers && typeof parsed.mcpServers === 'object') result.push(full); } catch { /* ignore */ }
        } else if (entry.isDirectory() && (depth === 0 || entry.name.startsWith('.') || /claude|cursor|windsurf|codeium|codex|cline/i.test(entry.name))) walkJsonCandidates(full, maxDepth, depth + 1, result);
    }
    return result;
}
export function discoverConfigs({ platform = process.platform, env = process.env, homeDir = home } = {}) {
    const allKnownPaths = new Set();
    const selected = [];
    for (const agent of AGENTS) {
        const candidates = platformPaths(agent, platform, env);
        candidates.forEach((file) => allKnownPaths.add(pathKey(file)));
        const file = candidates.find((candidate) => { try { return fs.statSync(candidate).isFile(); } catch { return false; } });
        if (file) selected.push({ path: file, agent, known: true, exists: true, format: path.extname(file).toLowerCase() === '.toml' ? 'toml' : 'json' });
    }
    const byPath = new Map(selected.map((entry) => [pathKey(entry.path), entry]));
    for (const file of walkJsonCandidates(homeDir)) {
        const key = pathKey(file);
        if (!allKnownPaths.has(key) && !byPath.has(key)) byPath.set(key, { path: file, agent: null, known: false, exists: true, format: 'json' });
    }
    return [...byPath.values()];
}
export function serverDefinition({ client = 'actspan', extensionId, fromNpm = false, packageRoot = HERE, apiUrl, apiKey } = {}) {
    const url = String(apiUrl ?? '').trim();
    const key = String(apiKey ?? '').trim();
    const env = {
        ...(url ? { ACTSPAN_API_URL: url } : {}),
        ...(key ? { ACTSPAN_API_KEY: key } : {}),
        ACTSPAN_BRIDGE_URL: 'ws://127.0.0.1:30121',
        ...(extensionId ? { ACTSPAN_EXTENSION_IDS: extensionId } : {}),
    };
    const checked = validateConfig(env);
    if (!checked.valid) throw new Error(`生成的 MCP 配置未通过服务端校验，install 不会写出无效配置：\n${checked.errors.map((error) => `- ${error}`).join('\n')}`);
    return fromNpm ? { command: process.platform === 'win32' ? 'npx.cmd' : 'npx', args: ['-y', '@actspan/mcp-server', 'mcp', '--client', client], env } : { command: process.execPath, args: [path.join(packageRoot, 'index.js'), 'mcp', '--client', client], env };
}
function jsonTarget(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { supported: false, configured: false, reason: '顶层不是 JSON 对象' };
    if (parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)) return { supported: true, configured: Boolean(parsed.mcpServers.actspan) };
    if (Object.prototype.hasOwnProperty.call(parsed, 'mcp')) return { supported: false, configured: false, reason: '识别到顶层 mcp + 命令数组格式；不会猜测其语义' };
    return { supported: true, configured: false };
}
export function planConfig(entry, definition) {
    if (entry.format === 'toml') {
        const source = entry.exists ? fs.readFileSync(entry.path, 'utf8') : '';
        const configured = /^\[mcp_servers\.actspan\]\s*$/m.test(source);
        return { ...entry, action: configured ? 'skip' : entry.exists ? 'append' : 'create', configured, supported: true, definition };
    }
    if (!entry.exists) return { ...entry, action: 'create', configured: false, supported: true, definition };
    try { const target = jsonTarget(JSON.parse(fs.readFileSync(entry.path, 'utf8'))); return { ...entry, action: !target.supported ? 'manual' : target.configured ? 'skip' : 'merge', configured: target.configured, supported: target.supported, reason: target.reason, definition }; } catch (error) { return { ...entry, action: 'manual', configured: false, supported: false, reason: `JSON 无法解析：${error.message}`, definition }; }
}
function jsonWithServer(file, definition) { const parsed = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}; return `${JSON.stringify({ ...parsed, mcpServers: { ...(parsed.mcpServers || {}), actspan: definition } }, null, 2)}\n`; }
function tomlQuote(value) { return JSON.stringify(String(value)); }
function tomlBlock(definition) { const lines = ['[mcp_servers.actspan]', `command = ${tomlQuote(definition.command)}`, `args = [${definition.args.map(tomlQuote).join(', ')}]`, '[mcp_servers.actspan.env]']; for (const [key, value] of Object.entries(definition.env || {})) lines.push(`${key} = ${tomlQuote(value)}`); return `${lines.join('\n')}\n`; }
function backupPath(file, now = Date.now()) { return `${file}.bak-${now}`; }
export function applyPlan(plan, { now = Date.now() } = {}) {
    if (!plan.supported || plan.action === 'manual' || plan.action === 'skip') return { applied: false, skipped: plan.action === 'skip', reason: plan.reason || 'unsupported format' };
    fs.mkdirSync(path.dirname(plan.path), { recursive: true });
    if (plan.exists) fs.copyFileSync(plan.path, backupPath(plan.path, now));
    if (plan.format === 'toml') { const source = plan.exists ? fs.readFileSync(plan.path, 'utf8') : ''; fs.writeFileSync(plan.path, `${source}${source && !source.endsWith('\n') ? '\n' : ''}${tomlBlock(plan.definition)}`, { mode: 0o600 }); } else fs.writeFileSync(plan.path, jsonWithServer(plan.path, plan.definition), { mode: 0o600 });
    return { applied: true, backup: plan.exists ? backupPath(plan.path, now) : null };
}
function redactDefinition(definition) { return { ...definition, env: Object.fromEntries(Object.entries(definition.env || {}).map(([key, value]) => [key, /token|key|secret|authorization/i.test(key) ? '[redacted]' : value])) }; }
export function printPlan(plan, output = console.log) { const marker = plan.action === 'manual' || plan.action === 'skip' ? '·' : '+'; output(`${marker} ${plan.path} — ${plan.action === 'manual' ? `手动配置说明（不表示 install 已支持自动安装）：${plan.reason}` : plan.action === 'skip' ? '已配置，跳过' : '将写入 MCP 配置'}`); if (plan.action === 'manual') output(JSON.stringify(redactDefinition(plan.definition), null, 2)); }
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
export function pairingGuide({ port, extensionId, nonce }) {
    const welcome = `chrome-extension://${extensionId}/welcome.html?pair_port=${port}&pair_nonce=${encodeURIComponent(nonce)}`;
    return [
        '<!doctype html><meta charset="utf-8"><title>ActSpan 安装</title>',
        '<h1>ActSpan 安装</h1>',
        '<p>1. 打开 <code>chrome://extensions</code>，启用开发者模式，加载 build_version/actspan-extension。</p>',
        '<p>浏览器不允许脚本代替你完成加载扩展这一下。</p>',
        '<p>2. 加载完成后，把下面这行地址整段复制到浏览器地址栏并回车。Chrome 不允许网页打开扩展页面，所以这里只能给你地址，不能给你链接。</p>',
        `<pre id="pair-url">${escapeHtml(welcome)}</pre>`,
        '<p>如果地址栏提示无法访问，说明扩展还没加载成功：回到第 1 步，在 <code>chrome://extensions</code> 确认 ActSpan 已启用，再复制一次上面的地址。</p>',
        '<p>配对结果会显示在扩展页面上；看到成功提示后即可关闭本页。</p>',
    ].join('\n');
}
export function pairExtension({ open = true, timeoutMs = 120000, output = console.log } = {}) {
    const nonce = randomBytes(18).toString('hex');
    const expectedId = extensionIdFromKey();
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
            if (req.method === 'GET' && requestUrl.pathname === '/') {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                res.end(pairingGuide({ port: server.address().port, extensionId: expectedId, nonce }));
                return;
            }
            if (req.method !== 'POST' || requestUrl.pathname !== '/pair' || req.headers['x-actspan-pairing'] !== nonce) { res.writeHead(404).end(); return; }
            let body = ''; req.on('data', (chunk) => { body += chunk; if (body.length > 8192) req.destroy(); }); req.on('end', () => { try { const value = JSON.parse(body); if (value.extensionId !== expectedId) throw new Error('unexpected extension id'); res.writeHead(204).end(); clearTimeout(timer); server.close(); resolve({ extensionId: value.extensionId }); } catch { res.writeHead(400).end(); } });
        });
        server.on('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; output(`等待扩展配对（仅本机，端口 ${port}）。加载扩展后在引导页继续。`); if (open) openWelcome({ port }); });
        const timer = setTimeout(() => { server.close(); reject(new Error('pairing timed out')); }, timeoutMs);
    });
}
export function openWelcome({ port } = {}) {
    const target = `http://127.0.0.1:${port}/`;
    try { const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'; const args = process.platform === 'win32' ? ['/c', 'start', '', target] : [target]; const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }); child.unref(); } catch { /* best effort */ }
}
export function versionReport() { return { package: VERSION, extension: EXTENSION_VERSION, consistent: VERSION === EXTENSION_VERSION }; }
export async function runInstall({ apply = false, yes = false, dryRun = false, extensionId, fromNpm = false, client = 'actspan', apiUrl, apiKey } = {}) {
    if (apply && !yes) throw new Error('不会覆盖用户配置：请同时传 --yes 明确确认；否则使用 --dry-run 预览');
    const report = versionReport(); if (!report.consistent) throw new Error(`版本不一致：MCP ${report.package} / 扩展 ${report.extension}`);
    // Local-only install is the default: the Bridge never calls the control plane, so API URL/key are
    // propagated only when the user actually configured them. Never invent values the server would reject.
    const controlPlaneUrl = String(apiUrl ?? process.env.ACTSPAN_API_URL ?? '').trim();
    const controlPlaneKey = String(apiKey ?? process.env.ACTSPAN_API_KEY ?? '').trim();
    const targets = discoverConfigs();
    if (!targets.length) throw new Error('未探测到受支持的 MCP 配置；不会猜测或创建未知宿主配置。请先在宿主中创建 MCP 配置文件');
    // One canonical identity: the allowlist is the ID derived from the manifest key, or the ID the
    // pairing page proved. A caller-supplied ID that disagrees is drift, not a preference.
    const canonicalId = extensionIdFromKey();
    if (extensionId && extensionId !== canonicalId) throw new Error(`扩展 ID 不匹配：传入 ${extensionId}，但当前 manifest key 推导出的规范 ID 是 ${canonicalId}。请勿手写扩展 ID；加载构建产物后由配对页自动写入。`);
    const paired = extensionId ? { extensionId } : apply ? await pairExtension() : null;
    const definition = serverDefinition({ client, extensionId: paired?.extensionId, fromNpm, apiUrl: controlPlaneUrl, apiKey: controlPlaneKey });
    const plans = targets.map((entry) => planConfig(entry, definition)); plans.forEach((plan) => printPlan(plan));
    const preview = plans.map((plan) => ({ ...plan, definition: redactDefinition(plan.definition) }));
    if (!apply || dryRun) return { report, plans: preview, paired: paired ? { extensionId: paired.extensionId } : null };
    return { report, plans: preview, results: plans.filter((plan) => plan.action !== 'manual').map((plan) => applyPlan(plan)), paired: paired ? { extensionId: paired.extensionId } : null };
}
function parseArgs(argv) { const options = { apply: false, yes: false, dryRun: false, fromNpm: false }; for (let i = 0; i < argv.length; i += 1) { const arg = argv[i]; if (arg === '--apply') options.apply = true; else if (arg === '--yes') options.yes = true; else if (arg === '--dry-run') options.dryRun = true; else if (arg === '--from-npm') options.fromNpm = true; else if (arg === '--extension-id') options.extensionId = argv[++i]; else if (arg === '--client') options.client = argv[++i]; else if (arg === '--help') options.help = true; } return options; }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { const options = parseArgs(process.argv.slice(2)); if (options.help) console.log('Usage: actspan-install [--dry-run] [--apply --yes] [--extension-id ID] [--from-npm] [--client NAME]\n默认写入本地 Bridge 配置（ACTSPAN_BRIDGE_URL + ACTSPAN_EXTENSION_IDS）。仅当启用控制面 API 时才需要 ACTSPAN_API_URL（HTTPS）与 ACTSPAN_API_KEY；密钥只放环境变量，不要写在命令行参数里。'); else runInstall(options).catch((error) => { process.stderr.write(`actspan install: ${error.message}\n`); process.exitCode = 1; }); }
