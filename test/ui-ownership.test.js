'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../assets/js/ui.js'), 'utf8');

// 只实现 sheet/flowSheet 所用的 DOM；定时器由测试显式推进，不依赖真实时间。
function fixture() {
  let now = 0, timerId = 0;
  const timers = new Map();
  const keyListeners = new Set();
  const focusLog = [];
  const document = {
    activeElement: null,
    addEventListener(type, fn) { if (type === 'keydown') keyListeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'keydown') keyListeners.delete(fn); }
  };
  function element(name) {
    const classes = new Set();
    const listeners = new Map();
    const el = {
      name, parentNode: null, children: [], offsetParent: {}, selectors: new Map(),
      classList: {
        add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
        toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }
      },
      appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
      removeChild(child) {
        this.children.splice(this.children.indexOf(child), 1); child.parentNode = null;
        if (child.contains(document.activeElement)) document.activeElement = document.body;
      },
      contains(child) { return this === child || this.children.some(el => el.contains(child)); },
      focus() { document.activeElement = this; focusLog.push(this); },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatch(type, target = this) { for (const fn of listeners.get(type) || []) fn({ target }); },
      closest(selector) { return selector === '[data-close]' && this.isClose ? this : null; },
      querySelector(selector) { return this.selectors.get(selector) || null; },
      querySelectorAll() { return this.controls || []; }
    };
    return el;
  }
  document.body = element('body');
  document.documentElement = element('html');
  const launcher = document.body.appendChild(element('launcher'));
  launcher.focus();
  document.createElement = () => {
    const wrapper = element('wrapper');
    Object.defineProperty(wrapper, 'innerHTML', { set(html) {
      const root = element('dialog');
      const sheet = root.appendChild(element('sheet'));
      const body = sheet.appendChild(element('sheet-body'));
      const footer = sheet.appendChild(element('sheet-footer'));
      const close = sheet.appendChild(element('close'));
      close.isClose = true;
      root.selectors.set('.sheet', sheet);
      root.selectors.set('.sheet-b', body);
      root.selectors.set('.sheet-f', footer);
      root.selectors.set('[data-close]', close);
      root.controls = [close];
      if (html.includes('autofocus')) {
        const auto = body.appendChild(element('autofocus'));
        root.selectors.set('[autofocus]', auto);
        root.controls.push(auto);
      }
      for (const selector of ['data-no', 'data-yes']) {
        if (!html.includes(selector)) continue;
        const button = footer.appendChild(element(selector));
        root.selectors.set('[' + selector + ']', button);
        root.controls.push(button);
      }
      wrapper.firstElementChild = root;
    } });
    return wrapper;
  };
  const window = { ZX: { util: { esc: value => String(value) } } };
  vm.runInNewContext(source, {
    window, document,
    setTimeout(fn, ms) { timers.set(++timerId, { fn, at: now + ms }); return timerId; }
  });
  return {
    ui: window.ZX.ui, document, launcher, focusLog, keyListeners,
    advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]); now = next[1].at; next[1].fn();
      }
      now = end;
    },
    key(key, shiftKey = false) {
      let prevented = false;
      for (const fn of [...keyListeners]) fn({ key, shiftKey, preventDefault() { prevented = true; } });
      return prevented;
    },
    clickClose(sheet) { sheet.root.dispatch('click', sheet.$('[data-close]')); }
  };
}

test('旧 A.close 与旧遮罩事件不会关闭 B，onClose 仅同步执行一次', () => {
  const f = fixture();
  const closed = [];
  const a = f.ui.sheet({ onClose: value => closed.push(['a', value]) });
  const b = f.ui.sheet({ onClose: value => closed.push(['b', value]) });
  assert.deepEqual(closed, [['a', undefined]]);
  assert.equal(a.root.classList.contains('out'), true);
  a.close('late');
  f.clickClose(a);
  assert.equal(b.root.classList.contains('out'), false);
  assert.equal(f.document.documentElement.classList.contains('no-scroll'), true);
  assert.equal(f.keyListeners.size, 1);
  assert.deepEqual(closed, [['a', undefined]]);
  b.close('done');
  b.close('again');
  assert.deepEqual(closed, [['a', undefined], ['b', 'done']]);
  assert.equal(f.keyListeners.size, 0);
  assert.equal(f.document.documentElement.classList.contains('no-scroll'), false);
  assert.equal(b.root.parentNode, f.document.body);
  f.advance(169);
  assert.equal(b.root.parentNode, f.document.body);
  f.advance(1);
  assert.equal(a.root.parentNode, null);
  assert.equal(b.root.parentNode, null);
});

