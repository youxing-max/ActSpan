/**
 * 页面 grounding 能力
 * 提供语义化页面快照和基于 element_id 的通用动作执行
 */

import Channel from '../lib/channel';
import { isSensitiveRecordedField } from '../lib/recorder-redaction';
import { detectObstruction, getElementCenter, withVirtualCursorBeforeObstruction } from './virtual-cursor';

/**
 * 隔离世界私有的 ref 解析入口：页面脚本不可见，供注入脚本（interactOnPage）复用同一套句柄校验。
 */
declare global {
  var __actspan_resolve_element_handle: ((elementId: string, snapshotId?: string) => FindResolution) | undefined;
}

interface PageSnapshotParams {
  query?: string;
  scope_selector?: string;
  include_non_interactive?: boolean;
  include_hidden?: boolean;
  only_viewport?: boolean;
  limit?: number;
  /** G5：桥接层为每个 frame 指定自己的 snapshotId；缺省时本 frame 自行生成 */
  snapshot_id?: string;
}

/** role+name 定位目标，不依赖快照；nth 为 0-based 索引，仅在多命中时用于消歧 */
export interface FindTarget {
  role?: string;
  name?: string;
  nth?: number;
}

interface ElementHandleActionParams {
  action: 'click' | 'fill' | 'focus' | 'get_info' | 'press_key' | 'scroll_into_view' | 'select' | 'hover' | 'inspect' | 'observe' | 'read' | 'classify';
  element_id?: string;
  snapshot_id?: string;
  selector?: string;
  find?: FindTarget;
  /** classify 按可见文本定位时使用 */
  text?: string;
  match_mode?: 'contains' | 'exact';
  value?: string;
  key?: string;
  modifiers?: string[];
  approved_signature?: string;
  submit?: boolean;
  max_chars?: number;
  /** 条件探针：只回报布尔观测，原始 value 与页面文本绝不回传。 */
  attr?: 'exists' | 'checked' | 'value' | 'text' | 'textContains';
  expect?: string;
}

interface PageAssertionItem {
  type: 'url_includes' | 'title_includes' | 'text_includes' | 'selector_exists' | 'selector_visible' | 'selector_text_includes';
  value?: string;
  selector?: string;
}

interface PageAssertParams {
  mode?: 'all' | 'any';
  scope_selector?: string;
  assertions?: PageAssertionItem[];
}

/** 缓存的元素信息，避免在 filter/score/build 三阶段重复调用昂贵 DOM API */
interface CachedElementInfo {
  rect: DOMRect;
  visible: boolean;
  inViewport: boolean;
  clickable: boolean;
  editable: boolean;
  disabled: boolean;
  text: string;
  label: string;
  surroundingText: string;
}

/** 需要跳过的无意义标签集合 */
const SKIP_TAGS = new Set([
  'script', 'style', 'meta', 'link', 'br', 'hr', 'noscript',
  'template', 'iframe', 'object', 'embed', 'head', 'title',
  'col', 'colgroup', 'source', 'track', 'wbr', 'path', 'defs',
  'clippath', 'lineargradient', 'radialgradient', 'stop', 'symbol', 'use',
]);

/** 节点遍历上限，避免超大 DOM 页面卡死 */
const MAX_NODES = 8000;

/**
 * G4：把开放 shadow root 的后代一并纳入候选。
 * 闭合 shadow root 无法访问，按契约不在范围内；跨源 iframe 由桥接层按 frame 路由，不在这里穿透。
 */
const collectDeepElements = (root: ParentNode, selector: string): Element[] => {
  const collected: Element[] = [];
  const visit = (scope: ParentNode): void => {
    for (const el of Array.from(scope.querySelectorAll('*'))) {
      // ActSpan 自身 UI（悬浮球宿主 #actspan-root）不属页面语义，不进快照候选
      if (el.id === 'actspan-root') continue;
      if (selector === '*' || el.matches(selector)) collected.push(el);
      const shadow = el.shadowRoot;
      if (shadow) visit(shadow);
    }
  };
  visit(root);
  const rootShadow = (root as Element).shadowRoot;
  if (rootShadow) visit(rootShadow);
  return collected;
};

