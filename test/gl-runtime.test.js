'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const GL_DIR = path.resolve(__dirname, '../assets/js/gl');

test('背景使用本地渐变且不加载远程图片', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  const css = fs.readFileSync(path.resolve(__dirname, '../assets/css/app.css'), 'utf8');
  assert.match(html, /Historical visual reference only \(not loaded\).*Defi22.*CC BY-SA 4\.0/);
  assert.doesNotMatch(css, /Special:FilePath\/Rainy_Lights\.jpg/);
  assert.match(css, /linear-gradient\(180deg,var\(--bg2\),var\(--bg\) 70%\)/);
});

test('CSS3DRenderer 产物保留 Three.js 作者与 MIT 署名', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../assets/vendor/three-css3d.js'), 'utf8');
  assert.match(source, /^\/\* Three\.js Authors \/ CSS3DRenderer · MIT License · three@0\.152\.2 \*\//);
  assert.doesNotMatch(source, /\b(?:import|export)\s/);
});

// Deliberately small DOM: only the operations used by these modules are supported.
// Observers and RAF are delivered explicitly, without real timers or a browser.
class EventTargetStub {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  dispatch(type, event = {}) {
    for (const fn of this.listeners.get(type) || []) fn(event);
  }
}

class ElementStub extends EventTargetStub {
  constructor(tagName = 'div') {
    super();
    this.tagName = tagName;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.parentNode = null;
    this.scrollTop = 0;
    this.scrollHeight = 500;
    this.offsetHeight = 0;
    this.inert = false;
    this.textContent = '';
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); }
    };
  }
  get className() { return this.getAttribute('class') || ''; }
  set className(value) { this.setAttribute('class', value); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    this.children.push(child);
    child.parentNode = this;
    return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    assert.notEqual(i, -1, 'removeChild must receive an existing child');
    this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  replaceChild(fresh, old) {
    const i = this.children.indexOf(old);
    assert.notEqual(i, -1, 'replaceChild must receive an existing child');
    this.children[i] = fresh;
    fresh.parentNode = this;
    old.parentNode = null;
    return old;
  }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  matches(selector) {
    if (selector === '[id]') return this.hasAttribute('id');
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    return false;
  }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [
      ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  cloneNode(deep = false) {
    const clone = new ElementStub(this.tagName);
    clone.attributes = new Map(this.attributes);
    clone.textContent = this.textContent;
    if (deep) this.children.forEach(child => clone.appendChild(child.cloneNode(true)));
    return clone;
  }
  get innerHTML() { return this.textContent + this.children.map(child => child.outerHTML).join(''); }
  set innerHTML(value) {
    this.children.forEach(child => { child.parentNode = null; });
    this.children = [];
    this.textContent = '';
    if (!value) return;
    // The sole HTML assignment made by stage.mount; fail on unexpected input.
    assert.equal(value, '<div class="gl-page-inner gl-ui"></div>');
    const inner = new ElementStub();
    inner.className = 'gl-page-inner gl-ui';
    this.appendChild(inner);
  }
  get outerHTML() {
    const attrs = [...this.attributes].map(([key, value]) => ` ${key}="${value}"`).join('');
    return `<${this.tagName}${attrs}>${this.innerHTML}</${this.tagName}>`;
  }
}

class Vector {
  constructor(x = 0, y = 0, z = 0) { this.set(x, y, z); }
  set(x, y, z = 0) { Object.assign(this, { x, y, z }); return this; }
  setScalar(value) { return this.set(value, value, value); }
}
class Object3DStub {
  constructor() {
    this.position = new Vector();
    this.scale = new Vector(1, 1, 1);
    this.userData = {};
    this.children = [];
  }
  add(child) { this.children.push(child); }
}

function harness({ webgl = true, rendererThrows = false, clearThrows = false, renderThrows = false, cssThrows = false, cssRenderThrows = false } = {}) {
  const window = new EventTargetStub();
  const document = new EventTargetStub();
  const ids = new Map();
  const observers = [];
  const raf = [];
  const timers = [];
  const draw = [];
  const pathInputs = [];
  const parsedSvg = [];
  const renders = [];
  const warnings = [];
  let picks = 0;
  document.documentElement = new ElementStub('html');
  document.body = new ElementStub('body');
  document.hidden = false;
  document.getElementById = id => ids.get(id) || null;
  document.querySelector = selector => document.body.querySelector(selector);
  document.createElement = tag => {
    const el = new ElementStub(tag);
    if (tag === 'canvas') {
      el.getContext = type => {
        assert.equal(type, '2d');
        const ctx = {};
        for (const method of ['scale', 'beginPath', 'moveTo', 'arcTo', 'closePath', 'fill', 'lineTo', 'stroke', 'save', 'translate', 'arc', 'roundRect', 'restore', 'fillText']) {
          ctx[method] = (...args) => draw.push({ method, args });
        }
        return ctx;
      };
    }
    return el;
  };
  function element(id, parent = document.body, className = '') {
    const el = new ElementStub();
    el.setAttribute('id', id);
    if (className) el.className = className;
    ids.set(id, el);
    parent.appendChild(el);
    return el;
  }
  const canvas = element('gl');
  canvas.getContext = () => webgl ? {} : null;
  element('css3d');

  const THREE = {
    Vector2: Vector,
    Color: class { constructor(value) { this.value = value; } },
    Scene: Object3DStub,
    Group: Object3DStub,
    DirectionalLight: Object3DStub,
    AmbientLight: Object3DStub,
    PlaneGeometry: class { constructor(w, h) { Object.assign(this, { w, h }); } },
    ShaderMaterial: class { constructor(options) { Object.assign(this, options); } },
    MeshBasicMaterial: class { constructor(options) { Object.assign(this, options); } },
    CanvasTexture: class { constructor(image) { this.image = image; } },
    Mesh: class extends Object3DStub {
      constructor(geometry, material) { super(); Object.assign(this, { geometry, material }); }
    },
    PerspectiveCamera: class extends Object3DStub {
      constructor(fov) { super(); this.fov = fov; }
      updateProjectionMatrix() {}
    },
    OrthographicCamera: class extends Object3DStub { updateProjectionMatrix() {} },
    Raycaster: class {
      setFromCamera() { picks++; }
      intersectObjects() { return []; }
    },
    WebGLRenderer: class {
      constructor() { if (rendererThrows) throw new Error('renderer unavailable'); }
      setClearColor() {}
      setPixelRatio(value) { this.pixelRatio = value; }
      setSize(w, h) { this.size = [w, h]; }
      clear() { if (clearThrows) throw new Error('clear failed'); }
      clearDepth() {}
      render(scene, camera) {
        if (renderThrows) throw new Error('render failed');
        renders.push({ scene, camera });
      }
    }
  };
  class MutationObserverStub {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target, options) { Object.assign(this, { target, options }); }
  }
  class DOMParserStub {
    parseFromString(source, mime) {
      assert.equal(mime, 'image/svg+xml');
      assert.match(source, /^<svg\b[^>]*>.*<\/svg>$/);
      parsedSvg.push(source);
      // Parse only self-closing SVG fixture primitives. Path2D below validates
      // the actual constructor argument, not production source-code strings.
      const children = [...source.matchAll(/<(path|rect|circle)\b([^>]*?)\s*\/>/g)].map(([, tag, attrs]) => {
        const child = new ElementStub(tag);
        for (const [, name, value] of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) child.setAttribute(name, value);
        return child;
      });
      return { documentElement: { children } };
    }
  }
  class Path2DStub {
    constructor(data) {
      assert.equal(typeof data, 'string');
      assert.doesNotMatch(data, /[<>]/, 'Path2D accepts path data, not SVG markup');
      pathInputs.push(data);
      this.data = data;
    }
  }
  Object.assign(window, {
    window, document, THREE,
    getComputedStyle: el => ({ display: el.style.display || 'block' }),
    ZX: {}, innerWidth: 1200, innerHeight: 800, devicePixelRatio: 3,
    console: { warn(...args) { warnings.push(args); } },
    MutationObserver: MutationObserverStub, DOMParser: DOMParserStub, Path2D: Path2DStub,
    requestAnimationFrame: fn => { raf.push(fn); return raf.length; },
    cancelAnimationFrame: id => { if (Number.isInteger(id) && id >= 1 && id <= raf.length) raf.splice(id - 1, 1); },
    setTimeout: fn => { timers.push(fn); return timers.length; },
    ZX_CSS3D: {
      CSS3DRenderer: class {
        constructor() {
          if (cssThrows) throw new Error('CSS renderer unavailable');
          this.domElement = new ElementStub();
        }
        setSize() {}
        render() { if (cssRenderThrows) throw new Error('CSS render failed'); }
      },
      CSS3DObject: class extends Object3DStub {
        constructor(el) { super(); this.element = el; }
      }
    }
  });
  const context = vm.createContext(window);
  return {
    window, document, element, observers, raf, draw, pathInputs, parsedSvg, renders, warnings,
    get picks() { return picks; },
    load(name) { vm.runInContext(fs.readFileSync(path.join(GL_DIR, name), 'utf8'), context, { filename: name }); },
    frame(now) { assert.ok(raf.length, 'a frame must be scheduled'); raf.shift()(now); },
    flushTimers() { while (timers.length) timers.shift()(); },
    notify(target, records = []) {
      const matching = observers.filter(observer => observer.target === target);
      assert.ok(matching.length, 'target must have a registered observer');
      matching.forEach(observer => observer.callback(records));
    }
  };
}

