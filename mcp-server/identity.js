import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** K1：宿主身份表只有一份，就是 agents.json；显示名与 slug 都从那里取。 */
function loadAgentTable() {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'agents.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entries = Array.isArray(parsed?.agents) ? parsed.agents : [];
    return Object.freeze(Object.fromEntries(entries
        .filter((entry) => entry && typeof entry === 'object' && entry.slug)
        .map((entry) => [String(entry.slug), Object.freeze({
            display: String(entry.name || entry.slug),
            aliases: Object.freeze(Array.isArray(entry.aliases) ? entry.aliases.map(String) : []),
        })])));
}

const AGENTS = loadAgentTable();

const GENERIC_HOST = /^(?:mcp(?:\s+client)?|client|host|ide|agent|assistant|unknown|generic)$/i;
const EMOJIS = ['🦊', '🐙', '🦉', '🐳', '🦄', '🐼', '🐸', '🦁', '🐝', '🦋', '🐢', '🐯', '🐨', '🦓', '🐬', '🦒'];
const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

function text(value) {
    return value === undefined || value === null ? '' : String(value).trim();
}

function slugOf(value) {
    let result = text(value).replace(/^我是\s*/u, '');
    result = result.replace(/(?:\s+|[-_])+(?:an?\s+)?mcp\s*(?:client|客户端)$/iu, '');
    return result.trim();
}

function slugify(value) {
    const slug = slugOf(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug || 'unknown-host';
}

function agentEntries(table = AGENTS) {
    if (Array.isArray(table)) {
        return table.flatMap(entry => {
            if (!entry || typeof entry !== 'object') return [];
            const slug = slugify(entry.slug || entry.id || entry.name);
            return [{ slug, display: text(entry.display || entry.name || slug), aliases: entry.aliases || [] }];
        });
    }
    return Object.entries(table && typeof table === 'object' ? table : {}).map(([key, entry]) => {
        if (typeof entry === 'string') return { slug: slugify(key), display: entry, aliases: [] };
        const item = entry && typeof entry === 'object' ? entry : {};
        return { slug: slugify(item.slug || key), display: text(item.display || item.name || key), aliases: item.aliases || [] };
    });
}

function findKnown(value, table) {
    const candidate = slugOf(value);
    if (!candidate || GENERIC_HOST.test(candidate)) return null;
    const normalized = candidate.toLowerCase();
    return agentEntries(table).find(entry => [entry.slug, entry.display, ...entry.aliases]
        .some(alias => slugOf(alias).toLowerCase() === normalized || slugify(alias) === slugify(candidate))) || null;
}

function parseVersion(value) {
    if (typeof value === 'string') {
        const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i);
        return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : null;
    }
    if (Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every(Number.isFinite)) {
        return { major: Number(value[0]), minor: Number(value[1]), patch: Number(value[2]) };
    }
    if (!value || typeof value !== 'object') return null;
    if (value.version !== undefined) return parseVersion(value.version);
    if ([value.major, value.minor, value.patch].every(part => Number.isFinite(Number(part)))) {
        return { major: Number(value.major), minor: Number(value.minor), patch: Number(value.patch) };
    }
    return null;
}

function parseProtocol(value) {
    if (Number.isFinite(Number(value)) && typeof value !== 'object') return Number(value);
    if (!value || typeof value !== 'object') return null;
    const candidate = value.protocol ?? value.protocolVersion ?? value.protocolNumber;
    if (candidate && typeof candidate === 'object') return parseProtocol(candidate.number ?? candidate.version);
    return Number.isFinite(Number(candidate)) ? Number(candidate) : null;
}

export function compareProtocolVersions(local, remote) {
    const localVersion = parseVersion(local);
    const remoteVersion = parseVersion(remote);
    const localProtocol = parseProtocol(local);
    const remoteProtocol = parseProtocol(remote);
    const base = { compatible: true, status: 'unknown', warning: null, localBehind: false, remoteBehind: false };
    if (!localVersion || !remoteVersion || localProtocol === null || remoteProtocol === null) return base;
    if (localProtocol !== remoteProtocol) {
        return { ...base, compatible: false, status: 'incompatible_protocol', warning: `protocol ${localProtocol} differs from ${remoteProtocol}` };
    }
    const localTuple = [localVersion.major, localVersion.minor, localVersion.patch];
    const remoteTuple = [remoteVersion.major, remoteVersion.minor, remoteVersion.patch];
    const difference = localTuple.findIndex((part, index) => part !== remoteTuple[index]);
    if (difference < 0 || difference === 2) return { ...base, status: 'compatible' };
    if (localTuple[difference] < remoteTuple[difference]) {
        const level = difference === 0 ? 'major' : 'minor';
        return { ...base, status: `local_${level}_behind`, warning: `local ${level} version is behind remote`, localBehind: true };
    }
    const level = difference === 0 ? 'major' : 'minor';
    return { ...base, status: `remote_${level}_behind`, warning: `remote ${level} version is behind local`, remoteBehind: true };
}

export function normalizeHostIdentity(selfReported, clientFallback, agentsTable = AGENTS) {
    const reported = text(selfReported);
    const fallback = text(clientFallback);
    const selected = (!reported || GENERIC_HOST.test(slugOf(reported))) ? fallback : reported;
    const source = selected === reported && reported ? 'self' : 'fallback';
    const known = findKnown(selected, agentsTable);
    if (known) return { slug: known.slug, display: known.display, source, reported: selected };
    return { slug: slugify(selected), display: selected || 'Unknown host', source, reported: selected };
}

function hashString(value) {
    let hash = 2166136261;
    for (const char of String(value)) {
        hash ^= char.codePointAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

export function deriveSessionIdentity(sid) {
    const value = text(sid) || 'session';
    const suffix = value.includes(':') ? value.slice(value.lastIndexOf(':') + 1) : value;
    const hash = hashString(value);
    return {
        shortCode: suffix || hash.toString(36).slice(0, 8),
        emoji: EMOJIS[hash % EMOJIS.length],
        groupColor: GROUP_COLORS[hash % GROUP_COLORS.length],
        color: GROUP_COLORS[hash % GROUP_COLORS.length],
    };
}

export function createStableSessionId(host, processId, now = Date.now()) {
    const hostSlug = slugify(host || 'host');
    const processSlug = text(processId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'process';
    const timestamp = Number.isFinite(Number(now)) ? Math.max(0, Number(now)).toString(36) : Date.now().toString(36);
    return `${hostSlug}:${processSlug}:${timestamp}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

export { AGENTS as DEFAULT_AGENTS, slugOf };