export const HANDLE_PREFIX = `ec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let handleSeq = 0;
let snapshotSeq = 0;
export const elementHandleMap = new Map<string, Element>();
export const elementToHandleMap = new WeakMap<Element, string>();
export const elementHandleSnapshotMap = new Map<string, { snapshotId: string; fingerprint: string }>();

export const createSnapshotId = (): string => `${HANDLE_PREFIX}-s${(++snapshotSeq).toString(36)}`;

const getElementFingerprint = (el: Element): string => [
  el.tagName.toLowerCase(),
  el.getAttribute('role') || '',
  normalizeText(getElementText(el)).slice(0, 120),
].join('|');

export const validateElementHandle = (
  elementId: string,
  snapshotId?: string,
  metadata: Map<string, { snapshotId: string; fingerprint: string }> = elementHandleSnapshotMap,
): string | null => {
  const entry = metadata.get(elementId);
  if (!entry) return null;
  if (!snapshotId || snapshotId !== entry.snapshotId) {
    return 'element_id 已过期，请重新调用 page(action="snapshot")，或改用 find 重新定位元素';
  }
  return null;
};

export const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'textarea',
  'select',
  '[role]',
  '[tabindex]',
  '[contenteditable="true"]',
  '[data-testid]',
  '[data-test]',
  '[aria-label]',
  '[name]',
  'label',
  'summary',
].join(',');

export const normalizeText = (raw: unknown): string => String(raw || '').replace(/\s+/g, ' ').trim();

export const clipText = (raw: unknown, max: number = 180): string => {
  const text = normalizeText(raw);
  return text.length > max ? `${text.slice(0, max)}...` : text;
};

const escapeCssValue = (value: string): string => {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return String(value).replace(/(["\\#.:\[\]\s>+~()])/g, '\\$1');
};

/**
 * 判断元素是否可见
 * @param el 目标元素
 * @param rect 可选，预先获取的 DOMRect，避免重复调用 getBoundingClientRect
 * @param style 可选，预先获取的 CSSStyleDeclaration，避免重复调用 getComputedStyle
 */
export const isElementVisible = (el: Element, rect?: DOMRect, style?: CSSStyleDeclaration): boolean => {
  const htmlEl = el as HTMLElement;
  const r = rect || htmlEl.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const s = style || window.getComputedStyle(htmlEl);
  if (s.display === 'none' || s.visibility === 'hidden') return false;
  if (Number(s.opacity) === 0) return false;
  return true;
};

const isInViewport = (el: Element, rect?: DOMRect): boolean => {
  const r = rect || (el as HTMLElement).getBoundingClientRect();
  return r.bottom >= 0
    && r.right >= 0
    && r.top <= window.innerHeight
    && r.left <= window.innerWidth;
};

const isElementDisabled = (el: Element): boolean => {
  const htmlEl = el as HTMLElement & { disabled?: boolean };
  return htmlEl.hasAttribute('disabled') || htmlEl.getAttribute('aria-disabled') === 'true' || htmlEl.disabled === true;
};

export const isElementEditable = (el: Element): boolean => {
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) {
    const type = (el.type || 'text').toLowerCase();
    return !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image'].includes(type);
  }
  return (el as HTMLElement).isContentEditable;
};

/**
 * G11：读 aria-selected 三态状态，形状与 readStateProbe 的 checkedOf 一致。
 * 属性缺失时返回 undefined，避免把「未声明」当成 false。
 */
const ariaSelectedOf = (el: Element): boolean | undefined => {
  const aria = el.getAttribute('aria-selected');
  if (aria === 'true') return true;
  if (aria === 'false') return false;
  return undefined;
};

/**
 * G11：class 表达的状态（is-active / selected 之类）也要可读。
 * 用 getAttribute('class') 而非 el.className：SVG 元素的 className 是 SVGAnimatedString 对象，不是字符串。
 * 上限 120 与 aria_label / label 同属「身份元数据」一族（text 走 220 的内容族）；
 * 空 class 返回 undefined，不给每个候选都塞空串。
 */
const CLASS_NAME_MAX = 120;
const classNameOf = (el: Element): string | undefined => clipText(el.getAttribute('class') || '', CLASS_NAME_MAX) || undefined;

/**
 * 判断元素是否可点击
 * @param el 目标元素
 * @param style 可选，预先获取的 CSSStyleDeclaration，避免重复调用 getComputedStyle
 */
export const isElementClickable = (el: Element, style?: CSSStyleDeclaration): boolean => {
  const htmlEl = el as HTMLElement;
  const tag = el.tagName.toLowerCase();
  if (tag === 'a' && (el as HTMLAnchorElement).href) return true;
  if (tag === 'button') return true;
  if (tag === 'summary') return true;
  if (el instanceof HTMLInputElement) {
    return ['button', 'submit', 'reset', 'checkbox', 'radio'].includes((el.type || '').toLowerCase());
  }
  const role = (el.getAttribute('role') || '').toLowerCase();
  if (['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'option'].includes(role)) return true;
  if (htmlEl.hasAttribute('onclick')) return true;
  // 只在前面都没命中时才 fallback 到 getComputedStyle（最昂贵的检查）
  const s = style || window.getComputedStyle(htmlEl);
  return s.cursor === 'pointer';
};

const getElementText = (el: Element): string => {
  if (el.tagName.toLowerCase() === 'input' &&
    ['button', 'submit', 'reset'].includes((el.getAttribute('type') || '').toLowerCase())) {
    return clipText((el as HTMLInputElement).value || '', 220);
  }
  const htmlEl = el as HTMLElement;
  const innerText = 'innerText' in htmlEl ? (htmlEl.innerText || '') : '';
  return clipText(innerText || el.textContent || '', 220);
};

const getElementLabel = (el: Element): string => {
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return clipText(ariaLabel, 120);
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const labelText = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter(Boolean)
      .map((node) => clipText(node?.textContent || '', 80))
      .filter(Boolean)
      .join(' ');
    if (labelText) return labelText;
  }

  if ('labels' in el) {
    const labels = Array.from((el as HTMLInputElement).labels || [])
      .map((label) => clipText(label.textContent || '', 80))
      .filter(Boolean);
    if (labels.length > 0) return labels.join(' ');
  }

  const parentLabel = el.closest('label');
  if (parentLabel) return clipText(parentLabel.textContent || '', 120);
  return '';
};

const getSurroundingText = (el: Element): string => {
  const parent = el.parentElement;
  if (!parent) return '';
  return clipText(parent.textContent || '', 60);
};

const getScopeText = (scopeSelector?: string): string => {
  if (!scopeSelector) return normalizeText(document.body?.innerText || document.body?.textContent || '');
  const scopeRoot = document.querySelector(scopeSelector);
  if (!scopeRoot) return '';
  const htmlRoot = scopeRoot as HTMLElement;
  return normalizeText(htmlRoot.innerText || scopeRoot.textContent || '');
};

/**
 * 获取元素的缓存信息，首次调用时计算所有字段并存入缓存，后续直接返回
 * 将 getBoundingClientRect、getComputedStyle、getElementText 等昂贵调用合并为一次
 */
const getElementInfo = (el: Element, cache: Map<Element, CachedElementInfo>): CachedElementInfo => {
  const cached = cache.get(el);
  if (cached) return cached;

  const htmlEl = el as HTMLElement;
  const rect = htmlEl.getBoundingClientRect();
  const style = window.getComputedStyle(htmlEl);
  const visible = isElementVisible(el, rect, style);
  const inViewport = isInViewport(el, rect);
  const clickable = isElementClickable(el, style);
  const editable = isElementEditable(el);
  const disabled = isElementDisabled(el);
  const text = getElementText(el);
  const label = getElementLabel(el);
  const surroundingText = getSurroundingText(el);

  const info: CachedElementInfo = {
    rect, visible, inViewport, clickable, editable, disabled, text, label, surroundingText,
  };
  cache.set(el, info);
  return info;
};

/**
 * 句柄表是强引用：元素脱离文档后 Map 仍会吊住整棵 DOM 子树。
 * 只保留仍在文档里的句柄，已脱离的连同快照元数据一起丢掉。
 * 仍在文档里的句柄一律保留，跨快照编号稳定（H1）不受影响。
 */
export const pruneDetachedHandles = (): void => {
  for (const [id, el] of elementHandleMap) {
    if (el.isConnected) continue;
    elementHandleMap.delete(id);
    elementHandleSnapshotMap.delete(id);
  }
  // 仍在文档中的超大页面仍会吊住大量 DOM：超过上限时优先释放旧快照与无元数据
  // （标注路径）的强引用；句柄删除时同步删除元数据，避免元数据表无限增长。
  for (const [id] of elementHandleMap) {
    if (elementHandleMap.size <= MAX_TRACKED_HANDLES) break;
    const metadata = elementHandleSnapshotMap.get(id);
    if (!metadata || metadata.snapshotId !== latestSnapshotId) {
      elementHandleMap.delete(id);
      elementHandleSnapshotMap.delete(id);
    }
  }
};

const MAX_TRACKED_HANDLES = 4000;
let latestSnapshotId = '';

// ponytail: 固定 256 阈值换 O(1) 摊还；页面元素数极多时单次清理会变慢，届时改成按快照边界清理。
const PRUNE_EVERY = 256;
let handlesSincePrune = 0;

export const getOrCreateElementHandle = (el: Element): string => {
  const existing = elementToHandleMap.get(el);
  if (existing) {
    elementHandleMap.set(existing, el);
    return existing;
  }
  handleSeq += 1;
  const handleId = `${HANDLE_PREFIX}-${handleSeq.toString(36)}`;
  elementToHandleMap.set(el, handleId);
  elementHandleMap.set(handleId, el);
  if (++handlesSincePrune >= PRUNE_EVERY) {
    handlesSincePrune = 0;
    pruneDetachedHandles();
  }
  return handleId;
};

const buildSelectorCandidates = (el: Element): string[] => {
  const selectors: string[] = [];
  const tag = el.tagName.toLowerCase();

  if (el.id) selectors.push(`#${escapeCssValue(el.id)}`);

  const attrCandidates: Array<[string, string | null]> = [
    ['data-testid', el.getAttribute('data-testid')],
    ['data-test', el.getAttribute('data-test')],
    ['name', el.getAttribute('name')],
    ['aria-label', el.getAttribute('aria-label')],
    ['placeholder', el.getAttribute('placeholder')],
    ['role', el.getAttribute('role')],
    ['type', el.getAttribute('type')],
  ];
  for (const [name, value] of attrCandidates) {
    if (!value) continue;
    selectors.push(`${tag}[${name}="${escapeCssValue(value)}"]`);
  }

  const classes = Array.from(el.classList).filter((name) => /^[a-zA-Z][a-zA-Z0-9_-]{0,40}$/.test(name));
  if (classes.length > 0) {
    selectors.push(`${tag}.${classes.slice(0, 2).map((name) => escapeCssValue(name)).join('.')}`);
  }

  const parent = el.parentElement;
  if (parent) {
    const siblings = Array.from(parent.children).filter((node) => node.tagName === el.tagName);
    if (siblings.length > 1) {
      const index = siblings.indexOf(el) + 1;
      selectors.push(`${parent.tagName.toLowerCase()} > ${tag}:nth-of-type(${index})`);
    }
  }


  return Array.from(new Set(selectors)).slice(0, 2);
};

export const sanitizeElementValue = (
  type: unknown,
  raw: unknown,
  meta?: { name?: string | null; id?: string | null; autocomplete?: string | null },
): string | undefined => {
  const inputType = String(type || '').toLowerCase();
  if (inputType === 'password' || inputType === 'hidden') return undefined;
  if (isSensitiveRecordedField({
    inputType,
    autocomplete: meta?.autocomplete || undefined,
    selector: [meta?.name, meta?.id].filter(Boolean).join(' '),
  })) return undefined;
  return clipText(raw || '', 120);
};