function moduleApi({ motion = false } = {}) {
  const api = {
    onFrame: [], onResize: [], onPointer: [], gl: [], css: [], pickables: [],
    motion: () => motion, time: () => 0, size: () => ({ w: 1200, h: 800 }),
    addGL(obj) { this.gl.push(obj); }, addCSS(obj) { this.css.push(obj); },
    register(obj) { this.pickables.push(obj); }, pulse() {}
  };
  return api;
}

function dispatchFallbackEvents(h) {
  h.window.dispatch('pointermove', { clientX: 10, clientY: 20, target: new ElementStub() });
  h.window.dispatch('click', { clientX: 10, clientY: 20, target: new ElementStub(), preventDefault() {} });
  h.document.hidden = true;
  h.document.dispatch('visibilitychange');
  h.document.hidden = false;
  h.document.dispatch('visibilitychange');
  h.window.dispatch('resize');
}

test('engine reads live html motion setting; off freezes time and clears pulse', () => {
  const h = harness();
  h.load('engine.js');
  h.load('background.js');
  assert.equal(h.window.ZX_GL.init(), true);
  const api = h.window.ZX_GL.api;
  const uniforms = h.window.ZX_GL_BG.uniforms();
  assert.equal(api.motion(), true);
  h.frame(1000);
  api.pulse(1);
  h.frame(1040);
  assert.ok(api.time() > 0);
  assert.ok(uniforms.uPulse.value > 0);
  const frozen = api.time();
  h.document.documentElement.dataset.motion = 'off';
  assert.equal(api.motion(), false);
  api.pulse(1);
  h.frame(1080);
  h.frame(1120);
  assert.equal(api.time(), frozen);
  assert.equal(uniforms.uTime.value, frozen);
  assert.equal(uniforms.uPulse.value, 0);
  h.document.documentElement.dataset.motion = 'on';
  api.pulse(1);
  h.frame(1160);
  assert.ok(api.time() > frozen);
  assert.ok(uniforms.uPulse.value > 0);
});

