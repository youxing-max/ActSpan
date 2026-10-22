#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
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
    if (Object.prototype.hasOwnProperty.call(parsed, 'mcpServers')) {
        const servers = parsed.mcpServers;
        // 数组/字符串/ null 都不是合法的 mcpServers 映射；静默展开会写成 "0"/"1" 键。
        if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
            return { supported: false, configured: false, reason: 'mcpServers 不是普通对象；拒绝改写以避免破坏配置' };
        }
        return { supported: true, configured: Boolean(servers.actspan), existing: servers.actspan };
    }
    if (Object.prototype.hasOwnProperty.call(parsed, 'mcp')) return { supported: false, configured: false, reason: '识别到顶层 mcp + 命令数组格式；不会猜测其语义' };
    return { supported: true, configured: false };
}
function staleDefinitionReason() { return '已有 actspan 配置与当前安装不一致（路径/Node/参数已变化）；确认后使用 --force 更新'; }

export function planConfig(entry, definition, { unknownAllowed = false, force = false } = {}) {
    if (entry.known === false && !unknownAllowed) return { ...entry, action: 'manual', configured: false, supported: true, reason: '未知配置路径：确认后使用 --include-unknown 才会写入', definition };
    if (entry.format === 'toml') {
        const source = entry.exists ? fs.readFileSync(entry.path, 'utf8') : '';
        const configured = source.split('\n').some(isActspanParentHeader);
        if (!configured) return { ...entry, action: entry.exists ? 'append' : 'create', configured: false, supported: true, definition };
        const matches = extractTomlSection(source) === tomlBlock(definition).trim();
        if (matches) return { ...entry, action: 'skip', configured: true, supported: true, definition };
        if (!force) return { ...entry, action: 'manual', configured: true, supported: true, reason: staleDefinitionReason(), definition };
        return { ...entry, action: 'merge', configured: true, replaceExisting: true, supported: true, definition };
    }
    if (!entry.exists) return { ...entry, action: 'create', configured: false, supported: true, definition };
    try {
        const target = jsonTarget(JSON.parse(fs.readFileSync(entry.path, 'utf8')));
        if (!target.supported) return { ...entry, action: 'manual', configured: false, supported: false, reason: target.reason, definition };
        if (!target.configured) return { ...entry, action: 'merge', configured: false, supported: true, definition };
        if (isDeepStrictEqual(target.existing, definition)) return { ...entry, action: 'skip', configured: true, supported: true, definition };
        if (!force) return { ...entry, action: 'manual', configured: true, supported: true, reason: staleDefinitionReason(), definition };
        return { ...entry, action: 'merge', configured: true, supported: true, definition };
    } catch (error) {
        return { ...entry, action: 'manual', configured: false, supported: false, reason: `JSON 无法解析：${error.message}`, definition };
    }
}
function jsonWithServer(file, definition) {
    const parsed = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    const existingServers = parsed?.mcpServers;
    // 写入边界再守一次：非普通对象绝不展开，避免把数组/字符串写成数字键。
    if (Object.prototype.hasOwnProperty.call(parsed, 'mcpServers')
        && (!existingServers || typeof existingServers !== 'object' || Array.isArray(existingServers))) {
        throw new Error('mcpServers 不是普通对象，拒绝改写');
    }
    return `${JSON.stringify({ ...parsed, mcpServers: { ...(existingServers || {}), actspan: definition } }, null, 2)}\n`;
}
function tomlQuote(value) { return JSON.stringify(String(value)); }
function tomlBlock(definition) { const lines = ['[mcp_servers.actspan]', `command = ${tomlQuote(definition.command)}`, `args = [${definition.args.map(tomlQuote).join(', ')}]`, '[mcp_servers.actspan.env]']; for (const [key, value] of Object.entries(definition.env || {})) lines.push(`${key} = ${tomlQuote(value)}`); return `${lines.join('\n')}\n`; }
const isTomlHeader = (line) => /^\s*\[/.test(line);
const isActspanParentHeader = (line) => /^\s*\[mcp_servers\.actspan\]\s*(?:#.*)?$/.test(line);
// env 是安装器自己写入的子表，必须和父表视为同一段；否则二次安装会误判为“旧配置”，
// --force 时还会留下旧 env 表，写出重复表头的非法 TOML。
const isActspanEnvHeader = (line) => /^\s*\[mcp_servers\.actspan\.env\]\s*(?:#.*)?$/.test(line);
function actspanSectionEnd(lines, start) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
        if (isTomlHeader(lines[i]) && !isActspanEnvHeader(lines[i])) { end = i; break; }
    }
    return end;
}
/** 截取现有 actspan TOML 段（父表 + env 子表），用于判断是否需要 --force 更新。 */
function extractTomlSection(source) {
    const lines = source.split('\n');
    const start = lines.findIndex(isActspanParentHeader);
    if (start < 0) return '';
    return lines.slice(start, actspanSectionEnd(lines, start)).join('\n').trim();
}
function replaceTomlSection(source, block) {
    const lines = source.split('\n');
    const start = lines.findIndex(isActspanParentHeader);
    if (start < 0) return `${source}${source && !source.endsWith('\n') ? '\n' : ''}${block}`;
    const end = actspanSectionEnd(lines, start);
    const merged = [...lines.slice(0, start), ...block.trimEnd().split('\n'), ...lines.slice(end)];
    return `${merged.join('\n').replace(/\n{3,}/g, '\n\n')}${merged.length && merged[merged.length - 1] === '' ? '' : '\n'}`;
}
function backupPath(file, now = Date.now()) { return `${file}.bak-${now}`; }
function writeFileAtomic(file, content) {
    // dotfiles 里的配置常是指向仓库的符号链接；改写必须落到真实目标，不能把链接替换成普通文件。
    let target = file;
    try { if (fs.lstatSync(file).isSymbolicLink()) target = fs.realpathSync(file); } catch { /* 新文件或链接失效 */ }
    let mode = 0o600;
    try { mode = fs.statSync(target).mode & 0o777; } catch { /* 新文件用 0600 */ }
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    try {
        fs.writeFileSync(temp, content, { mode });
        fs.renameSync(temp, target);
    } catch (error) {
        try { fs.rmSync(temp, { force: true }); } catch { /* 清理失败不掩盖原始错误 */ }
        throw error;
    }
}
export function applyPlan(plan, { now = Date.now() } = {}) {
    if (!plan.supported || plan.action === 'manual' || plan.action === 'skip') return { applied: false, skipped: plan.action === 'skip', reason: plan.reason || 'unsupported format' };
    fs.mkdirSync(path.dirname(plan.path), { recursive: true });
    if (plan.exists) fs.copyFileSync(plan.path, backupPath(plan.path, now));
    if (plan.format === 'toml') {
        const source = plan.exists ? fs.readFileSync(plan.path, 'utf8') : '';
        const next = plan.replaceExisting ? replaceTomlSection(source, tomlBlock(plan.definition))
            : `${source}${source && !source.endsWith('\n') ? '\n' : ''}${tomlBlock(plan.definition)}`;
        writeFileAtomic(plan.path, next);
    } else writeFileAtomic(plan.path, jsonWithServer(plan.path, plan.definition));
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
export async function runInstall({ apply = false, yes = false, dryRun = false, extensionId, fromNpm = false, client = 'actspan', apiUrl, apiKey, includeUnknown = false, force = false, pairTimeoutMs } = {}) {
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
    // 非交互环境没有人能完成浏览器里的配对；固定等 120s 只会让 CI 空转。
    if (apply && !extensionId && !process.stdin.isTTY && pairTimeoutMs === undefined) {
        throw new Error('非交互环境无法完成扩展配对：请传 --extension-id <manifest 推导的 ID>，或显式传 --pair-timeout <秒数> 后手动完成配对');
    }
    const waitMs = Number.isFinite(pairTimeoutMs) && pairTimeoutMs > 0 ? pairTimeoutMs : 120000;
    const paired = extensionId ? { extensionId } : apply ? await pairExtension({ timeoutMs: waitMs }) : null;
    const definition = serverDefinition({ client, extensionId: paired?.extensionId, fromNpm, apiUrl: controlPlaneUrl, apiKey: controlPlaneKey });
    const plans = targets.map((entry) => planConfig(entry, definition, { unknownAllowed: includeUnknown, force })); plans.forEach((plan) => printPlan(plan));
    const preview = plans.map((plan) => ({ ...plan, definition: redactDefinition(plan.definition) }));
    if (!apply || dryRun) return { report, plans: preview, paired: paired ? { extensionId: paired.extensionId } : null };
    return { report, plans: preview, results: plans.filter((plan) => plan.action !== 'manual').map((plan) => applyPlan(plan)), paired: paired ? { extensionId: paired.extensionId } : null };
}
function parseArgs(argv) {
    const options = { apply: false, yes: false, dryRun: false, fromNpm: false, includeUnknown: false, force: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--apply') options.apply = true;
        else if (arg === '--yes') options.yes = true;
        else if (arg === '--dry-run') options.dryRun = true;
        else if (arg === '--from-npm') options.fromNpm = true;
        else if (arg === '--include-unknown') options.includeUnknown = true;
        else if (arg === '--force' || arg === '--update') options.force = true;
        else if (arg === '--extension-id') options.extensionId = argv[++i];
        else if (arg === '--client') options.client = argv[++i];
        else if (arg === '--pair-timeout') {
            const raw = argv[++i];
            const seconds = Number(raw);
            if (!Number.isInteger(seconds) || seconds <= 0 || seconds > 3600) {
                options.error = `Invalid --pair-timeout: ${raw ?? '(missing)'}（需要 1–3600 秒）`;
                return options;
            }
            options.pairTimeoutMs = seconds * 1000;
        } else if (arg === '--help') options.help = true;
    }
    return options;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const options = parseArgs(process.argv.slice(2));
    if (options.error) {
        process.stderr.write(`actspan install: ${options.error}\n`);
        process.exitCode = 1;
    } else if (options.help) console.log('Usage: actspan-install [--dry-run] [--apply --yes] [--include-unknown] [--force] [--extension-id ID] [--pair-timeout SECONDS] [--from-npm] [--client NAME]\n默认只写已知宿主配置；--include-unknown 才会处理扫描到的未知 JSON 配置；--force 更新与当前安装不一致的旧 actspan 配置。非交互环境必须传 --extension-id 或 --pair-timeout。仅当启用控制面 API 时才需要 ACTSPAN_API_URL（HTTPS）与 ACTSPAN_API_KEY；密钥只放环境变量，不要写在命令行参数里。');
    else runInstall(options).then((result) => {
        if (!options.apply || options.dryRun) return;
        // 只打印 manual、实际 0 写入不是成功：自动化必须能感知需要人工处理。
        const manual = result.plans.filter((plan) => plan.action === 'manual');
        if (manual.length > 0 && result.results.every((item) => !item.applied && !item.skipped)) {
            process.stderr.write(`actspan install: 没有写入任何配置；${manual.length} 个目标需要人工处理或使用 --force\n`);
            process.exitCode = 1;
        }
    }).catch((error) => { process.stderr.write(`actspan install: ${error.message}\n`); process.exitCode = 1; });
}