test('取消同步失效草稿，40/170ms 前到达的异步结果不能应用', async () => {
  const f = fixture();
  let active = true, applied = false, finish;
  const flow = f.ui.flowSheet({
    ns: 'draft', steps: { 1: () => ({ head: ['', 'draft', ''], body: '', footer: '' }) },
    onClose() { active = false; }
  });
  const sheet = flow.open();
  const work = new Promise(resolve => { finish = resolve; }).then(() => { if (active) applied = true; });
  f.clickClose(sheet);
  assert.equal(active, false);
  assert.equal(flow.api, null);
  finish();
  await work;
  assert.equal(applied, false);
  assert.equal(sheet.root.parentNode, f.document.body);
  f.advance(170);
  assert.equal(sheet.root.parentNode, null);
});

test('旧实例 40ms autofocus 必须失效，当前实例仍可 autofocus', () => {
  const f = fixture();
  const a = f.ui.sheet({ body: '<input autofocus>' });
  f.advance(10);
  const b = f.ui.sheet({ body: '<input autofocus>' });
  const bTarget = b.$('[autofocus]');
  bTarget.focus();
  f.advance(30); // A 的 autofocus 到期，B 的尚未到期。
  assert.equal(f.document.activeElement, bTarget);
  assert.equal(f.focusLog.includes(a.$('[autofocus]')), false);
  f.advance(10);
  assert.equal(f.document.activeElement, bTarget);
  assert.equal(f.focusLog.filter(el => el === bTarget).length, 2);
});

test('关闭后未到期的 autofocus 不得再聚焦已关闭弹层', () => {
  const f = fixture();
  const sheet = f.ui.sheet({ body: '<input autofocus>' });
  sheet.close();
  f.advance(40);
  assert.equal(f.document.activeElement, f.launcher);
  assert.equal(f.focusLog.includes(sheet.$('[autofocus]')), false);
});

test('焦点同步返回发起控件，旧 170ms 删除回调不会抢新弹层焦点', () => {
  const f = fixture();
  const a = f.ui.sheet({ body: '<input autofocus>' });
  f.advance(40);
  assert.equal(f.document.activeElement, a.$('[autofocus]'));
  a.close();
  assert.equal(f.document.activeElement, f.launcher);
  const b = f.ui.sheet({ body: '<input autofocus>' });
  f.advance(40);
  const target = b.$('[autofocus]');
  assert.equal(f.document.activeElement, target);
  f.advance(130);
  assert.equal(a.root.parentNode, null);
  assert.equal(f.document.activeElement, target);
  b.close();
  assert.equal(f.document.activeElement, f.launcher);
  f.advance(170);
  assert.equal(f.document.activeElement, f.launcher);
});

test('onClose 同步打开新弹层时，旧 close 的后续清理不破坏新实例', () => {
  const f = fixture();
  let b;
  const a = f.ui.sheet({ onClose() { b = f.ui.sheet({ body: '<input autofocus>' }); } });
  a.close();
  assert.ok(b);
  assert.equal(f.keyListeners.size, 1);
  assert.equal(f.document.documentElement.classList.contains('no-scroll'), true);
  f.advance(170);
  assert.equal(f.document.activeElement, b.$('[autofocus]'));
  assert.equal(b.root.classList.contains('out'), false);
});

test('全局 close、Escape 和 Tab 焦点圈仍作用于当前弹层', () => {
  const f = fixture();
  const values = [];
  const a = f.ui.sheet({ onClose: value => values.push(value), body: '<input autofocus>' });
  f.advance(40);
  assert.equal(f.key('Tab'), true);
  assert.equal(f.document.activeElement, a.$('[data-close]'));
  assert.equal(f.key('Tab', true), true);
  assert.equal(f.document.activeElement, a.$('[autofocus]'));
  assert.equal(f.key('Escape'), true);
  assert.deepEqual(values, [undefined]);
  const b = f.ui.sheet({ onClose: value => values.push(value) });
  f.ui.close('global');
  assert.deepEqual(values, [undefined, 'global']);
  assert.equal(b.root.classList.contains('out'), true);
});

for (const action of ['cancel', 'yes', 'no', 'replace']) {
  test('confirm 的 Promise 保留确认 / 取消语义：' + action, async () => {
    const f = fixture();
    const done = f.ui.confirm({ title: 'confirm' });
    const root = f.document.body.children.at(-1);
    if (action === 'cancel') f.ui.close();
    else if (action === 'replace') f.ui.sheet({});
    else root.querySelector('[data-' + action + ']').dispatch('click');
    assert.equal(await done, action === 'yes');
    assert.equal(root.parentNode, f.document.body);
  });
}
