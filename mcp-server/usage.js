import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * K3：宿主身份的配额/积分归因账本。
 *
 * 审计（D8）回答「谁在什么时候做了什么」；这个账本回答「哪个宿主用了多少」——
 * 上游配额/积分系统按 host slug 取数，不再只把身份当日志文案。
 * 键就是 K1 解析出来的 slug（认不出的宿主是 `host-<hash>`，不冒充别家）。
 */
const VERSION = 1;
const MAX_HOSTS = 64;
const MAX_TOOLS_PER_HOST = 32;
const MAX_SESSIONS_PER_HOST = 16;

const empty = () => ({ version: VERSION, hosts: {} });

function readLedger(file) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || parsed.version !== VERSION || typeof parsed.hosts !== 'object') return empty();
        return { version: VERSION, hosts: parsed.hosts && typeof parsed.hosts === 'object' ? parsed.hosts : {} };
    } catch {
        return empty();
    }
}

/** 计数表只保留最近用到的键，避免账本被一次性宿主无限撑大。 */
function bump(bucket, key, limit) {
    bucket[key] = (Number.isSafeInteger(bucket[key]) ? bucket[key] : 0) + 1;
    const keys = Object.keys(bucket);
    if (keys.length <= limit) return;
    // 必须排除刚记的键：整数样的键在 Object.keys 里排最前，否则它会被当成最旧的删掉，
    // 再靠下一行写回，上限就永远多出一个。
    for (const stale of keys.filter((known) => known !== key).slice(0, keys.length - limit)) delete bucket[stale];
}

export function createUsageLedger({ path: file }) {
    const write = (state) => {
        const temp = `${file}.${process.pid}.tmp`;
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
            fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
            fs.renameSync(temp, file);
            return true;
        } catch {
            try { fs.unlinkSync(temp); } catch { /* Nothing to clean up. */ }
            return false;
        }
    };
    return {
        /** 记一次已落审计的调用；host 必须是 K1 解析后的 slug。 */
        record({ host, tool, sessionId, at } = {}) {
            // 账本是全局的，daemon 是按端口的：以文件为准，否则多端口会互相覆盖计数。
            const state = readLedger(file);
            const slug = typeof host === 'string' && host ? host.slice(0, 128) : 'unknown';
            const entry = state.hosts[slug] || (state.hosts[slug] = { calls: 0, firstAt: null, lastAt: null, tools: {}, sessions: {} });
            const time = Number.isSafeInteger(at) ? at : Date.now();
            entry.calls += 1;
            entry.firstAt = entry.firstAt === null ? time : Math.min(entry.firstAt, time);
            entry.lastAt = entry.lastAt === null ? time : Math.max(entry.lastAt, time);
            bump(entry.tools, typeof tool === 'string' && tool ? tool.slice(0, 64) : 'unknown', MAX_TOOLS_PER_HOST);
            if (typeof sessionId === 'string' && sessionId) bump(entry.sessions, sessionId.slice(0, 128), MAX_SESSIONS_PER_HOST);
            const slugs = Object.keys(state.hosts);
            if (slugs.length > MAX_HOSTS) {
                const oldest = slugs.filter((known) => known !== slug)
                    .sort((a, b) => (state.hosts[a].lastAt || 0) - (state.hosts[b].lastAt || 0))
                    .slice(0, slugs.length - MAX_HOSTS);
                for (const stale of oldest) delete state.hosts[stale];
            }
            return write(state);
        },
        snapshot() {
            return readLedger(file);
        },
        /** 单个宿主的归因切片，供 `actspan_status` 直接展示。 */
        hostReport(slug) {
            const entry = readLedger(file).hosts[slug];
            if (!entry) return { host: slug, calls: 0, firstAt: null, lastAt: null, tools: {} };
            return { host: slug, calls: entry.calls, firstAt: entry.firstAt, lastAt: entry.lastAt, tools: { ...entry.tools } };
        },
    };
}

export { VERSION as USAGE_LEDGER_VERSION };

/** 账本与审计同目录（`~/.actspan`），所以读的一方不必知道 daemon 的端口。 */
export const DEFAULT_USAGE_PATH = path.join(os.homedir(), '.actspan', 'usage.json');

/** 只读视图：给 `actspan_status` 和配额系统用，不产生副作用。 */
export function readUsage(file = DEFAULT_USAGE_PATH) {
    return readLedger(file);
}