/**
 * read 回传 html 前的脱敏，复用快照的 sanitizeElementValue 口径：
 * password/hidden 输入整体移出，其余敏感 value 属性剥掉，否则明文直接进模型上下文。
 */
export const sanitizeReadHtml = (target: Element): string => {
  let html = target.outerHTML || '';
  for (const el of [target, ...Array.from(target.querySelectorAll('input'))]) {
    const serialized = el.outerHTML || '';
    if (!serialized) continue;
    const type = el.getAttribute('type');
    const raw = el.getAttribute('value');
    if (!raw) continue;
    const normalizedType = String(type || '').toLowerCase();
    if (normalizedType === 'password' || normalizedType === 'hidden') {
      html = html.split(serialized).join('');
      continue;
    }
    const kept = sanitizeElementValue(type, raw, {
      name: el.getAttribute('name'),
      id: el.getAttribute('id'),
      autocomplete: el.getAttribute('autocomplete'),
    });
    if (kept !== undefined) continue;
    // 序列化后的属性值已转义引号，按整段 outerHTML 精确替换不会误伤相邻节点
    html = html.split(serialized).join(serialized.replace(/\svalue\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, ''));
  }
  return html;
};

/**
 * 构建元素描述符
 * @param cache 可选，元素信息缓存，传入时复用缓存数据避免重复 DOM 查询
 */
const buildElementDescriptor = (el: Element, score: number = 0, matchReasons?: string[], cache?: Map<Element, CachedElementInfo>, snapshotId?: string) => {
  const htmlEl = el as HTMLElement;
  const handleId = getOrCreateElementHandle(el);
  if (snapshotId) {
    latestSnapshotId = snapshotId;
    elementHandleSnapshotMap.set(handleId, { snapshotId, fingerprint: getElementFingerprint(el) });
  }
  const placeholder = el.getAttribute('placeholder') || undefined;
  const href = el instanceof HTMLAnchorElement ? el.href || undefined : undefined;
  const role = el.getAttribute('role') || undefined;
  const value = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
    ? sanitizeElementValue(el.getAttribute('type'), el.value, {
      name: el.getAttribute('name'),
      id: el.getAttribute('id'),
      autocomplete: el.getAttribute('autocomplete'),
    })
    : undefined;

  // 有缓存时复用缓存数据，避免重复调用昂贵 DOM API
  if (cache) {
    const info = getElementInfo(el, cache);
    return {
      element_id: handleId,
      tag: el.tagName.toLowerCase(),
      snapshot_id: snapshotId,
      role,
      type: el.getAttribute('type') || undefined,
      text: info.text || undefined,
      label: info.label || undefined,
      placeholder,
      aria_label: el.getAttribute('aria-label') || undefined,
      aria_selected: ariaSelectedOf(el),
      name: el.getAttribute('name') || undefined,
      class_name: classNameOf(el),
      href,
      value,
      clickable: info.clickable,
      editable: info.editable,
      disabled: info.disabled,
      visible: info.visible,
      in_viewport: info.inViewport,
      selector_candidates: buildSelectorCandidates(el),
      surrounding_text: info.surroundingText || undefined,
      rect: {
        x: Math.round(info.rect.x),
        y: Math.round(info.rect.y),
        width: Math.round(info.rect.width),
        height: Math.round(info.rect.height),
      },
      score,
      match_reasons: matchReasons && matchReasons.length > 0 ? matchReasons : undefined,
    };
  }

  // 无缓存时走原始路径（向后兼容 buildActionInfo 等外部调用）
  const rect = htmlEl.getBoundingClientRect();
  const label = getElementLabel(el);
  const text = getElementText(el);

  return {
    element_id: handleId,
    tag: el.tagName.toLowerCase(),
    snapshot_id: snapshotId,
    role,
    type: el.getAttribute('type') || undefined,
    text: text || undefined,
    label: label || undefined,
    placeholder,
    aria_label: el.getAttribute('aria-label') || undefined,
    aria_selected: ariaSelectedOf(el),
    class_name: classNameOf(el),
    name: el.getAttribute('name') || undefined,
    href,
    value,
    clickable: isElementClickable(el),
    editable: isElementEditable(el),
    disabled: isElementDisabled(el),
    visible: isElementVisible(el),
    in_viewport: isInViewport(el),
    selector_candidates: buildSelectorCandidates(el),
    surrounding_text: getSurroundingText(el) || undefined,
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    score,
    match_reasons: matchReasons && matchReasons.length > 0 ? matchReasons : undefined,
  };
};

const getScopeRoot = (scopeSelector?: string): Element | null => {
  if (!scopeSelector) return document.body;
  return document.querySelector(scopeSelector);
};

const tokenizeQuery = (query: string): string[] => {
  if (typeof Intl.Segmenter === 'function') {
    return Array.from(new Intl.Segmenter(undefined, { granularity: 'word' }).segment(query))
      .filter((part) => part.isWordLike)
      .map((part) => part.segment);
  }
  // Older browsers still need short Chinese labels to match compound queries.
  return Array.from(new Set([
    ...query.split(/\s+/).filter(Boolean),
    ...Array.from(query.matchAll(/(?=([\p{Script=Han}]{2}))/gu), (match) => match[1]),
  ]));
};

/**
 * 对元素进行 query 匹配评分
 * @param cache 可选，元素信息缓存，传入时复用缓存的 text/label 等数据
 */
const scoreElementAgainstQuery = (el: Element, query: string, tokens: string[], cache?: Map<Element, CachedElementInfo>): { score: number; reasons: string[] } => {
  const normalizedQuery = normalizeText(query).toLowerCase();
  if (!normalizedQuery) return { score: 0, reasons: [] };

  // 有缓存时使用缓存数据，否则实时计算
  const info = cache ? getElementInfo(el, cache) : null;

  const fields: Array<[string, string]> = [
    ['text', info ? info.text : getElementText(el)],
    ['label', info ? info.label : getElementLabel(el)],
    ['placeholder', el.getAttribute('placeholder') || ''],
    ['aria_label', el.getAttribute('aria-label') || ''],
    ['name', el.getAttribute('name') || ''],
    ['href', el instanceof HTMLAnchorElement ? el.href || '' : ''],
    ['surrounding_text', info ? info.surroundingText : getSurroundingText(el)],
  ];

  let score = 0;
  const reasons: string[] = [];

  // 先检查 text 和 label 两个主要字段
  for (let i = 0; i < fields.length; i++) {
    const [fieldName, rawFieldValue] = fields[i];
    const fieldValue = normalizeText(rawFieldValue).toLowerCase();
    if (!fieldValue) continue;
    if (fieldValue === normalizedQuery) {
      score += 12;
      reasons.push(`${fieldName}:exact`);
    } else if (fieldValue.includes(normalizedQuery)) {
      score += 8;
      reasons.push(`${fieldName}:contains`);
    }

    for (const token of tokens) {
      if (token.length < 2) continue;
      if (fieldValue.includes(token)) {
        score += fieldName === 'text' || fieldName === 'label' ? 3 : 2;
        reasons.push(`${fieldName}:token:${token}`);
      }
    }
  }

  // Visibility and interactivity rank matches; they are not query matches themselves.
  if (reasons.length === 0) return { score: 0, reasons: [] };

  const clickable = info ? info.clickable : isElementClickable(el);
  const editable = info ? info.editable : isElementEditable(el);
  const visible = info ? info.visible : isElementVisible(el);
  const inViewport = info ? info.inViewport : isInViewport(el);

  if (clickable) score += 3;
  if (editable) score += 3;
  if (visible) score += 2;
  if (inViewport) score += 2;
  return { score, reasons: Array.from(new Set(reasons)).slice(0, 4) };
};

/**
 * G15：弱候选判定。带 onclick / tabindex 的非原生标签可能是独立操作（卡片上的「×」），
 * 即使嵌在别的可点区域里也必须保留。
 */
const isWeakCandidate = (el: Element): boolean => el.hasAttribute('onclick') || el.hasAttribute('tabindex');

