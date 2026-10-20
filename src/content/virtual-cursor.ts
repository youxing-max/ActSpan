import Channel from '../lib/channel';

export const VIRTUAL_CURSOR_EVENT = '__virtual_cursor';

export const VIRTUAL_CURSOR_HOOKS = {
  beforeObstruction: 'before_obstruction',
  afterObstruction: 'after_obstruction',
} as const;

export type VirtualCursorPhase = 'move' | 'press' | 'release' | 'idle';

export interface VirtualCursorUpdate {
  x: number;
  y: number;
  phase: VirtualCursorPhase;
  label?: string;
  visible: boolean;
  obstructed?: boolean;
}

export interface ObstructionResult {
  obstructed: boolean;
  element?: Element;
}

const CURSOR_ATTRIBUTE = 'data-actspan-virtual-cursor';
const CURSOR_LABEL_ATTRIBUTE = 'data-actspan-virtual-cursor-label';
const CURSOR_HOOK_EVENT = (hook: string) => `actspan-virtual-cursor-${hook}`;
const VALID_PHASES = new Set<VirtualCursorPhase>(['move', 'press', 'release', 'idle']);

export const normalizeVirtualCursorUpdate = (raw: unknown): VirtualCursorUpdate | null => {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  const { x, y } = data;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const phase = typeof data.phase === 'string' && VALID_PHASES.has(data.phase as VirtualCursorPhase)
    ? data.phase as VirtualCursorPhase
    : 'move';
  const label = typeof data.label === 'string' && data.label.trim()
    ? data.label.replace(/\s+/g, ' ').trim().slice(0, 80)
    : undefined;
  return {
    x,
    y,
    phase,
    ...(label ? { label } : {}),
    visible: data.visible !== false,
    ...(typeof data.obstructed === 'boolean' ? { obstructed: data.obstructed } : {}),
  };
};

/** Apply a normalized update to the visible cursor node. */
export const applyVirtualCursorUpdate = (
  cursor: { style: { display: string; transform: string }; classList: { add: (name: string) => void; remove: (name: string) => void } },
  update: VirtualCursorUpdate,
): void => {
  cursor.classList.remove('is-move');
  cursor.classList.remove('is-press');
  cursor.classList.remove('is-release');
  cursor.classList.remove('is-idle');
  cursor.classList.add(`is-${update.phase}`);
  cursor.style.transform = `translate3d(${update.x}px, ${update.y}px, 0)`;
  cursor.style.display = update.visible ? 'block' : 'none';
};

/** Dispatch the same hook names used by the operation path and the UI. */
export const emitVirtualCursorHook = (
  hook: string,
  update: VirtualCursorUpdate,
  target?: Pick<Window, 'dispatchEvent'>,
): void => {
  const win = target || (typeof window !== 'undefined' ? window : undefined);
  if (!win || typeof win.dispatchEvent !== 'function' || typeof CustomEvent === 'undefined') return;
  win.dispatchEvent(new CustomEvent(CURSOR_HOOK_EVENT(hook), { detail: update }));
};

/** Keep the cursor move hook synchronously ahead of obstruction detection. */
export const withVirtualCursorBeforeObstruction = <T>(
  rawUpdate: unknown,
  detect: () => T,
  emit: (hook: string, update: VirtualCursorUpdate) => void = emitVirtualCursorHook,
): T => {
  const update = normalizeVirtualCursorUpdate(rawUpdate);
  if (!update) return detect();
  emit(VIRTUAL_CURSOR_HOOKS.beforeObstruction, update);
  try {
    return detect();
  } finally {
    emit(VIRTUAL_CURSOR_HOOKS.afterObstruction, update);
  }
};

export const getElementCenter = (target: Element): { x: number; y: number; phase: 'move'; visible: true } | null => {
  const rect = (target as HTMLElement).getBoundingClientRect?.();
  if (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.top)
    || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return null;
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    phase: 'move',
    visible: true,
  };
};

/** Identify the top element at a target point without treating our cursor as an obstruction. */
export const detectObstruction = (
  target: Element,
  point: { x: number; y: number },
  doc?: Pick<Document, 'elementsFromPoint'>,
): ObstructionResult => {
  const ownerDocument = doc || (typeof document !== 'undefined' ? document : undefined);
  if (!ownerDocument || typeof ownerDocument.elementsFromPoint !== 'function') return { obstructed: false };
  const elements = ownerDocument.elementsFromPoint(point.x, point.y);
  for (const element of elements) {
    if (element.closest?.(`[${CURSOR_ATTRIBUTE}]`)) continue;
    if (element === target || target.contains?.(element) || element.contains?.(target)) return { obstructed: false };
    return { obstructed: true, element };
  }
  return { obstructed: false };
};