test('隐藏的 GL 舞台不拾取，显示时恢复拾取', () => {
  const h = harness();
  h.load('engine.js');
  assert.equal(h.window.ZX_GL.init(), true);
  const canvas = h.document.getElementById('gl');
  canvas.style.display = 'none';
  h.window.dispatch('click', { clientX: 10, clientY: 20, target: new ElementStub(), preventDefault() {} });
  h.window.dispatch('pointermove', { clientX: 10, clientY: 20, target: new ElementStub() });
  assert.equal(h.picks, 0, '隐藏舞台不得拾取');
  canvas.style.display = 'block';
  h.window.dispatch('click', { clientX: 10, clientY: 20, target: new ElementStub(), preventDefault() {} });
  assert.equal(h.picks, 1, '显示舞台应恢复拾取');
});

test('隐藏舞台停止 rAF 自调度，重新显示后恢复且不产生重复循环', () => {
  const h = harness();
  h.load('engine.js');
  const canvas = h.document.getElementById('gl');
  canvas.style.display = 'none';
  assert.equal(h.window.ZX_GL.init(), false);
  assert.equal(h.raf.length, 0);
  canvas.style.display = 'block';
  h.notify(h.document.documentElement);
  assert.equal(h.raf.length, 1);
  h.frame(1000);
  assert.equal(h.raf.length, 1);
  canvas.style.display = 'none';
  h.notify(h.document.documentElement);
  assert.equal(h.raf.length, 0);
});

