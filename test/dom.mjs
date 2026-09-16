// TANKFALL — minimal DOM/browser stub so the real client code can be executed
// headlessly in Node for tests. Only the APIs the client actually touches are
// implemented; everything else is a tolerant no-op.

import fs from 'node:fs';

class ClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  add(...c) { for (const x of c) this.set.add(x); }
  remove(...c) { for (const x of c) this.set.delete(x); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : !!force;
    if (on) this.set.add(c); else this.set.delete(c);
    return on;
  }
  get value() { return [...this.set].join(' '); }
  toString() { return this.value; }
}

class ElementStub {
  constructor(tag = 'div', id = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.classList = new ClassList(this);
    this.children = [];
    this.style = {
      setProperty(k, v) { this[k] = v; },
      removeProperty(k) { delete this[k]; },
      getPropertyValue(k) { return this[k] || ''; },
      cssText: '',
    };
    this.dataset = {};
    this.value = '';
    this._text = '';
    this.listeners = new Map();
    this.isCanvas = tag === 'canvas';
    if (this.isCanvas) {
      this.width = 300;
      this.height = 150;
      this._ctx = makeCtx();
    }
  }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    return this._text;
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get childElementCount() { return this.children.length; }
  get firstElementChild() { return this.children[0] || null; }
  appendChild(node) { this.children.push(node); node.parent = this; return node; }
  append(...nodes) { for (const n of nodes) this.appendChild(n); }
  prepend(node) { this.children.unshift(node); }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  removeChild(node) { this.children = this.children.filter((c) => c !== node); return node; }
  setAttribute(k, v) { this[k] = v; }
  getAttribute(k) { return this[k]; }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const l = this.listeners.get(type) || [];
    this.listeners.set(type, l.filter((x) => x !== fn));
  }
  dispatch(type, ev = {}) {
    for (const fn of this.listeners.get(type) || []) fn({ target: this, preventDefault() {}, stopPropagation() {}, ...ev });
  }
  click() { this.dispatch('click'); }
  focus() {}
  blur() {}
  select() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 1280, height: 720, right: 1280, bottom: 720, x: 0, y: 0 }; }
  get offsetWidth() { return 1280; }
  get offsetHeight() { return 720; }
  querySelector(sel) {
    const cls = sel.replace(/^\./, '');
    return this.find((el) => el.classList.contains(cls)) || new ElementStub('div');
  }
  querySelectorAll(sel) {
    const cls = sel.replace(/^\./, '');
    return this.findAll((el) => el.classList.contains(cls));
  }
  find(pred) {
    for (const c of this.children) {
      if (pred(c)) return c;
      const deep = c.find?.(pred);
      if (deep) return deep;
    }
    return null;
  }
  findAll(pred, out = []) {
    for (const c of this.children) {
      if (pred(c)) out.push(c);
      c.findAll?.(pred, out);
    }
    return out;
  }
  closest(sel) {
    const cls = sel.replace(/^\./, '').replace(/^#/, '');
    // eslint-disable-next-line no-this-alias
    let node = this;
    while (node) {
      if (node.classList?.contains(cls) || node.id === cls) return node;
      node = node.parent;
    }
    return null;
  }
  getContext() { return this._ctx || makeCtx(); }
  getContext2d() { return this.getContext('2d'); }
}

function makeCtx() {
  const ctx = {
    canvas: null,
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1,
    font: '10px sans-serif', textAlign: 'left', textBaseline: 'alphabetic',
    globalCompositeOperation: 'source-over', imageSmoothingEnabled: true, lineDashOffset: 0,
    calls: 0,
  };
  const noop = function () { ctx.calls++; };
  for (const m of [
    'save', 'restore', 'setTransform', 'resetTransform', 'scale', 'translate', 'rotate', 'transform',
    'beginPath', 'closePath', 'moveTo', 'lineTo', 'quadraticCurveTo', 'bezierCurveTo', 'arc', 'arcTo',
    'ellipse', 'rect', 'roundRect', 'fill', 'stroke', 'clip', 'fillRect', 'strokeRect', 'clearRect',
    'drawImage', 'fillText', 'strokeText', 'setLineDash', 'getLineDash', 'putImageData', 'getImageData',
    'createPattern', 'isPointInPath', 'roundRectPath',
  ]) ctx[m] = noop;
  ctx.measureText = (t) => ({ width: String(t).length * 7 });
  ctx.createLinearGradient = () => ({ addColorStop() {} });
  ctx.createRadialGradient = () => ({ addColorStop() {} });
  ctx.createPattern = () => ({});
  return ctx;
}

/** Builds a document whose elements mirror the ids/classes used by index.html. */
export function installDom({ html = null } = {}) {
  const markup = html ?? fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const tagById = new Map();
  for (const m of markup.matchAll(/<([a-zA-Z0-9]+)([^>]*?)\sid="([^"]+)"/g)) tagById.set(m[3], m[1]);
  const elements = new Map();
  for (const [id, tag] of tagById) elements.set(id, new ElementStub(tag, id));

  const document = {
    hidden: false,
    visibilityState: 'visible',
    body: new ElementStub('body'),
    documentElement: new ElementStub('html'),
    getElementById: (id) => elements.get(id) || null,
    createElement: (tag) => new ElementStub(tag),
    createTextNode: (t) => ({ nodeValue: t, textContent: t }),
    addEventListener() {}, removeEventListener() {},
    execCommand: () => true,
    querySelector: () => null,
    querySelectorAll: () => [],
    elements,
  };

  // A real event target, so window-level handlers (keyboard, pointer release,
  // touch fallbacks) are actually exercised by the harness.
  const winListeners = new Map();
  const win = {
    devicePixelRatio: 1,
    innerWidth: 1280,
    innerHeight: 720,
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const l = winListeners.get(type) || [];
      winListeners.set(type, l.filter((x) => x !== fn));
    },
    dispatch(type, ev = {}) {
      for (const fn of winListeners.get(type) || []) fn({ type, target: win, preventDefault() {}, stopPropagation() {}, ...ev });
    },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: (fn) => setTimeout(() => fn(performance.now()), 16),
    cancelAnimationFrame: (id) => clearTimeout(id),
    location: { protocol: 'http:', host: '127.0.0.1', origin: 'http://127.0.0.1', pathname: '/', href: 'http://127.0.0.1/' },
    navigator: { userAgent: 'node-stub', clipboard: null, share: null },
    localStorage: makeStorage(),
    AudioContext: undefined,
    visualViewport: null,
    isSecureContext: false,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  };

  globalThis.document = document;
  globalThis.window = win;
  globalThis.localStorage = win.localStorage;
  globalThis.location = win.location;
  // Node exposes a read-only `navigator`; redefine it so client code sees ours.
  try {
    Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true, writable: true });
  } catch {
    Object.defineProperty(globalThis, 'navigator', { get: () => win.navigator, configurable: true });
  }
  globalThis.matchMedia = win.matchMedia;
  globalThis.requestAnimationFrame = win.requestAnimationFrame;
  globalThis.cancelAnimationFrame = win.cancelAnimationFrame;
  globalThis.devicePixelRatio = 1;
  globalThis.Element = ElementStub;
  globalThis.screen = { orientation: { lock: () => Promise.reject(new Error('n/a')) } };
  return { document, window: win, elements, ElementStub };
}

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    get length() { return map.size; },
  };
}

export { ElementStub, makeCtx };
