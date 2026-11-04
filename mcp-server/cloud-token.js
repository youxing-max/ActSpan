#!/usr/bin/env node
/**
 * Actspan Cloud token 管理工具（管理员用）
 *
 * 子命令：
 *   add <name>            生成一个新 token 并写入 tokens.json（打印一次性交接信息）
 *   add <name> --force    已存在则轮换（旧 token 立即失效）
 *   batch <n1> <n2> ...   批量生成（也支持 --count N --prefix p 或 --file names.txt）
 *   list                  列出所有用户与脱敏 token
 *   revoke <name>         吊销某用户（立即失效，云端 2s 内热加载）
 *   verify <token>        校验一个 token 属于谁（排障用）
 *
 * 选项：
 *   --file <path>         tokens.json 路径，默认 ./tokens.json（与 cloud.js 默认一致）
 *
 * token 格式：actspan_<32 位 base64url 随机串>，前缀便于日志检索与泄露扫描白名单。
 * 文件为扁平结构 { "name": "token" }，cloud.js 直接读取，变更 2s 内热加载。
 */

import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

const argv = process.argv.slice(2);
const argValue = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
};

const FILE = resolvePath(argValue('--file') || 'tokens.json');
const NAME_RE = /^[a-zA-Z0-9_.-]{1,64}$/;

const usage = () => {
    console.log(`用法：
  node cloud-token.js add <name> [--force]   生成/轮换 token
  node cloud-token.js batch <n1> <n2> ...    批量生成（可配合 --count/--prefix 或 --file）
  node cloud-token.js list                   列出用户
  node cloud-token.js revoke <name>          吊销用户
  node cloud-token.js verify <token>         校验 token 归属
  batch 选项：--count N --prefix p 生成 p-0001..p-N；--file names.txt 每行一个名字
              --csv out.csv 输出分发清单（默认 tokens-batch-<ts>.csv）；--force 覆盖已存在
  选项：--file <path>  （默认 ./tokens.json）`);
};

const readTokens = () => {
    if (!existsSync(FILE)) return {};
    try {
        const obj = JSON.parse(readFileSync(FILE, 'utf8'));
        return obj && typeof obj === 'object' ? obj : {};
    } catch (err) {
        console.error(`tokens 文件解析失败 (${FILE}):`, err.message);
        process.exit(1);
    }
};

