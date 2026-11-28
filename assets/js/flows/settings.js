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
  var BACKUP_FORMAT = 'nova-backup';
  var BACKUP_VERSION = 1;
  /* 生产路径以 util.js 的单一事实源为准；下方回退仅为兼容未加载 util 的极简测试桩。 */
  var SNAPSHOT_FIELDS = U.SNAPSHOT_FIELDS || ['tasks', 'sessions', 'goal', 'feas', 'week', 'weekShift',
    'placementModel', 'dayAssign', 'locks', 'avail', 'availSource', 'notif', 'attrCounts',
    'consecutiveZeroDays', 'interrupted', 'rescueRecord', 'replanHistory', 'replanSnapshot'];
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
      S.availSource = 'default';
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
    return '已选 <b>' + m.segs + '</b> 段 · 可用窗口 <b>' + m.hours + '</b> h · ' + ({ default: '默认模板', user: '用户设置', legacy: '旧版设置' }[ZX.state.availSource] || '来源未知');
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

  function warnAvailabilityChanged() {
    if (ZX.state.placementAvailabilityMatches && ZX.state.placementAvailabilityMatches() === false) {
      ZX.ui.toast('可用时段已变化，当前计划仍保留旧窗口；重新生成目标后按新时段生效', 'warn');
    }
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
    ZX.state.availSource = 'user';
    if (ZX.state.saveOverlay() === false) ZX.ui.toast('本机保存失败，修改仅在当前页面；刷新可能丢失', 'warn');
    queueAvail('toggle', { day: d, slot: s, value: g[d][s] });
    syncDom();
    warnAvailabilityChanged();
    U.refocus(U.$('.sd-cell[data-day="' + d + '"][data-slot="' + s + '"]'));
  }

  /* kind: copy（周一到工作日） / clear（全部清空） / reset（恢复默认） */
  function bulk(kind) {
    var g = ensure();
    var message;
    if (kind === 'copy') {
      for (var d = 1; d <= 4; d++) g[d] = g[0].slice();
      queueAvail('copyMon', U.clone(g));
      message = '已把周一的可用时段复制到工作日';
    } else if (kind === 'clear') {
      g = zeroGrid();
      ZX.state.avail = g;
      queueAvail('clear', U.clone(g));
      message = '已清空全部时段';
    } else if (kind === 'reset') {
      g = normGrid(DEFAULT_GRID);
      ZX.state.avail = g;
      queueAvail('reset', U.clone(g));
      message = '已恢复默认时段';
    } else {
      return;
    }
    ZX.state.availSource = kind === 'reset' ? 'default' : 'user';
    if (ZX.state.saveOverlay() === false) ZX.ui.toast('本机保存失败，修改仅在当前页面；刷新可能丢失', 'warn');
    else ZX.ui.toast(message);
    syncDom();
    warnAvailabilityChanged();
    U.refocus(U.$('[data-act="avail-bulk"][data-kind="' + kind + '"]'));
  }

  /* ---------- 导出（本地 CSV，无后端可用；pad2 用 util.js 共用实现） ---------- */
  function ymd(ms) {
    if (ms === undefined || ms === null) return '';
    var d = new Date(ms);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + U.pad2(d.getMonth() + 1) + '-' + U.pad2(d.getDate());
  }

  function cell(v) {
    var s = (v === undefined || v === null) ? '' : String(v);
    /* 防公式注入：公式符号及制表符开头的文本加前缀。 */
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function taskStatus(t, unplanned) {
    if (t.skipped) return '已跳过';
    if (t.done) return '已完成';
    if (t.partial) return '部分完成';
    if (t.deferred) return '今日暂缓';
    if (t.abandoned) return '已放弃';
    if (t.substituted) return '已替代';
    if (t.unplanned || unplanned[t.id]) return '未排入';
    return '未开始';
  }

  function taskDate(t) {
    if (typeof t.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(t.date)) return '';
    var parts = t.date.split('-').map(Number);
    var parsed = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    if (isNaN(parsed.getTime()) || parsed.getUTCFullYear() !== parts[0] ||
        parsed.getUTCMonth() !== parts[1] - 1 || parsed.getUTCDate() !== parts[2]) return '';
    return t.date;
  }

  function availabilityRows() {
    var S = ZX.state;
    if (!Array.isArray(S.avail) || S.avail.length !== DAYS.length || S.availSource === 'default') return [];
    var source = S.availSource === 'user' ? '用户设置' : '旧版设置';
    var rows = [];
    DAYS.forEach(function (day, d) {
      SLOTS.slice(0, 3).forEach(function (slot, i) {
        var enabled = Array.isArray(S.avail[d]) && S.avail[d][i] === true;
        rows.push(['可用时段', '', '', day + ' ' + slot + '（' + source + '）', '', '', '', enabled ? '可排程' : '不可排程', '', '']);
      });
    });
    return rows;
  }

  function goalRows() {
    var goal = ZX.state.goal;
    if (!goal || goal.source !== 'user' || !goal.name) return [];
    return [['阶段目标', '', '', goal.name, '', '', '', '用户设置', goal.deadline || '', '']];
  }

  function csv() {
    var S = ZX.state;
    var head = ['类型', '任务ID', '科目', '标题', '预估分钟', '实际分钟', '完成度', '状态', '日期', '计划版本'];
    var rows = [];
    var byId = {};
    var unplanned = Object.create(null);
    if (S.placementModel && Array.isArray(S.placementModel.unplanned)) {
      S.placementModel.unplanned.forEach(function (item) { unplanned[item.taskId] = true; });
    }

    (S.tasks || []).forEach(function (t) {
      byId[t.id] = t;
      var pct = (t.completion !== undefined && t.completion !== null)
        ? t.completion
        : (t.done ? 100 : (t.partial || 0));
      rows.push([
        '任务', t.id, t.subject || t.s || '', t.title || '',
        U.num(t.est, 0),
        (t.actual === undefined || t.actual === null) ? '' : U.num(t.actual, 0),
        pct, taskStatus(t, unplanned), taskDate(t), ''
      ]);
    });

    (S.sessions || []).forEach(function (s) {
      var t = byId[s.taskId] || {};
      rows.push([
        '记录', s.taskId || '', t.subject || t.s || '', t.title || '',
        '', (s.minutes === undefined || s.minutes === null) ? '' : U.num(s.minutes, 0),
        (s.completion === undefined || s.completion === null) ? '' : U.num(s.completion, 0),
        s.status || '', ymd(s.startAt), s.planVersion || ''
      ]);
    });

    var lines = rows.concat(availabilityRows(), goalRows()).map(function (r) { return r.map(cell).join(','); });
    return [head.join(',')].concat(lines).join('\n') + '\n';
  }

  /* 数据行数在组装时统计，避免按换行符拆分把引号内换行误算成多行 */
  function csvRowCount() {
    var n = 0;
    (ZX.state.tasks || []).forEach(function () { n++; });
    (ZX.state.sessions || []).forEach(function () { n++; });
    return n + availabilityRows().length + goalRows().length;
  }

  function download(filename, text, mime) {
    var type = mime || 'text/csv;charset=utf-8';
    var blob = new Blob([(mime ? '' : '\ufeff') + text], { type: type });
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

  /* ---------- 完整 JSON 备份（业务白名单，不含凭据或待同步队列） ---------- */
  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  var SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  var MAX_TEXT_LENGTH = 200; /* 与目标名 / 计划项标题的输入上限一致 */
  var UNSAFE_TEXT = /[\u0000-\u001F\u007F]/;

  /* 备份是纯文本数据，正常尖括号由 UI 转义；这里只拒绝控制字符。 */
  function validateSafeStrings(value, path) {
    if (typeof value === 'string') {
      if (UNSAFE_TEXT.test(value)) throw new Error(path + ' 含不安全字符');
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(function (item, index) { validateSafeStrings(item, path + '[' + index + ']'); });
      return;
    }
    if (isObject(value)) {
      Object.keys(value).forEach(function (key) {
        validateSafeStrings(key, path + ' 的键');
        validateSafeStrings(value[key], path + '.' + key);
      });
    }
  }

  function validateId(value, label) {
    if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(label + ' 必须是安全字符串 ID');
  }

  function validateText(value, label, maxLength) {
    if (value === undefined || value === null) return;
    if (typeof value !== 'string' || value.length > maxLength) {
      throw new Error(label + ' 必须是长度不超过 ' + maxLength + ' 的字符串');
    }
  }

  function validateSnapshot(snapshot) {
    if (!isObject(snapshot)) throw new Error('snapshot 必须是对象');
    var missing = SNAPSHOT_FIELDS.filter(function (key) {
      return ['placementModel', 'consecutiveZeroDays', 'interrupted', 'rescueRecord'].indexOf(key) < 0 &&
        !Object.prototype.hasOwnProperty.call(snapshot, key);
    });
    if (missing.length) throw new Error('snapshot 缺少字段：' + missing.join(', '));
    if (snapshot.planVersion !== undefined &&
        !/^plan-[0-9a-f]{32}$/.test(snapshot.planVersion)) throw new Error('planVersion 无效');
    ['tasks', 'sessions', 'week', 'weekShift', 'replanHistory'].forEach(function (key) {
      if (!Array.isArray(snapshot[key]) || snapshot[key].some(function (item) { return !isObject(item); })) {
        throw new Error(key + ' 必须是对象数组');
      }
    });
    ['goal', 'feas', 'dayAssign', 'locks', 'attrCounts'].forEach(function (key) {
      if (!isObject(snapshot[key])) throw new Error(key + ' 必须是对象');
    });
    if (snapshot.placementModel !== undefined && snapshot.placementModel !== null) {
      var P = window.Rhythm && window.Rhythm.placementModel;
      if (!P) throw new Error('落点模型不可用');
      var model = P.normalizeModel(snapshot.placementModel);
    }
    if (snapshot.week.concat(snapshot.weekShift).some(function (day) {
      return !Array.isArray(day.segs) || day.segs.some(function (seg) {
        return !((Array.isArray(seg) && seg.length >= 2) ||
          (typeof seg === 'number' && isFinite(seg)));
      });
    })) throw new Error('week / weekShift 的 segs 结构无效');
    if (snapshot.avail !== null && (!Array.isArray(snapshot.avail) || snapshot.avail.length !== 7 ||
        snapshot.avail.some(function (row) {
          return !Array.isArray(row) || row.length !== 4 || row.some(function (cell) { return typeof cell !== 'boolean'; });
        }))) throw new Error('avail 必须是 7 × 4 布尔数组或 null');
    if (snapshot.availSource !== null && ['default', 'user', 'legacy'].indexOf(snapshot.availSource) < 0) {
      throw new Error('availSource 无效');
    }
    if (snapshot.notif !== null && !isObject(snapshot.notif)) throw new Error('notif 必须是对象或 null');
    if (snapshot.consecutiveZeroDays !== undefined && (typeof snapshot.consecutiveZeroDays !== 'number' || !isFinite(snapshot.consecutiveZeroDays))) throw new Error('consecutiveZeroDays 无效');
    if (snapshot.interrupted !== undefined && snapshot.interrupted !== null && typeof snapshot.interrupted !== 'boolean') throw new Error('interrupted 无效');
    if (snapshot.rescueRecord !== undefined && snapshot.rescueRecord !== null && !isObject(snapshot.rescueRecord)) throw new Error('rescueRecord 无效');
    if (snapshot.buffer !== undefined && (!isObject(snapshot.buffer) || typeof snapshot.buffer.free !== 'boolean' ||
        (snapshot.buffer.time !== undefined && typeof snapshot.buffer.time !== 'string'))) throw new Error('buffer 无效');
    if (snapshot.tiredAdopted !== undefined && typeof snapshot.tiredAdopted !== 'boolean') throw new Error('tiredAdopted 无效');
    if (snapshot.replanSnapshot !== null && (!isObject(snapshot.replanSnapshot) ||
        !Array.isArray(snapshot.replanSnapshot.tasks) ||
        snapshot.replanSnapshot.tasks.some(function (task) { return !isObject(task); }))) {
      throw new Error('replanSnapshot 结构无效');
    }
    if (['token', 'opQueue', 'op_queue', 'queue'].some(function (key) {
      return Object.prototype.hasOwnProperty.call(snapshot, key);
    })) throw new Error('snapshot 不得包含凭据或操作队列');
    validateSafeStrings(snapshot, 'snapshot');
    function validateTask(task, label) {
      validateId(task.id, label + '.id');
      if (task.substitutedBy !== undefined && task.substitutedBy !== null) {
        validateId(task.substitutedBy, label + '.substitutedBy');
      }
      if (task.replaces !== undefined && task.replaces !== null) validateId(task.replaces, label + '.replaces');
      validateText(task.title, label + '.title', MAX_TEXT_LENGTH);
      validateText(task.s, label + '.s', 80);
      validateText(task.subject, label + '.subject', 80);
      validateText(task.domain, label + '.domain', 80);
      validateText(task.time, label + '.time', 64);
      validateText(task.skipReason, label + '.skipReason', 300);
      validateText(task.deferredReason, label + '.deferredReason', 300);
      validateText(task.localNote, label + '.localNote', 1000);
    }
    function validateFinite(value, label, min, max) {
      if (value === undefined || value === null) return;
      if (typeof value !== 'number' || !isFinite(value) || value < min || (max !== undefined && value > max)) {
        throw new Error(label + ' 必须是' + (max === undefined ? '不小于 ' + min : ' ' + min + '–' + max) + ' 的有限数值');
      }
    }
    var taskIds = Object.create(null);
    snapshot.tasks.forEach(function (task, index) {
      validateTask(task, 'tasks[' + index + ']');
      if (taskIds[task.id]) throw new Error('任务 ID 重复：' + task.id);
      taskIds[task.id] = true;
      validateFinite(task.est, 'tasks[' + index + '].est', 0);
      validateFinite(task.weight, 'tasks[' + index + '].weight', 0);
      validateFinite(task.actual, 'tasks[' + index + '].actual', 0);
      validateFinite(task.plannedEst, 'tasks[' + index + '].plannedEst', 0);
      validateFinite(task.completion, 'tasks[' + index + '].completion', 0, 100);
      validateFinite(task.partial, 'tasks[' + index + '].partial', 0, 100);
    });
    if (model) {
      var dangling = model.placements.some(function (placement) { return !taskIds[placement.taskId]; }) ||
        model.unplanned.some(function (item) { return !taskIds[item.taskId]; });
      if (dangling) throw new Error('placementModel 引用了 snapshot.tasks 中不存在的任务');
    }
    var sessionIds = Object.create(null);
    snapshot.sessions.forEach(function (session, index) {
      validateId(session.id, 'sessions[' + index + '].id');
      validateId(session.taskId, 'sessions[' + index + '].taskId');
      if (sessionIds[session.id]) throw new Error('session ID 重复：' + session.id);
      sessionIds[session.id] = true;
      if (!taskIds[session.taskId]) throw new Error('sessions[' + index + '] 引用了不存在的任务');
      validateFinite(session.minutes, 'sessions[' + index + '].minutes', 0);
      validateFinite(session.startAt, 'sessions[' + index + '].startAt', 0);
      validateFinite(session.endAt, 'sessions[' + index + '].endAt', 0);
      validateFinite(session.completion, 'sessions[' + index + '].completion', 0, 100);
      if (session.startAt !== undefined && session.endAt !== undefined && session.endAt < session.startAt) {
        throw new Error('sessions[' + index + '] 的结束时间早于开始时间');
      }
      validateText(session.status, 'sessions[' + index + '].status', 64);
      validateText(session.note, 'sessions[' + index + '].note', 1000);
      validateText(session.feel, 'sessions[' + index + '].feel', 300);
    });
    if (snapshot.replanSnapshot) {
      var snapshotTaskIds = Object.create(null);
      snapshot.replanSnapshot.tasks.forEach(function (task, index) {
        validateTask(task, 'replanSnapshot.tasks[' + index + ']');
        if (snapshotTaskIds[task.id]) throw new Error('replanSnapshot 任务 ID 重复：' + task.id);
        snapshotTaskIds[task.id] = true;
      });
    }
    validateText(snapshot.goal.name, 'goal.name', MAX_TEXT_LENGTH);
    validateText(snapshot.goal.deadline, 'goal.deadline', 64);
    validateText(snapshot.goal.source, 'goal.source', 64);
    validateFinite(snapshot.goal.weeks, 'goal.weeks', 0);
    validateFinite(snapshot.feas.weeklyH, 'feas.weeklyH', 0);
    validateFinite(snapshot.feas.weeks, 'feas.weeks', 0);
    validateFinite(snapshot.feas.discount, 'feas.discount', 0, 1);
    validateFinite(snapshot.feas.demand, 'feas.demand', 0);
    Object.keys(snapshot.dayAssign).forEach(function (id) {
      validateId(id, 'dayAssign 的任务 ID');
      if (!taskIds[id] || ['日', '一', '二', '三', '四', '五', '六'].indexOf(snapshot.dayAssign[id]) < 0) {
        throw new Error('dayAssign 引用了不存在的任务或非法星期：' + id);
      }
    });
    Object.keys(snapshot.locks).forEach(function (id) {
      validateId(id, 'locks 的任务 ID');
      if (!taskIds[id]) throw new Error('locks 引用了不存在的任务：' + id);
    });
    return snapshot;
  }

  function parseBackup(text) {
    var backup;
    try {
      backup = JSON.parse(String(text).replace(/^\uFEFF/, ''));
    } catch (e) {
      throw new Error('文件不是有效 JSON');
    }
    if (!isObject(backup) || backup.format !== BACKUP_FORMAT) throw new Error('不是 Nova 完整备份');
    if (backup.version !== BACKUP_VERSION) throw new Error('完整备份版本不受支持');
    if (typeof backup.createdAt !== 'string' || !isFinite(Date.parse(backup.createdAt))) {
      throw new Error('createdAt 无效');
    }
    if (typeof backup.installId !== 'string' || !backup.installId.trim()) throw new Error('installId 无效');
    validateSnapshot(backup.snapshot);
    return backup;
  }

  function exportBackup() {
    if (ZX.state.localLoadFailed) throw new Error('本地数据加载失败，已禁止把种子数据当作完整备份导出');
    var snapshot = ZX.state.exportSnapshot();
    validateSnapshot(snapshot);
    return {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      installId: ZX.state.getInstallId(),
      snapshot: snapshot
    };
  }

  function downloadBackup() {
    try {
      var backup = exportBackup();
      var d = new Date();
      var filename = 'nova-backup-' + d.getFullYear() + U.pad2(d.getMonth() + 1) + U.pad2(d.getDate()) + '.json';
      download(filename, JSON.stringify(backup, null, 2) + '\n', 'application/json;charset=utf-8');
      ZX.ui.toast('完整备份已导出');
      return true;
    } catch (e) {
      ZX.ui.toast(e.message || '完整备份导出失败', 'warn');
      return false;
    }
  }

  function readRawStrict(key) {
    var value = window.localStorage.getItem(key);
    return value === undefined ? null : value;
  }

  function writeVerified(key, value) {
    window.localStorage.setItem(key, value);
    if (readRawStrict(key) !== value) throw new Error(key + ' 回读校验失败');
  }

  function restoreRaw(key, raw) {
    if (raw === null) {
      window.localStorage.removeItem(key);
      if (readRawStrict(key) !== null) throw new Error(key + ' 回滚校验失败');
    } else {
      writeVerified(key, raw);
    }
  }

  function restoreRawOverlay(raw, snapshot) {
    restoreRaw('zx.overlay', raw);
    if (snapshot && typeof ZX.state.applySnapshot === 'function') ZX.state.applySnapshot(snapshot);
    ZX.state.applyOverlay();
  }

  function withOverlayLock(task) {
    var locks = typeof navigator !== 'undefined' ? navigator.locks : (window.navigator && window.navigator.locks);
    return locks && typeof locks.request === 'function' ? locks.request('nova-local-overlay', task) : task();
  }

  var importingBackup = false;
  async function importBackupUnlocked(input) {
    var stage = '校验';
    var previousRaw = null;
    var previousTrashRaw = null;
    var previousSnapshot = null;
    var writtenRaw = null;
    var writtenTrashRaw = null;
    var preservedExternal = false;
    var overlayTouched = false;
    var trashTouched = false;
    try {
      var text;
      if (typeof input === 'string') text = input;
      else if (input && typeof input.text === 'function') text = await input.text();
      else throw new Error('请选择 JSON 文件或提供备份文本');
      var backup = parseBackup(text);
      stage = '确认';
      var confirmed = await ZX.ui.confirm({
        eyebrow: 'DATA / 完整备份',
        title: '导入完整备份？',
        text: '将用备份覆盖当前计划、执行记录、目标与可用时段。覆盖前的当前业务快照会保留在 7 天回收站；凭据、旧队列与待复核记录不会被带入或改动。',
        okText: '导入并覆盖',
        danger: true
      });
      if (!confirmed) return false;

      var S = ZX.state;
      previousSnapshot = S.exportSnapshot();
      previousRaw = readRawStrict('zx.overlay');
      previousTrashRaw = readRawStrict(TRASH_KEY);
      stage = '保存覆盖前快照';
      var at = Date.now();
      trashTouched = true;
      writtenTrashRaw = JSON.stringify({ at: at, snapshot: previousSnapshot });
      writeVerified(TRASH_KEY, writtenTrashRaw);

      stage = '写入与回读校验';
      overlayTouched = true;
      var committed = S.commitSnapshot(backup.snapshot);
      var writeEvidence = typeof S.overlayWriteEvidence === 'function' ? S.overlayWriteEvidence() : { attempt: null, verified: null };
      writtenRaw = writeEvidence.verified || writeEvidence.attempt || null;
      if (!committed) throw new Error('本机 overlay 写入失败');
      var saved = JSON.parse(writtenRaw || 'null');
      var expected = S.exportSnapshot();
      if (!saved || saved.format !== 'nova-overlay' || saved.version !== 3 ||
          saved.syncMode !== 'local-only' || saved.installId !== S.getInstallId() ||
          saved.revision !== S.overlayRevision || saved.updatedAt !== S.overlayUpdatedAt ||
          saved.planVersion !== expected.planVersion ||
          SNAPSHOT_FIELDS.some(function (key) {
            return JSON.stringify(saved[key]) !== JSON.stringify(expected[key]);
          })) throw new Error('导入结果回读不一致');

      /* 再走一次真实重载路径，确认落盘数据可安全恢复，而不只比较内存字段。 */
      if (!S.applyOverlay() || S.localLoadFailed) throw new Error('导入结果重载校验失败');
      var reloaded = S.exportSnapshot();
      if (reloaded.planVersion !== expected.planVersion || SNAPSHOT_FIELDS.some(function (key) {
        return JSON.stringify(reloaded[key]) !== JSON.stringify(expected[key]);
      })) throw new Error('导入结果重载不一致');
      if (typeof S.resetTimer === 'function') S.resetTimer();
      /* overlay 已完成提交与重载校验；这里只重绘，不重复持久化。 */
      ZX.render({ skipOverlaySave: true });

      ZX.ui.toast('完整备份导入成功；覆盖前数据可在 7 天内恢复');
      return true;
    } catch (e) {
      var rollbackFailures = [];
      /* 两项独立尝试并回读校验：一项失败不得阻止另一项恢复。
         若另一页已改动当前值，则保留其写入，不用旧快照反向覆盖。 */
      if (overlayTouched) {
        try {
          var currentRaw = readRawStrict('zx.overlay');
          if (currentRaw === previousRaw || (writtenRaw !== null && currentRaw === writtenRaw)) {
            restoreRawOverlay(previousRaw, previousSnapshot);
          } else {
            preservedExternal = true;
            S.applyOverlay();
          }
        } catch (rollbackError) {
          rollbackFailures.push('原 overlay 回滚失败');
        }
      }
      if (trashTouched) {
        try {
          var currentTrashRaw = readRawStrict(TRASH_KEY);
          if (currentTrashRaw === previousTrashRaw || currentTrashRaw === writtenTrashRaw) {
            restoreRaw(TRASH_KEY, previousTrashRaw);
          } else {
            preservedExternal = true;
          }
        } catch (rollbackError) {
          rollbackFailures.push('原 trash 回滚失败');
        }
      }
      ZX.ui.toast('完整备份导入失败（' + stage + '）：' + (e.message || '未知错误') +
        (rollbackFailures.length
          ? '；' + rollbackFailures.join('；') + '，请保留页面并立即导出当前数据'
          : preservedExternal
            ? '；已保留另一标签页的更新，未用旧快照覆盖'
            : '；原数据未改变'), 'warn');
      return false;
    }
  }

  async function importBackup(input) {
    if (importingBackup) {
      ZX.ui.toast('正在导入完整备份，请稍候', 'warn');
      return false;
    }
    importingBackup = true;
    try {
      return await withOverlayLock(function () { return importBackupUnlocked(input); });
    } catch (e) {
      ZX.ui.toast('无法获得本机存储锁，未导入备份', 'warn');
      return false;
    } finally {
      importingBackup = false;
    }
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

  function dropTrashIfUnchanged(expected) {
    try {
      if (readRawStrict(TRASH_KEY) !== expected) return true;
      window.localStorage.removeItem(TRASH_KEY);
      return readRawStrict(TRASH_KEY) === null;
    } catch (e) {
      return false;
    }
  }

  function readTrash() {
    var raw = readRaw(TRASH_KEY);
    if (!raw) return null;
    var t = null;
    try { t = JSON.parse(raw); } catch (e) { t = null; }
    if (!t || typeof t.at !== 'number' || !t.snapshot) { dropTrashIfUnchanged(raw); return null; }
    try { validateSnapshot(t.snapshot); } catch (e) { dropTrashIfUnchanged(raw); return null; }
    if (Date.now() - t.at > TTL) { dropTrashIfUnchanged(raw); return null; }
    t.daysLeft = Math.max(0, Math.ceil((TTL - (Date.now() - t.at)) / 86400000));
    return t;
  }

  function wipe() {
    var S = ZX.state;
    if (ZX.state.canDropOverlay && !ZX.state.canDropOverlay()) {
      ZX.ui.toast('无法确认当前存储未被另一标签页修改，已暂停删除以免覆盖；请先导出本页备份，再刷新页面', 'warn');
      return;
    }
    var previousTrashRaw;
    try { previousTrashRaw = readRawStrict(TRASH_KEY); } catch (e) {
      ZX.ui.toast('无法读取回收站，未删除数据', 'warn');
      return;
    }
    var snap = {
      planVersion: S.currentPlanVersion ? S.currentPlanVersion() : null,
      tasks: U.clone(S.tasks || []),
      sessions: U.clone(S.sessions || []),
      goal: U.clone(S.goal || null),
      feas: U.clone(S.feas || null),
      avail: U.clone(ensure()),
      availSource: S.availSource,
      week: U.clone(S.week || null),
      weekShift: U.clone(S.weekShift || null),
      placementModel: U.clone(S.placementModel || null),
      dayAssign: U.clone(S.dayAssign || {}),
      locks: U.clone(S.locks || {}),
      notif: U.clone(S.notif || null),
      attrCounts: U.clone(S.attrCounts || {}),
      consecutiveZeroDays: U.num(S.consecutiveZeroDays, 0),
      interrupted: S.interrupted === true,
      rescueRecord: U.clone(S.rescueRecord || null),
      replanHistory: U.clone(S.replanHistory || []),
      replanSnapshot: U.clone(S.replanned ? S.snapshot : null),
      at: Date.now()
    };
    var trash = JSON.stringify({ at: snap.at, snapshot: snap });
    try {
      window.localStorage.setItem(TRASH_KEY, trash);
      if (window.localStorage.getItem(TRASH_KEY) !== trash) throw new Error('trash not saved');
    } catch (e) {
      ZX.ui.toast('无法保存恢复快照，未删除数据', 'warn');
      return;
    }
    /* 旧 zx.op_queue 与 zx.pending_plan 原样保留隔离，不随业务数据删除。 */
    var dropResult = ZX.state.dropOverlay ? ZX.state.dropOverlay() : false;
    if (dropResult === false) {
      var trashRollbackFailed = false;
      try {
        if (readRawStrict(TRASH_KEY) === trash) restoreRaw(TRASH_KEY, previousTrashRaw);
      } catch (e) {
        trashRollbackFailed = true;
      }
      ZX.ui.toast('另一标签页已修改本机数据，已暂停删除以免覆盖；请先导出本页备份，再刷新页面' +
        (trashRollbackFailed ? '；回收站回滚失败，请立即导出当前数据' : ''), 'warn');
      return;
    }
    if (dropResult === 'unverified') {
      ZX.ui.toast('删除已执行但回读确认失败，回收站仍保留；请刷新页面核查', 'warn');
      setTimeout(function () { window.location.reload(); }, 260);
      return;
    }
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

  function confirmRemoveGoal() {
    var S = ZX.state;
    var goal = S.goal;
    if (!goal || goal.source !== 'user') return Promise.resolve(false);
    return ZX.ui.confirm({ title: '删除阶段目标？', text: '仅移除本机阶段目标，保留已生成计划与执行记录。', okText: '删除阶段目标', danger: true }).then(async function (ok) {
      if (!ok || S.goal !== goal) return false;
      return await withOverlayLock(function () {
        var previousGoal = S.goal;
        var previousFeas = S.feas;
        var previousTrashRaw = readRawStrict(TRASH_KEY);
        var trash = readTrash();
        var nextTrashRaw = previousTrashRaw;
        try {
          if (trash) {
            delete trash.snapshot.goal;
            delete trash.snapshot.feas;
            nextTrashRaw = JSON.stringify({ at: trash.at, snapshot: trash.snapshot });
            if (readRawStrict(TRASH_KEY) !== previousTrashRaw) return false;
            window.localStorage.setItem(TRASH_KEY, nextTrashRaw);
            if (window.localStorage.getItem(TRASH_KEY) !== nextTrashRaw) throw new Error('trash not saved');
          }
          S.goal = { name: '未设置阶段目标', deadline: '', weeks: 0, target: '', source: 'removed' };
          S.feas = { weeklyH: 0, weeks: 0, discount: 0, demand: 0 };
          S.goalDraft = null;
          S.planDraft = null;
          if (S.saveOverlay() === false) throw new Error('overlay not saved');
          ZX.render();
          return true;
        } catch (e) {
          S.goal = previousGoal;
          S.feas = previousFeas;
          try { restoreRaw(TRASH_KEY, previousTrashRaw); } catch (rollbackError) { /* keep explicit warning */ }
          ZX.render();
          ZX.ui.toast('删除目标未保存，已回滚；请导出备份后重试', 'warn');
          return false;
        }
      });
    });
  }

  async function confirmWipe() {
    var confirmed = await ZX.ui.confirm({
      eyebrow: 'DATA / 删除',
      title: '删除全部数据？',
      text: '删除本机业务数据，旧队列与待复核记录保留隔离。' +
            '删除后 7 天内可以在「我的」页恢复，超过 7 天自动清除。视觉偏好设置不受影响。',
      okText: '删除全部数据',
      danger: true
    });
    if (confirmed) await withOverlayLock(wipe);
  }

  function restoreInfo() { return readTrash(); }

  function restoreUnlocked() {
    var trashRaw = readRawStrict(TRASH_KEY);
    var t = readTrash();
    if (!t) { ZX.ui.toast('没有可恢复的数据', 'warn'); return false; }
    var S = ZX.state;
    var s = t.snapshot || {};
    var previous = {};
    var previousPlanVersion = S.currentPlanVersion ? S.currentPlanVersion() : null;
    ['tasks', 'sessions', 'goal', 'feas', 'week', 'weekShift', 'placementModel', 'dayAssign', 'locks',
      'notif', 'attrCounts', 'consecutiveZeroDays', 'interrupted', 'rescueRecord', 'replanHistory', 'snapshot', 'replanned', 'avail', 'availSource']
      .forEach(function (key) { previous[key] = S[key]; });
    if (Array.isArray(s.tasks)) S.tasks = s.tasks.map(ZX.state.normTask);
    if (Array.isArray(s.sessions)) S.sessions = s.sessions;
    if (!S.goal || S.goal.source !== 'removed') {
      if (s.goal) S.goal = s.goal;
      if (s.feas) S.feas = s.feas;
    }
    if (s.week) S.week = s.week;
    if (Array.isArray(s.weekShift)) S.weekShift = s.weekShift;
    if (Object.prototype.hasOwnProperty.call(s, 'placementModel')) {
      S.placementModel = s.placementModel ? window.Rhythm.placementModel.normalizeModel(s.placementModel) : null;
    }
    if (s.dayAssign && typeof s.dayAssign === 'object') S.dayAssign = s.dayAssign;
    if (s.locks && typeof s.locks === 'object') S.locks = s.locks;
    if (s.notif && typeof s.notif === 'object') S.notif = s.notif;
    if (s.attrCounts && typeof s.attrCounts === 'object') S.attrCounts = s.attrCounts;
    if (Array.isArray(s.replanHistory)) S.replanHistory = s.replanHistory;
    if (typeof s.consecutiveZeroDays === 'number' && isFinite(s.consecutiveZeroDays)) S.consecutiveZeroDays = s.consecutiveZeroDays;
    S.interrupted = s.interrupted === true;
    if (Object.prototype.hasOwnProperty.call(s, 'rescueRecord')) S.rescueRecord = s.rescueRecord ? U.clone(s.rescueRecord) : null;
    if (Object.prototype.hasOwnProperty.call(s, 'replanSnapshot')) {
      S.snapshot = s.replanSnapshot && Array.isArray(s.replanSnapshot.tasks) ? s.replanSnapshot : null;
      S.replanned = S.snapshot !== null;
    }
    if (s.avail) {
      S.avail = normGrid(s.avail);
      S.availSource = ['default', 'user'].indexOf(s.availSource) >= 0 ? s.availSource : 'legacy';
    }
    if (S.placementModel && S.syncPlacementProjection) S.syncPlacementProjection();
    if (typeof S.ensurePlacementWindow === 'function') S.ensurePlacementWindow();
    if (typeof S.restorePlanVersion === 'function') S.restorePlanVersion(s.planVersion);
    /* 先确认 overlay 已持久化，再丢弃唯一的恢复快照。 */
    var restoredAt = Date.now();
    S.saveOverlay();
    var saved;
    try { saved = JSON.parse(window.localStorage.getItem('zx.overlay') || 'null'); } catch (e) { saved = null; }
    var restoredFields = {
      planVersion: S.currentPlanVersion ? S.currentPlanVersion() : null,
      tasks: S.tasks, sessions: S.sessions, goal: S.goal, feas: S.feas, week: S.week,
      weekShift: S.weekShift, placementModel: S.placementModel || null, dayAssign: S.dayAssign || {}, locks: S.locks || {},
      avail: S.avail || null, availSource: S.availSource || null, notif: S.notif || null,
      attrCounts: S.attrCounts || {}, consecutiveZeroDays: U.num(S.consecutiveZeroDays, 0), interrupted: S.interrupted === true,
      rescueRecord: S.rescueRecord || null, replanHistory: S.replanHistory || [],
      replanSnapshot: S.replanned ? S.snapshot : null
    };
    if (!saved || saved.at < restoredAt || Object.keys(restoredFields).some(function (key) {
      return JSON.stringify(saved[key]) !== JSON.stringify(restoredFields[key]);
    })) {
      var mismatched = saved ? Object.keys(restoredFields).filter(function (key) {
        return JSON.stringify(saved[key]) !== JSON.stringify(restoredFields[key]);
      }) : [];
      Object.keys(previous).forEach(function (key) { S[key] = previous[key]; });
      if (typeof S.restorePlanVersion === 'function') S.restorePlanVersion(previousPlanVersion);
      ZX.ui.toast('无法保存恢复结果' + (mismatched.length ? '（' + mismatched.join('、') + '）' : '') + '，回收站仍保留', 'warn');
      return false;
    }
    var trashRemoved = dropTrashIfUnchanged(trashRaw);
    if (typeof S.resetTimer === 'function') S.resetTimer();
    ZX.api.queueOp({ entity: 'data', entityId: 'all', field: 'restored', value: { at: t.at } });
    ZX.render();
    ZX.ui.toast(trashRemoved ? '已恢复删除前的数据' : '已恢复删除前的数据；另一页更新后的回收站仍保留');
    return true;
  }

  async function restore() {
    try {
      return await withOverlayLock(restoreUnlocked);
    } catch (e) {
      ZX.ui.toast('恢复失败或无法获得本机存储锁，未恢复数据', 'warn');
      return false;
    }
  }

  /* ---------- 字号偏好（F-8.5） ---------- */
  function setFont(v) {
    var val = (v === 'm' || v === 'l') ? v : '';
    ZX.util.setPref('font', val);
    if (ZX.state.tab === 'me') ZX.render();
    /* 全量重绘会丢焦点：放回当前档位按钮（与 toggle/bulk 的焦点重放一致） */
    U.refocus(U.$('[data-act="font"][data-v="' + val + '"]'));
  }

  /* ---------- 启动 ---------- */
  var backupUiBound = false;
  function bindBackupUi() {
    if (backupUiBound) return;
    backupUiBound = true;
    var input = U.$('#backupFileInput');
    if (input && typeof input.addEventListener === 'function') {
      input.addEventListener('change', function () {
        var file = input.files && input.files[0];
        if (!file) return;
        input.value = '';
        importBackup(file);
      });
    }
    /* 事件委托同时覆盖 DOM 与 GL 克隆按钮，不依赖 main.js 的动作分派。 */
    if (typeof document.addEventListener === 'function') {
      document.addEventListener('click', function (event) {
        var button = event.target && event.target.closest ? event.target.closest('[data-act]') : null;
        if (!button) return;
        if (button.dataset.act === 'export-backup') downloadBackup();
        if (button.dataset.act === 'import-backup') {
          if (input && typeof input.click === 'function') {
            input.value = '';
            input.click();
          } else {
            ZX.ui.toast('找不到备份文件选择器', 'warn');
          }
        }
      });
    }
  }

  function init() {
    bindBackupUi();
    ensure();
    readTrash(); /* 过期即清理 */
    if (ZX.state.localLoadError) {
      var warning = U.$('#saveWarning');
      if (warning) {
        warning.hidden = false;
        warning.textContent = '本地数据加载失败，原数据已保留且暂停覆盖。请导入完整备份，或确认后删除全部数据。';
      }
      if (ZX.ui && typeof ZX.ui.toast === 'function') ZX.ui.toast('本地数据加载失败，已暂停覆盖以保留原数据', 'warn');
    }
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
    exportBackup: exportBackup, downloadBackup: downloadBackup, importBackup: importBackup,
    confirmRemoveGoal: confirmRemoveGoal, confirmWipe: confirmWipe, restoreInfo: restoreInfo, restore: restore,
    setFont: setFont, init: init
  };
  ZX.settings = ZX.flows.settings;

})(window.ZX);