test('快速隐藏再显示会取消旧 rAF，不留下重复循环', () => {
  const h = harness();
  h.load('engine.js');
  const canvas = h.document.getElementById('gl');
  assert.equal(h.window.ZX_GL.init(), true);
  assert.equal(h.raf.length, 1);
  canvas.style.display = 'none';
  h.notify(h.document.documentElement);
  assert.equal(h.raf.length, 0);
  canvas.style.display = 'block';
  h.notify(h.document.documentElement);
  assert.equal(h.raf.length, 1);
  h.frame(1000);
  assert.equal(h.raf.length, 1);
});

test('engine resizes mounted modules and background before first rendered frame', () => {
  const h = harness();
  h.load('engine.js');
  h.load('background.js');
  const sizes = [];
  h.window.ZX_GL_NAV = { mount(api) { api.onResize.push((w, height) => sizes.push([w, height])); } };
  assert.equal(h.window.ZX_GL.init(), true);
  assert.deepEqual(sizes, [[1200, 800]]);
  assert.equal(h.renders.length, 0);
  const res = h.window.ZX_GL_BG.uniforms().uRes.value;
  assert.deepEqual([res.x, res.y], [1176, 776]);
  assert.equal(h.raf.length, 1, 'resize/resume must not create duplicate loops');
  h.frame(1000);
  const background = h.renders[0].scene.children[0];
  assert.equal(background.position.z, 0);
  assert.deepEqual([background.scale.x, background.scale.y], [1176, 776]);
  h.window.innerWidth = 800;
  h.window.innerHeight = 600;
  h.window.dispatch('resize');
  assert.deepEqual(sizes.at(-1), [800, 600]);
  assert.deepEqual([res.x, res.y], [776, 576]);
  assert.deepEqual([background.scale.x, background.scale.y], [776, 576]);
});

test('disabled/uninitialized engine ignores pointer and visibility events', () => {
  const h = harness();
  h.document.documentElement.dataset.gl3d = 'off';
  h.load('engine.js');
  assert.doesNotThrow(() => dispatchFallbackEvents(h));
  assert.equal(h.picks, 0);
  assert.equal(h.raf.length, 0);
});

