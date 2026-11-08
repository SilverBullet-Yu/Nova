/* =========================================================
   诺瓦 Nova · 通用工具
   经典 script（非 ESM）：保证 file:// 双击直接打开
   ========================================================= */
window.ZX = window.ZX || {};

(function (ZX) {
  'use strict';

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function hm(n) {
    return n >= 60
      ? (Math.floor(n / 60) + 'h' + (n % 60 ? String(n % 60).padStart(2, '0') : ''))
      : n + 'm';
  }

  function nowStr() { var d = new Date(); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
  function num(v, dft) { var n = Number(v); return isFinite(n) ? n : dft; }

  /* ---------- 视觉偏好：科技网格 / 辉光 / 动效 / 字号 ---------- */
  var PREF_KEY = 'zx.ui_prefs';
  var PREF_KEYS = ['grid', 'glow', 'motion'];
  var FONTS = ['', 'm', 'l'];

  function prefs() {
    var p = { grid: true, glow: true, motion: true, font: '' };
    try {
      var raw = JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {};
      PREF_KEYS.forEach(function (k) { if (raw[k] === false) p[k] = false; });
      if (raw.font === 'm' || raw.font === 'l') p.font = raw.font;
    } catch (e) { /* 隐私模式禁用存储时使用默认值 */ }
    return p;
  }

  function applyPrefs(p) {
    var v = p || prefs();
    var r = document.documentElement;
    r.dataset.grid = v.grid ? 'on' : 'off';
    r.dataset.glow = v.glow ? 'on' : 'off';
    r.dataset.motion = v.motion ? 'on' : 'off';
    r.dataset.font = FONTS.indexOf(v.font) > 0 ? v.font : '';
    return v;
  }

  function savePrefs(p) {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch (e) { /* 忽略写入失败 */ }
    applyPrefs(p);
    return p;
  }

  function togglePref(k) {
    var p = prefs();
    if (PREF_KEYS.indexOf(k) < 0) return p;
    p[k] = !p[k];
    return savePrefs(p);
  }

  /* 单值偏好（字号 ''|'m'|'l'），与既有布尔偏好合并写入同一键 */
  function setPref(k, v) {
    var p = prefs();
    if (k === 'font') p.font = FONTS.indexOf(v) > 0 ? v : '';
    else if (PREF_KEYS.indexOf(k) >= 0) p[k] = !!v;
    else return p;
    return savePrefs(p);
  }

  ZX.util = {
    $: $, $$: $$, esc: esc, pad2: pad2, hm: hm,
    nowStr: nowStr, sleep: sleep, clone: clone, num: num,
    prefs: prefs, applyPrefs: applyPrefs, togglePref: togglePref, setPref: setPref
  };
  ZX.$ = $;

})(window.ZX);
