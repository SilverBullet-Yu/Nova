'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const H = require('./helpers');
const seed = require('../shared/data/seed.js');

// 仅使用内存 localStorage 和 DOM 桩；不加载服务端模块、不连接网络。
function setup() {
  const stored = H.storage();
  let mode = 'ok';
  const storage = {
    getItem(key) { return stored.localStorage.getItem(key); },
    setItem(key, value) {
      if (mode === 'throw') throw new Error('quota');
      if (mode === 'discard') return;
      stored.localStorage.setItem(key, value);
    },
    removeItem(key) { return stored.localStorage.removeItem(key); }
  };
  const elements = {};
  for (const key of ['#form', '#ctxR', '#ctxGoal', '#btTitle b', '#btMeta', '#view', '#syncDot', '#syncText', '#saveWarning']) {
    elements[key] = { dataset: {}, textContent: '', innerHTML: '', className: '', addEventListener() {}, querySelector() { return null; } };
  }
  const toasts = [];
  const ZX = { api: { isOnline: () => true, pendingCount: () => 0, pendingPlan: () => null, queueOp() {} },
    ui: { countTo() {}, toast: (text, kind) => toasts.push([text, kind]) }, assistant: {} };
  const document = { readyState: 'loading', documentElement: { dataset: {} }, addEventListener() {} };
  const window = { ZX, document, Rhythm: { seed }, localStorage: storage };
  const sandbox = { window, document, crypto: globalThis.crypto };
  H.installUtil(sandbox);
  ZX.util.$ = key => elements[key] || null;
  vm.runInNewContext(fs.readFileSync(require.resolve('../assets/js/state.js'), 'utf8'), sandbox);
  ZX.state.feasibility = () => null;
  vm.runInNewContext(fs.readFileSync(require.resolve('../assets/js/main.js'), 'utf8'), sandbox);
  return { ZX, elements, sandbox, toasts, disk: stored.disk, setMode: value => { mode = value; } };
}

for (const mode of ['throw', 'discard']) {
  test('本机存储 ' + mode + ' 时持续显示保存失败，恢复后才清除警告', () => {
    const app = setup();
    app.ZX.render();
    const previous = app.disk.get('zx.overlay');
    app.ZX.state.tasks[0].title = '修改后的任务';
    app.setMode(mode);
    assert.doesNotThrow(() => app.ZX.render());
    assert.equal(app.disk.get('zx.overlay'), previous);
    assert.equal(app.ZX.state.tasks[0].title, '修改后的任务');
    assert.match(app.elements['#syncText'].textContent, /本机保存失败/);
    assert.match(app.elements['#syncText'].textContent, /刷新可能丢失/);
    assert.doesNotMatch(app.elements['#syncText'].textContent, /已同步/);
    app.ZX.render();
    assert.match(app.elements['#syncText'].textContent, /本机保存失败/);
    app.setMode('ok');
    app.ZX.render();
    assert.equal(JSON.parse(app.disk.get('zx.overlay')).tasks[0].title, '修改后的任务');
    assert.doesNotMatch(app.elements['#syncText'].textContent, /本机保存失败/);
  });
}


test('页面有独立于移动端隐藏同步栏的常驻保存失败警告', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const warning = html.indexOf('id="saveWarning"');
  const sync = html.indexOf('id="syncMain"');
  assert.ok(warning > 0, '缺少独立保存告警');
  assert.ok(warning < sync, '告警不应放进会隐藏的同步栏');
  assert.match(html, /<body>\s*<div id="saveWarning"[^>]*role="alert"[^>]*hidden>/);
  const css = fs.readFileSync(require.resolve('../assets/css/app.css'), 'utf8');
  assert.match(css, /[.]save-warning\[hidden\]\s*\{\s*display\s*:\s*none\s*\}/);
  const app = setup();
  app.setMode('throw');
  app.ZX.render();
  assert.equal(app.elements['#saveWarning'].hidden, false);
  app.setMode('ok');
  app.ZX.render();
  assert.equal(app.elements['#saveWarning'].hidden, true);
});

for (const action of ['toggle', 'copy', 'clear', 'reset']) {
  test('可用时段直接保存失败时立即显示警告且不伪报成功：' + action, () => {
    const app = setup();
    app.ZX.util.$ = key => key === '.sd-avail-grid' ? {} : app.elements[key] || null;
    app.ZX.util.$$ = () => [];
    app.ZX.util.refocus = () => {};
    vm.runInNewContext(fs.readFileSync(require.resolve('../assets/js/flows/settings.js'), 'utf8'), app.sandbox);
    app.ZX.render();
    const previous = app.disk.get('zx.overlay');
    app.setMode('throw');
    if (action === 'toggle') app.ZX.settings.toggle(0, 0);
    else app.ZX.settings.bulk(action);
    assert.equal(app.disk.get('zx.overlay'), previous);
    assert.equal(app.ZX.state.overlaySaveFailed, true);
    assert.equal(app.elements['#saveWarning'].hidden, false);
    assert.ok(app.toasts.some(([message, kind]) => /本机保存失败/.test(message) && kind === 'warn'));
    if (action !== 'toggle') {
      assert.ok(!app.toasts.some(([message]) => /^已(把周一|清空全部|恢复默认)/.test(message)), '不能用成功提示掩盖本机未保存');
    }
    app.setMode('ok');
    app.ZX.settings.toggle(0, 0);
    assert.equal(app.elements['#saveWarning'].hidden, true);
  });
}


test('离线时本机保存失败告警优先于同步状态', () => {
  const app = setup();
  app.ZX.api.isOnline = () => false;
  app.setMode('throw');
  app.ZX.render();
  assert.equal(app.elements['#saveWarning'].hidden, false);
  assert.match(app.elements['#syncText'].textContent, /本机保存失败/);
});

test('可用时段批量操作保存成功后显示成功提示，不显示失败提示', () => {
  const app = setup();
  app.ZX.util.$ = key => key === '.sd-avail-grid' ? {} : app.elements[key] || null;
  app.ZX.util.$$ = () => [];
  app.ZX.util.refocus = () => {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../assets/js/flows/settings.js'), 'utf8'), app.sandbox);
  app.ZX.settings.bulk('clear');
  assert.ok(app.toasts.some(([message]) => message === '已清空全部时段'));
  assert.ok(!app.toasts.some(([message]) => /本机保存失败/.test(message)));
  assert.equal(app.elements['#saveWarning'].hidden, true);
});