for (const [label, options] of [
  ['missing WebGL context', { webgl: false }],
  ['WebGL renderer construction failure', { rendererThrows: true }],
  ['CSS renderer construction failure', { cssThrows: true }]
]) {
  test(`engine fallback after ${label} remains event-safe without RAF`, () => {
    const h = harness(options);
    h.load('engine.js');
    assert.equal(h.window.ZX_GL.init(), false);
    const root = h.document.documentElement;
    assert.equal(root.dataset.gl3d, 'off');
    assert.equal(root.classList.contains('gl-off'), true);
    assert.equal(root.classList.contains('gl-on'), false);
    assert.doesNotThrow(() => dispatchFallbackEvents(h));
    assert.equal(h.picks, 0);
    assert.equal(h.raf.length, 0);
  });
}

for (const [label, options] of [
  ['clear', { clearThrows: true }],
  ['render', { renderThrows: true }]
]) {
  test(`WebGL renderer ${label} failure falls back to DOM without residual RAF`, () => {
    const h = harness(options);
    h.load('engine.js');
    assert.equal(h.window.ZX_GL.init(), true);
    const root = h.document.documentElement;
    assert.equal(root.classList.contains('gl-on'), true);
    assert.equal(h.raf.length, 1);
    assert.doesNotThrow(() => h.frame(1000));
    assert.equal(h.warnings.length, 1);
    assert.match(h.warnings[0][0], /WebGL 渲染异常/);
    assert.equal(root.dataset.gl3d, 'off');
    assert.equal(root.classList.contains('gl-on'), false);
    assert.equal(root.classList.contains('gl-off'), true);
    assert.equal(h.raf.length, 0, 'render failure must not schedule another frame');
    assert.doesNotThrow(() => h.notify(root), 'fallback mutations must not restart the loop');
    assert.doesNotThrow(() => dispatchFallbackEvents(h));
    assert.equal(h.picks, 0, 'DOM fallback must disable GL picking');
    assert.equal(h.raf.length, 0);
  });
}

test('nav draws SVG child path/rect/circle and settles on first motion-off frame', () => {
  const h = harness();
  const pathData = 'M2 3h12v10H2z';
  h.window.ZX.glTabs = [{
    id: 'chat', label: '对话',
    icon: `<path d="${pathData}"/><rect x="2" y="4" width="12" height="9" rx="2"/><circle cx="8" cy="7" r="3"/>`
  }];
  h.window.ZX.state = { tab: 'chat' };
  h.load('nav.js');
  const api = moduleApi();
  h.window.ZX_GL_NAV.mount(api);
  assert.deepEqual(h.pathInputs, [pathData, pathData], 'idle and active textures both use path d');
  assert.equal(h.parsedSvg.length, 2);
  assert.equal(h.draw.filter(call => call.method === 'stroke' && call.args[0]?.data === pathData).length, 2);
  assert.deepEqual(h.draw.filter(call => call.method === 'roundRect').map(call => call.args), [[2, 4, 12, 9, 2], [2, 4, 12, 9, 2]]);
  assert.deepEqual(h.draw.filter(call => call.method === 'arc').map(call => call.args), [[8, 7, 3, 0, Math.PI * 2], [8, 7, 3, 0, Math.PI * 2]]);
  api.onFrame.forEach(fn => fn(0));
  const card = api.gl[0].children[0];
  assert.equal(card.position.z, 10);
  assert.equal(card.position.y, 370);
  assert.deepEqual([card.scale.x, card.scale.y, card.scale.z], [1, 1, 1]);
  api.pickables[0].userData.onHover(true);
  api.onFrame.forEach(fn => fn(0));
  assert.equal(card.position.y, 375);
  assert.equal(card.scale.x, 1.05);
});