/** G15：label 关联的控件；有 for 按 id 找，否则退回包裹式关联（label.control）。 */
const labelControlOf = (el: Element): Element | null => {
  if (el.tagName.toLowerCase() !== 'label') return null;
  const htmlFor = el.getAttribute('for');
  if (htmlFor) return document.getElementById(htmlFor);
  return (el as HTMLLabelElement).control ?? null;
};

/** G15：沿祖先链（含 shadow 边界）判断元素是否落在另一个「真正可点」的候选内部。 */
const nestedInClickableCandidate = (el: Element, kept: Set<Element>, cache: Map<Element, CachedElementInfo>): boolean => {
  let node: Node | null = el.parentNode;
  while (node) {
    if ('tagName' in node) {
      // role=group 这类容器也在候选里，但它们不代表同一个可点区域
      if (kept.has(node as Element) && getElementInfo(node as Element, cache).clickable) return true;
      node = node.parentNode;
    } else {
      node = (node as ShadowRoot).host ?? null;
    }
  }
  return false;
};

/**
 * G15：同一可点区域只算一个候选。
 * label[for] 与其关联控件折叠为一个（保留控件，标签文本经 .labels 仍读得到）；
 * 纯装饰的嵌套后代（按钮里的 <i class="fa">）不再单独占候选。
 * 弱候选（onclick / tabindex）一律保留。
 */
const dedupeNestedCandidates = <T extends { el: Element }>(items: T[], cache: Map<Element, CachedElementInfo>): T[] => {
  const candidates = new Set(items.map((item) => item.el));
  const folded = items.filter((item) => {
    const control = labelControlOf(item.el);
    return !(control && candidates.has(control));
  });
  const kept = new Set(folded.map((item) => item.el));
  return folded.filter((item) => isWeakCandidate(item.el) || !nestedInClickableCandidate(item.el, kept, cache));
};

const collectSnapshotElements = (params: PageSnapshotParams) => {
  const snapshotId = normalizeText(params.snapshot_id) || createSnapshotId();
  const query = normalizeText(params.query || '');
  const tokens = tokenizeQuery(query.toLowerCase());
  const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 60);
  const includeHidden = params.include_hidden === true;
  const onlyViewport = params.only_viewport === true;
  const selector = params.include_non_interactive || query ? '*' : INTERACTIVE_SELECTOR;
  const scopeRoot = getScopeRoot(params.scope_selector);

  if (!scopeRoot) {
    return { success: false, error: `未找到 scope_selector: ${params.scope_selector}` };
  }

  // 创建本次快照的元素信息缓存，函数返回后自动回收
  const cache = new Map<Element, CachedElementInfo>();

  let nodes = collectDeepElements(scopeRoot, selector);

  // 优化 1：提前剪枝——过滤掉无意义标签和 SVG 内部元素
  if (selector === '*') {
    nodes = nodes.filter((el) => {
      const tag = el.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) return false;
      // SVG 内部的 path/rect/circle 等不是用户可交互元素，只保留 svg 根元素
      if (tag !== 'svg' && el.closest('svg')) return false;
      return true;
    });
  }

  // 优化 2：节点数上限保护
  if (nodes.length > MAX_NODES) {
    nodes.length = MAX_NODES;
  }

  const scored = nodes
    .filter((el) => {
      // 优化 3：使用缓存的 visible 和 inViewport 判断
      const info = getElementInfo(el, cache);
      if (!includeHidden && !info.visible) return false;
      if (onlyViewport && !info.inViewport) return false;
      return true;
    })
    .map((el) => {
      const match = scoreElementAgainstQuery(el, query, tokens, cache);
      let baseScore = match.score;
      if (!query) {
        // 使用缓存数据避免重复 DOM 查询
        const info = getElementInfo(el, cache);
        if (info.clickable) baseScore += 6;
        if (info.editable) baseScore += 6;
        if (info.inViewport) baseScore += 4;
        if (info.visible) baseScore += 3;
      }
      return {
        el,
        score: baseScore,
        reasons: match.reasons,
      };
    })
    .filter((item) => !query || item.score > 0)
    .sort((left, right) => right.score - left.score);

  // G15：折叠后再取前 limit 个，避免被折叠掉的候选白占名额
  const items = dedupeNestedCandidates(scored, cache)
    .slice(0, limit)
    .map((item) => buildElementDescriptor(item.el, item.score, item.reasons, cache, snapshotId));
  return {
    success: true,
    data: {
      snapshot_id: snapshotId,
      url: window.location.href,
      title: document.title,
      matched_query: query || undefined,
      scope_selector: params.scope_selector || undefined,
      total_candidates: items.length,
      elements: items,
      message: query
        ? `已找到 ${items.length} 个与"${clipText(query, 24)}"相关的候选元素`
        : `已生成页面语义快照（${items.length} 个候选元素）`,
    },
  };
};

/**
 * 计算元素的隐式/显式语义角色。
 * find 的 role 语义必须与快照暴露的 role 一致，否则 agent 从快照学到的角色无法用于 find。
 */
export const computeAccessibleRole = (el: Element): string => {
  const explicit = normalizeText(el.getAttribute('role') || '').toLowerCase().split(/\s+/)[0];
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input') {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'file') return 'file';
    if (type === 'search') return 'searchbox';
    if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button';
    if (['range', 'number'].includes(type)) return 'spinbutton';
    return 'textbox';
  }
  if (tag === 'textarea') return 'textbox';
  if (tag === 'select') return (el as HTMLSelectElement).multiple ? 'listbox' : 'combobox';
  if (tag === 'a' || tag === 'area') return el.hasAttribute('href') ? 'link' : '';
  if (tag === 'button' || tag === 'summary') return 'button';
  if (/^h[1-6]$/.test(tag)) return 'heading';
  if (tag === 'option') return 'option';
  if (tag === 'li') return 'listitem';
  if (tag === 'img') return 'img';
  if (tag === 'table') return 'table';
  if (tag === 'dialog') return 'dialog';
  if (tag === 'nav') return 'navigation';
  if (tag === 'main') return 'main';
  if (tag === 'form') return 'form';
  if (tag === 'section') return 'region';
  return '';
};

/**
 * 计算可访问名。与 bridge 的 pageAction 保持同一套规则：
 * 不含 placeholder 与可编辑元素的文本，避免把用户输入/页面回填写进定位描述符。
 */
export const computeAccessibleName = (el: Element): string => {
  const labelled = getElementLabel(el);
  if (labelled) return labelled;
  for (const attribute of ['alt', 'title']) {
    const text = el.getAttribute(attribute);
    if (text) return clipText(text, 120);
  }
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' && ['submit', 'button', 'reset', 'image'].includes((el.getAttribute('type') || '').toLowerCase())) {
    const value = el.getAttribute('value');
    if (value) return clipText(value, 120);
  }
  const name = el.getAttribute('name');
  if (name) return clipText(name, 120);
  const editable = tag === 'input' || tag === 'textarea' || tag === 'select'
    || (el as HTMLElement).isContentEditable === true;
  return editable ? '' : getElementText(el);
};

/** find 命中候选的可读描述，用于歧义/越界时并列展示而不猜测。 */
export interface FindCandidate {
  role?: string;
  name?: string;
  tag: string;
  element_id?: string;
  selector_candidates: string[];
}

const describeFindCandidate = (el: Element): FindCandidate => ({
  role: computeAccessibleRole(el) || undefined,
  name: clipText(computeAccessibleName(el), 80) || undefined,
  tag: el.tagName.toLowerCase(),
  element_id: elementToHandleMap.get(el),
  selector_candidates: buildSelectorCandidates(el),
});

export interface FindResolution {
  target: Element | null;
  error?: string;
  candidates?: FindCandidate[];
  available_roles?: string[];
}

/**
 * 按 role+name 定位元素，不依赖快照。
 * 精确名称匹配优先于包含匹配；多命中拒绝猜测，返回候选与可用角色。
 */