/** 原子写：先写临时文件再 rename，避免 cloud.js 热加载读到半截文件 */
const writeTokens = (obj) => {
    const tmp = `${FILE}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    renameSync(tmp, FILE);
};

const genToken = () => `actspan_${randomBytes(24).toString('base64url')}`;

const mask = (token) => (token.length <= 16 ? token : `${token.slice(0, 12)}…${token.slice(-4)}`);

const cmd = argv[0];
const name = argv[1];

switch (cmd) {
    case 'add': {
        if (!name || !NAME_RE.test(name)) {
            console.error('name 非法：允许字母数字 . _ - ，1-64 位');
            process.exit(1);
        }
        const tokens = readTokens();
        if (tokens[name] && !argv.includes('--force')) {
            console.error(`用户 ${name} 已存在。轮换请用: add ${name} --force（旧 token 立即失效）`);
            process.exit(1);
        }
        const token = genToken();
        tokens[name] = token;
        writeTokens(tokens);
        console.log(`\n✅ 已为用户 ${name} 生成 token 并写入 ${FILE}`);
        console.log(`\n──── 交接给用户的两条配置（token 仅此一次完整展示）────\n`);
        console.log(`【浏览器扩展】Options → 云端连接器`);
        console.log(`  服务器地址: wss://<你的云域名>/ws`);
        console.log(`  个人 Token: ${token}`);
        console.log(`\n【IDE 添加连接】（认证方式选「请求头认证」）`);
        console.log(`  服务地址:   https://<你的云域名>/mcp`);
        console.log(`  请求头名:   Authorization`);
        console.log(`  请求头值:   Bearer ${token}`);
        console.log(`\n──────────────────────────────────────────`);
        console.log(`提示：tokens.json 变更 2 秒内被云端热加载，无需重启服务。`);
        break;
    }

    case 'list': {
        const tokens = readTokens();
        const entries = Object.entries(tokens);
        if (entries.length === 0) {
            console.log(`（空）${FILE} 中没有任何用户`);
            break;
        }
        console.log(`共 ${entries.length} 个用户（${FILE}）：`);
        for (const [n, t] of entries) {
            console.log(`  ${n.padEnd(24)} ${mask(String(t))}`);
        }
        break;
    }

    case 'revoke': {
        if (!name) { usage(); process.exit(1); }
        const tokens = readTokens();
        if (!(name in tokens)) {
            console.error(`用户 ${name} 不存在`);
            process.exit(1);
        }
        delete tokens[name];
        writeTokens(tokens);
        console.log(`✅ 已吊销用户 ${name}（云端 2s 内生效；其浏览器与 IDE 连接随后全部 401/4001）`);
        break;
    }

    case 'verify': {
        const token = name;
        if (!token) { usage(); process.exit(1); }
        const tokens = readTokens();
        const owner = Object.entries(tokens).find(([, t]) => t === token);
        if (owner) console.log(`✅ 有效，属于用户: ${owner[0]}`);
        else { console.log('❌ 无效 token'); process.exit(1); }
        break;
    }

    case 'batch': {
        const rest = argv.slice(1);
        const VALUE_FLAGS = new Set(['--count', '--prefix', '--file', '--csv']);
        const positional = [];
        for (let i = 0; i < rest.length; i++) {
            const a = rest[i];
            if (a === '--force') continue;
            if (VALUE_FLAGS.has(a)) { i++; continue; } // 跳过选项值
            if (a.startsWith('--')) { console.warn(`未知选项: ${a}`); continue; }
            positional.push(a);
        }
        const count = Number(argValue('--count'));
        const prefix = argValue('--prefix');
        const namesFile = argValue('--file');

        const names = [...positional];
        if (namesFile) {
            names.push(...readFileSync(resolvePath(namesFile), 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
        }
        if (count > 0 && prefix) {
            const pad = Math.max(String(count).length, 1);
            for (let i = 1; i <= count; i++) names.push(`${prefix}-${String(i).padStart(pad, '0')}`);
        }

        const seen = new Set();
        const valid = [];
        const invalid = [];
        for (const n of names) {
            if (!NAME_RE.test(n)) { invalid.push(n); continue; }
            if (seen.has(n)) continue;
            seen.add(n);
            valid.push(n);
        }
        if (valid.length === 0) { console.error('没有合法的用户名（--count 需配 --prefix）'); process.exit(1); }
        if (invalid.length) console.warn(`⚠️  忽略非法名字: ${invalid.slice(0, 20).join(', ')}${invalid.length > 20 ? '…' : ''}`);

        const tokens = readTokens();
        const skipped = [];
        for (const n of valid) {
            if (tokens[n] && !argv.includes('--force')) { skipped.push(n); continue; }
            tokens[n] = genToken();
        }
        const generated = valid.length - skipped.length;
        if (generated === 0) {
            console.error('全部用户名都已存在；若要轮换请加 --force（旧 token 立即失效）');
            process.exit(1);
        }
        writeTokens(tokens);

        const csvPath = argValue('--csv') || `tokens-batch-${Date.now()}.csv`;
        const rows = [['name', 'token']];
        for (const n of valid) rows.push([n, String(tokens[n])]);
        const csvContent = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n') + '\n';
        writeFileSync(csvPath, csvContent, 'utf8');

        console.log(`✅ 已批量生成 ${generated} 个 token（跳过已存在 ${skipped.length} 个）写入 ${FILE}`);
        console.log(`分发清单（name,token）: ${csvPath}`);
        if (skipped.length) console.log(`已存在未动: ${skipped.slice(0, 20).join(', ')}${skipped.length > 20 ? '…' : ''}`);
        console.log(`\n──── 共享配置（写进发给所有人的通知，完全相同）────`);
        console.log(`【IDE】服务地址:  http://<你的云域名>/mcp`);
        console.log(`       认证方式:  请求头认证；请求头名 Authorization`);
        console.log(`       请求头值:  Bearer <csv 里该用户自己的 token>`);
        console.log(`【浏览器扩展】服务器地址: wss://<你的云域名>/ws ；个人 Token = csv 里该用户 token`);
        console.log(`\n提示：token 一人一张、互不相同；tokens.json 变更 2 秒内被云端热加载。`);
        break;
    }

    default:
        usage();
        process.exit(cmd ? 1 : 0);
}