const setupCursorStyles = (cursor: HTMLElement, dot: HTMLElement, label: HTMLElement): void => {
  cursor.style.cssText = [
    'position:fixed', 'left:0', 'top:0', 'width:18px', 'height:18px',
    'margin:-9px 0 0 -9px', 'z-index:2147483647', 'pointer-events:none',
    'display:none', 'will-change:transform', 'transition:transform 80ms linear',
  ].join(';');
  dot.style.cssText = [
    'position:absolute', 'inset:3px', 'border:2px solid #2563eb',
    'border-radius:50%', 'background:rgba(255,255,255,.9)',
    'box-shadow:0 0 0 3px rgba(37,99,235,.16)',
  ].join(';');
  label.style.cssText = [
    'position:absolute', 'left:14px', 'top:12px', 'max-width:180px',
    'padding:2px 6px', 'border-radius:5px', 'background:rgba(20,37,58,.9)',
    'color:#fff', 'font:11px/1.3 sans-serif', 'white-space:nowrap',
    'overflow:hidden', 'text-overflow:ellipsis',
  ].join(';');
};

/** Install the page-visible cursor and subscribe it to operation hooks. */
export const initVirtualCursor = (
  doc: Document | undefined = typeof document === 'undefined' ? undefined : document,
  win: Window | undefined = typeof window === 'undefined' ? undefined : window,
): (() => void) => {
  if (!doc?.body || !win) return () => undefined;
  const existing = doc.querySelector<HTMLElement>(`[${CURSOR_ATTRIBUTE}]`);
  const cursor = existing || doc.createElement('div');
  const owned = !existing;
  if (owned) {
    cursor.setAttribute(CURSOR_ATTRIBUTE, '');
    cursor.setAttribute('aria-hidden', 'true');
    const dot = doc.createElement('span');
    const label = doc.createElement('span');
    label.setAttribute(CURSOR_LABEL_ATTRIBUTE, '');
    cursor.append(dot, label);
    setupCursorStyles(cursor, dot, label);
    doc.body.appendChild(cursor);
  }
  const dot = cursor.firstElementChild as HTMLElement | null;
  const label = cursor.querySelector<HTMLElement>(`[${CURSOR_LABEL_ATTRIBUTE}]`);
  if (!dot || !label) return () => undefined;
  let idleTimer: number | undefined;
  const handleUpdate = (raw: unknown) => {
    const update = normalizeVirtualCursorUpdate(raw);
    if (!update) return;
    win.clearTimeout(idleTimer);
    applyVirtualCursorUpdate(cursor, update);
    label.textContent = update.label || '';
    label.style.display = update.label && update.visible ? 'block' : 'none';
    if (update.visible && update.phase !== 'idle') {
      idleTimer = win.setTimeout(() => {
        applyVirtualCursorUpdate(cursor, { ...update, phase: 'idle', visible: false });
        label.style.display = 'none';
      }, 700);
    }
  };
  const handleHook = (event: Event) => handleUpdate((event as CustomEvent<VirtualCursorUpdate>).detail);
  const hideForScreenshot = () => {
    win.clearTimeout(idleTimer);
    cursor.style.display = 'none';
    label.style.display = 'none';
  };
  Channel.on('__screenshot_hide', hideForScreenshot);
  Channel.on(VIRTUAL_CURSOR_EVENT, handleUpdate);
  win.addEventListener(CURSOR_HOOK_EVENT(VIRTUAL_CURSOR_HOOKS.beforeObstruction), handleHook);
  win.addEventListener(CURSOR_HOOK_EVENT(VIRTUAL_CURSOR_HOOKS.afterObstruction), handleHook);
  return () => {
    Channel.off(VIRTUAL_CURSOR_EVENT, handleUpdate);
    Channel.off('__screenshot_hide', hideForScreenshot);
    win.removeEventListener(CURSOR_HOOK_EVENT(VIRTUAL_CURSOR_HOOKS.beforeObstruction), handleHook);
    win.removeEventListener(CURSOR_HOOK_EVENT(VIRTUAL_CURSOR_HOOKS.afterObstruction), handleHook);
    win.clearTimeout(idleTimer);
    if (owned) cursor.remove();
  };
};