export const resolveFindTarget = (find: FindTarget | undefined, root: ParentNode = document): FindResolution => {
  const role = normalizeText(find?.role || '').toLowerCase();
  const name = normalizeText(find?.name || '');
  const nth = find?.nth;
  if (!role && !name) return { target: null, error: 'find 需要至少提供 role 或 name' };
  if (nth !== undefined && (!Number.isSafeInteger(nth) || Number(nth) < 0)) {
    return { target: null, error: 'find.nth 必须是非负整数（0-based）' };
  }

  const rolesPresent = new Set<string>();
  const matched: Element[] = [];
  const exact: Element[] = [];
  for (const el of collectDeepElements(root, '*')) {
    const elRole = computeAccessibleRole(el);
    if (elRole) rolesPresent.add(elRole);
    if (role && elRole !== role) continue;
    const elName = normalizeText(computeAccessibleName(el));
    if (name) {
      if (!elName) continue;
      const lowered = elName.toLowerCase();
      const wanted = name.toLowerCase();
      if (lowered === wanted) {
        exact.push(el);
        matched.push(el);
        continue;
      }
      if (!lowered.includes(wanted)) continue;
    }
    matched.push(el);
  }

  const pool = exact.length > 0 ? exact : matched;
  const availableRoles = Array.from(rolesPresent).sort();
  if (pool.length === 0) {
    return {
      target: null,
      error: `find 未匹配到元素（role="${role}" name="${name}"）；请改用 page(action="snapshot") 或提供 selector`,
      available_roles: availableRoles,
    };
  }
  if (nth !== undefined) {
    if (nth >= pool.length) {
      return {
        target: null,
        error: `find.nth=${nth} 超出匹配数量 ${pool.length}；nth 为 0-based`,
        candidates: pool.map(describeFindCandidate),
        available_roles: availableRoles,
      };
    }
    return { target: promoteSvgActionTarget(pool[nth]) };
  }
  if (pool.length === 1) return { target: promoteSvgActionTarget(pool[0]) };
  return {
    target: null,
    error: `find 命中 ${pool.length} 个元素，未指定 nth，拒绝猜测；请用 nth（0-based）选择或改用 selector`,
    candidates: pool.map(describeFindCandidate),
    available_roles: availableRoles,
  };
};

/**
 * ref 句柄的唯一解析实现：快照 id、指纹、连接性全部对着私有句柄表校验。
 * 页面可控属性（例如伪造的 data-actspan-handle）不参与解析，因此无法把 ref 重定向到别的元素。
 */
export const resolveElementHandle = (elementId: string, snapshotId?: string): FindResolution => {
  const id = normalizeText(elementId || '');
  if (!id) return { target: null, error: '缺少 element_id' };
  const snapshotError = validateElementHandle(id, snapshotId);
  if (snapshotError) return { target: null, error: snapshotError };
  const found = elementHandleMap.get(id);
  if (found?.isConnected) {
    const recorded = elementHandleSnapshotMap.get(id);
    if (recorded && recorded.fingerprint !== getElementFingerprint(found)) {
      return { target: null, error: 'ref 指向的元素内容已改变（指纹不一致），该编号已失效；请重新调用 page(action="snapshot") 或改用 find 重新定位元素' };
    }
    return { target: promoteSvgActionTarget(found) };
  }
  if (found && !found.isConnected) {
    elementHandleMap.delete(id);
    elementHandleSnapshotMap.delete(id);
  }
  return { target: null, error: 'ref 对应的元素已不在文档中；请重新调用 page(action="snapshot") 或改用 find 重新定位元素' };
};

export const resolveActionTarget = (params: ElementHandleActionParams): FindResolution => {
  const elementId = normalizeText(params.element_id || '');
  const selector = normalizeText(params.selector || '');
  const hasFind = !!params.find && typeof params.find === 'object' && !Array.isArray(params.find);
  const provided = [elementId && 'ref', selector && 'selector', hasFind && 'find'].filter(Boolean) as string[];
  if (provided.length > 1) {
    return { target: null, error: `ref、selector、find 只能三选一，当前同时提供了：${provided.join('、')}` };
  }
  if (elementId) return resolveElementHandle(elementId, params.snapshot_id);
  if (selector) {
    const found = document.querySelector(selector);
    return { target: found ? promoteSvgActionTarget(found) : null };
  }
  if (hasFind) return resolveFindTarget(params.find);
  return { target: null };
};

const setNativeInputValue = (input: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
  const prototype = Object.getPrototypeOf(input);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  if (descriptor?.set) {
    descriptor.set.call(input, value);
  } else {
    input.value = value;
  }
};

const ACTION_BEARING_ANCESTOR_SELECTOR = 'button,a,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[onclick]';
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** 将 SVG 内部节点提升到真正承载点击行为的复合控件祖先。 */
export const promoteSvgActionTarget = (target: Element): Element => {
  const tag = target.tagName.toLowerCase();
  if (target.namespaceURI !== SVG_NAMESPACE && tag !== 'svg') return target;
  const ancestor = typeof target.closest === 'function'
    ? target.closest(ACTION_BEARING_ANCESTOR_SELECTOR)
    : null;
  return ancestor || target;
};

/** 同步触发点击，再计算并返回成功回执所需的数据。 */
export const clickAndReport = <T>(target: Element, report: () => T): T => {
  if (isElementDisabled(target)) throw new Error('目标元素处于禁用状态，无法点击');
  (target as HTMLElement).click();
  return report();
};


const buildActionInfo = (target: Element, elementId?: string) => ({
  ...buildElementDescriptor(target, 0, undefined, undefined, elementId),
  message: `已获取元素信息：${target.tagName.toLowerCase()}`,
});

export interface ElementObservableState {
  visible: boolean;
  text: string;
  value?: string;
  ariaExpanded?: string;
  disabled: boolean;
  className: string;
}

export interface EffectEvidence {
  action: string;
  status: 'changed' | 'requested' | 'unchanged' | 'validation_error';
  changed: boolean;
  target: { element_id?: string; tag: string; role?: string; text?: string };
  changed_fields: string[];
  observed: { visible: boolean; text?: string; value?: string; nearby_text?: string; validation_error?: string };
  diagnostic: string;
}

const readTargetVisible = (target: Element): boolean => {
  if (target.hasAttribute('hidden') || target.getAttribute('aria-hidden') === 'true') return false;
  const htmlTarget = target as HTMLElement;
  const style = typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
    ? window.getComputedStyle(htmlTarget)
    : undefined;
  if (style && (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)) return false;
  const rect = typeof htmlTarget.getBoundingClientRect === 'function' ? htmlTarget.getBoundingClientRect() : undefined;
  return !rect || (rect.width > 0 && rect.height > 0);
};

export const captureObservableState = (target: Element): ElementObservableState => {
  const type = (target.getAttribute('type') || '').toLowerCase();
  const rawValue = 'value' in target ? String((target as HTMLInputElement).value || '') : undefined;
  return {
    visible: readTargetVisible(target),
    text: getElementText(target),
    // 密码框只暴露「有没有内容」：与 bridge 的 pageAction 同源，否则填写成功也被判 unchanged 而触发无谓的真实事件重放。
    value: type === 'password' ? (rawValue ? '[set]' : '') : rawValue,
    ariaExpanded: target.getAttribute('aria-expanded') || undefined,
    disabled: isElementDisabled(target),
    className: typeof (target as HTMLElement).className === 'string' ? (target as HTMLElement).className : '',
  };
};

