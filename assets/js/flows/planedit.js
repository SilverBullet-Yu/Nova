/* =========================================================
   诺瓦 Nova · 计划页交互（Stage C-2 / F-3.2 F-3.3 F-3.5 F-5.2）
   ---------------------------------------------------------
   · 旧模式：7 列（周一…周日），来源 state.tasks，增量写 state.dayAssign
   · M1 v3：有 placementModel 时以 P.summary / P.taskSegments / P.moveTask 为权威
   · v3 日程块按具体日期、逐 currentSegment 渲染；跨日任务拖动任一段即移动整任务
   · 普通容量与弹性容量分列；弹性占用会减少抗中断余量
   · 锁定：state.locks[taskId]，锁定块不可拖动，重排不参与（assistant.js 结果层过滤）
   · 逐条否决：v3 快照只恢复目标任务，压缩项同时恢复 snapshot.tasks 的 est/time
   · 经典 script，IIFE 挂 ZX.flows.planedit，支持 file:// 双击
   ========================================================= */
window.ZX = window.ZX || {};

(function (ZX) {
  'use strict';

  var U = ZX.util;

  var DAYS = ['一', '二', '三', '四', '五', '六', '日'];
  var DAY_CN = { '一': '周一', '二': '周二', '三': '周三', '四': '周四', '五': '周五', '六': '周六', '日': '周日' };

  /* 任务在基线周（state.week）里的原始落点：seed 的四项今日任务都记在「日」 */
  var ORIGIN = '日';
  var CAP_FALLBACK = 300;

  /* ---------- 状态初始化 ----------
     dayAssign 稀疏表：只记被移动过的块，缺省即「日」；
     locks 为契约第 4 节预留字段，C-1 未写入，这里补默认值。 */
  (function initState() {
    var S = ZX.state;
    if (!S.dayAssign || typeof S.dayAssign !== 'object') S.dayAssign = {};
    if (!S.locks || typeof S.locks !== 'object') S.locks = {};
  })();

  /* ---------- 基础 ---------- */
  function capMin() {
    var S = ZX.state;
    return U.num(S.user && S.user.dailyCapMin, CAP_FALLBACK);
  }

  function findTask(id) {
    return U.findById(ZX.state.tasks, id);
  }

  /* 参与日程块的任务：未完成、未跳过、未暂缓、未退役（与今日页口径一致） */
  function boardTasks() {
    return (ZX.state.tasks || []).filter(function (t) { return !t.done && !t.skipped && !t.deferred && !t.abandoned && !t.substituted; });
  }

  function placementApi() {
    return window.Rhythm && window.Rhythm.placementModel;
  }

  function commitState(mutate) {
    return typeof ZX.state.transact === 'function' ? ZX.state.transact(mutate) : mutate();
  }

  function currentSegments(model, taskId) {
    var P = placementApi();
    return P && model ? P.taskSegments(model, taskId) : [];
  }

  function segmentsMap(model) {
    if (model === ZX.state.placementModel && ZX.state.taskSegmentsMap) return ZX.state.taskSegmentsMap();
    var P = placementApi();
    return P && model ? P.taskSegmentsMap(model) : Object.create(null);
  }

  function placementSummary(model) {
    var S = ZX.state;
    if (model === S.placementModel && S.placementSummary) return S.placementSummary();
    var P = placementApi();
    return P && model ? P.summary(model) : null;
  }

  function weekdayOf(date) {
    return ['日', '一', '二', '三', '四', '五', '六'][new Date(date + 'T00:00:00Z').getUTCDay()];
  }

  /* v3 拖放使用 ISO 日期；兼容调用方传星期标签，但绝不回退到旧 ORIGIN。 */
  function targetDate(model, value) {
    if (!model || typeof value !== 'string') return null;
    var days = Array.isArray(model.days) ? model.days : [];
    if (days.some(function (day) { return day.date === value; })) return value;
    var day = DAYS.indexOf(value) >= 0 ? value : Object.keys(DAY_CN).filter(function (d) { return DAY_CN[d] === value; })[0];
    if (!day) return null;
    var row = days.filter(function (item) { return weekdayOf(item.date) === day; })[0];
    return row ? row.date : null;
  }

  function segmentSignature(segments) {
    return JSON.stringify((segments || []).map(function (seg) {
      return [seg.blockId, seg.taskId, seg.date, seg.startMin, seg.durMin, seg.isBuffer];
    }).sort(function (a, b) {
      var left = JSON.stringify(a), right = JSON.stringify(b);
      return left < right ? -1 : left > right ? 1 : 0;
    }));
  }

  /* 今日弹性位展示跟随 v3 实际窗口；free 只由今日 bufferUsedMin 证明。 */
  function syncBuffer(model) {
    var S = ZX.state;
    var P = placementApi();
    if (!model || !P) return;
    var summary = P.summary(model);
    var today = U.todayKey();
    var row = summary.days.filter(function (day) { return day.date === today; })[0];
    var day = model.days.filter(function (item) { return item.date === today; })[0];
    var windows = day ? day.windows.filter(function (item) { return item.isBuffer; }) : [];
    var time = windows.length
      ? U.pad2(Math.floor(windows[0].startMin / 60)) + ':' + U.pad2(windows[0].startMin % 60) + '–' +
        U.pad2(Math.floor(windows[windows.length - 1].endMin / 60)) + ':' + U.pad2(windows[windows.length - 1].endMin % 60)
      : '';
    S.buffer = Object.assign({}, S.buffer || {}, { time: time, free: !row || row.bufferUsedMin === 0 });
  }

  function assignOf(id) {
    if (ZX.state.placementModel) {
      var segments = currentSegments(ZX.state.placementModel, id);
      return segments.length ? segments[0].date : null;
    }
    var v = ZX.state.dayAssign[id];
    return DAYS.indexOf(v) >= 0 ? v : ORIGIN;
  }

  /* 基线日负载：取自 state.week 的 total（改期不回写这个数组） */
  function baseOf(day) {
    var week = ZX.state.week || [];
    for (var i = 0; i < week.length; i++) if (week[i].d === day) return U.num(week[i].total, 0);
    return 0;
  }

  /* 每日负载：旧模式 = 基线 + 迁入 − 迁出；v3 = P.summary 的实际分段用量。 */
  function loads() {
    var S = ZX.state;
    if (S.placementModel) {
      var summary = placementSummary(S.placementModel);
      var placementOut = {};
      summary.days.forEach(function (day) {
        var row = {
          base: 0,
          normalUsed: day.normalUsedMin,
          bufferUsed: day.bufferUsedMin,
          total: day.usedMin,
          capacity: day.capacityMin,
          bufferCapacity: day.bufferCapacityMin,
          inMin: 0,
          outMin: 0
        };
        placementOut[day.date] = row;
        placementOut[day.d] = row;
      });
      return placementOut;
    }
    var out = {};
    DAYS.forEach(function (d) { out[d] = { base: baseOf(d), inMin: 0, outMin: 0, total: 0 }; });
    boardTasks().forEach(function (t) {
      var day = assignOf(t.id);
      var est = U.num(t.est, 0);
      if (day === ORIGIN) return;
      if (out[day]) out[day].inMin += est;
      out[ORIGIN].outMin += est;
    });
    DAYS.forEach(function (d) {
      var x = out[d];
      x.total = Math.max(0, x.base + x.inMin - x.outMin);
    });
    return out;
  }

  function movedCount() {
    var S = ZX.state;
    if (S.placementModel) {
      var byId = {};
      var byTaskId = segmentsMap(S.placementModel);
      S.placementModel.placements.forEach(function (placement) { byId[placement.taskId] = placement; });
      return boardTasks().filter(function (task) {
        var placement = byId[task.id];
        return !!placement && segmentSignature(placement.originalSegments) !== segmentSignature(byTaskId[task.id] || []);
      }).length;
    }
    return boardTasks().filter(function (t) { return assignOf(t.id) !== ORIGIN; }).length;
  }

  function lockedCount() {
    var locks = ZX.state.locks || {};
    return boardTasks().filter(function (t) { return !!locks[t.id]; }).length;
  }

  /* 周图增量：旧模式按迁入 − 迁出；v3 按日期/星期返回 current − original。 */
  function weekDeltas() {
    var S = ZX.state;
    if (S.placementModel) {
      var summary = placementSummary(S.placementModel);
      var original = {}, current = {}, out = {};
      var byTaskId = segmentsMap(S.placementModel);
      summary.days.forEach(function (day) {
        original[day.date] = 0;
        current[day.date] = 0;
        out[day.date] = 0;
        out[day.d] = 0;
      });
      S.placementModel.placements.forEach(function (placement) {
        placement.originalSegments.forEach(function (seg) { original[seg.date] += seg.durMin; });
        (byTaskId[placement.taskId] || []).forEach(function (seg) { current[seg.date] += seg.durMin; });
      });
      summary.days.forEach(function (day) {
        var delta = current[day.date] - original[day.date];
        out[day.date] = delta;
        out[day.d] = delta;
      });
      return out;
    }
    var L = loads(), out = {};
    DAYS.forEach(function (d) { out[d] = L[d].inMin - L[d].outMin; });
    return out;
  }

  /* 预测改期后的目标日负载（只算，不写状态） */
  function probe(taskId, toDay) {
    var S = ZX.state;
    var t = findTask(taskId);
    if (!t || t.done || t.skipped || t.deferred || t.abandoned || t.substituted) return null;
    if (S.placementModel) {
      if ((S.locks || {})[taskId]) return null;
      var P = placementApi();
      var date = targetDate(S.placementModel, toDay);
      if (!P || !date) return null;
      var segments = currentSegments(S.placementModel, taskId);
      try {
        /* moveTask 自身会归一化；这里仍显式克隆，保证探测绝不接触状态对象。 */
        var result = P.moveTask(U.clone(S.placementModel), taskId, date);
        return Object.assign({}, result, {
          same: segments.length > 0 && segments.every(function (seg) { return seg.date === date; }),
          day: date,
          date: date
        });
      } catch (err) {
        return { ok: false, same: false, day: date, date: date, reason: '落点模型校验失败：' + err.message };
      }
    }
    if (DAYS.indexOf(toDay) < 0) return null;
    var L = loads();
    var from = assignOf(taskId);
    var est = U.num(t.est, 0);
    var cap = capMin();
    if (from === toDay) return { ok: true, same: true, load: L[toDay].total, cap: cap, day: toDay };
    /* 回到「日」时，迁出量减少 est；去别的日则直接叠加迁入 */
    var load = toDay === ORIGIN
      ? L[ORIGIN].base - (L[ORIGIN].outMin - est)
      : L[toDay].base + L[toDay].inMin + est;
    if (load < 0) load = 0;
    return { ok: load <= cap, same: false, load: load, cap: cap, day: toDay };
  }

  /* ---------- 视图：本周日程块 ---------- */
  function block(t) {
    var locked = !!(ZX.state.locks || {})[t.id];
    var color = (ZX.SUBJ[t.s] && ZX.SUBJ[t.s].c) ? ZX.SUBJ[t.s].c : 'var(--txt3)';
    return '<div class="sc2-blk' + (locked ? ' is-locked' : '') + '"' +
        ' data-pe-task="' + U.esc(t.id) + '" draggable="' + (locked ? 'false' : 'true') + '"' +
        ' aria-label="' + U.esc(t.title) + ' ' + U.hm(t.est) + (locked ? '，已锁定' : '，可拖动改期') + '">' +
      '<i class="sc2-dot" style="background:' + color + '"></i>' +
      '<span class="sc2-blk-t">' + U.esc(t.title) + '</span>' +
      '<span class="sc2-blk-m">' + U.hm(t.est) + '</span>' +
      '<button type="button" class="sc2-lock" data-pe-lock="' + U.esc(t.id) + '"' +
        ' aria-pressed="' + (locked ? 'true' : 'false') + '"' +
        ' aria-label="' + (locked ? '解除锁定：' : '锁定：') + U.esc(t.title) + '">' +
        (locked ? '◆' : '◇') + '</button>' +
      (locked ? '<span class="sc2-blk-lk">已锁定</span>' : '') +
    '</div>';
  }

  function segmentBlock(task, segment, crossDay) {
    var locked = !!(ZX.state.locks || {})[task.id];
    var color = (ZX.SUBJ[task.s] && ZX.SUBJ[task.s].c) ? ZX.SUBJ[task.s].c : 'var(--txt3)';
    var meta = segment.durMin + 'm' + (segment.isBuffer ? ' · 弹性' : '') + (crossDay ? ' · 跨日' : '');
    var status = (segment.isBuffer ? '，弹性段' : '，普通段') + (crossDay ? '，跨日任务' : '') + (locked ? '，已锁定' : '，可拖动改期');
    return '<div class="sc2-blk' + (locked ? ' is-locked' : '') + (segment.isBuffer ? ' is-buffer' : '') + '"' +
        ' data-pe-task="' + U.esc(task.id) + '" data-pe-block="' + U.esc(segment.blockId) + '"' +
        ' data-pe-date="' + U.esc(segment.date) + '" data-pe-dur="' + segment.durMin + '"' +
        ' data-pe-buffer="' + (segment.isBuffer ? 'true' : 'false') + '"' +
        ' draggable="' + (locked ? 'false' : 'true') + '" role="listitem"' +
        ' aria-label="' + U.esc(task.title) + ' ' + segment.durMin + ' 分钟' + U.esc(status) + '">' +
      '<i class="sc2-dot" style="background:' + color + '"></i>' +
      '<span class="sc2-blk-t">' + U.esc(task.title) + '</span>' +
      '<span class="sc2-blk-m">' + U.esc(meta) + '</span>' +
      '<button type="button" class="sc2-lock" data-pe-lock="' + U.esc(task.id) + '"' +
        ' aria-pressed="' + (locked ? 'true' : 'false') + '"' +
        ' aria-label="' + (locked ? '解除锁定：' : '锁定：') + U.esc(task.title) + '">' +
        (locked ? '◆' : '◇') + '</button>' +
      (locked ? '<span class="sc2-blk-lk">已锁定</span>' : '') +
    '</div>';
  }

  function placementBoard() {
    var S = ZX.state;
    var L = loads();
    var entries = {};
    var byTaskId = segmentsMap(S.placementModel);
    S.placementModel.days.forEach(function (day) { entries[day.date] = []; });
    boardTasks().forEach(function (task) {
      var segments = byTaskId[task.id] || [];
      var dates = {};
      segments.forEach(function (seg) { dates[seg.date] = true; });
      var crossDay = Object.keys(dates).length > 1;
      segments.forEach(function (seg) {
        if (entries[seg.date]) entries[seg.date].push({ task: task, segment: seg, crossDay: crossDay });
      });
    });
    return '<div class="sc2-board" role="group" aria-label="本周日程块，可拖动改期">' +
      '<div class="sc2-board-h"><span class="sc2-board-t">本周日程块</span>' +
        '<span class="sc2-board-n">按具体日期排程 · 拖动任一段移动整任务 · 普通与弹性容量分列</span>' +
        '<span class="sc2-board-cap">弹性占用会减少抗中断余量</span></div>' +
      '<div class="sc2-days">' + S.placementModel.days.map(function (day) {
        var d = weekdayOf(day.date);
        var load = L[day.date];
        var capacity = load.capacity + load.bufferCapacity;
        var list = entries[day.date];
        return '<div class="sc2-col" data-pe-day="' + U.esc(day.date) + '" data-pe-weekday="' + d + '">' +
          '<div class="sc2-col-h"><b>' + DAY_CN[d] + ' ' + day.date.slice(5).replace('-', '.') + '</b>' +
            '<span class="sc2-col-n" title="普通已用 ' + load.normalUsed + '/' + load.capacity + ' 分钟；弹性已用 ' + load.bufferUsed + '/' + load.bufferCapacity + ' 分钟">' +
              '已用 ' + load.total + '/' + capacity + '<br>弹性 ' + load.bufferUsed + '/' + load.bufferCapacity + '</span></div>' +
          '<div class="sc2-col-b" role="list">' +
            (list.length ? list.map(function (entry) { return segmentBlock(entry.task, entry.segment, entry.crossDay); }).join('') : '<div class="sc2-empty">未排</div>') +
          '</div>' +
        '</div>';
      }).join('') + '</div>' +
    '</div>';
  }

  function board() {
    if (ZX.state.placementModel) return placementBoard();
    var cap = capMin();
    var L = loads();
    var list = boardTasks();
    return '<div class="sc2-board" role="group" aria-label="本周日程块，可拖动改期">' +
      '<div class="sc2-board-h"><span class="sc2-board-t">本周日程块</span>' +
        '<span class="sc2-board-n">拖动任务块改到别的日子 · 锁定后重排不会改动</span>' +
        '<span class="sc2-board-cap">日上限 ' + cap + ' 分钟</span></div>' +
      '<div class="sc2-days">' + DAYS.map(function (d) {
        var inDay = list.filter(function (t) { return assignOf(t.id) === d; });
        return '<div class="sc2-col" data-pe-day="' + d + '">' +
          '<div class="sc2-col-h"><b>' + DAY_CN[d] + '</b>' +
            '<span class="sc2-col-n">' + L[d].total + '/' + cap + '</span></div>' +
          '<div class="sc2-col-b" role="list">' +
            (inDay.length ? inDay.map(block).join('') : '<div class="sc2-empty">未排</div>') +
          '</div>' +
        '</div>';
      }).join('') + '</div>' +
    '</div>';
  }

  /* ---------- 改期 ---------- */
  var dragId = null;
  var dragEl = null;
  var overCol = null;

  function moveTask(id, day) {
    var S = ZX.state;
    var p = probe(id, day);
    if (!p) return false;
    if (p.same) return true;
    if (!p.ok) {
      var message = S.placementModel
        ? (p.date || day) + '：' + (p.reason || '目标日期容量不足') + '。当前计划未改动。'
        : DAY_CN[day] + '将达 ' + p.load + ' 分钟，超过日上限 ' + p.cap;
      ZX.ui.toast(message, 'warn');
      if (dragEl) {
        var el = dragEl;
        el.classList.add('is-rej');
        setTimeout(function () { el.classList.remove('is-rej'); }, 360);
      }
      return false;
    }
    if (S.placementModel) {
      var P = placementApi();
      var summary = P.summary(p.model);
      var target = summary.days.filter(function (item) { return item.date === p.date; })[0];
      var totalCapacity = target.capacityMin + target.bufferCapacityMin;
      /* 只有共享模型成功返回候选模型后才提交；随后统一刷新 week/dayAssign/buffer。 */
      try {
        commitState(function () {
          S.placementModel = p.model;
          S.syncPlacementProjection();
          syncBuffer(S.placementModel);
        });
      } catch (e) {
        ZX.ui.toast('改期未能保存，当前计划已回滚', 'warn');
        return false;
      }
      ZX.render({ skipOverlaySave: true });
      var cost = p.bufferUsedMin > 0
        ? '本次使用弹性 ' + p.bufferUsedMin + ' 分钟，代价是抗中断余量减少，再遇突发只能压缩或顺延。'
        : '弹性占用会减少抗中断余量，再遇突发只能压缩或顺延。';
      ZX.ui.toast('已移到' + DAY_CN[weekdayOf(p.date)] + ' ' + p.date.slice(5).replace('-', '.') +
        ' · 普通已用 ' + p.normalUsedMin + '/' + target.capacityMin + ' 分钟' +
        ' · 弹性已用 ' + p.bufferUsedMin + '/' + target.bufferCapacityMin + ' 分钟' +
        ' · 总容量 ' + totalCapacity + ' 分钟。' + cost, 'ok');
      ZX.api.queueOp({ entity: 'plan', entityId: 'dayAssign', field: 'moved', value: { taskId: id, date: p.date, day: weekdayOf(p.date) } });
      return true;
    }
    try {
      commitState(function () {
        if (day === ORIGIN) delete S.dayAssign[id];
        else S.dayAssign[id] = day;
      });
    } catch (e) {
      ZX.ui.toast('改期未能保存，当前计划已回滚', 'warn');
      return false;
    }
    ZX.render({ skipOverlaySave: true });
    ZX.ui.toast('已移到' + DAY_CN[day] + ' · 当日 ' + p.load + ' / ' + p.cap + ' 分钟', 'ok');
    ZX.api.queueOp({ entity: 'plan', entityId: 'dayAssign', field: 'moved', value: { taskId: id, day: day } });
    return true;
  }

  function toggleLock(id) {
    var S = ZX.state;
    var on = !!S.locks[id];
    try {
      commitState(function () {
        if (on) delete S.locks[id];
        else S.locks[id] = true;
      });
    } catch (e) {
      ZX.ui.toast('锁定状态未能保存，当前计划已回滚', 'warn');
      return false;
    }
    ZX.render({ skipOverlaySave: true });
    /* 重绘会重建按钮，焦点按 data-pe-lock 重放，键盘连续操作不丢位置 */
    U.refocus(document.querySelector('[data-pe-lock="' + id + '"]'));
    ZX.ui.toast(on ? '已解锁 · 重排会重新考虑这一块' : '已锁定 · 重排不会改动', on ? '' : 'ok');
    ZX.api.queueOp({ entity: 'plan', entityId: id, field: 'locked', value: !on });
  }

  /* ---------- 逐条否决 ---------- */
  function isVetoed(taskId, op) {
    var rec = ZX.state.replanRecord;
    var list = (rec && Array.isArray(rec.vetoed)) ? rec.vetoed : [];
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      var id = (v && typeof v === 'object') ? v.taskId : v;
      var o = (v && typeof v === 'object') ? v.op : null;
      if (id !== taskId) continue;
      if (!op || !o || o === op) return true;
    }
    return false;
  }

  function markRow(btn) {
    var line = btn.closest ? btn.closest('.sc2-diff') : null;
    if (!line) return;
    line.classList.add('is-vetoed');
    var sp = document.createElement('span');
    sp.className = 'sc2-vetoed';
    sp.setAttribute('tabindex', '-1');
    sp.textContent = '已否决';
    btn.parentNode.replaceChild(sp, btn);
    U.refocus(sp);
  }

  /* v3 否决先在克隆上恢复并归一化，任何快照缺项/落点冲突都不落状态。 */
  function restorePlacementForVeto(taskId, op) {
    var S = ZX.state;
    var snap = S.snapshot;
    var before = snap && snap.beforePlacementModel;
    var cur = findTask(taskId);
    if (!before || !cur) {
      return { ok: false, message: '无法否决：v3 快照缺少重排前落点或当前任务，现有计划未改动。' };
    }
    if (op === 'compress' && (!Array.isArray(snap.tasks) || !snap.tasks.some(function (task) {
      return task.id === taskId && typeof task.est === 'number' && isFinite(task.est) && task.est >= 0 &&
        typeof task.time === 'string';
    }))) {
      return { ok: false, message: '无法否决：v3 快照缺少该任务重排前的 est/time，现有计划未改动。' };
    }
    var P = placementApi();
    if (!P) return { ok: false, message: '无法否决：落点模型未加载，现有计划未改动。' };
    try {
      var beforeModel = P.normalizeModel(U.clone(before));
      var candidate = U.clone(S.placementModel);
      var beforePlacement = beforeModel.placements.filter(function (placement) { return placement.taskId === taskId; })[0];
      var placement = candidate.placements.filter(function (item) { return item.taskId === taskId; })[0];
      if (!beforePlacement && !placement) {
        return { ok: false, message: '无法否决：v3 快照与当前模型都没有该任务的落点证据。' };
      }
      if (beforePlacement) {
        if (placement) placement.currentSegments = U.clone(beforePlacement.currentSegments);
        else candidate.placements.push({
          placementId: beforePlacement.placementId,
          taskId: taskId,
          /* 原始终段是创建证据，不能从否决快照反向改写。 */
          originalSegments: [],
          currentSegments: U.clone(beforePlacement.currentSegments),
          source: beforePlacement.source
        });
      } else {
        placement.currentSegments = [];
      }
      var restoredTask = null;
      if (op === 'compress') {
        var orig = snap.tasks.filter(function (task) { return task.id === taskId; })[0];
        restoredTask = U.clone(cur);
        restoredTask.est = U.num(orig.est, cur.est);
        restoredTask.time = orig.time;
        delete restoredTask.compressed;
        delete restoredTask.degraded;
        if (orig.degraded) restoredTask.degraded = U.clone(orig.degraded);
      }
      return { ok: true, model: P.normalizeModel(candidate), task: restoredTask };
    } catch (err) {
      return { ok: false, message: '无法否决：恢复后的落点校验失败（' + err.message + '），其他重排结果未改动。' };
    }
  }

  function veto(taskId, op, btn, expectedDraft, expectedPlan) {
    var S = ZX.state;
    var rec = S.replanRecord;
    if (!rec) return false;
    var context = rec.vetoContext;
    if ((expectedDraft || expectedPlan) && (!context ||
        (expectedDraft && context.draftId !== expectedDraft) ||
        (expectedPlan && context.planVersion !== expectedPlan))) {
      ZX.ui.toast('这份否决卡已失效，请在最新重排结果上操作。', 'warn');
      return false;
    }
    if (isVetoed(taskId, op)) { if (btn) markRow(btn); return true; }

    try {
      commitState(function () {
        if (S.placementModel && (op === 'compress' || op === 'defer')) {
          var restored = restorePlacementForVeto(taskId, op);
          if (!restored.ok) throw new Error(restored.message);
          S.placementModel = restored.model;
          if (restored.task) {
            var index = S.tasks.findIndex(function (task) { return task.id === taskId; });
            if (index < 0) throw new Error('无法否决：当前任务不存在');
            S.tasks[index] = restored.task;
          }
          S.syncPlacementProjection();
          syncBuffer(S.placementModel);
        } else if (op === 'compress') {
          var snap = (S.snapshot && Array.isArray(S.snapshot.tasks)) ? S.snapshot.tasks : [];
          var orig = null, i;
          for (i = 0; i < snap.length; i++) if (snap[i].id === taskId) { orig = snap[i]; break; }
          var cur = findTask(taskId);
          if (orig && cur) {
            cur.est = U.num(orig.est, cur.est);
            delete cur.compressed;
            delete cur.degraded;
            if (orig.degraded) cur.degraded = orig.degraded;
          }
        }
        if (!Array.isArray(rec.vetoed)) rec.vetoed = [];
        rec.vetoed.push({ taskId: taskId, op: op, at: Date.now() });
      });
    } catch (e) {
      ZX.ui.toast(e.message || '否决未能保存，当前计划已回滚', 'warn');
      return false;
    }
    ZX.api.queueOp({ entity: 'plan', entityId: 'replan', field: 'vetoed', value: { taskId: taskId } });
    if (btn) markRow(btn);
    if (S.tab === 'plan') ZX.render({ skipOverlaySave: true });
    ZX.ui.toast(S.placementModel
      ? (op === 'compress' ? '已否决这条压缩 · 仅该任务工时与落点已恢复' : '已否决这条顺延 · 仅该任务落点已恢复，其余变更保留')
      : (op === 'compress' ? '已否决这条压缩 · 工时已恢复' : '已否决这条顺延 · 其余变更保留'), 'ok');
    return true;
  }

  /* ---------- 事件 ---------- */
  function onDragStart(e) {
    var el = e.target.closest ? e.target.closest('[data-pe-task]') : null;
    if (!el) return;
    var id = el.dataset.peTask;
    if ((ZX.state.locks || {})[id]) { e.preventDefault(); return; }
    dragId = id;
    dragEl = el;
    el.classList.add('is-drag');
    try {
      e.dataTransfer.setData('text/plain', id);
      e.dataTransfer.effectAllowed = 'move';
    } catch (err) { /* 老浏览器忽略 */ }
  }

  function onDragOver(e) {
    if (!dragId) return;
    var col = e.target.closest ? e.target.closest('[data-pe-day]') : null;
    if (!col) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch (err) { /* 忽略 */ }
    if (overCol !== col) {
      if (overCol) overCol.classList.remove('is-over');
      overCol = col;
      col.classList.add('is-over');
    }
  }

  function onDragLeave(e) {
    var col = e.target.closest ? e.target.closest('[data-pe-day]') : null;
    if (!col) return;
    if (e.relatedTarget && col.contains(e.relatedTarget)) return;
    col.classList.remove('is-over');
    if (overCol === col) overCol = null;
  }

  function clearDrag() {
    dragId = null;
    if (overCol) { overCol.classList.remove('is-over'); overCol = null; }
    U.$$('.sc2-blk.is-drag').forEach(function (el) { el.classList.remove('is-drag'); });
  }

  function onDrop(e) {
    if (!dragId) return;
    var col = e.target.closest ? e.target.closest('[data-pe-day]') : null;
    if (!col) { clearDrag(); return; }
    e.preventDefault();
    var id = dragId;
    var day = col.dataset.peDay;
    clearDrag();
    moveTask(id, day);
  }

  document.addEventListener('dragstart', onDragStart);
  document.addEventListener('dragover', onDragOver);
  document.addEventListener('dragleave', onDragLeave);
  document.addEventListener('drop', onDrop);
  document.addEventListener('dragend', clearDrag);

  document.addEventListener('click', function (e) {
    if (!e.target || !e.target.closest) return;

    var lk = e.target.closest('[data-pe-lock]');
    if (lk) { toggleLock(lk.dataset.peLock); return; }

    var vt = e.target.closest('[data-veto]');
    if (vt) { veto(vt.dataset.veto, vt.dataset.vop, vt, vt.dataset.vdraft, vt.dataset.vplan); return; }

    /* 计划页头部「重新安排」：走重排域 flows/replan.js，不复制重排逻辑 */
    if (e.target.closest('[data-replan-run]')) {
      if (ZX.flows && ZX.flows.replan) ZX.flows.replan.replanFlow();
    }
  });

  ZX.flows = ZX.flows || {};
  ZX.flows.planedit = {
    board: board,
    loads: loads,
    weekDeltas: weekDeltas,
    movedCount: movedCount,
    lockedCount: lockedCount,
    assignOf: assignOf,
    probe: probe,
    moveTask: moveTask,
    toggleLock: toggleLock,
    veto: veto,
    isVetoed: isVetoed
  };

})(window.ZX);
