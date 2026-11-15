/* =========================================================
   诺瓦 Nova · 计划页交互（Stage C-2 / F-3.2 F-3.3 F-3.5 F-5.2）
   ---------------------------------------------------------
   · 本周日程块：7 列（周一…周日），来源 state.tasks（未完成且未跳过）
   · 拖拽改期：HTML5 DnD，写 state.dayAssign，不改 state.week 原始数组
   · 日上限：目标日 = 基线负载 + 迁入分钟 − 迁出分钟，超 user.dailyCapMin 拒绝并回弹
   · 锁定：state.locks[taskId]，锁定块不可拖动，重排不参与（assistant.js 结果层过滤）
   · 逐条否决：重排卡片 diff 行右侧按钮；压缩项从 snapshot 恢复 est
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

  /* 参与日程块的任务：未完成且未跳过（与今日页口径一致） */
  function boardTasks() {
    return (ZX.state.tasks || []).filter(function (t) { return !t.done && !t.skipped; });
  }

  function assignOf(id) {
    var v = ZX.state.dayAssign[id];
    return DAYS.indexOf(v) >= 0 ? v : ORIGIN;
  }

  /* 基线日负载：取自 state.week 的 total（改期不回写这个数组） */
  function baseOf(day) {
    var week = ZX.state.week || [];
    for (var i = 0; i < week.length; i++) if (week[i].d === day) return U.num(week[i].total, 0);
    return 0;
  }

  /* 每日负载：total = 基线 + 迁入（本日新落点）− 迁出（离开基线日「日」的分钟） */
  function loads() {
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
    return boardTasks().filter(function (t) { return assignOf(t.id) !== ORIGIN; }).length;
  }

  function lockedCount() {
    var locks = ZX.state.locks || {};
    return boardTasks().filter(function (t) { return !!locks[t.id]; }).length;
  }

  /* 周图增量：{ '一': delta, ... }，delta = 迁入 − 迁出 */
  function weekDeltas() {
    var L = loads(), out = {};
    DAYS.forEach(function (d) { out[d] = L[d].inMin - L[d].outMin; });
    return out;
  }

  /* 预测改期后的目标日负载（只算，不写状态） */
  function probe(taskId, toDay) {
    var t = findTask(taskId);
    if (!t || DAYS.indexOf(toDay) < 0) return null;
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

  function board() {
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
    var p = probe(id, day);
    if (!p) return false;
    if (p.same) return true;
    if (!p.ok) {
      ZX.ui.toast(DAY_CN[day] + '将达 ' + p.load + ' 分钟，超过日上限 ' + p.cap, 'warn');
      if (dragEl) {
        var el = dragEl;
        el.classList.add('is-rej');
        setTimeout(function () { el.classList.remove('is-rej'); }, 360);
      }
      return false;
    }
    var S = ZX.state;
    if (day === ORIGIN) delete S.dayAssign[id];
    else S.dayAssign[id] = day;
    ZX.render();
    ZX.ui.toast('已移到' + DAY_CN[day] + ' · 当日 ' + p.load + ' / ' + p.cap + ' 分钟', 'ok');
    ZX.api.queueOp({ entity: 'plan', entityId: 'dayAssign', field: 'moved', value: { taskId: id, day: day } });
    return true;
  }

  function toggleLock(id) {
    var S = ZX.state;
    var on = !!S.locks[id];
    if (on) delete S.locks[id];
    else S.locks[id] = true;
    ZX.render();
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

  /* 给 views/plan.js 用：哪些科目有被否决的压缩条目 */
  function vetoedSubjects() {
    var rec = ZX.state.replanRecord;
    var list = (rec && Array.isArray(rec.vetoed)) ? rec.vetoed : [];
    var diff = (rec && Array.isArray(rec.diff)) ? rec.diff : [];
    var out = {};
    list.forEach(function (v) {
      var id = (v && typeof v === 'object') ? v.taskId : v;
      diff.forEach(function (d) { if (d.taskId === id) out[d.subject] = true; });
    });
    return out;
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

  function veto(taskId, op, btn) {
    var S = ZX.state;
    var rec = S.replanRecord;
    if (!rec) return;
    if (!Array.isArray(rec.vetoed)) rec.vetoed = [];
    if (isVetoed(taskId, op)) { if (btn) markRow(btn); return; }

    if (op === 'compress') {
      /* 压缩：从重排前快照取回原工时，并清掉 degraded 标记 */
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
    } else if (op === 'defer') {
      /* 顺延：本地未改任务的落点，因此只清可能存在的延期标记 */
      var t = findTask(taskId);
      if (t && t.deferred) { delete t.deferred; delete t.deferredTo; }
    }

    rec.vetoed.push({ taskId: taskId, op: op, at: Date.now() });
    ZX.api.queueOp({ entity: 'plan', entityId: 'replan', field: 'vetoed', value: { taskId: taskId } });
    if (btn) markRow(btn);
    if (S.tab === 'plan') ZX.render();
    ZX.ui.toast(op === 'compress' ? '已否决这条压缩 · 工时已恢复' : '已否决这条顺延 · 其余变更保留', 'ok');
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
    if (vt) { veto(vt.dataset.veto, vt.dataset.vop, vt); return; }

    /* 计划页头部「重新安排」：走既有 replanFlow，不复制重排逻辑 */
    if (e.target.closest('[data-replan-run]')) {
      if (ZX.assistant && ZX.assistant.replanFlow) ZX.assistant.replanFlow();
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
    isVetoed: isVetoed,
    vetoedSubjects: vetoedSubjects,
    CAP: function () { return capMin(); }
  };

})(window.ZX);