export const buildEffectEvidence = (
  action: string,
  target: Element,
  before: ElementObservableState,
  elementId?: string,
): EffectEvidence => {
  const after = captureObservableState(target);
  const changedFields = (['visible', 'text', 'value', 'ariaExpanded', 'disabled', 'className'] as const)
    .filter((field) => before[field] !== after[field]);
  const invalid = typeof target.matches === 'function' && target.matches(':invalid');
  const formInvalid = !invalid && typeof target.closest === 'function'
    ? target.closest('form')?.querySelector(':invalid')
    : null;
  const validationError = invalid || formInvalid ? '页面表单校验未通过' : undefined;
  const status = validationError
    ? 'validation_error'
    : changedFields.length > 0
      ? 'changed'
      : action === 'click'
        ? 'requested'
        : 'unchanged';
  const type = (target.getAttribute('type') || '').toLowerCase();
  const observedValue = type === 'password' ? undefined : after.value;
  const nearbyText = typeof target.parentElement?.textContent === 'string'
    ? clipText(target.parentElement.textContent, 160)
    : undefined;
  const diagnostic = validationError
    ? `${action} 已执行，但目标附近报告表单校验错误；请修正字段后重试`
    : changedFields.length > 0
      ? `${action} 已执行，目标 ${target.tagName.toLowerCase()} 发生可观察变化：${changedFields.join(', ')}`
      : `${action} 已请求目标 ${target.tagName.toLowerCase()}；目标附近未观察到同步 DOM 变化，不能据此判定页面无响应`;
  return {
    action,
    status,
    changed: changedFields.length > 0,
    target: {
      element_id: elementId,
      tag: target.tagName.toLowerCase(),
      role: target.getAttribute('role') || undefined,
      text: clipText(getElementText(target), 120) || undefined,
    },
    changed_fields: changedFields,
    observed: {
      visible: after.visible,
      text: after.text || undefined,
      value: observedValue,
      nearby_text: nearbyText,
      validation_error: validationError,
    },
    diagnostic,
  };
};

const runPageAssertions = (params: PageAssertParams) => {
  const mode = params.mode === 'any' ? 'any' : 'all';
  const assertions = Array.isArray(params.assertions) ? params.assertions : [];
  const scopeText = getScopeText(params.scope_selector).toLowerCase();
  const results = assertions.map((assertion, index) => {
    const type = assertion?.type;
    const expectedValue = normalizeText(assertion?.value || '');
    const selector = normalizeText(assertion?.selector || '');
    let passed = false;
    let detail = '';

    switch (type) {
      case 'url_includes': {
        passed = window.location.href.toLowerCase().includes(expectedValue.toLowerCase());
        detail = `URL ${passed ? '包含' : '未包含'} ${expectedValue}`;
        break;
      }
      case 'title_includes': {
        passed = document.title.toLowerCase().includes(expectedValue.toLowerCase());
        detail = `标题 ${passed ? '包含' : '未包含'} ${expectedValue}`;
        break;
      }
      case 'text_includes': {
        passed = scopeText.includes(expectedValue.toLowerCase());
        detail = `${params.scope_selector ? `范围 ${params.scope_selector}` : '页面文本'} ${passed ? '包含' : '未包含'} ${expectedValue}`;
        break;
      }
      case 'selector_exists': {
        const el = selector ? document.querySelector(selector) : null;
        passed = Boolean(el);
        detail = `${selector || '(empty selector)'} ${passed ? '存在' : '不存在'}`;
        break;
      }
      case 'selector_visible': {
        const el = selector ? document.querySelector(selector) : null;
        passed = Boolean(el && isElementVisible(el));
        detail = `${selector || '(empty selector)'} ${passed ? '可见' : '不可见或不存在'}`;
        break;
      }
      case 'selector_text_includes': {
        const el = selector ? document.querySelector(selector) : null;
        const text = normalizeText((el as HTMLElement | null)?.innerText || el?.textContent || '');
        passed = Boolean(el) && text.toLowerCase().includes(expectedValue.toLowerCase());
        detail = `${selector || '(empty selector)'} 的文本${passed ? '包含' : '未包含'} ${expectedValue}`;
        break;
      }
      default: {
        detail = `不支持的断言类型: ${String(type || '')}`;
        passed = false;
      }
    }

    return {
      index,
      type,
      selector: selector || undefined,
      value: expectedValue || undefined,
      passed,
      detail,
    };
  });

  const passed = mode === 'any'
    ? results.some((item) => item.passed)
    : results.every((item) => item.passed);

  return {
    success: true,
    data: {
      passed,
      mode,
      url: window.location.href,
      title: document.title,
      total: results.length,
      passed_count: results.filter((item) => item.passed).length,
      results,
      message: passed
        ? `页面断言通过（${results.filter((item) => item.passed).length}/${results.length}）`
        : `页面断言未通过（${results.filter((item) => item.passed).length}/${results.length}）`,
    },
  };
};

/**
 * 从真实目标元素判定敏感动作分类。
 * 规则与 bridge 的 pageAction 保持一致：支付/删除/普通三分，金额带进签名。
 * 存在的意义是让 find/ref 目标也能在**真实元素**上被策略检查，而不是靠猜出来的选择器。
 */
export interface SensitiveTargetClassification {
  kind: 'payment' | 'deletion' | 'ordinary';
  amount: string;
  label: string;
  signature: string;
}

export const classifySensitiveTarget = (target: Element, submit = false): SensitiveTargetClassification => {
  const htmlTarget = target as HTMLElement;
  const form = (target as HTMLInputElement).form;
  // 与执行路径同源：提交语义检查表单提交按钮（fill+submit 会 requestSubmit），
  // 普通点击检查目标自身或它最近的按钮祖先（click 只点目标本身）。
  const button = submit
    ? (form?.querySelector('button[type="submit"], input[type="submit"], button:not([type])') as HTMLElement | null) || htmlTarget
    : (typeof target.closest === 'function'
      ? target.closest('button, a, [role="button"], input[type="submit"]') as HTMLElement | null
      : null) || htmlTarget;
  const label = (button.innerText || button.getAttribute?.('aria-label') || button.getAttribute?.('value') || button.textContent || '')
    .trim().slice(0, 120);
  const surrounding = (form?.innerText || button.parentElement?.innerText || '').slice(0, 500);
  const amount = (surrounding.match(/(?:[$€£¥]\s*\d[\d,.]*|\d[\d,.]*\s*(?:元|円|美元|欧元|USD|CNY|EUR|GBP))/i) || [])[0] || '';
  const kind = /(?:支付|付款|购买|结算|下单|充值|订阅|捐赠|pay\b|checkout\b|purchase\b|place order\b|subscribe\b|donate\b)/i.test(label)
    ? 'payment' as const
    : /(?:删除|清空|移除|delete\b|remove\b|erase\b)/i.test(label) ? 'deletion' as const
      : amount && /(?:确认|确定|继续|提交|完成|confirm\b|continue\b|proceed\b|submit\b|complete\b)/i.test(label) ? 'payment' as const
        : 'ordinary' as const;
  return { kind, amount, label, signature: JSON.stringify([kind, label, amount]) };
};

/**
 * 条件探针：在页面内把 DOM 状态折算成布尔观测。
 * 原始 value 与页面文本绝不回传，桥接层只拿到 exists/matched。
 */
const readStateProbe = (target: Element | null, attr: string, expect?: string) => {
  const normalized = (value: string) => value.replace(/\s+/g, ' ').trim();
  const textOf = (el: Element) => normalized((el as HTMLElement).innerText || el.textContent || '');
  const checkedOf = (el: Element): boolean | undefined => {
    const aria = el.getAttribute('aria-checked');
    if (aria === 'true') return true;
    if (aria === 'false') return false;
    const checked = (el as HTMLInputElement).checked;
    return typeof checked === 'boolean' ? checked : undefined;
  };
  const valueOf = (el: Element): string | undefined => {
    const value = (el as HTMLInputElement).value;
    if (typeof value === 'string') return value;
    const attribute = el.getAttribute('value');
    return attribute === null ? undefined : attribute;
  };
  if (attr === 'exists') return { exists: Boolean(target) };
  const text = target ? textOf(target) : normalized(document.body?.innerText || '');
  if (attr === 'checked') {
    const checked = target ? checkedOf(target) : undefined;
    return { exists: Boolean(target), matched: checked !== undefined && checked === (expect === 'true') };
  }
  if (attr === 'value') {
    const value = target ? valueOf(target) : undefined;
    return { exists: Boolean(target), matched: value !== undefined && value === (expect ?? '') };
  }
  if (attr === 'text') return { exists: true, matched: text === normalized(expect ?? '') };
  if (attr === 'textContains') return { exists: true, matched: text.includes(normalized(expect ?? '')) };
  return { exists: Boolean(target) };
};


/**
 * 与 bridge 的 pageAction 同源的稳定定位描述符：只回传 role+name(+nth)。
 * act 草稿靠它把 ref 步骤改写成 find 重放，因此绝不回传 ref 或页面可控属性。
 */
