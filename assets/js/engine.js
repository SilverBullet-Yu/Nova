/* =========================================================
   诺瓦 Nova · 引擎桥接
   统一入口：优先调后端（ZX.api.*），捕获错误则降级到本地 shared/engine
   —— 后端在线与离线时，行为完全一致（同一套纯函数语义）。
   契约：docs/HANDOFF.md 第 3 节（引擎 API）+ 第 6 节（降级要求）
   ========================================================= */
window.ZX = window.ZX || {};

(function (ZX) {
  'use strict';

  var U = ZX.util;

  /* shared/ 采用 UMD 命名空间形态：Rhythm.<name> = { <name>: fn, ... }
     同时兼容直接挂函数的老写法 */
  function rhythmFn(name) {
    var R = window.Rhythm;
    if (!R) return null;
    var mod = R[name];
    if (typeof mod === 'function') return mod;
    if (mod && typeof mod[name] === 'function') return mod[name];
    if (name === 'undoReplan' && R.replan && typeof R.replan.undoReplan === 'function') return R.replan.undoReplan;
    return null;
  }

  function pct(v) { return (Math.round(v * 1000) / 10) + '%'; }

  /* ------------------------------------------------------------
     内置兜底实现：与 HANDOFF 第 3 节契约同构。
     仅在 shared/ 尚未就位（或后端与本地引擎均不可用）时兜底，
     保证 file:// 双击打开时全部功能可用。
     ------------------------------------------------------------ */

  function embedFeasibility(input) {
    var i = input || {};
    var T = Math.round(i.weeklyH * i.weeks * i.discount);
    var D = i.demand;
    var R = +(T / D).toFixed(2);
    var margin = T - D;
    var verdict = R >= 1.2 ? '充裕' : R >= 0.9 ? '合理' : R >= 0.7 ? '偏紧' : '阻断';
    return {
      T: T, D: D, R: R, margin: margin, verdict: verdict,
      threshold: { ample: 1.2, reasonable: 0.9, tight: 0.7 }
    };
  }

  function embedUndo(snapshot) {
    var s = snapshot || {};
    return { tasks: U.clone(s.tasks || []), week: U.clone(s.week || []) };
  }

  /* 四级策略有序执行，首个通过防雪崩校验的级别即停止 */
  function embedReplan(input) {
    var i = input || {};
    var tasks = (i.tasks || []).map(function (t) { return U.clone(t); });
    var week = i.week || [];
    var p = i.params || {};
    var loadGrowthCap = U.num(p.loadGrowthCap, 0.20);
    var compressFloor = U.num(p.compressFloor, 0.60);
    var compressedShareCap = U.num(p.compressedShareCap, 0.30);
    var cap = U.num(i.history && i.history.consecutiveNoImprove, 0);
    var consecutiveCap = U.num(p.consecutiveNoImproveCap, 3);

    var baseLoad = 0, bufferTotal = 0;
    for (var w = 0; w < week.length; w++) {
      baseLoad += U.num(week[w].minutes, 0);
      bufferTotal += U.num(week[w].buf, 0);
    }

    var todo = tasks.filter(function (t) { return !t.done; });
    var strategies = [], diff = [], compressed = [];
    var deferredMin = 0, i2;
    for (i2 = 0; i2 < todo.length; i2++) deferredMin += U.num(todo[i2].est, 0);

    var appliedLevel = 0, loadDelta = baseLoad ? deferredMin / baseLoad : 0, bufferUsed = deferredMin;

    /* L1 顺延 */
    var l1Ok = loadDelta <= loadGrowthCap;
    strategies.push({
      level: 1, name: '顺延', applied: l1Ok,
      reason: l1Ok ? '未完成项顺延至弹性位' : '7 天负载增幅 ' + pct(loadDelta) + ' 超过上限 ' + pct(loadGrowthCap)
    });
    if (l1Ok) {
      appliedLevel = 1;
      todo.forEach(function (t) {
        diff.push({
          op: 'defer', taskId: t.id, subject: t.subject || t.s,
          from: t.time || '', to: '弹性位', detail: '顺延至最近弹性位'
        });
      });
    }

    /* L2 压缩 */
    if (!appliedLevel) {
      var maxCompressed = Math.floor(tasks.length * compressedShareCap);
      var cand = todo.slice().sort(function (a, b) {
        return (U.num(a.weight, 0) - U.num(b.weight, 0)) || (String(a.id) < String(b.id) ? -1 : 1);
      });
      var compressedEst = 0;
      for (var c = 0; c < cand.length && compressed.length < maxCompressed; c++) {
        var t = cand[c];
        var from = U.num(t.est, 0);
        var floorMin = Math.ceil(from * compressFloor);
        var to = Math.ceil(floorMin / 5) * 5;      /* 取 5 min 粒度向上取整 */
        if (to >= from) continue;
        compressed.push(t.id);
        compressedEst += from;
        diff.push({
          op: 'compress', taskId: t.id, subject: t.subject || t.s,
          from: String(from), to: String(to), detail: '按权重压缩，下限 ' + compressFloor
        });
      }
      /* 压缩项原地缩短，不再计入顺延负载 */
      loadDelta = baseLoad ? (deferredMin - compressedEst) / baseLoad : 0;
      bufferUsed = Math.max(0, deferredMin - compressedEst);
      var l2Ok = loadDelta <= loadGrowthCap && compressed.length <= maxCompressed;
      strategies.push({
        level: 2, name: '压缩', applied: l2Ok,
        reason: l2Ok ? '压缩低权重项后复核通过' : '压缩后增幅 ' + pct(loadDelta) + ' 仍未达标'
      });
      if (l2Ok) appliedLevel = 2;
    }

    /* L3 替代 */
    if (!appliedLevel) {
      var pairs = 0;
      for (var a = 0; a < todo.length; a++) {
        for (var b = 0; b < todo.length; b++) {
          if (a === b) continue;
          var la = todo[a], lb = todo[b];
          if ((la.subject || la.s) !== (lb.subject || lb.s)) continue;
          if (U.num(lb.weight, 0) > U.num(la.weight, 0)) {
            diff.push({
              op: 'substitute', taskId: la.id, subject: la.subject || la.s,
              from: la.title || '', to: lb.title || '', detail: '同知识域内高权重节点替换'
            });
            pairs++;
            break;
          }
        }
      }
      strategies.push({
        level: 3, name: '替代', applied: false,
        reason: pairs ? '存在替代候选，需人工确认' : '无可替换节点'
      });
    }

    /* L4 放弃 */
    if (!appliedLevel) {
      strategies.push({ level: 4, name: '放弃', applied: false, reason: '需用户确认后才执行' });
    }

    var guards = {
      loadGrowthOk: loadDelta <= loadGrowthCap,
      bufferPreserved: bufferUsed <= bufferTotal,
      consecutiveOk: cap < consecutiveCap,
      compressedShareOk: compressed.length <= Math.floor(tasks.length * compressedShareCap)
    };

    var accepted = !!appliedLevel && guards.loadGrowthOk && guards.bufferPreserved && guards.consecutiveOk;

    return {
      strategies: strategies,
      diff: diff,
      loadDelta: loadDelta,
      accepted: accepted,
      verdict: accepted ? 'ok' : 'blocked',
      snapshot: { tasks: U.clone(tasks), week: U.clone(week), timestamp: U.num(i.timestamp, 0) },
      guards: guards,
      compressed: compressed
    };
  }

  /* 判定顺序固定：先计划、后用户 */
  function embedAttribute(input) {
    var i = input || {};
    var planLoadRatio = U.num(i.planLoadRatio, 0);
    var zeroDays = U.num(i.consecutiveZeroDays, 0);
    var timeoutCount = U.num(i.consecutiveTimeoutCount, 0);
    var efficiency = U.num(i.efficiencyRatio, 1);
    var completion = U.num(i.completion, 0);
    var external = U.num(i.externalRatio, 0);

    var type, actions, confidence;
    if (planLoadRatio > 1.1 || timeoutCount >= 3) {
      type = '计划过载'; actions = ['下调密度', '提高弹性位比例']; confidence = 0.80;
    } else if (zeroDays >= 2) {
      type = '执行中断'; actions = ['转入恢复流程', '不追加任务']; confidence = 0.75;
    } else if (efficiency > 1.4 && completion >= 0.6) {
      type = '效率不足'; actions = ['校准标准工时', '建议拆分']; confidence = 0.70;
    } else if (external > 0.3) {
      type = '外部干扰'; actions = ['重排弹性位', '避开不可用时段']; confidence = 0.60;
    } else {
      type = '无偏差'; actions = ['保持当前节奏']; confidence = 0.50;
    }

    return {
      type: type, confidence: confidence, actions: actions,
      evidence: {
        planLoadRatio: planLoadRatio,
        consecutiveZeroDays: zeroDays,
        consecutiveTimeoutCount: timeoutCount,
        efficiencyRatio: efficiency,
        completion: completion,
        externalRatio: external
      }
    };
  }

  /* 贪心装箱：弹性位优先级最低，仅在无其他选择时使用 */
  function embedSchedule(input) {
    var i = input || {};
    var tasks = i.tasks || [], slots = i.slots || [];
    var p = i.params || {};
    var slotMinutes = U.num(p.slotMinutes, 30);
    var maxContiguous = U.num(p.maxContiguousMin, 150);
    var dailyCap = U.num(p.dailyCapMin, 300);

    var hasHard = false, s2;
    for (s2 = 0; s2 < slots.length; s2++) if (!slots[s2].isBuffer) hasHard = true;

    var dayMin = {}, subjMin = {}, blocks = [], unplanned = [];
    var order = tasks.slice().sort(function (a, b) {
      return (U.num(b.weight, 0) - U.num(a.weight, 0)) || (String(a.id) < String(b.id) ? -1 : 1);
    });

    order.forEach(function (t) {
      var placed = false;
      for (var s = 0; s < slots.length && !placed; s++) {
        var sl = slots[s];
        if (sl.available === false) continue;
        if (sl.isBuffer && hasHard) continue;
        if (t.date && sl.date !== t.date) continue;
        var dur = slotMinutes * Math.max(1, Math.ceil(U.num(t.estMin, slotMinutes) / slotMinutes));
        var dkey = sl.date + '|' + (t.subject || '');
        if (U.num(dayMin[sl.date], 0) + dur > dailyCap) continue;
        if (U.num(subjMin[dkey], 0) + dur > maxContiguous) continue;
        blocks.push({
          id: 'b_' + blocks.length, taskId: t.id, subject: t.subject || t.s,
          date: sl.date, startMin: sl.startMin, durMin: dur,
          isBuffer: !!sl.isBuffer, locked: false,
          reason: sl.isBuffer ? '弹性位补位' : '常规装箱'
        });
        dayMin[sl.date] = U.num(dayMin[sl.date], 0) + dur;
        subjMin[dkey] = U.num(subjMin[dkey], 0) + dur;
        placed = true;
      }
      if (!placed) unplanned.push({ taskId: t.id, reason: '无可用时段（受可用性 / 日上限 / 连续时长约束）' });
    });

    var loadByDay = {};
    blocks.forEach(function (b) { loadByDay[b.date] = U.num(loadByDay[b.date], 0) + b.durMin; });

    var totalSlots = 0, bufferSlots = 0;
    slots.forEach(function (s3) { if (s3.available !== false) { totalSlots++; if (s3.isBuffer) bufferSlots++; } });
    var bufferUsed = blocks.filter(function (b) { return b.isBuffer; })
      .reduce(function (a, b) { return a + b.durMin; }, 0);
    var bufferTotalMin = slots.filter(function (s4) { return s4.isBuffer && s4.available !== false; })
      .reduce(function (a, s5) { return a + U.num(s5.durMin, 0); }, 0);

    return {
      blocks: blocks,
      unplanned: unplanned,
      softScore: Math.round((blocks.length / Math.max(1, tasks.length)) * 100),
      truncated: false,
      version: 'planner-1.0.0',
      loadByDay: loadByDay,
      bufferUsedRatio: bufferTotalMin ? Math.min(1, bufferUsed / bufferTotalMin) : 0
    };
  }

  /* ------------------------------------------------------------
     统一入口：后端优先 → 本地 shared/engine → 内置兜底
     后端返回结构不合约时按本地计算，避免 UI 出现 undefined
     ------------------------------------------------------------ */
  function localFeasibility(input) {
    var f = rhythmFn('feasibility');
    return f ? f(input) : embedFeasibility(input);
  }
  function localReplan(input) {
    var f = rhythmFn('replan');
    return f ? f(input) : embedReplan(input);
  }
  function localUndo(snapshot) {
    var f = rhythmFn('undoReplan');
    return f ? f(snapshot) : embedUndo(snapshot);
  }
  function localAttribute(input) {
    var f = rhythmFn('attribute');
    return f ? f(input) : embedAttribute(input);
  }
  function localSchedule(input) {
    var f = rhythmFn('schedule');
    return f ? f(input) : embedSchedule(input);
  }

  function okFeas(r) { return !!(r && typeof r.R === 'number' && typeof r.T === 'number' && r.verdict); }
  function okReplan(r) { return !!(r && Array.isArray(r.strategies) && Array.isArray(r.diff)); }
  function okUndo(r) { return !!(r && Array.isArray(r.tasks)); }
  function okAttr(r) { return !!(r && typeof r.type === 'string'); }
  function okSched(r) { return !!(r && Array.isArray(r.blocks)); }

  ZX.engine = {
    /* 异步入口：后端优先，失败降级本地 */
    feasibility: function (input) {
      return ZX.api.feasibility(input).then(function (r) {
        if (!okFeas(r)) { ZX.engine.source = 'local'; return localFeasibility(input); }
        ZX.engine.source = 'backend';
        return r;
      }, function () {
        ZX.engine.source = 'local';
        return localFeasibility(input);
      });
    },
    replan: function (input) {
      return ZX.api.replan(input).then(function (r) {
        if (!okReplan(r)) { ZX.engine.source = 'local'; return localReplan(input); }
        ZX.engine.source = 'backend';
        return r;
      }, function () {
        ZX.engine.source = 'local';
        return localReplan(input);
      });
    },
    undo: function (snapshot) {
      return ZX.api.undo(snapshot).then(function (r) {
        if (!okUndo(r)) { ZX.engine.source = 'local'; return localUndo(snapshot); }
        ZX.engine.source = 'backend';
        return r;
      }, function () {
        ZX.engine.source = 'local';
        return localUndo(snapshot);
      });
    },
    attribute: function (input) {
      return ZX.api.attribute(input).then(function (r) {
        if (!okAttr(r)) { ZX.engine.source = 'local'; return localAttribute(input); }
        ZX.engine.source = 'backend';
        return r;
      }, function () {
        ZX.engine.source = 'local';
        return localAttribute(input);
      });
    },
    schedule: function (input) {
      return ZX.api.schedule(input).then(function (r) {
        if (!okSched(r)) { ZX.engine.source = 'local'; return localSchedule(input); }
        ZX.engine.source = 'backend';
        return r;
      }, function () {
        ZX.engine.source = 'local';
        return localSchedule(input);
      });
    },

    /* 同步入口：本地确定性纯函数，与后端同语义（渲染路径使用，避免 UI 抖动） */
    feasibilityNow: function (input) { return localFeasibility(input); },
    replanNow: function (input) { return localReplan(input); },
    undoNow: function (snapshot) { return localUndo(snapshot); },
    attributeNow: function (input) { return localAttribute(input); },
    scheduleNow: function (input) { return localSchedule(input); },

    source: 'local',
    embedded: {
      feasibility: embedFeasibility, replan: embedReplan, undoReplan: embedUndo,
      attribute: embedAttribute, schedule: embedSchedule
    }
  };

})(window.ZX);
