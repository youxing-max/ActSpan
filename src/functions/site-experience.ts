/**
 * 站点经验记忆（本地缓存版）
 * 只做排序偏置，不做硬编码规则
 */

import Storage from '../lib/storage';
import type { ToolExecutionContext } from './types';
import { readMigratedStorage } from '../lib/legacy-storage';
import { isPlainObject } from '../lib/guards';

const SITE_EXPERIENCE_STORAGE_KEY = 'actspan_site_experience_v1';
const LEGACY_SITE_EXPERIENCE_STORAGE_KEY = 'mole_site_experience_v1';
const SITE_EXPERIENCE_RECENT_REPAIR_STORAGE_KEY = 'actspan_site_experience_recent_repair_v1';
const LEGACY_SITE_EXPERIENCE_RECENT_REPAIR_STORAGE_KEY = 'mole_site_experience_recent_repair_v1';
const storageArea = {
  get: (keys: string | string[]) => new Promise<Record<string, unknown>>((resolve) => chrome.storage.local.get<Record<string, unknown>>(keys, resolve)),
  set: (items: Record<string, unknown>) => new Promise<void>((resolve) => chrome.storage.local.set(items, resolve)),
};
const SITE_EXPERIENCE_LAYERS_STORAGE_KEY = 'actspan_site_experience_layers_v1';
const SITE_EXPERIENCE_REVISIONS_STORAGE_KEY = 'actspan_site_experience_revisions_v1';
const MAX_DOMAIN_ENTRIES = 40;
const MAX_TOTAL_DOMAINS = 60;
const RECENT_REPAIR_TTL_MS = 20 * 60 * 1000;

export interface SiteExperienceCandidateInput {
  element_id?: string;
  tag?: string;
  text?: string;
  label?: string;
  placeholder?: string;
  selector_candidates?: string[];
  clickable?: boolean;
  editable?: boolean;
  visible?: boolean;
  in_viewport?: boolean;
  repair_score?: number;
}

interface SiteExperienceEntry {
  key: string;
  hint: string;
  tag?: string;
  text?: string;
  label?: string;
  placeholder?: string;
  selector?: string;
  clickable?: boolean;
  editable?: boolean;
  strength: number;
  count: number;
  source: 'repair';
  updatedAt: number;
}

interface SiteExperienceDomainRecord {
  updatedAt: number;
  entries: SiteExperienceEntry[];
}

interface SiteExperienceStoreShape {
  version: 1;
  updatedAt: number;
  domains: Record<string, SiteExperienceDomainRecord>;
}

interface RecentRepairEntry {
  domain: string;
  hint: string;
  candidates: SiteExperienceCandidateInput[];
  createdAt: number;
}

export interface SiteExperienceBoostResult<T extends SiteExperienceCandidateInput> {
  candidates: Array<T & { experience_boost?: number; experience_matches?: number }>;
  matchedEntries: number;
}

const normalizeText = (raw: unknown): string => String(raw || '').replace(/\s+/g, ' ').trim();

const normalizeHint = (hint: string): string => normalizeText(hint).toLowerCase();