const describeStableFind = (el: Element): FindTarget | undefined => {
  const role = computeAccessibleRole(el);
  const name = computeAccessibleName(el);
  if (!name || name.length > 120) return undefined;
  const peers = collectDeepElements(document, '*')
    .filter((node) => computeAccessibleRole(node) === role && computeAccessibleName(node) === name);
  const index = peers.indexOf(el);
  return { role: role || undefined, name, ...(peers.length > 1 && index >= 0 ? { nth: index } : {}) };
};
const initElementHandleAction = () => {
  Channel.on('__page_grounding_action', (data: ElementHandleActionParams, _sender, sendResponse) => {
    try {
      const action = data?.action;
      if (!action) {
        sendResponse?.({ success: false, error: '缺少 action' });
        return true;
      }

      // 分类只回传 payment/deletion/ordinary 与签名，不读取文本或值。
      if (action === 'classify') {
        let target: Element | null = null;
        if (data.text) {
          const wanted = normalizeText(data.text);
          const candidates = collectDeepElements(document, 'button, a, [role="button"], input[type="submit"], input[type="button"], label');
          target = candidates.find((element) => {
            const text = normalizeText((element as HTMLElement).innerText || element.textContent || '');
            return data.match_mode === 'exact' ? text === wanted : text.includes(wanted);
          }) || null;
        } else {
          const resolved = resolveActionTarget(data);
          if (resolved.error) {
            sendResponse?.({ success: false, error: resolved.error });
            return true;
          }
          target = resolved.target;
        }
        if (!target) {
          sendResponse?.({ success: false, error: '未找到目标元素' });
          return true;
        }
        sendResponse?.({ success: true, data: classifySensitiveTarget(target, data.submit === true) });
        return true;
      }

      const resolved = resolveActionTarget(data);
      if (resolved.error) {
        sendResponse?.({
          success: false,
          error: resolved.error,
          ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
          ...(resolved.available_roles ? { available_roles: resolved.available_roles } : {}),
        });
        return true;
      }
      const target = resolved.target;
      // 条件探针：selector 未命中是合法观测（exists:false）而不是错误；ref/find 未命中仍走上面的 error 分支。
      if (action === 'read' && data.attr) {
        sendResponse?.({ success: true, data: readStateProbe(target, data.attr, data.expect) });
        return true;
      }
      if (!target) {
        sendResponse?.({ success: false, error: '未找到目标元素，请重新调用 page(action="snapshot") 或改用 find 定位' });
        return true;
      }

      // 定向读取是纯读动作：绝不为它滚动页面或绘制虚拟光标，否则读一次就改变页面状态。
      if (action === 'read') {
        const limit = Math.max(1, Number(data.max_chars) || 20000);
        sendResponse?.({
          success: true,
          data: {
            // innerText 不含输入框的 value，只有 html 需要脱敏；先脱敏再截断，否则截断会切进 value 属性留下明文
            text: ((target as HTMLElement).innerText || target.textContent || '').slice(0, limit),
            html: sanitizeReadHtml(target).slice(0, limit),
            tag: target.tagName,
            find: describeStableFind(target),
          },
        });
        return true;
      }

      // A2：升级前后各观测一次目标的可观察状态。纯读动作，绝不滚动页面或绘制虚拟光标。
      if (action === 'observe') {
        sendResponse?.({
          success: true,
          data: {
            state: captureObservableState(target),
            center: getElementCenter(target) || undefined,
            kind: classifySensitiveTarget(target, data.submit === true).kind,
            tag: target.tagName.toLowerCase(),
            find: describeStableFind(target),
          },
        });
        return true;
      }

      const htmlTarget = target as HTMLElement;
      if (typeof htmlTarget.scrollIntoView === 'function') {
        htmlTarget.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
      }

      // Move the visible cursor synchronously before hit-testing for obstructions.
      const cursorPoint = getElementCenter(target);
      if (cursorPoint) {
        withVirtualCursorBeforeObstruction(cursorPoint, () => detectObstruction(target, cursorPoint));
      }

      // 自由化模式：审批与签名重检已移除。

      switch (action) {
        case 'inspect': {
          const classification = classifySensitiveTarget(target, data.submit === true);
          sendResponse?.({
            success: true,
            data: {
              ...classification,
              center: getElementCenter(target) || undefined,
              element_id: elementToHandleMap.get(target),
              tag: target.tagName.toLowerCase(),
              role: computeAccessibleRole(target) || undefined,
              name: clipText(computeAccessibleName(target), 120) || undefined,
            },
          });
          return true;
        }

        case 'get_info': {
          sendResponse?.({ success: true, data: buildActionInfo(target) });
          return true;
        }

        case 'focus': {
          htmlTarget.focus?.();
          sendResponse?.({ success: true, data: { ...buildActionInfo(target), message: '已聚焦目标元素' } });
          return true;
        }

        case 'hover': {
          htmlTarget.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
          htmlTarget.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          sendResponse?.({ success: true, data: { ...buildActionInfo(target), message: '已悬停目标元素' } });
          return true;
        }

        case 'scroll_into_view': {
          sendResponse?.({ success: true, data: { ...buildActionInfo(target), message: '已滚动到目标元素附近' } });
          return true;
        }

        case 'click': {
          const stableFind = describeStableFind(target);
          const before = captureObservableState(target);
          clickAndReport(target, () => undefined);
          const effect = buildEffectEvidence('click', target, before, data.element_id);
          sendResponse?.({ success: true, data: { effect, changed: effect.changed, ...buildActionInfo(target, data.snapshot_id), find: stableFind, kind: classifySensitiveTarget(target, false).kind, center: getElementCenter(target) || undefined, message: '已触发目标元素点击' } });
          return true;
        }

        case 'fill': {
          const value = String(data?.value ?? '');
          const reportedValue = (target.getAttribute('type') || '').toLowerCase() === 'password'
            ? '[已填写密码，值已隐藏]'
            : value;
          const stableFind = describeStableFind(target);
          const before = captureObservableState(target);
          if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
            htmlTarget.focus?.();
            setNativeInputValue(target, value);
            target.dispatchEvent(new Event('input', { bubbles: true }));
            target.dispatchEvent(new Event('change', { bubbles: true }));
            if (data.submit === true) {
              target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
              const form = (target as HTMLInputElement).form;
              if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
            }
            const effect = buildEffectEvidence('fill', target, before, data.element_id);
            sendResponse?.({ success: true, data: { effect, changed: effect.changed, ...buildActionInfo(target, data.snapshot_id), find: stableFind, value: reportedValue, kind: classifySensitiveTarget(target, data.submit === true).kind, center: getElementCenter(target) || undefined, message: '已填写目标元素' } });
            return true;
          }
          if (htmlTarget.isContentEditable) {
            htmlTarget.focus?.();
            htmlTarget.textContent = value;
            htmlTarget.dispatchEvent(new Event('input', { bubbles: true }));
            const effect = buildEffectEvidence('fill', target, before, data.element_id);
            sendResponse?.({ success: true, data: { effect, changed: effect.changed, ...buildActionInfo(target, data.snapshot_id), find: stableFind, value: reportedValue, kind: classifySensitiveTarget(target, data.submit === true).kind, center: getElementCenter(target) || undefined, message: '已填写可编辑区域' } });
            return true;
          }
          sendResponse?.({ success: false, error: 'fill 已尝试观察目标，但元素不支持输入；请改用 click/focus/get_info' });
          return true;
        }

        case 'select': {
          const value = String(data?.value ?? '');
          if (!(target instanceof HTMLSelectElement)) {
            sendResponse?.({ success: false, error: 'select 已尝试目标，但观察到元素不是 select；请改用 page(action="snapshot") 或 get_info' });
            return true;
          }
          const before = captureObservableState(target);
          const options = Array.from(target.options);
          const matched = options.find((option) => option.value === value)
            || options.find((option) => normalizeText(option.textContent || '') === normalizeText(value))
            || options.find((option) => normalizeText(option.textContent || '').includes(normalizeText(value)));
          if (!matched) {
            sendResponse?.({ success: false, error: `select 已尝试目标，但观察到没有匹配选项：${value}；请先读取 get_info 或 snapshot` });
            return true;
          }
          target.value = matched.value;
          target.dispatchEvent(new Event('change', { bubbles: true }));
          const effect = buildEffectEvidence('select', target, before, data.element_id);
          sendResponse?.({ success: true, data: { effect, ...buildActionInfo(target, data.snapshot_id), value: matched.value, message: '已选择目标选项' } });
          return true;
        }

        case 'press_key': {
          const key = String(data?.key || '').trim();
          if (!key) {
            sendResponse?.({ success: false, error: 'press_key 需要 key' });
            return true;
          }
          const modifiers = new Set(Array.isArray(data?.modifiers) ? data.modifiers : []);
          htmlTarget.focus?.();
          const eventInit: KeyboardEventInit = {
            key,
            bubbles: true,
            cancelable: true,
            ctrlKey: modifiers.has('ctrl'),
            shiftKey: modifiers.has('shift'),
            altKey: modifiers.has('alt'),
            metaKey: modifiers.has('meta'),
          };
          htmlTarget.dispatchEvent(new KeyboardEvent('keydown', eventInit));
          htmlTarget.dispatchEvent(new KeyboardEvent('keyup', eventInit));
          sendResponse?.({ success: true, data: { ...buildActionInfo(target), key, modifiers: Array.from(modifiers), message: `已触发按键：${key}` } });
          return true;
        }

        default:
          sendResponse?.({ success: false, error: `不支持的 action: ${action}` });
          return true;
      }
    } catch (err: any) {
      sendResponse?.({ success: false, error: err.message || 'element_action 执行失败' });
      return true;
    }
  });
};

