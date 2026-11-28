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
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function hm(n) {
    return n >= 60
      ? (Math.floor(n / 60) + 'h' + (n % 60 ? String(n % 60).padStart(2, '0') : ''))
      : n + 'm';
  }

  function nowStr() { var d = new Date(); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  /* 真实时钟的星期标签（'日'..'六' → '一'..'日'）；周图「今天」高亮、今日弹性位等
     按此对齐——seed.week 里的 today 旗标是示例数据（测试有断言），不代表演示日期 */
  function todayDow() {
    var map = ['日', '一', '二', '三', '四', '五', '六'];
    return map[new Date().getDay()];
  }
  /* 毫秒时间戳 → HH:MM（快照 / 重排记录等展示用；非法输入返回空串） */
  function tsHM(ms) {
    var d = new Date(ms);
    return isNaN(d.getTime()) ? '' : pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  /* ISO 周数（周一为一周之始），周报与趋势图标注用 */
  function isoWeek(date) {
    var d = date ? new Date(date) : new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
    var w1 = new Date(d.getFullYear(), 0, 4);
    return 1 + Math.round(((d - w1) / 86400000 - 3 + ((w1.getDay() + 6) % 7)) / 7);
  }

  /* ---------- 日期与时段（goal / rescue / exec flows 共用） ---------- */
  /* 'YYYY-MM-DD' → 当日 0 点 Date；非法输入返回 null */
  function parseDay(str) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || ''));
    if (!m) return null;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
    d.setHours(0, 0, 0, 0);
    return isNaN(d.getTime()) ? null : d;
  }

  /* Date → 'YYYY-MM-DD' */
  function isoDay(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /* 日期 ±n 天（不改原对象） */
  function addDays(d, n) {
    var x = new Date(d.getTime());
    x.setDate(x.getDate() + n);
    return x;
  }

  /* 按新工时重算 'HH:MM–HH:MM' 时段终点；起始小时兼容 9:00 与 09:00，输出统一补零 */
  function retime(str, minutes) {
    var m = String(str || '').match(/^(\d{1,2}):(\d{2})/);
    if (!m) return str;
    var start = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    var end = start + num(minutes, 0);
    return pad2(Math.floor(start / 60)) + ':' + pad2(start % 60) + '–' +
      pad2(Math.floor(end / 60) % 24) + ':' + pad2(end % 60);
  }

  /* 0.23 → '23%'（负载增幅等展示） */
  function pct(v) {
    if (typeof v !== 'number' || !isFinite(v)) return '0%';
    return (Math.round(v * 1000) / 10) + '%';
  }

  /* ---------- 记录日口径（执行记录 / 中断识别 / 周报共用） ---------- */
  /* 毫秒时间戳 → 'YYYY-MM-DD'（本地时区）；非法输入返回空串 */
  function dayKey(ts) {
    if (typeof ts !== 'number' || !isFinite(ts)) return '';
    var d = new Date(ts);
    return isNaN(d.getTime()) ? '' : isoDay(d);
  }
  function todayKey() { return isoDay(new Date()); }

  /* ---------- 通用小件 ---------- */
  /* 按 id 线性查找（任务 / 草案项共用，替换各 flow 的同名三胞胎） */
  function findById(list, id) {
    var arr = Array.isArray(list) ? list : [];
    for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].id === id) return arr[i];
    return null;
  }
  /* 今天 0 点（本地时区）：挽救缺口推演、目标周期计算共用 */
  function today0() {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }
  /* 16 字节 crypto 随机的十六进制串：sync / 重排 / 排程 / 计划版本四条 trace 的事件 id */
  function randHex() {
    var bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, function (v) { return v.toString(16).padStart(2, '0'); }).join('');
  }
  /* localStorage 留痕：追加一条事件并只保留最后 99 条 + 本次；
     同一实现供 zx.syncTrace / zx.replanTrace / zx.scheduleTrace / zx.executionTrace 共用，
     留痕失败静默忽略（不影响主链路）。经 window 访问存储，VM 测试的 window 桩同样可装配 */
  function appendTrace(key, event) {
    try {
      var store = window.localStorage;
      var raw = store.getItem(key);
      var events = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(events)) events = [];
      store.setItem(key, JSON.stringify(events.slice(-99).concat([event])));
    } catch (e) { /* 隐私模式 / 配额不足：跳过留痕 */ }
  }
  /* 聚焦重放：全量重绘后把焦点放回原控件；不抛错 */
  function refocus(el) {
    if (el && el.focus) { try { el.focus(); } catch (e) { /* 忽略 */ } }
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
  function num(v, dft) { var n = Number(v); return isFinite(n) ? n : dft; }

  /* ---------- 业务快照字段清单（overlay 持久化与备份校验的单一事实源） ----------
     state.js 用它写 overlay 快照与冲突比对；flows/settings.js 用它做备份导入校验。
     新增/删除业务字段只改此处，避免两处复制漂移。 */
  var SNAPSHOT_FIELDS = ['tasks', 'sessions', 'goal', 'feas', 'week', 'weekShift',
    'placementModel', 'dayAssign', 'locks', 'avail', 'availSource', 'notif', 'attrCounts',
    'consecutiveZeroDays', 'interrupted', 'rescueRecord', 'replanHistory', 'replanSnapshot'];
  var OPTIONAL_SNAPSHOT_FIELDS = ['buffer', 'tiredAdopted'];

  /* ---------- 视觉偏好：科技网格 / 辉光 / 动效 / 字号 / 3D 舞台 ---------- */
  var PREF_KEY = 'zx.ui_prefs';
  var PREF_KEYS = ['grid', 'glow', 'motion', 'gl3d'];
  var FONTS = ['', 'm', 'l'];

  function prefs() {
    /* 动效：显式选择优先于系统提示——只有从未选择过（raw.motion 非布尔）时
       才跟随 prefers-reduced-motion；产品开关置 on 后系统设置不再拦截 */
    var reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    var p = { grid: true, glow: true, motion: !reduce, gl3d: true, font: '' };
    try {
      var raw = JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {};
      PREF_KEYS.forEach(function (k) { if (raw[k] === false) p[k] = false; });
      if (raw.motion === true) p.motion = true;
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
    r.dataset.gl3d = v.gl3d ? 'on' : 'off';
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
    SNAPSHOT_FIELDS: SNAPSHOT_FIELDS,
    OPTIONAL_SNAPSHOT_FIELDS: OPTIONAL_SNAPSHOT_FIELDS,
    $: $, $$: $$, esc: esc, pad2: pad2, hm: hm,
    nowStr: nowStr, tsHM: tsHM, isoWeek: isoWeek, todayDow: todayDow,
    parseDay: parseDay, isoDay: isoDay, addDays: addDays, retime: retime, pct: pct,
    dayKey: dayKey, todayKey: todayKey,
    findById: findById, refocus: refocus, today0: today0,
    randHex: randHex, appendTrace: appendTrace,
    sleep: sleep, clone: clone, num: num,
    prefs: prefs, applyPrefs: applyPrefs, togglePref: togglePref, setPref: setPref
  };

})(window.ZX);