function stageHarness(initialTab = 'chat', visible = true) {
  const h = harness();
  h.document.documentElement.dataset.tab = initialTab;
  if (!visible) h.document.getElementById('gl').style.display = 'none';
  const chat = h.element('chat');
  const message = h.element('message', chat, 'bubble');
  const text = h.element('message-text', message);
  text.textContent = 'original message';
  const bench = h.element('main');
  const head = h.element('bench-title', bench, 'bench-head');
  head.textContent = 'Today';
  const view = h.element('view', bench);
  const wrap = h.element('panel', view, 'wrap');
  wrap.textContent = 'today content';
  h.load('stage.js');
  const api = moduleApi();
  h.window.ZX_GL_STAGE.mount(api);
  const frame = api.css[0].element;
  const slide = frame.querySelector('.gl-slide');
  const pages = Object.fromEntries(['chat', 'today', 'plan', 'data', 'me'].map((name, i) => [name, slide.children[i]]));
  return { h, api, chat, text, bench, head, wrap, slide, pages, stream: frame.querySelector('.gl-stream') };
}

function assertActivePage(pages, active) {
  for (const [name, page] of Object.entries(pages)) {
    assert.equal(page.inert, name !== active, `${name} inert`);
    assert.equal(page.getAttribute('aria-hidden'), name === active ? 'false' : 'true', `${name} aria-hidden`);
  }
}

test('stage only syncs current tab, marks inactive pages, and switches without motion', () => {
  const { h, api, bench, head, wrap, slide, pages } = stageHarness('today');
  const inner = name => pages[name].querySelector('.gl-page-inner');
  assertActivePage(pages, 'today');
  assert.equal(inner('today').children.length, 2);
  assert.equal(inner('today').children[1].textContent, 'today content');
  for (const name of ['plan', 'data', 'me']) assert.equal(inner(name).children.length, 0);
  assert.equal(inner('today').querySelectorAll('[id]').length, 0);
  api.onFrame.forEach(fn => fn(0));
  assert.equal(slide.style.transform, 'translateX(-1080px)');
  const todayClone = inner('today').children[1];
  h.document.documentElement.dataset.tab = 'plan';
  head.textContent = 'Plan';
  wrap.textContent = 'plan content';
  h.notify(h.document.documentElement);
  assertActivePage(pages, 'plan');
  assert.equal(inner('plan').children[1].textContent, 'plan content');
  assert.equal(inner('today').children[1], todayClone, 'switch must not overwrite inactive page');
  api.onFrame.forEach(fn => fn(0));
  assert.equal(slide.style.transform, 'translateX(-2160px)');
  inner('plan').scrollTop = 73;
  wrap.textContent = 'updated plan';
  const observer = h.observers.find(item => item.target === bench);
  assert.equal(observer.options.subtree, true);
  h.notify(bench);
  h.flushTimers();
  assert.equal(inner('plan').children[1].textContent, 'updated plan');
  assert.equal(inner('plan').scrollTop, 73);
  assert.equal(inner('today').children[1], todayClone);
  // Public go can arrive before the source DOM's tab changes: do not clone the
  // currently rendered plan source into the unrelated data page.
  h.window.ZX_GL_STAGE.go('data');
  assert.equal(inner('data').children.length, 0);
});

test('隐藏舞台不克隆 DOM，显示后 refresh 补齐当前页', () => {
  const { h, chat, stream, pages } = stageHarness('chat', false);
  assert.equal(stream.children.length, 0);
  assert.equal(pages.today.querySelector('.gl-page-inner').children.length, 0);
  h.notify(chat);
  assert.equal(stream.children.length, 0);
  h.document.getElementById('gl').style.display = 'block';
  h.window.ZX_GL_STAGE.refresh();
  assert.equal(stream.children.length, 1);
  assertActivePage(pages, 'chat');
});

test('降级后强制可见的舞台不再克隆 DOM', () => {
  const { h, chat, stream } = stageHarness('chat');
  const first = stream.children[0];
  h.document.documentElement.dataset.gl3d = 'off';
  h.document.getElementById('gl').style.display = 'block';
  h.document.getElementById('css3d').style.display = 'block';
  const second = h.element('second-message', chat, 'bubble');
  second.textContent = 'after fallback';
  h.notify(chat);
  h.window.ZX_GL_STAGE.refresh();
  assert.equal(stream.children.length, 1);
  assert.equal(stream.children[0], first);
});