const tokenizeHint = (hint: string): string[] => {
  return normalizeHint(hint)
    .split(/[\s,，、/|]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
};

const buildEntryKey = (hint: string, candidate: SiteExperienceCandidateInput): string => {
  const selector = Array.isArray(candidate.selector_candidates) ? normalizeText(candidate.selector_candidates[0] || '') : '';
  return [
    normalizeHint(hint),
    normalizeText(candidate.tag || '').toLowerCase(),
    normalizeText(candidate.label || '').toLowerCase(),
    normalizeText(candidate.text || '').toLowerCase(),
    normalizeText(candidate.placeholder || '').toLowerCase(),
    selector.toLowerCase(),
  ].join('::');
};

const readStore = async (): Promise<SiteExperienceStoreShape> => {
  const stored = await readMigratedStorage<SiteExperienceStoreShape>(
    storageArea,
    SITE_EXPERIENCE_STORAGE_KEY,
    LEGACY_SITE_EXPERIENCE_STORAGE_KEY,
  );
  if (stored && stored.version === 1 && stored.domains && typeof stored.domains === 'object') {
    return stored;
  }
  return {
    version: 1,
    updatedAt: Date.now(),
    domains: {},
  };
};

const persistStore = async (store: SiteExperienceStoreShape): Promise<void> => {
  const domainEntries = Object.entries(store.domains)
    .sort((left, right) => Number(right[1]?.updatedAt || 0) - Number(left[1]?.updatedAt || 0))
    .slice(0, MAX_TOTAL_DOMAINS);
  const nextStore: SiteExperienceStoreShape = {
    version: 1,
    updatedAt: Date.now(),
    domains: Object.fromEntries(domainEntries),
  };
  await Storage.save(SITE_EXPERIENCE_STORAGE_KEY, nextStore);
};

const readRecentRepairMap = async (): Promise<Record<string, RecentRepairEntry>> => {
  const stored = await readMigratedStorage<Record<string, RecentRepairEntry>>(
    storageArea,
    SITE_EXPERIENCE_RECENT_REPAIR_STORAGE_KEY,
    LEGACY_SITE_EXPERIENCE_RECENT_REPAIR_STORAGE_KEY,
  );
  if (!stored || typeof stored !== 'object') return {};
  const now = Date.now();
  return Object.fromEntries(
    Object.entries(stored).filter(([, value]) => {
      return value && typeof value === 'object' && now - Number(value.createdAt || 0) <= RECENT_REPAIR_TTL_MS;
    }),
  );
};

// 与 persistStore 同一条上限：最近修复表也按域名存，不设上限同样会被无限撑大。
const persistRecentRepairMap = async (map: Record<string, RecentRepairEntry>): Promise<void> => {
  const entries = Object.entries(map)
    .sort((left, right) => Number(right[1]?.createdAt || 0) - Number(left[1]?.createdAt || 0))
    .slice(0, MAX_TOTAL_DOMAINS);
  await Storage.save(SITE_EXPERIENCE_RECENT_REPAIR_STORAGE_KEY, Object.fromEntries(entries));
};

const getDomainFromUrl = (url: string): string | null => {
  const key = siteExperienceKey(url);
  return key || null;
};


export const resolveSiteExperienceDomain = async (context?: ToolExecutionContext): Promise<string | null> => {
  try {
    if (typeof context?.tabId === 'number' && context.tabId > 0) {
      const tab = await chrome.tabs.get(context.tabId);
      return getDomainFromUrl(tab.url || tab.pendingUrl || '');
    }
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return getDomainFromUrl(activeTab?.url || activeTab?.pendingUrl || '');
  } catch {
    return null;
  }
};

const computeHintSimilarity = (entryHint: string, runtimeHint: string): number => {
  const left = tokenizeHint(entryHint);
  const right = tokenizeHint(runtimeHint);
  if (left.length === 0 || right.length === 0) {
    return normalizeHint(entryHint) === normalizeHint(runtimeHint) ? 1 : 0;
  }
  const rightSet = new Set(right);
  const overlap = left.filter((token) => rightSet.has(token)).length;
  if (overlap === 0) return 0;
  return overlap / Math.max(left.length, right.length);
};

const computeCandidateBoost = (entry: SiteExperienceEntry, candidate: SiteExperienceCandidateInput, runtimeHint: string): number => {
  const hintSimilarity = runtimeHint ? computeHintSimilarity(entry.hint, runtimeHint) : 0.4;
  if (runtimeHint && hintSimilarity <= 0) return 0;

  let boost = entry.strength * (runtimeHint ? 6 * hintSimilarity : 2);
  const text = normalizeText(candidate.text || '').toLowerCase();
  const label = normalizeText(candidate.label || '').toLowerCase();
  const placeholder = normalizeText(candidate.placeholder || '').toLowerCase();
  const selector = Array.isArray(candidate.selector_candidates) ? normalizeText(candidate.selector_candidates[0] || '').toLowerCase() : '';

  if (entry.selector && selector && selector === entry.selector.toLowerCase()) boost += 16;
  if (entry.label && label && label === entry.label.toLowerCase()) boost += 12;
  if (entry.text && text && text === entry.text.toLowerCase()) boost += 10;
  if (entry.placeholder && placeholder && placeholder === entry.placeholder.toLowerCase()) boost += 8;
  if (entry.label && label && label.includes(entry.label.toLowerCase())) boost += 4;
  if (entry.text && text && text.includes(entry.text.toLowerCase())) boost += 4;
  if (entry.tag && normalizeText(candidate.tag || '').toLowerCase() === entry.tag.toLowerCase()) boost += 2;
  if (entry.clickable && candidate.clickable) boost += 1;
  if (entry.editable && candidate.editable) boost += 1;
  return boost;
};

export const applySiteExperienceBoost = async <T extends SiteExperienceCandidateInput>(
  domain: string | null,
  runtimeHint: string,
  candidates: T[],
): Promise<SiteExperienceBoostResult<T>> => {
  if (!domain || candidates.length === 0) {
    return { candidates, matchedEntries: 0 };
  }

  const store = await readStore();
  const domainRecord = store.domains[domain];
  if (!domainRecord || !Array.isArray(domainRecord.entries) || domainRecord.entries.length === 0) {
    return { candidates, matchedEntries: 0 };
  }

  let matchedEntries = 0;
  const nextCandidates = candidates.map((candidate) => {
    let experienceBoost = 0;
    let experienceMatches = 0;
    for (const entry of domainRecord.entries) {
      const boost = computeCandidateBoost(entry, candidate, runtimeHint);
      if (boost <= 0) continue;
      matchedEntries++;
      experienceMatches++;
      experienceBoost += boost;
    }
    return {
      ...candidate,
      ...(experienceBoost > 0 ? { experience_boost: experienceBoost } : {}),
      ...(experienceMatches > 0 ? { experience_matches: experienceMatches } : {}),
    };
  });

  nextCandidates.sort((left, right) => {
    const rightScore = Number((right as any).repair_score || 0) + Number((right as any).experience_boost || 0);
    const leftScore = Number((left as any).repair_score || 0) + Number((left as any).experience_boost || 0);
    return rightScore - leftScore;
  });

  return { candidates: nextCandidates, matchedEntries };
};

export const rememberSiteRepairExperience = async (
  domain: string | null,
  runtimeHint: string,
  candidates: SiteExperienceCandidateInput[],
): Promise<void> => {
  if (!domain || !runtimeHint || candidates.length === 0) return;

  const store = await readStore();
  const domainRecord: SiteExperienceDomainRecord = store.domains[domain] || {
    updatedAt: Date.now(),
    entries: [],
  };

  const now = Date.now();
  const nextEntries = [...domainRecord.entries];
  for (const raw of candidates.slice(0, 3)) {
    // 先脱敏再算 key：key 里也拼了选择器，只在落盘字段上脱敏等于把凭据换个字段存下来。
    const candidate = sanitizeCandidate(raw);
    const key = buildEntryKey(runtimeHint, candidate);
    const existingIndex = nextEntries.findIndex((entry) => entry.key === key);
    if (existingIndex >= 0) {
      const current = nextEntries[existingIndex];
      nextEntries[existingIndex] = {
        ...current,
        strength: Math.min(current.strength + 1, 12),
        count: current.count + 1,
        updatedAt: now,
      };
      continue;
    }

    nextEntries.push({
      key,
      hint: runtimeHint,
      tag: normalizeText(candidate.tag || '') || undefined,
      text: normalizeText(candidate.text || '') || undefined,
      label: normalizeText(candidate.label || '') || undefined,
      placeholder: normalizeText(candidate.placeholder || '') || undefined,
      // 选择器由属性值拼成（如 input[name="csrf_token"]），落盘前必须过 selectorOf。
      selector: candidate.selector_candidates?.[0] || undefined,
      clickable: candidate.clickable === true,
      editable: candidate.editable === true,
      strength: 2,
      count: 1,
      source: 'repair',
      updatedAt: now,
    });
  }

  domainRecord.updatedAt = now;
  domainRecord.entries = nextEntries
    .sort((left, right) => {
      const rightScore = right.strength * 100 + right.count * 10 + Math.floor(right.updatedAt / 1000);
      const leftScore = left.strength * 100 + left.count * 10 + Math.floor(left.updatedAt / 1000);
      return rightScore - leftScore;
    })
    .slice(0, MAX_DOMAIN_ENTRIES);
  store.domains[domain] = domainRecord;
  await persistStore(store);
};

export const markRecentSiteRepair = async (
  domain: string | null,
  runtimeHint: string,
  candidates: SiteExperienceCandidateInput[],
): Promise<void> => {
  if (!domain || candidates.length === 0) return;
  const recentMap = await readRecentRepairMap();
  recentMap[domain] = {
    domain,
    hint: runtimeHint,
    candidates: candidates.slice(0, 5).map(sanitizeCandidate),
    createdAt: Date.now(),
  };
  await persistRecentRepairMap(recentMap);
};


export const replayRecentSiteRepair = async (
  domain: string | null,
  runtimeHint: string,
  maxCount: number = 3,
): Promise<{ candidates: SiteExperienceCandidateInput[]; sourceHint?: string; ageMs?: number }> => {
  if (!domain) {
    return { candidates: [] };
  }
  const recentMap = await readRecentRepairMap();
  const recent = recentMap[domain];
  if (!recent || !Array.isArray(recent.candidates) || recent.candidates.length === 0) {
    return { candidates: [] };
  }

  const similarity = runtimeHint ? computeHintSimilarity(recent.hint, runtimeHint) : 1;
  if (runtimeHint && similarity <= 0) {
    return { candidates: [] };
  }

  return {
    candidates: recent.candidates.slice(0, Math.max(1, maxCount)).map((candidate, index) => ({
      ...candidate,
      repair_score: Math.max(Number(candidate.repair_score || 0), 14 - index * 2),
    })),
    sourceHint: recent.hint,
    ageMs: Math.max(0, Date.now() - Number(recent.createdAt || 0)),
  };
};

export const reinforceRecentSiteRepairSuccess = async (domain: string | null): Promise<void> => {
  if (!domain) return;
  const recentMap = await readRecentRepairMap();
  const recent = recentMap[domain];
  if (!recent) return;

  const store = await readStore();
  const domainRecord: SiteExperienceDomainRecord = store.domains[domain] || {
    updatedAt: Date.now(),
    entries: [],
  };
  const now = Date.now();
  const nextEntries = [...domainRecord.entries];

  for (const raw of recent.candidates.slice(0, 3)) {
    const candidate = sanitizeCandidate(raw);
    const key = buildEntryKey(recent.hint, candidate);
    const existingIndex = nextEntries.findIndex((entry) => entry.key === key);
    if (existingIndex >= 0) {
      const current = nextEntries[existingIndex];
      nextEntries[existingIndex] = {
        ...current,
        strength: Math.min(current.strength + 3, 20),
        count: current.count + 2,
        updatedAt: now,
      };
      continue;
    }

    nextEntries.push({
      key,
      hint: recent.hint,
      tag: normalizeText(candidate.tag || '') || undefined,
      text: normalizeText(candidate.text || '') || undefined,
      label: normalizeText(candidate.label || '') || undefined,
      placeholder: normalizeText(candidate.placeholder || '') || undefined,
      selector: candidate.selector_candidates?.[0] || undefined,
      clickable: candidate.clickable === true,
      editable: candidate.editable === true,
      strength: 5,
      count: 2,
      source: 'repair',
      updatedAt: now,
    });
  }

  domainRecord.updatedAt = now;
  domainRecord.entries = nextEntries
    .sort((left, right) => {
      const rightScore = right.strength * 100 + right.count * 10 + Math.floor(right.updatedAt / 1000);
      const leftScore = left.strength * 100 + left.count * 10 + Math.floor(left.updatedAt / 1000);
      return rightScore - leftScore;
    })
    .slice(0, MAX_DOMAIN_ENTRIES);
  store.domains[domain] = domainRecord;
  await persistStore(store);

  delete recentMap[domain];
  await persistRecentRepairMap(recentMap);
};
export type SiteExperienceAction = 'click' | 'type' | 'read' | 'screenshot';

export interface SiteExperienceObservation {
  url?: string;
  host?: string;
  action: string;
  selector?: string;
  success: boolean;
  failureReason?: string;
  requiredPreconditions?: string[];
}

export interface SiteExperienceSelectorStats {
  actions: Partial<Record<SiteExperienceAction, { attempts: number; successes: number; successRate: number }>>;
  requiredPreconditions: string[];
}

export interface SiteExperienceMemory {
  version: 1;
  domains: Record<string, { selectors: Record<string, SiteExperienceSelectorStats>; failureReasons: Record<string, number>; drafts?: SiteExperienceDraft[] }>;
}

export interface SiteExperienceRecipe {
  action: SiteExperienceAction | 'needs_precondition';
  reason: string;
  confidence: number;
  requiredPreconditions: string[];
  fallback: 'read' | 'screenshot';
  selector?: string;
}

const SAFE_ACTIONS = new Set<SiteExperienceAction>(['click', 'type', 'read', 'screenshot']);
const SAFE_PRECONDITIONS = new Set(['login', 'popup', 'challenge', 'consent', 'authenticated']);
// 这些名字会命中 Object.prototype 上的继承属性，不能当 host 键用。
const RESERVED_HOSTS = new Set(['__proto__', 'constructor', 'prototype']);

/** Return only a stable host key; URL paths, queries, fragments and credentials are never retained. */
export function siteExperienceKey(urlOrHost: unknown): string {
  if (typeof urlOrHost !== 'string' || !urlOrHost.trim()) return '';
  const value = urlOrHost.trim();
  let host = '';
  try {
    host = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`).hostname;
  } catch {
    return '';
  }
  host = host.toLowerCase().replace(/^www\./, '').replace(/\.+$/, '');
  // 保留字必须在这里挡掉：下游用 domains[host] 取值，'constructor' 会解析到继承来的
  // Object 构造函数，随后的写入就落到 Object.selectors 上，污染整个扩展 realm。
  if (!host || host.includes('..') || RESERVED_HOSTS.has(host) || /[^a-z0-9._:-]/.test(host)) return '';
  if (host === 'twitter.com' || host.endsWith('.twitter.com')) return host.replace(/(?:^|\.)twitter\.com$/, '.x.com').replace(/^\./, 'x.com');
  if (host === 'tmall.com' || host.endsWith('.tmall.com')) return host.replace(/(?:^|\.)tmall\.com$/, '.taobao.com').replace(/^\./, 'taobao.com');
  return host;
}

const actionOf = (value: unknown): SiteExperienceAction | '' => {
  const action = String(value || '').trim().toLowerCase();
  if (action === 'fill' || action === 'input') return 'type';
  return SAFE_ACTIONS.has(action as SiteExperienceAction) ? action as SiteExperienceAction : '';
};

const preconditionOf = (value: unknown): string => {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z_]/g, '_');
  if (normalized.includes('login') || normalized.includes('auth')) return 'login';
  if (normalized.includes('popup') || normalized.includes('modal')) return 'popup';
  if (normalized.includes('challenge') || normalized.includes('captcha') || normalized.includes('verification')) return 'challenge';
  if (normalized.includes('consent') || normalized.includes('cookie')) return 'consent';
  return SAFE_PRECONDITIONS.has(normalized) ? normalized : '';
};

const selectorOf = (value: unknown): string => {
  const selector = typeof value === 'string' ? value.trim().slice(0, 300) : '';
  if (!selector || /(?:password|token|secret|value\s*=|query)/i.test(selector)) return '';
  return selector;
};

/** 候选落盘前的统一脱敏：选择器可能内嵌属性值，一律过 selectorOf。 */
const sanitizeCandidate = (candidate: SiteExperienceCandidateInput): SiteExperienceCandidateInput => ({
  ...candidate,
  selector_candidates: (candidate.selector_candidates || []).map(selectorOf).filter(Boolean),
});

const reasonOf = (value: unknown): string => {
  const text = String(value || '').toLowerCase();
  if (/timeout|timed? ?out/.test(text)) return 'timeout';
  if (/not.?found|missing|selector/.test(text)) return 'not_found';
  if (/disabled|not.?enabled/.test(text)) return 'disabled';
  if (/challenge|captcha|verification/.test(text)) return 'challenge';
  if (/login|auth|sign.?in/.test(text)) return 'login_required';
  if (/popup|modal/.test(text)) return 'popup_blocked';
  return text ? 'unknown' : '';
};

const emptyMemory = (): SiteExperienceMemory => ({ version: 1, domains: {} });

const hostCandidates = (host: string): string[] => {
  const parts = host.split('.');
  const result = [host];
  for (let index = 1; index < parts.length - 1; index += 1) result.push(parts.slice(index).join('.'));
  return result;
};

/** Merge one bounded observation without copying credentials, values or full URLs. */
export function mergeSiteExperience(old: SiteExperienceMemory | Record<string, unknown> | null | undefined, observation: SiteExperienceObservation): SiteExperienceMemory {
  const source = old && typeof old === 'object' && (old as SiteExperienceMemory).domains && typeof (old as SiteExperienceMemory).domains === 'object'
    ? old as SiteExperienceMemory : emptyMemory();
  const next: SiteExperienceMemory = { version: 1, domains: {} };
  for (const [host, domain] of Object.entries(source.domains || {})) {
    next.domains[host] = {
      selectors: {},
      failureReasons: { ...(domain?.failureReasons || {}) },
    };
    for (const [selector, stats] of Object.entries(domain?.selectors || {})) {
      const actions: SiteExperienceSelectorStats['actions'] = {};
      for (const [action, value] of Object.entries(stats?.actions || {})) {
        const safeAction = actionOf(action);
        if (safeAction && value && Number.isFinite(value.attempts) && Number.isFinite(value.successes)) {
          const attempts = Math.max(0, Math.floor(value.attempts));
          const successes = Math.min(attempts, Math.max(0, Math.floor(value.successes)));
          actions[safeAction] = { attempts, successes, successRate: attempts ? successes / attempts : 0 };
        }
      }
      next.domains[host].selectors[selector] = { actions, requiredPreconditions: Array.from(new Set((stats?.requiredPreconditions || []).map(preconditionOf).filter(Boolean))) };
    }
  }
  const host = siteExperienceKey(observation.host || observation.url);
  const action = actionOf(observation.action);
  const selector = selectorOf(observation.selector);
  if (!host || !action || !selector || typeof observation.success !== 'boolean') return next;
  const domain = next.domains[host] || { selectors: {}, failureReasons: {} };
  const current = domain.selectors[selector] || { actions: {}, requiredPreconditions: [] };
  const oldStats = current.actions[action] || { attempts: 0, successes: 0, successRate: 0 };
  const attempts = oldStats.attempts + 1;
  const successes = oldStats.successes + (observation.success ? 1 : 0);
  current.actions[action] = { attempts, successes, successRate: successes / attempts };
  current.requiredPreconditions = Array.from(new Set([...current.requiredPreconditions, ...(observation.requiredPreconditions || []).map(preconditionOf).filter(Boolean)])).sort();
  domain.selectors[selector] = current;
  const failure = reasonOf(observation.failureReason);
  if (failure) domain.failureReasons[failure] = (domain.failureReasons[failure] || 0) + 1;
  next.domains[host] = domain;
  return next;
}

const availablePreconditions = (context: Record<string, unknown>): Set<string> => {
  const values = Array.isArray(context.preconditions) ? context.preconditions : [];
  const result = new Set(values.map(preconditionOf).filter(Boolean));
  for (const name of SAFE_PRECONDITIONS) if (context[name] === true) result.add(name);
  return result;
};

/** Select only well-supported actions; uncertainty always returns a non-mutating fallback. */
export function chooseRecipe(experience: SiteExperienceMemory | Record<string, unknown> | null | undefined, goal: string, context: Record<string, unknown> = {}): SiteExperienceRecipe {
  const requested = actionOf(goal) || 'read';
  const host = siteExperienceKey(context.host || context.url);
  const memory = experience && typeof experience === 'object' && (experience as SiteExperienceMemory).domains ? experience as SiteExperienceMemory : emptyMemory();
  const fallback = requested === 'read' ? 'read' : 'screenshot';
  if (requested === 'read' || requested === 'screenshot') return { action: requested, reason: 'safe observation action', confidence: 1, requiredPreconditions: [], fallback };
  const candidates: Array<{ selector: string; stats: SiteExperienceSelectorStats; confidence: number }> = [];
  for (const key of hostCandidates(host)) {
    const domain = memory.domains[key];
    for (const [selector, stats] of Object.entries(domain?.selectors || {})) {
      const actionStats = stats.actions[requested];
      if (!actionStats) continue;
      const confidence = actionStats.successRate;
      const competing = Object.entries(stats.actions).some(([action, value]) => action !== requested && (value?.successes || 0) > 0);
      if (competing || actionStats.attempts < 2 || confidence < 0.75) continue;
      candidates.push({ selector, stats, confidence });
    }
  }
  candidates.sort((left, right) => right.confidence - left.confidence || left.selector.localeCompare(right.selector));
  const selected = candidates[0];
  if (!selected) return { action: fallback, reason: 'insufficient or conflicting site experience', confidence: 0, requiredPreconditions: [], fallback };
  const required = [...selected.stats.requiredPreconditions].sort();
  const missing = required.filter((item) => !availablePreconditions(context).has(item));
  if (missing.length > 0) return { action: 'needs_precondition', reason: 'required precondition is missing', confidence: selected.confidence, requiredPreconditions: missing, fallback };
  return { action: requested, selector: selected.selector, reason: 'supported by repeated successful site experience', confidence: selected.confidence, requiredPreconditions: required, fallback };
}

export interface SiteExperienceDraft {
  id: string;
  steps: Record<string, unknown>[];
}

const safeDraftStep = (raw: unknown): Record<string, unknown> | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const step = raw as Record<string, unknown>;
  const action = step.action;
  if (typeof action !== 'string' || !['click', 'type', 'select', 'scroll', 'read', 'wait'].includes(action)) return null;
  const find = step.find as Record<string, unknown> | undefined;
  const named = find && typeof find.role === 'string' && find.role.trim() && typeof find.name === 'string' && find.name.trim()
    ? { role: find.role.trim(), name: find.name.trim(), ...(Number.isSafeInteger(find.nth) && Number(find.nth) >= 0 ? { nth: find.nth } : {}) }
    : null;
  if (!named) return null;
  const result: Record<string, unknown> = { action, find: named };
  if (action === 'type' || action === 'select') {
    const key = action === 'type' ? 'text' : 'value';
    if (typeof step[key] !== 'string' || !/^\$\{[a-z][a-z0-9_]*\}$/.test(step[key] as string)) return null;
    result[key] = step[key];
  }
  if (action === 'wait' && Number.isSafeInteger(step.ms) && Number(step.ms) >= 0 && Number(step.ms) <= 60000) result.ms = step.ms;
  return result;
};

const safeDraft = (raw: unknown): SiteExperienceDraft | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const draft = raw as Record<string, unknown>;
  if (typeof draft.id !== 'string' || !/^act-[a-f0-9]{24}$/.test(draft.id) || !Array.isArray(draft.steps) || !draft.steps.length) return null;
  const steps = draft.steps.map(safeDraftStep);
  return steps.every(Boolean) ? { id: draft.id, steps: steps as Record<string, unknown>[] } : null;
};

export interface SiteExperienceLayers {
  host: string;
  builtin: SiteExperienceMemory;
  local: SiteExperienceMemory;
  merged: SiteExperienceMemory;
  /** F1：出厂段可被整段识别——这些 host 的条目来自只读的出厂层。 */
  factoryHosts: string[];
  hasRecords: boolean;
  guidance: string;
}

const copyMemory = (input: SiteExperienceMemory | Record<string, unknown> | null | undefined): SiteExperienceMemory => {
  const result = emptyMemory();
  if (!input || typeof input !== 'object') return result;
  const domains = (input as SiteExperienceMemory).domains;
  if (!domains || typeof domains !== 'object') return result;
  for (const [rawHost, rawDomain] of Object.entries(domains)) {
    const host = siteExperienceKey(rawHost);
    if (!host || !rawDomain || typeof rawDomain !== 'object') continue;
    const domain = result.domains[host] || { selectors: {}, failureReasons: {} };
    const source = rawDomain as { selectors?: Record<string, SiteExperienceSelectorStats>; failureReasons?: Record<string, unknown>; drafts?: unknown[] };
    for (const [rawSelector, rawStats] of Object.entries(source.selectors || {})) {
      const selector = selectorOf(rawSelector);
      if (!selector || !rawStats || typeof rawStats !== 'object') continue;
      const stats = rawStats as SiteExperienceSelectorStats;
      const target = domain.selectors[selector] || { actions: {}, requiredPreconditions: [] };
      for (const [rawAction, rawValue] of Object.entries(stats.actions || {})) {
        const action = actionOf(rawAction);
        if (!action || !rawValue || typeof rawValue !== 'object') continue;
        const attempts = Math.max(0, Math.floor(Number(rawValue.attempts) || 0));
        const successes = Math.min(attempts, Math.max(0, Math.floor(Number(rawValue.successes) || 0)));
        const current = target.actions[action];
        if (!current || attempts > current.attempts) target.actions[action] = { attempts, successes, successRate: attempts ? successes / attempts : 0 };
      }
      target.requiredPreconditions = Array.from(new Set([...target.requiredPreconditions, ...(stats.requiredPreconditions || []).map(preconditionOf).filter(Boolean)])).sort();
      domain.selectors[selector] = target;
    }
    for (const [rawReason, count] of Object.entries(source.failureReasons || {})) {
      const reason = reasonOf(rawReason);
      if (reason) domain.failureReasons[reason] = (domain.failureReasons[reason] || 0) + Math.max(0, Math.floor(Number(count) || 0));
    }
    if (Array.isArray(source.drafts)) {
      const drafts = source.drafts.map(safeDraft).filter((draft): draft is SiteExperienceDraft => draft !== null);
      if (drafts.length) domain.drafts = drafts;
    }
    result.domains[host] = domain;
  }
  return result;
};

/** Remove provenance and unbounded fields before local persistence or round-trip. */
export function stripSiteExperienceProvenance(input: SiteExperienceMemory | Record<string, unknown> | null | undefined): SiteExperienceMemory {
  return copyMemory(input);
}

/** Built-in guidance is read-only; local entries win per selector while missing built-ins remain visible. */
export function mergeSiteExperienceLayers(builtin: SiteExperienceMemory | Record<string, unknown> | null | undefined, local: SiteExperienceMemory | Record<string, unknown> | null | undefined): SiteExperienceMemory {
  const base = copyMemory(builtin);
  const user = copyMemory(local);
  for (const [host, domain] of Object.entries(user.domains)) {
    const target = base.domains[host] || { selectors: {}, failureReasons: {} };
    for (const [selector, stats] of Object.entries(domain.selectors)) target.selectors[selector] = stats;
    for (const [reason, count] of Object.entries(domain.failureReasons)) target.failureReasons[reason] = (target.failureReasons[reason] || 0) + count;
    if (domain.drafts?.length) target.drafts = [
      ...domain.drafts,
      ...(target.drafts || []).filter(draft => !domain.drafts!.some(localDraft => localDraft.id === draft.id)),
    ];
    base.domains[host] = target;
  }
  return base;
}

export function siteExperienceGuidance(experience: SiteExperienceMemory | Record<string, unknown> | null | undefined): string {
  const safe = copyMemory(experience);
  return Object.keys(safe.domains).length > 0
    ? '已有站点经验可供参考；经验是提示不是规则，执行前仍需重新读取页面。'
    : '当前站点暂无经验记录；不阻塞操作，可在成功后回流沉淀经验。';
}

export function getSiteExperienceLayers(builtin: SiteExperienceMemory | Record<string, unknown> | null | undefined, local: SiteExperienceMemory | Record<string, unknown> | null | undefined, urlOrHost: unknown): SiteExperienceLayers {
  const host = siteExperienceKey(urlOrHost);
  const safeBuiltin = copyMemory(builtin);
  const safeLocal = copyMemory(local);
  const merged = mergeSiteExperienceLayers(safeBuiltin, safeLocal);
  return {
    host,
    builtin: safeBuiltin,
    local: safeLocal,
    merged,
    factoryHosts: Object.keys(safeBuiltin.domains).sort(),
    hasRecords: Boolean(host && (merged.domains[host] || hostCandidates(host).some((candidate) => merged.domains[candidate]))),
    guidance: siteExperienceGuidance(merged),
  };
}

export interface SiteExperienceSaveResult {
  experience: SiteExperienceMemory;
  warning: string;
  revisions: SiteExperienceMemory[];
}

export const readSiteExperience = async (builtin: SiteExperienceMemory | Record<string, unknown> | null | undefined, urlOrHost: unknown): Promise<SiteExperienceLayers> => {
  const stored = await readMigratedStorage<SiteExperienceMemory>(storageArea, SITE_EXPERIENCE_LAYERS_STORAGE_KEY, 'mole_site_experience_layers_v1');
  return getSiteExperienceLayers(builtin, stored, urlOrHost);
};
/**
 * F6：把 `get` 的全文原样回贴时，先认出它是哪一层，再只取本机内容。
 * 认不出来就返回 null——宁可拒绝，也不能把本机层静默清空。
 */
const unwrapSiteExperience = (input: unknown): SiteExperienceMemory | null => {
  let value = input;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    try { value = JSON.parse(text); } catch { return null; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  // `get` 的全文带 merged/local/builtin 三个小节：取合并视图，出厂段随后被减掉。
  for (const key of ['merged', 'local'] as const) {
    const candidate = record[key];
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate) && 'domains' in candidate) {
      return copyMemory(candidate as SiteExperienceMemory);
    }
  }
  return 'domains' in record ? copyMemory(record) : null;
};

/** 出厂段要按条目减掉：selector 按值、失败计数按差、草稿按 id，重复回贴才不会越存越多。 */
const subtractSiteExperience = (merged: SiteExperienceMemory, builtin: SiteExperienceMemory): SiteExperienceMemory => {
  const result = emptyMemory();
  for (const [host, domain] of Object.entries(merged.domains)) {
    const base = builtin.domains[host];
    const selectors: Record<string, SiteExperienceSelectorStats> = {};
    for (const [selector, stats] of Object.entries(domain.selectors)) {
      const builtinStats = base?.selectors[selector];
      if (!builtinStats || JSON.stringify(builtinStats) !== JSON.stringify(stats)) selectors[selector] = stats;
    }
    const failureReasons: Record<string, number> = {};
    for (const [reason, count] of Object.entries(domain.failureReasons)) {
      const remaining = count - (base?.failureReasons[reason] || 0);
      if (remaining > 0) failureReasons[reason] = remaining;
    }
    const factoryDrafts = base?.drafts || [];
    const drafts = (domain.drafts || []).filter(draft => !factoryDrafts.some(factoryDraft => factoryDraft.id === draft.id));
    if (Object.keys(selectors).length > 0 || drafts.length > 0) {
      result.domains[host] = { selectors, failureReasons, ...(drafts.length ? { drafts } : {}) };
    }
  }
  return result;
};

export const saveSiteExperience = async (input: SiteExperienceMemory | Record<string, unknown> | null | undefined, builtin: SiteExperienceMemory | Record<string, unknown> | null | undefined = null): Promise<SiteExperienceSaveResult> => {
  const unwrapped = unwrapSiteExperience(input);
  if (!unwrapped) throw new Error('site experience save requires a memory object, a site_experience get result, or their JSON text');
  // 回贴的全文自带出厂段；调用方没显式给 builtin 时就用它，否则出厂条目会被当成本机内容存下来。
  const declaredBuiltin = isPlainObject(input) && isPlainObject(input.builtin) ? input.builtin : null;
  const experience = subtractSiteExperience(unwrapped, stripSiteExperienceProvenance(builtin ?? declaredBuiltin));
  const current = await readMigratedStorage<SiteExperienceMemory>(storageArea, SITE_EXPERIENCE_LAYERS_STORAGE_KEY, 'mole_site_experience_layers_v1');
  const previous = await readMigratedStorage<SiteExperienceMemory[]>(storageArea, SITE_EXPERIENCE_REVISIONS_STORAGE_KEY, 'mole_site_experience_revisions_v1');
  const priorSnapshots = current && typeof current === 'object' && current.domains
    ? [stripSiteExperienceProvenance(current)]
    : [];
  const revisions = [...priorSnapshots, ...(Array.isArray(previous) ? previous.map(stripSiteExperienceProvenance) : [])].slice(0, 10);
  await storageArea.set({ [SITE_EXPERIENCE_LAYERS_STORAGE_KEY]: experience, [SITE_EXPERIENCE_REVISIONS_STORAGE_KEY]: revisions });
  return { experience, revisions, warning: '经验仅保存本机站点提示，不含凭据、表单值或完整 URL；经验是提示不是规则。' };
};

/** Promote a sanitized draft into the local layer, ahead of every existing recipe. */
export const addSiteExperienceDraft = async (hostOrUrl: unknown, input: SiteExperienceDraft): Promise<void> => {
  const host = siteExperienceKey(hostOrUrl);
  const draft = safeDraft(input);
  if (!host || !draft) throw new Error('Invalid site draft');
  const stored = await readMigratedStorage<SiteExperienceMemory>(storageArea, SITE_EXPERIENCE_LAYERS_STORAGE_KEY, 'mole_site_experience_layers_v1');
  const local = stripSiteExperienceProvenance(stored);
  const domain = local.domains[host] || { selectors: {}, failureReasons: {} };
  domain.drafts = [draft, ...(domain.drafts || []).filter(existing => existing.id !== draft.id)];
  local.domains[host] = domain;
  await saveSiteExperience(local);
};
