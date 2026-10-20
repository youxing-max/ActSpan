import { addSiteExperienceDraft, siteExperienceKey, type SiteExperienceDraft } from '../functions/site-experience';

const STORAGE_KEY = 'actspan_act_drafts_v1';
const MUTATIONS: Record<string, true> = { click: true, type: true, select: true, scroll: true };
const ACTIONS: Record<string, true> = { ...MUTATIONS, read: true, wait: true };

type Step = Record<string, unknown>;
type Draft = SiteExperienceDraft & { host: string; successCount: number; createdAt: number };
type DraftStore = { version: 1; drafts: Draft[] };
type ActDraftInput = { tabId?: unknown; steps?: unknown; audit?: unknown; site?: unknown };

let pending: Promise<unknown> = Promise.resolve();
const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
  const result = pending.then(operation);
  pending = result.catch(() => undefined);
  return result;
};

const namedFind = (source: Step): { role: string; name: string; nth?: number } | null => {
  const candidate = source.find && typeof source.find === 'object' && !Array.isArray(source.find)
    ? source.find as Step : source;
  const role = typeof candidate.role === 'string' ? candidate.role.trim() : '';
  const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
  if (!role || !name || role.length > 64 || name.length > 160) return null;
  const nth = candidate.nth;
  if (nth !== undefined && (!Number.isSafeInteger(nth) || Number(nth) < 0)) return null;
  return { role, name, ...(nth === undefined ? {} : { nth: Number(nth) }) };
};

const placeholderFor = (name: string, index: number): string => {
  const slug = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48);
  return `\${${slug || `input_${index}`}}`;
};

const sanitize = (raw: unknown, index: { typed: number; effective: number; mutations: number; values: string[] }): Step | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const step = raw as Step;
  const action = step.action;
  if (typeof action !== 'string') return null;
  if (Object.hasOwn(ACTIONS, action)) {
    const find = namedFind(step);
    if (!find) return null;
    const cleaned: Step = { action, find };
    if (action === 'type' || action === 'select') {
      index.typed++;
      for (const key of ['text', 'value', 'input', 'keys']) {
        if (typeof step[key] === 'string' && (step[key] as string).length > 0) index.values.push(step[key] as string);
      }
      cleaned[action === 'select' ? 'value' : 'text'] = placeholderFor(find.name, index.typed);
    }
    if (action === 'read' && (step.attr !== undefined || step.selector !== undefined || step.contains !== undefined)) return null;
    if (action === 'wait') {
      if (step.for !== undefined || step.timeoutMs !== undefined) return null;
      if (step.ms !== undefined && (!Number.isSafeInteger(step.ms) || Number(step.ms) < 0 || Number(step.ms) > 60000)) return null;
      if (step.ms !== undefined) cleaned.ms = step.ms;
    }
    index.effective++;
    if (Object.hasOwn(MUTATIONS, action)) index.mutations++;
    return cleaned;
  }
  return null;
};

const sanitizeSteps = (input: unknown, index: { typed: number; effective: number; mutations: number; values: string[] }): Step[] | null => {
  if (!Array.isArray(input)) return null;
  const result: Step[] = [];
  for (const raw of input) {
    const step = sanitize(raw, index);
    if (!step) return null;
    result.push(step);
  }
  return result;
};

const readStore = async (): Promise<DraftStore> => {
  const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] as DraftStore | undefined;
  return stored?.version === 1 && Array.isArray(stored.drafts) ? stored : { version: 1, drafts: [] };
};

const hostForTab = async (tabId: unknown): Promise<string> => {
  if (!Number.isSafeInteger(tabId) || Number(tabId) <= 0) return '';
  const tab = await chrome.tabs.get(Number(tabId));
  return siteExperienceKey(tab.url || tab.pendingUrl || '');
};

/** The only durable boundary for act input: admit known fields, never raw script or audit. */
export const recordSuccessfulActDraft = async (input: ActDraftInput) => {
  const audit = input.audit as { success?: unknown; stepCount?: unknown; effectiveCount?: unknown; hasMutation?: unknown; trace?: unknown } | undefined;
  const excluded = (reason: string) => ({ success: true, draftId: null, created: false, successCount: 0, reason });
  if (audit?.success !== true || audit.hasMutation !== true || !Number.isSafeInteger(audit.effectiveCount) || Number(audit.effectiveCount) < 3 || !Number.isSafeInteger(audit.stepCount) || Number(audit.stepCount) < 3) return excluded('ineligible act');
  const index = { typed: 0, effective: 0, mutations: 0, values: [] as string[] };
  const steps = sanitizeSteps(input.steps, index);
  if (!steps || index.effective < 3 || index.mutations < 1 || index.effective > 20) return excluded('ineligible steps');
  if (Array.isArray(audit.trace)) {
    if (audit.trace.some(entry => !entry || typeof entry !== 'object' || (entry as Step).ok !== true)) return excluded('failed step');
    const actions = audit.trace.map(entry => (entry as Step).action).filter((action): action is string => typeof action === 'string' && Object.hasOwn(ACTIONS, action));
    if (actions.length !== steps.length || actions.some((action, index) => action !== steps[index].action)) return excluded('execution trace mismatch');
  }
  const structural = JSON.stringify(steps);
  if (index.values.some(value => structural.includes(value))) return excluded('unsafe target');
  const host = await hostForTab(input.tabId);
  if (!host) return excluded('site unavailable');
  const bytes = new TextEncoder().encode(`${host}:${structural}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const id = `act-${Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 24)}`;
  return serialized(async () => {
    const store = await readStore();
    const existing = store.drafts.find(draft => draft.id === id && draft.host === host);
    if (existing) {
      existing.successCount++;
      await chrome.storage.local.set({ [STORAGE_KEY]: store });
      return { success: true, draftId: id, created: false, successCount: existing.successCount };
    }
    store.drafts.push({ id, host, steps, successCount: 1, createdAt: Date.now() });
    await chrome.storage.local.set({ [STORAGE_KEY]: store });
    return { success: true, draftId: id, created: true, successCount: 1 };
  });
};

export const listActDrafts = async (hostOrUrl: unknown): Promise<Draft[]> => {
  const host = siteExperienceKey(hostOrUrl);
  return (await readStore()).drafts.filter(draft => draft.host === host);
};

/** Adoption is explicit; drafts do not affect site guidance until promoted. */
export const adoptActDraft = async ({ draftId, tabId }: { draftId?: unknown; tabId?: unknown }) => serialized(async () => {
  const host = await hostForTab(tabId);
  const draft = (await readStore()).drafts.find(candidate => candidate.host === host && candidate.id === draftId);
  if (!draft) throw new Error('Draft not found for this site');
  await addSiteExperienceDraft(host, draft);
  return { success: true, draftId: draft.id, host };
});