// ============ 视觉标注 ============

/** 标注容器的 data 属性标识 */
const ANNOTATION_CONTAINER_ATTR = 'data-actspan-annotations';

/** 标注编号上限 */
const MAX_ANNOTATION_COUNT = 50;

/** 标注项信息（返回给 background） */
export interface AnnotationEntry {
  index: number;
  element_id: string;
  tag: string;
  text: string;
  role?: string;
  placeholder?: string;
  aria_label?: string;
  name?: string;
  href?: string;
  rect: { x: number; y: number; width: number; height: number };
}

/**
 * 收集视口内可见的可交互元素，注入 DOM 标记，返回映射表
 */
const annotateInteractiveElements = (): { success: boolean; annotations?: AnnotationEntry[]; error?: string } => {
  // 移除旧标注（以防重复调用）
  removeAnnotations();

  // 收集候选元素
  const cache = new Map<Element, CachedElementInfo>();
  const nodes = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR));

  // 过滤：可见 + 视口内 + 有尺寸
  const candidates = nodes.filter(el => {
    const info = getElementInfo(el, cache);
    return info.visible && info.inViewport && info.rect.width > 0 && info.rect.height > 0;
  });

  // 按位置排序（上到下、左到右，40px 行容差）
  candidates.sort((a, b) => {
    const ra = cache.get(a)!.rect;
    const rb = cache.get(b)!.rect;
    const rowDiff = Math.floor(ra.y / 40) - Math.floor(rb.y / 40);
    return rowDiff !== 0 ? rowDiff : ra.x - rb.x;
  });

  const selected = candidates.slice(0, MAX_ANNOTATION_COUNT);
  if (selected.length === 0) {
    return { success: true, annotations: [] };
  }

  // 创建标注容器（position:fixed，覆盖整个视口，不接收鼠标事件）
  const container = document.createElement('div');
  container.setAttribute(ANNOTATION_CONTAINER_ATTR, 'true');
  container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483647;';

  const annotations: AnnotationEntry[] = [];

  for (let i = 0; i < selected.length; i++) {
    const el = selected[i];
    const index = i + 1;
    const info = cache.get(el)!;
    const rect = info.rect;
    const elementId = getOrCreateElementHandle(el);

    // 半透明高亮边框
    const highlight = document.createElement('div');
    highlight.style.cssText = `position:fixed;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;border:2px solid rgba(229,62,62,0.6);border-radius:3px;background:rgba(229,62,62,0.08);pointer-events:none;`;
    container.appendChild(highlight);

    // 编号圆圈标记（放在元素上方或内部）
    const badge = document.createElement('div');
    const badgeTop = rect.y >= 22 ? rect.y - 22 : rect.y + 2;
    const badgeLeft = Math.max(rect.x - 2, 0);
    badge.style.cssText = `position:fixed;left:${badgeLeft}px;top:${badgeTop}px;min-width:20px;height:20px;border-radius:10px;background:#e53e3e;color:#fff;font-size:11px;font-weight:bold;display:flex;align-items:center;justify-content:center;line-height:1;font-family:Arial,sans-serif;pointer-events:none;box-shadow:0 1px 3px rgba(0,0,0,0.3);padding:0 4px;`;
    badge.textContent = String(index);
    container.appendChild(badge);

    annotations.push({
      index,
      element_id: elementId,
      tag: el.tagName.toLowerCase(),
      text: clipText(info.text, 60),
      role: el.getAttribute('role') || undefined,
      placeholder: el.getAttribute('placeholder') || undefined,
      aria_label: el.getAttribute('aria-label') || undefined,
      name: el.getAttribute('name') || undefined,
      href: el instanceof HTMLAnchorElement ? clipText(el.href, 100) : undefined,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    });
  }

  document.documentElement.appendChild(container);
  return { success: true, annotations };
};

/** 移除所有视觉标注 DOM 节点 */
const removeAnnotations = (): void => {
  const containers = document.querySelectorAll(`[${ANNOTATION_CONTAINER_ATTR}]`);
  containers.forEach(c => c.remove());
};

export const initPageGrounding = () => {
  // 注入脚本（interactOnPage）在同一个隔离世界里执行，只能通过这个私有入口拿到句柄对应的元素。
  globalThis.__actspan_resolve_element_handle = resolveElementHandle;
  Channel.on('__page_grounding_snapshot', (data: PageSnapshotParams, _sender, sendResponse) => {
    try {
      sendResponse?.(collectSnapshotElements(data || {}));
    } catch (err: any) {
      sendResponse?.({ success: false, error: err.message || 'page_snapshot 执行失败' });
    }
    return true;
  });

  Channel.on('__page_grounding_assert', (data: PageAssertParams, _sender, sendResponse) => {
    try {
      sendResponse?.(runPageAssertions(data || {}));
    } catch (err: any) {
      sendResponse?.({ success: false, error: err.message || 'page_assert 执行失败' });
    }
    return true;
  });

  initElementHandleAction();
  Channel.on('__get_element_rect', (data: { element_id?: string; snapshot_id?: string }, _sender, sendResponse) => {
    try {
      const resolved = resolveElementHandle(String(data?.element_id || ''), data?.snapshot_id);
      if (!resolved.target) {
        sendResponse?.({ success: false, error: resolved.error });
        return true;
      }
      const el = resolved.target;
      const rect = (el as HTMLElement).getBoundingClientRect();
      sendResponse?.({
        success: true,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      });
    } catch (err: any) {
      sendResponse?.({ success: false, error: err.message || '坐标查询失败' });
    }
    return true;
  });

  // 视觉标注：注入交互元素编号标记
  Channel.on('__annotate_elements', (_data: unknown, _sender: unknown, sendResponse?: (response: any) => void) => {
    try {
      const result = annotateInteractiveElements();
      // 双 rAF 确保标记已渲染到屏幕
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          sendResponse?.(result);
        });
      });
    } catch (err: any) {
      sendResponse?.({ success: false, error: err.message || '标注失败' });
    }
    return true;
  });

  // 视觉标注：移除所有标记
  Channel.on('__remove_annotations', (_data: unknown, _sender: unknown, sendResponse?: (response: any) => void) => {
    try {
      removeAnnotations();
      sendResponse?.({ success: true });
    } catch (err: any) {
      sendResponse?.({ success: false, error: err.message || '移除标注失败' });
    }
    return true;
  });
};