test('stage preserves unchanged bubbles, replaces changed descendants, and tracks append/remove', () => {
  const { h, api, chat, text, stream, pages } = stageHarness();
  assertActivePage(pages, 'chat');
  const first = stream.children[0];
  assert.equal(first.classList.contains('gl-in'), true);
  assert.equal(first.hasAttribute('id'), false);
  assert.equal(first.querySelectorAll('[id]').length, 0);
  const observer = h.observers.find(item => item.target === chat);
  for (const option of ['childList', 'subtree', 'characterData', 'attributes']) assert.equal(observer.options[option], true);
  h.notify(chat);
  api.onResize.forEach(fn => fn(800, 600));
  assert.equal(stream.children[0], first, 'gl-in/id cleanup must not cause unchanged source to re-clone');
  text.textContent = 'streamed update';
  h.notify(chat, [{ type: 'characterData', target: text }]);
  const updated = stream.children[0];
  assert.notEqual(updated, first);
  assert.equal(updated.children[0].textContent, 'streamed update');
  assert.equal(updated.classList.contains('gl-in'), false);
  const secondSource = h.element('second-message', chat, 'bubble');
  secondSource.textContent = 'new reply';
  h.notify(chat);
  assert.equal(stream.children.length, 2);
  assert.equal(stream.children[0], updated);
  const secondClone = stream.children[1];
  assert.equal(secondClone.classList.contains('gl-in'), true);
  h.notify(chat);
  assert.equal(stream.children[1], secondClone);
  chat.removeChild(secondSource);
  h.notify(chat);
  assert.equal(stream.children.length, 1);
  assert.equal(secondClone.parentNode, null);
  assert.equal(stream.children[0], updated);
});

test('CSS3D 渲染异常、上下文丢失和后台初始化均安全降级且不重复初始化', () => {
  const css = harness({ cssRenderThrows: true });
  css.load('engine.js');
  assert.equal(css.window.ZX_GL.init(), true);
  css.frame(1000);
  assert.equal(css.document.documentElement.dataset.gl3d, 'off');
  assert.equal(css.raf.length, 0);

  const lost = harness();
  lost.load('engine.js');
  assert.equal(lost.window.ZX_GL.init(), true);
  const observerCount = lost.observers.length;
  assert.equal(lost.window.ZX_GL.init(), true);
  assert.equal(lost.observers.length, observerCount);
  lost.document.getElementById('gl').dispatch('webglcontextlost', { preventDefault() {} });
  assert.equal(lost.document.documentElement.dataset.gl3d, 'off');
  assert.equal(lost.raf.length, 0);

  const background = harness();
  background.document.hidden = true;
  background.load('engine.js');
  assert.equal(background.window.ZX_GL.init(), false);
  assert.equal(background.raf.length, 0);
  background.document.hidden = false;
  background.document.dispatch('visibilitychange');
  assert.equal(background.raf.length, 1);
});

test('对话滚回底部后新消息继续贴底', () => {
  const { h, api, chat, stream } = stageHarness('chat');
  stream.scrollHeight = 1000;
  h.notify(chat);
  h.window.dispatch('wheel', { target: stream, deltaY: 100, preventDefault() {} });
  api.onFrame.forEach(fn => fn(1));
  assert.notEqual(stream.style.transform, 'translateY(0px)');
  h.window.dispatch('wheel', { target: stream, deltaY: -100, preventDefault() {} });
  api.onFrame.forEach(fn => fn(1));
  assert.equal(stream.style.transform, 'translateY(0px)');
  const reply = h.element('reply', chat, 'bubble');
  reply.textContent = 'new reply';
  h.notify(chat);
  api.onFrame.forEach(fn => fn(1));
  assert.equal(stream.style.transform, 'translateY(0px)');
});
