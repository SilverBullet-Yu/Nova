/* =========================================================
   诺瓦 Nova · 设置补全（Stage D）
   ---------------------------------------------------------
   F-8.1 可用时段 · F-8.3 真实导出 · F-8.4 删除全部数据（7 天可撤回）
   F-8.5 字号偏好（与 util.prefs 共用 zx.ui_prefs）
   经典 script，IIFE 挂 ZX.flows.settings；无后端亦可完整使用。
   ========================================================= */
window.ZX = window.ZX || {};

(function (ZX) {
  'use strict';

  var U = ZX.util;

  var TRASH_KEY = 'zx.trash';
  var FLASH_KEY = 'zx.flash';
  var QUEUE_KEY = 'zx.op_queue';
  var TTL = 7 * 86400000;

  var DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  var SLOTS = ['08–12', '12–18', '18–22', '22–24'];
  /* 每个时间带的窗口小时：22–24 为静默时段，不参与排程，故为 0 */
  var SLOT_H = [4, 6, 4, 0];
  var DEFAULT_GRID = [
    [true, true, true, false],
    [true, false, true, false],
    [true, true, true, false],
    [false, false, true, false],
    [true, false, true, false],
    [true, true, true, false],
    [true, true, true, false]
  ];

  /* ---------- 可用时段 ---------- */
  function zeroGrid() {
    return [0, 1, 2, 3, 4, 5, 6].map(function () { return [false, false, false, false]; });
  }

  function normGrid(g) {
    var out = zeroGrid();
    for (var d = 0; d < 7; d++) {
      var row = (g && g[d]) || [];
      for (var s = 0; s < 3; s++) out[d][s] = !!row[s];
      out[d][3] = false; /* 静默列永远不可开启 */
    }
    return out;
  }

  function ensure() {
    var S = ZX.state;
    if (!Array.isArray(S.avail) || S.avail.length !== 7) {
      S.avail = normGrid(DEFAULT_GRID);
    } else {
      S.avail = normGrid(S.avail);
    }
    return S.avail;
  }

  function grid() { return ensure(); }

  function metrics() {
    var g = ensure();
    var segs = 0, hours = 0;
    for (var d = 0; d < 7; d++) {
      for (var s = 0; s < 4; s++) {
        if (g[d][s]) { segs++; hours += SLOT_H[s]; }
      }
    }
    return { segs: segs, hours: hours };
  }

  function summaryHtml() {
    var m = metrics();
    return '已选 <b>' + m.segs + '</b> 段 · 可用窗口 <b>' + m.hours + '</b> h';
  }

  /* 局部更新：只改网格与计数，避免整页重绘丢失焦点 / 滚动位置 */
  function syncDom() {
    var g = ensure();
    var wrap = U.$('.sd-avail-grid');
    if (!wrap) { ZX.render(); return; }
    U.$$('.sd-cell').forEach(function (btn) {
      var d = U.num(btn.dataset.day, -1), s = U.num(btn.dataset.slot, -1);
      if (d < 0 || s < 0 || s === 3) return;
      btn.setAttribute('aria-pressed', g[d][s] ? 'true' : 'false');
      btn.setAttribute('aria-label', DAYS[d] + ' ' + SLOTS[s] + (g[d][s] ? '（可排程）' : '（不可排程）'));
    });
    var sum = U.$('.sd-avail-sum');
    if (sum) sum.innerHTML = summaryHtml();
  }

  function queueAvail(field, value) {
    ZX.api.queueOp({ entity: 'avail', entityId: 'grid', field: field, value: value });
  }

  function toggle(day, slot) {
    var d = U.num(day, -1), s = U.num(slot, -1);
    if (d < 0 || d > 6) return;
    if (s === 3) {
      ZX.ui.toast('22:00–08:00 是静默时段，不参与排程', 'warn');
      return;
    }
    if (s < 0 || s > 3) return;
    var g = ensure();
    g[d][s] = !g[d][s];
    queueAvail('toggle', { day: d, slot: s, value: g[d][s] });
    syncDom();
    var btn = U.$('.sd-cell[data-day="' + d + '"][data-slot="' + s + '"]');
    if (btn) { try { btn.focus(); } catch (e) { /* 忽略 */ } }
  }

  /* kind: copy（周一到工作日） / clear（全部清空） / reset（恢复默认） */
  function bulk(kind) {
    var g = ensure();
    if (kind === 'copy') {
      for (var d = 1; d <= 4; d++) g[d] = g[0].slice();
      queueAvail('copyMon', U.clone(g));
      ZX.ui.toast('已把周一的可用时段复制到工作日');
    } else if (kind === 'clear') {
      g = zeroGrid();
      ZX.state.avail = g;
      queueAvail('clear', U.clone(g));
      ZX.ui.toast('已清空全部时段');
    } else if (kind === 'reset') {
      g = normGrid(DEFAULT_GRID);
      ZX.state.avail = g;
      queueAvail('reset', U.clone(g));
      ZX.ui.toast('已恢复默认时段');
    } else {
      return;
    }
    syncDom();
    var btn = U.$('[data-act="avail-bulk"][data-kind="' + kind + '"]');
    if (btn) { try { btn.focus(); } catch (e) { /* 忽略 */ } }
  }

  /* ---------- 导出（本地 CSV，无后端可用；pad2 用 util.js 共用实现） ---------- */
  function ymd(ms) {
    var d = ms === undefined || ms === null ? new Date() : new Date(ms);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + U.pad2(d.getMonth() + 1) + '-' + U.pad2(d.getDate());
  }

  function cell(v) {
    var s = (v === undefined || v === null) ? '' : String(v);
    /* 防公式注入：以 = + - @ 开头的文本在 Excel/WPS 打开时会被当公式执行 */
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function taskStatus(t) {
    if (t.skipped) return '已跳过';
    if (t.done) return '已完成';
    if (t.partial) return '部分完成';
    return '未开始';
  }

  function csv() {
    var S = ZX.state;
    var head = ['类型', '任务ID', '科目', '标题', '预估分钟', '实际分钟', '完成度', '状态', '日期'];
    var today = ymd();
    var rows = [];
    var byId = {};

    (S.tasks || []).forEach(function (t) {
      byId[t.id] = t;
      var pct = (t.completion !== undefined && t.completion !== null)
        ? t.completion
        : (t.done ? 100 : (t.partial || 0));
      rows.push([
        '任务', t.id, t.subject || t.s || '', t.title || '',
        U.num(t.est, 0),
        (t.actual === undefined || t.actual === null) ? '' : U.num(t.actual, 0),
        pct, taskStatus(t), today
      ]);
    });

    (S.sessions || []).forEach(function (s) {
      var t = byId[s.taskId] || {};
      rows.push([
        '记录', s.taskId || '', t.subject || t.s || '', t.title || '',
        '', U.num(s.minutes, 0),
        (s.completion === undefined || s.completion === null) ? '' : U.num(s.completion, 0),
        s.status || '', ymd(s.startAt)
      ]);
    });

    return head.join(',') + '\n' +
      rows.map(function (r) { return r.map(cell).join(','); }).join('\n') + '\n';
  }

  /* 数据行数在组装时统计，避免按换行符拆分把引号内换行误算成多行 */
  function csvRowCount() {
    var n = 0;
    (ZX.state.tasks || []).forEach(function () { n++; });
    (ZX.state.sessions || []).forEach(function () { n++; });
    return n;
  }

  function download(filename, text) {
    var blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      if (a.parentNode) a.parentNode.removeChild(a);
      try { URL.revokeObjectURL(url); } catch (e) { /* 忽略 */ }
    }, 1500);
  }

  function exportCsv() {
    var text = csv();
    var rows = csvRowCount();
    var d = new Date();
    var filename = 'nova-export-' + d.getFullYear() + U.pad2(d.getMonth() + 1) + U.pad2(d.getDate()) + '.csv';
    download(filename, text);
    ZX.state.exportLog = { at: Date.now(), rows: rows, filename: filename };
    ZX.api.queueOp({
      entity: 'export', entityId: 'plan_and_records', field: 'exported',
      value: { filename: filename, rows: rows }
    });
    if (ZX.state.tab === 'me') ZX.render();
    ZX.ui.toast('已导出 ' + rows + ' 行');
  }

  /* ---------- 删除全部数据（7 天可撤回） ---------- */
  function readRaw(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }

  function writeRaw(key, val) {
    try { window.localStorage.setItem(key, val); } catch (e) { /* 隐私模式：忽略 */ }
  }

  function dropRaw(key) {
    try { window.localStorage.removeItem(key); } catch (e) { /* 忽略 */ }
  }

  function readTrash() {
    var raw = readRaw(TRASH_KEY);
    if (!raw) return null;
    var t = null;
    try { t = JSON.parse(raw); } catch (e) { t = null; }
    if (!t || typeof t.at !== 'number' || !t.snapshot) { dropRaw(TRASH_KEY); return null; }
    if (Date.now() - t.at > TTL) { dropRaw(TRASH_KEY); return null; }
    t.daysLeft = Math.max(0, Math.ceil((TTL - (Date.now() - t.at)) / 86400000));
    return t;
  }

  function wipe() {
    var S = ZX.state;
    var snap = {
      tasks: U.clone(S.tasks || []),
      sessions: U.clone(S.sessions || []),
      goal: U.clone(S.goal || null),
      feas: U.clone(S.feas || null),
      avail: U.clone(ensure()),
      week: U.clone(S.week || null),
      at: Date.now()
    };
    writeRaw(TRASH_KEY, JSON.stringify({ at: snap.at, snapshot: snap }));
    dropRaw(QUEUE_KEY);
    writeRaw(FLASH_KEY, '已删除，可在 7 天内恢复');

    /* 先重置内存，再重载到种子状态；重载后由 init() 消费 flash 并提示 */
    S.tasks = [];
    S.sessions = [];
    S.running = null;
    S.timerStart = null;
    S.avail = zeroGrid();
    ZX.ui.toast('已删除，可在 7 天内恢复', 'warn');
    setTimeout(function () { window.location.reload(); }, 260);
  }

  function confirmWipe() {
    ZX.ui.confirm({
      eyebrow: 'DATA / 删除',
      title: '删除全部数据？',
      text: '会删除本机保存的计划、执行记录、目标与可用时段，并清空待同步队列。' +
            '删除后 7 天内可以在「我的」页恢复，超过 7 天自动清除。视觉偏好设置不受影响。',
      okText: '删除全部数据',
      danger: true
    }).then(function (ok) { if (ok) wipe(); });
  }

  function restoreInfo() { return readTrash(); }

  function restore() {
    var t = readTrash();
    if (!t) { ZX.ui.toast('没有可恢复的数据', 'warn'); return false; }
    var S = ZX.state;
    var s = t.snapshot || {};
    if (Array.isArray(s.tasks)) S.tasks = s.tasks.map(ZX.state.normTask);
    if (Array.isArray(s.sessions)) S.sessions = s.sessions;
    if (s.goal) S.goal = s.goal;
    if (s.feas) S.feas = s.feas;
    if (s.week) S.week = s.week;
    if (s.avail) S.avail = normGrid(s.avail);
    dropRaw(TRASH_KEY);
    ZX.api.queueOp({ entity: 'data', entityId: 'all', field: 'restored', value: { at: t.at } });
    ZX.render();
    ZX.ui.toast('已恢复删除前的数据');
    return true;
  }

  /* ---------- 字号偏好（F-8.5） ---------- */
  function setFont(v) {
    var val = (v === 'm' || v === 'l') ? v : '';
    ZX.util.setPref('font', val);
    if (ZX.state.tab === 'me') ZX.render();
    /* 全量重绘会丢焦点：放回当前档位按钮（与 toggle/bulk 的焦点重放一致） */
    var btn = U.$('[data-act="font"][data-v="' + val + '"]');
    if (btn) { try { btn.focus(); } catch (e) { /* 忽略 */ } }
  }

  /* ---------- 启动 ---------- */
  function init() {
    ensure();
    readTrash(); /* 过期即清理 */
    var flash = readRaw(FLASH_KEY);
    if (flash) {
      dropRaw(FLASH_KEY);
      setTimeout(function () { ZX.ui.toast(flash, 'warn'); }, 420);
    }
  }

  ZX.flows = ZX.flows || {};
  ZX.flows.settings = {
    DAYS: DAYS, SLOTS: SLOTS, SLOT_H: SLOT_H, DEFAULT_GRID: DEFAULT_GRID, TTL: TTL,
    ensure: ensure, grid: grid, metrics: metrics, summaryHtml: summaryHtml,
    toggle: toggle, bulk: bulk,
    csv: csv, exportCsv: exportCsv,
    confirmWipe: confirmWipe, restoreInfo: restoreInfo, restore: restore,
    setFont: setFont, init: init
  };
  ZX.settings = ZX.flows.settings;

})(window.ZX);
