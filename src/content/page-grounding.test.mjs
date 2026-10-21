import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `
      export {
        clickAndReport,
        promoteSvgActionTarget,
        createSnapshotId,
        validateElementHandle,
        captureObservableState,
        buildEffectEvidence,
        sanitizeElementValue,
        initPageGrounding,
        resolveFindTarget,
        resolveActionTarget,
        computeAccessibleRole,
        computeAccessibleName,
        elementHandleMap,
        elementHandleSnapshotMap,
        getOrCreateElementHandle,
      } from './src/content/page-grounding.ts';
      export { default as Channel } from './src/lib/channel.ts';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { clickAndReport, promoteSvgActionTarget, createSnapshotId, validateElementHandle, captureObservableState, buildEffectEvidence, sanitizeElementValue, initPageGrounding, resolveFindTarget, resolveActionTarget, computeAccessibleRole, computeAccessibleName, getOrCreateElementHandle, elementHandleMap, elementHandleSnapshotMap, Channel } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

test('reports a click only after the synchronous click completes', () => {
  const events = [];
  const target = {
    hasAttribute: () => false,
    getAttribute: () => null,
    disabled: false,
    click: () => events.push('click'),
  };

  const result = clickAndReport(target, () => {
    events.push('report');
    return 'done';
  });

  assert.equal(result, 'done');
  assert.deepEqual(events, ['click', 'report']);
});

test('promotes an SVG descendant to its action-bearing ancestor', () => {
  const button = { tagName: 'BUTTON' };
  const path = {
    tagName: 'path',
    namespaceURI: 'http://www.w3.org/2000/svg',
    closest: (selector) => selector.includes('button') ? button : null,
  };

  assert.equal(promoteSvgActionTarget(path), button);
});

test('keeps a standalone SVG target when no action-bearing ancestor exists', () => {
  const svg = {
    tagName: 'svg',
    namespaceURI: 'http://www.w3.org/2000/svg',
    closest: () => null,
  };

  assert.equal(promoteSvgActionTarget(svg), svg);
});

test('rotates snapshot ids and rejects a handle from an older snapshot', () => {
  const first = createSnapshotId();
  const second = createSnapshotId();
  const metadata = new Map([['handle-1', { snapshotId: first, fingerprint: 'button|Save' }]]);

  assert.notEqual(first, second);
  assert.equal(validateElementHandle('handle-1', first, metadata), null);
  assert.match(validateElementHandle('handle-1', second, metadata) || '', /重新调用 page\(action="snapshot"\)|find/);
});

test('requires a snapshot id when a snapshot-backed handle is used', () => {
  const metadata = new Map([['handle-1', { snapshotId: 'snapshot-1', fingerprint: 'button|Save' }]]);

  assert.match(validateElementHandle('handle-1', undefined, metadata) || '', /snapshot|find/);
});


const makeTarget = ({ tagName = 'BUTTON', type = null, text = 'Save', value = '', changed = false, invalid = false } = {}) => {
  const target = {
    tagName,
    textContent: text,
    value,
    className: '',
    parentElement: { textContent: `nearby ${text}` },
    hasAttribute: () => false,
    getAttribute: (name) => name === 'type' ? type : null,
    matches: (selector) => selector === ':invalid' && invalid,
    closest: () => null,
    getBoundingClientRect: () => ({ width: 20, height: 20 }),
    click: () => {
      if (changed) target.textContent = 'Opened';
    },
  };
  return target;
};
test('reports a synchronous local DOM change as effect evidence', () => {
  const target = makeTarget({ changed: true });
  const before = captureObservableState(target);
  clickAndReport(target, () => undefined);
  const effect = buildEffectEvidence('click', target, before, 'ec-1');

  assert.equal(effect.status, 'changed');
  assert.equal(effect.changed, true);
  assert.deepEqual(effect.changed_fields, ['text']);
  assert.equal(effect.target.element_id, 'ec-1');
});
test('reports a click request without claiming that the page had no response', () => {
  const target = makeTarget();
  const effect = buildEffectEvidence('click', target, captureObservableState(target), 'ec-2');

  assert.equal(effect.status, 'requested');
  assert.equal(effect.changed, false);
  assert.match(effect.diagnostic, /未观察到同步 DOM 变化/);
});

test('does not expose password values in effect evidence', () => {
  const target = makeTarget({ tagName: 'INPUT', type: 'password', value: 'secret' });
  const effect = buildEffectEvidence('fill', target, captureObservableState(target), 'ec-3');

  assert.equal(effect.observed.value, undefined);
  assert.doesNotMatch(JSON.stringify(effect), /secret/);
});

test('reports form validation as an unsuccessful effect', () => {
  const target = makeTarget({ invalid: true });
  const effect = buildEffectEvidence('click', target, captureObservableState(target), 'ec-4');

  assert.equal(effect.status, 'validation_error');
  assert.equal(effect.observed.validation_error, '页面表单校验未通过');
});

test('masks password values before any element action metadata is returned', () => {
  assert.equal(sanitizeElementValue('password', 'secret'), undefined);
  assert.equal(sanitizeElementValue('text', 'visible'), 'visible');
});

test('page click moves the cursor before checking obstruction and performing the click', () => {
  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    HTMLAnchorElement: globalThis.HTMLAnchorElement,
    HTMLInputElement: globalThis.HTMLInputElement,
    HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
    HTMLSelectElement: globalThis.HTMLSelectElement,
  };
  const events = [];
  const target = {
    tagName: 'BUTTON', namespaceURI: 'http://www.w3.org/1999/xhtml',
    textContent: 'Save', className: '', dataset: {}, classList: [], parentElement: null,
    hasAttribute: () => false, getAttribute: () => null, closest: () => null,
    matches: () => false, contains: () => false,
    scrollIntoView: () => events.push('scroll'),
    getBoundingClientRect: () => ({ x: 8, y: 16, left: 8, top: 16, right: 28, bottom: 36, width: 20, height: 20 }),
    click: () => events.push('click'),
  };
  try {
    globalThis.HTMLAnchorElement = class {};
    globalThis.HTMLInputElement = class {};
    globalThis.HTMLTextAreaElement = class {};
    globalThis.HTMLSelectElement = class {};
    globalThis.document = {
      querySelector: () => target,
      querySelectorAll: () => [],
      elementsFromPoint: () => { events.push('hit-test'); return [target]; },
    };
    globalThis.window = {
      innerWidth: 800, innerHeight: 600,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', cursor: 'pointer' }),
      dispatchEvent: (event) => { events.push(event.type); return true; },
    };
    initPageGrounding();
    let response;
    for (const action of Channel.handlers.get('__page_grounding_action')) {
      action({ action: 'click', selector: '#save' }, null, (value) => { response = value; });
    }
    assert.equal(response.success, true);
    assert.ok(events.indexOf('actspan-virtual-cursor-before_obstruction') < events.indexOf('hit-test'));
    assert.ok(events.indexOf('hit-test') < events.indexOf('click'));
  } finally {
    Object.assign(globalThis, saved);
  }
});

const fakeEl = (tagName, { text = '', attrs = {} } = {}) => ({
  tagName: tagName.toUpperCase(),
  textContent: text,
  innerText: text,
  labels: [],
  namespaceURI: 'http://www.w3.org/1999/xhtml',
  isConnected: true,
  className: '',
  classList: [],
  dataset: {},
  parentElement: null,
  getAttribute: (name) => (Object.hasOwn(attrs, name) ? attrs[name] : null),
  hasAttribute: (name) => Object.hasOwn(attrs, name),
  closest: () => null,
  matches: () => false,
});
const fakeRoot = (nodes) => ({ querySelectorAll: (selector) => (selector === '*' ? nodes : []) });

test('find prefers an exact accessible-name match over a substring match', () => {
  const deleteOne = fakeEl('button', { text: '删除' });
  const deleteAll = fakeEl('button', { text: '删除全部' });
  const resolution = resolveFindTarget({ role: 'button', name: '删除' }, fakeRoot([deleteAll, deleteOne]));
  assert.equal(resolution.error, undefined);
  assert.equal(resolution.target, deleteOne);
});

test('find refuses to guess between exact matches and lists candidates plus nth bounds', () => {
  const first = fakeEl('button', { text: '删除' });
  const second = fakeEl('button', { text: '删除' });
  const root = fakeRoot([first, second]);
  const ambiguous = resolveFindTarget({ role: 'button', name: '删除' }, root);
  assert.equal(ambiguous.target, null);
  assert.match(ambiguous.error, /命中 2 个元素/);
  assert.deepEqual(ambiguous.candidates.map((candidate) => candidate.name), ['删除', '删除']);
  assert.equal(resolveFindTarget({ role: 'button', name: '删除', nth: 1 }, root).target, second);
  assert.match(resolveFindTarget({ role: 'button', name: '删除', nth: 3 }, root).error, /超出匹配数量 2/);
});

test('find with no match reports the roles the page actually offers', () => {
  const resolution = resolveFindTarget({ role: 'link', name: 'Checkout' },
    fakeRoot([fakeEl('button', { text: '删除' }), fakeEl('input', { attrs: { type: 'text' } })]));
  assert.equal(resolution.target, null);
  assert.match(resolution.error, /未匹配到元素/);
  assert.deepEqual(resolution.available_roles, ['button', 'textbox']);
});

test('element actions reject mixed locators and stale refs before touching the page', () => {
  assert.match(resolveActionTarget({ element_id: 'e5', selector: '#save' }).error, /只能三选一/);
  const target = fakeEl('button', { text: 'Pay' });
  elementHandleMap.set('e9', target);
  elementHandleSnapshotMap.set('e9', { snapshotId: 'snap-a', fingerprint: 'stale-fingerprint' });
  assert.match(resolveActionTarget({ element_id: 'e9', snapshot_id: 'snap-b' }).error, /已过期/);
  assert.match(resolveActionTarget({ element_id: 'e9', snapshot_id: 'snap-a' }).error, /指纹不一致/);
  const detached = fakeEl('button', { text: 'Gone' });
  detached.isConnected = false;
  elementHandleMap.set('e10', detached);
  assert.match(resolveActionTarget({ element_id: 'e10', snapshot_id: 'snap-a' }).error, /已不在文档中/);
  elementHandleMap.delete('e9');
  elementHandleMap.delete('e10');
  elementHandleSnapshotMap.delete('e9');
});

test('handle table drops elements that left the document instead of growing without bound', () => {
  const alive = { isConnected: true };
  elementHandleMap.set('keep-1', alive);
  elementHandleSnapshotMap.set('keep-1', { snapshotId: 'snap-a', fingerprint: 'f' });

  const doomed = [];
  for (let i = 0; i < 300; i += 1) doomed.push(getOrCreateElementHandle({ isConnected: false }));

  const retained = doomed.filter((id) => elementHandleMap.has(id)).length;
  assert.ok(retained < 300, `300 detached handles all stayed resident (retained ${retained})`);
  assert.equal(elementHandleMap.get('keep-1'), alive, 'a connected handle must survive pruning');
  assert.equal(elementHandleSnapshotMap.has('keep-1'), true);

  elementHandleMap.delete('keep-1');
  elementHandleSnapshotMap.delete('keep-1');
  for (const id of doomed) {
    elementHandleMap.delete(id);
    elementHandleSnapshotMap.delete(id);
  }
});

test('accessible names stay stable and never expose editable values', () => {
  const input = fakeEl('input', { attrs: { type: 'text', name: 'email', placeholder: 'Enter email' } });
  input.value = 'user@example.com';
  assert.equal(computeAccessibleRole(input), 'textbox');
  assert.equal(computeAccessibleName(input), 'email');
  assert.equal(computeAccessibleName(fakeEl('input', { attrs: { type: 'text', placeholder: 'Enter email' } })), '');
  assert.equal(computeAccessibleName(fakeEl('button', { text: 'Pay now' })), 'Pay now');
  // 快照暴露的 role 必须与 find 的匹配语义同源，否则 agent 从快照学到的角色永远命不中搜索框。
  assert.equal(computeAccessibleRole(fakeEl('input', { attrs: { type: 'search' } })), 'searchbox');
});

// 动作回执曾经把 element_id 当成 snapshotId 传给描述符构造函数，于是句柄表里记下的
// 「快照 id」变成了元素 id，同一个 ref 第二次使用就会被判成「已过期」。
test('a click receipt reports the real snapshot id and keeps the ref usable', () => {
  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    HTMLAnchorElement: globalThis.HTMLAnchorElement,
    HTMLInputElement: globalThis.HTMLInputElement,
    HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
    HTMLSelectElement: globalThis.HTMLSelectElement,
  };
  const target = {
    tagName: 'BUTTON', namespaceURI: 'http://www.w3.org/1999/xhtml',
    textContent: 'Save', className: '', dataset: {}, classList: [], parentElement: null, isConnected: true,
    hasAttribute: () => false, getAttribute: () => null, closest: () => null,
    matches: () => false, contains: () => false,
    scrollIntoView: () => {},
    getBoundingClientRect: () => ({ x: 8, y: 16, left: 8, top: 16, right: 28, bottom: 36, width: 20, height: 20 }),
    click: () => {},
  };
  try {
    globalThis.HTMLAnchorElement = class {};
    globalThis.HTMLInputElement = class {};
    globalThis.HTMLTextAreaElement = class {};
    globalThis.HTMLSelectElement = class {};
    globalThis.document = {
      querySelector: () => target,
      querySelectorAll: () => [],
      elementsFromPoint: () => [target],
    };
    globalThis.window = {
      innerWidth: 800, innerHeight: 600,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', cursor: 'pointer' }),
    };
    initPageGrounding();
    const elementId = 'handle-click-1';
    const snapshotId = 'snap-real-1';
    elementHandleMap.set(elementId, target);

    let response;
    for (const action of Channel.handlers.get('__page_grounding_action')) {
      action({ action: 'click', element_id: elementId, snapshot_id: snapshotId }, null, (value) => { response = value; });
    }
    assert.equal(response.success, true, JSON.stringify(response));
    assert.equal(response.data.snapshot_id, snapshotId, 'the receipt must echo the snapshot id, not the element id');
    // 句柄表里记下的必须也是真快照 id：写错的话下一次用同一个 ref 就会被判「已过期」。
    assert.equal(elementHandleSnapshotMap.get(response.data.element_id)?.snapshotId, snapshotId);
    // 同一个 ref + 同一个 snapshot 必须还能解析；被污染时会报「已过期」。
    assert.equal(resolveActionTarget({ element_id: elementId, snapshot_id: snapshotId }).error, undefined);
  } finally {
    elementHandleMap.delete('handle-click-1');
    elementHandleSnapshotMap.delete('handle-click-1');
    Object.assign(globalThis, saved);
  }
});

// G11 / G15 的假 DOM：只需要快照路径真正读到的那些 API
const domNode = (tagName, { text = '', attrs = {}, cursor = 'default', children = [] } = {}) => {
  const el = {
    tagName: tagName.toUpperCase(),
    id: attrs.id || '',
    textContent: text,
    innerText: text,
    className: '',
    classList: [],
    dataset: {},
    labels: [],
    control: null,
    children: [],
    parentElement: null,
    parentNode: null,
    isConnected: true,
    shadowRoot: null,
    cursor,
    getAttribute: (name) => (Object.hasOwn(attrs, name) ? attrs[name] : null),
    hasAttribute: (name) => Object.hasOwn(attrs, name),
    matches: () => true,
    closest: (selector) => {
      let node = el;
      while (node) {
        if (node.tagName.toLowerCase() === selector) return node;
        node = node.parentElement;
      }
      return null;
    },
    getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, right: 40, bottom: 20, width: 40, height: 20 }),
  };
  for (const child of children) {
    child.parentElement = el;
    child.parentNode = el;
    el.children.push(child);
  }
  return el;
};

/** 用假 DOM 跑一次 page snapshot，返回响应体 */
const snapshotOf = (nodes, params = {}) => {
  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    HTMLAnchorElement: globalThis.HTMLAnchorElement,
    HTMLInputElement: globalThis.HTMLInputElement,
    HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
    HTMLSelectElement: globalThis.HTMLSelectElement,
  };
  const byId = new Map(nodes.filter((node) => node.id).map((node) => [node.id, node]));
  const handles = [];
  let response;
  try {
    globalThis.HTMLAnchorElement = class {};
    globalThis.HTMLInputElement = class {};
    globalThis.HTMLTextAreaElement = class {};
    globalThis.HTMLSelectElement = class {};
    globalThis.document = {
      title: 'Login',
      body: { querySelectorAll: () => nodes, shadowRoot: null },
      getElementById: (id) => byId.get(id) || null,
      querySelector: () => null,
    };
    globalThis.window = {
      innerWidth: 800,
      innerHeight: 600,
      location: { href: 'https://example.test/login' },
      getComputedStyle: (el) => ({ display: 'block', visibility: 'visible', opacity: '1', cursor: el.cursor }),
    };
    initPageGrounding();
    for (const handler of Channel.handlers.get('__page_grounding_snapshot')) {
      handler(params, null, (value) => { response = value; });
    }
    for (const descriptor of response?.data?.elements || []) handles.push(descriptor.element_id);
  } finally {
    for (const handle of handles) {
      elementHandleMap.delete(handle);
      elementHandleSnapshotMap.delete(handle);
    }
    Object.assign(globalThis, saved);
  }
  return response;
};

test('snapshot descriptors expose aria-selected as a tri-state', () => {
  const selected = domNode('button', { text: 'A', attrs: { role: 'tab', 'aria-selected': 'true' } });
  const unselected = domNode('button', { text: 'B', attrs: { role: 'tab', 'aria-selected': 'false' } });
  const plain = domNode('button', { text: 'C' });

  const response = snapshotOf([selected, unselected, plain]);
  assert.equal(response.success, true, JSON.stringify(response));
  const byText = (text) => response.data.elements.find((el) => el.text === text);
  assert.equal(byText('A').aria_selected, true);
  assert.equal(byText('B').aria_selected, false);
  // 没写 aria-selected 的元素是「未声明」，不能被当成 false
  assert.equal(byText('C').aria_selected, undefined);
});

test('snapshot descriptors expose the class attribute only when it is set', () => {
  const active = domNode('button', { text: 'A', attrs: { class: '  tab   is-active ' } });
  const bare = domNode('button', { text: 'B' });

  const response = snapshotOf([active, bare]);
  assert.equal(response.success, true, JSON.stringify(response));
  // 描述符经 JSON 送到 agent，序列化结果才是可观察契约（undefined 会被丢掉）
  const wire = (text) => JSON.parse(JSON.stringify(response.data.elements.find((el) => el.text === text)));
  // class 表达的状态要可读，且按既有 clip 习惯归一化空白
  assert.equal(wire('A').class_name, 'tab is-active');
  // 没有 class 的候选不带该字段，不塞空串
  assert.equal(Object.hasOwn(wire('B'), 'class_name'), false);
});

test('snapshot folds nested decorations and labels but keeps weak candidates', () => {
  const icon = domNode('i', { cursor: 'pointer' });
  const weak = domNode('span', { text: '×', attrs: { tabindex: '0' } });
  const button = domNode('button', { text: 'Search', children: [icon, weak] });

  const forLabel = domNode('label', { text: 'Plan', attrs: { for: 'plan' } });
  const select = domNode('select', { attrs: { id: 'plan' } });
  select.labels = [forLabel];

  const email = domNode('input', { attrs: { id: 'email', type: 'email' } });
  const wrapLabel = domNode('label', { text: 'Email', children: [email] });
  wrapLabel.control = email;
  email.labels = [wrapLabel];

  const response = snapshotOf([button, icon, weak, forLabel, select, wrapLabel, email], { include_non_interactive: true });
  assert.equal(response.success, true, JSON.stringify(response));
  assert.deepEqual(response.data.elements.map((el) => el.tag).sort(), ['button', 'input', 'select', 'span']);
  // 名字一个不少：折叠掉标签后控件仍带着标签文本
  assert.equal(response.data.elements.find((el) => el.tag === 'select').label, 'Plan');
  assert.equal(response.data.elements.find((el) => el.tag === 'input').label, 'Email');
  // 弱候选（tabindex）可能是独立操作，必须保留且可寻址
  assert.ok(response.data.elements.find((el) => el.tag === 'span').element_id, '弱候选必须保留');
});

test('actspan root host is excluded from the page snapshot', () => {
  const ball = domNode('div', { attrs: { id: 'actspan-root' }, text: 'floating-ball-ui' });
  const real = domNode('button', { text: 'real-button' });

  const response = snapshotOf([ball, real]);
  assert.equal(response.success, true, JSON.stringify(response));
  const texts = response.data.elements.map((el) => el.text);
  assert.ok(!texts.includes('floating-ball-ui'), 'actspan root content must not enter the snapshot');
  assert.ok(texts.includes('real-button'), 'real page content must remain');
});