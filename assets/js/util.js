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

  ZX.util = {
    $: $, $$: $$, esc: esc, pad2: pad2, hm: hm,
    nowStr: nowStr, sleep: sleep, clone: clone, num: num
  };
  ZX.$ = $;

})(window.ZX);
