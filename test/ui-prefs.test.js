'use strict';
/* 视觉偏好（zx.ui_prefs）VM 单测：真实 util.js + 最小 document/localStorage 桩。
   重点回归 A-01：布尔白名单扩到 gl3d（2026-11-28）后，保存其他偏好不得抹掉 gl3d。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

function makeSandbox() {
  const disk = new Map();
  const root = { dataset: {} };
  const ZX = {};
  const sandbox = {
    window: { ZX },
    ZX,
    document: { documentElement: root },
    localStorage: {
      getItem: (k) => (disk.has(k) ? disk.get(k) : null),
      setItem: (k, v) => disk.set(String(k), String(v)),
      removeItem: (k) => disk.delete(k)
    }
  };
  H.installUtil(sandbox);
  return { ZX, root, disk };
}

test('gl3d 偏好缺省开启：prefs 默认 true，applyPrefs 写 data-gl3d="on"', () => {
  const { ZX, root } = makeSandbox();
  assert.equal(ZX.util.prefs().gl3d, true);
  ZX.util.applyPrefs();
  assert.equal(root.dataset.gl3d, 'on');
});

test('togglePref("gl3d") 往返：落盘 zx.ui_prefs 并同步 data-gl3d', () => {
  const { ZX, root, disk } = makeSandbox();
  ZX.util.togglePref('gl3d');
  assert.equal(ZX.util.prefs().gl3d, false);
  assert.equal(root.dataset.gl3d, 'off');
  assert.match(disk.get('zx.ui_prefs'), /"gl3d":false/);
  ZX.util.togglePref('gl3d');
  assert.equal(ZX.util.prefs().gl3d, true);
  assert.equal(root.dataset.gl3d, 'on');
});

test('A-01 回归：保存其他偏好不得抹掉 gl3d:false', () => {
  const { ZX, root } = makeSandbox();
  ZX.util.setPref('gl3d', false);
  assert.equal(root.dataset.gl3d, 'off');
  ZX.util.togglePref('grid');   // 改别的偏好（true → false，切换本身生效）
  assert.equal(ZX.util.prefs().grid, false);
  assert.equal(ZX.util.prefs().gl3d, false, 'gl3d 必须原样保留');
  assert.equal(root.dataset.gl3d, 'off');
});

test('旧存储只含 {gl3d:false}：prefs 读出 false，其余键走缺省', () => {
  const { ZX, disk } = makeSandbox();
  disk.set('zx.ui_prefs', JSON.stringify({ gl3d: false }));   // 模拟旧用户已存的偏好
  const p = ZX.util.prefs();
  assert.equal(p.gl3d, false);
  assert.equal(p.grid, true);
  assert.equal(p.glow, true);
  assert.equal(p.font, '');
});

test('togglePref 不在白名单的键不落盘', () => {
  const { ZX, disk } = makeSandbox();
  const before = disk.get('zx.ui_prefs') || null;
  ZX.util.togglePref('font');   // font 走 setPref 单值路径，toggle 必须拒绝
  assert.equal(disk.get('zx.ui_prefs') || null, before);
});
