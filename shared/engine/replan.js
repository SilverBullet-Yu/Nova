/* 诺瓦 Nova · 四级重排引擎（纯函数）
 *
 * 契约：docs/HANDOFF.md §3.3 / §2（UMD 双模）
 * 依赖：无（不读时钟、不读随机数、不做 I/O、不依赖 shared/ 之外的模块）
 *
 * 浏览器：window.Rhythm.replan.replan(input) / window.Rhythm.replan.undoReplan(snapshot)
 * Node   ：require('./replan.js').replan(input) / .undoReplan(snapshot)
 *
 * ── 模型说明（契约未展开处的显式裁决）────────────────────────────────────────
 * · 「未来 7 天负载」= week 中各日 minutes 之和；顺延把未完成项放进未来 7 天的空闲时段，
 *   因此负载 = 原负载 + 顺延分钟数；负载增幅 = (新负载 − 原负载) / 原负载。
 * · week 元素兼容三种写法：{ date, minutes } / { d, total } / { date, minutes, buf, capacity }。
 *   输入顺序即周内顺序（不做字典序排序，避免 '一' '二' '三' 被重排）。
 * · capacity = 该日刚性学习分钟上限（默认 params.dailyCapMin = 300）；
 *   buffer = 该日弹性池（默认 round(capacity × bufferRatio)，或 week 里的 buf）。
 *   弹性池在容量之外，重排只占用 capacity 以内的空闲分钟，绝不侵占弹性池。
 * · compressedShareCap 解释为「被压缩掉的分钟数 / 输入全部任务的总分钟数」的上限。
 * · L3 替代要求任务带 domain / freq 字段（同知识域内，低频低权重 → 高频高权重）。
 * · L4 放弃：标记 abandoned 并在 detail 中注明「需用户确认」。
 * · snapshot.timestamp 由调用方通过 input.timestamp 注入，本模块绝不读时钟。
 * · 契约未定义「重排后的状态」，本模块额外返回 nextTasks / nextWeek（附加字段，不影响契约字段）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.Rhythm = root.Rhythm || {}; root.Rhythm.replan = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EPS = 1e-9;
  var LEVEL_NAMES = { 1: '顺延', 2: '压缩', 3: '替代', 4: '放弃' };

  function clone(v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  }

  function num(v, dflt) {
    return typeof v === 'number' && isFinite(v) ? v : dflt;
  }

  function round(v, p) {
    var f = Math.pow(10, p);
    return Math.round(v * f) / f;
  }

  function pct(v) {
    return (v * 100).toFixed(1) + '%';
  }

  function taskMinutes(t) {
    if (!t) return 0;
    if (t.estMin !== undefined && t.estMin !== null) return num(t.estMin, 0);
    if (t.est !== undefined && t.est !== null) return num(t.est, 0);
    return 0;
  }

  function setMinutes(t, v) {
    if (t.estMin !== undefined && t.estMin !== null) t.estMin = v;
    else if (t.est !== undefined && t.est !== null) t.est = v;
    else t.estMin = v;
    return t;
  }

  function taskWeight(t) {
    return num(t && t.weight, 0);
  }

  function normalizeParams(p) {
    p = p || {};
    return {
      loadGrowthCap: num(p.loadGrowthCap, 0.20),
      compressFloor: num(p.compressFloor, 0.60),
      compressedShareCap: num(p.compressedShareCap, 0.30),
      consecutiveNoImproveCap: num(p.consecutiveNoImproveCap, 3),
      bufferRatio: num(p.bufferRatio, 0.15),
      dailyCapMin: num(p.dailyCapMin, 300)
    };
  }

  function normalizeDays(week, P) {
    var days = [];
    var seen = {};
    (week || []).forEach(function (w) {
      var src = w || {};
      var date = String(src.date !== undefined && src.date !== null ? src.date
        : (src.d !== undefined && src.d !== null ? src.d : ''));
      if (!date || seen[date]) return;
      seen[date] = true;
      var capacity = num(src.capacity, P.dailyCapMin);
      var buf = src.buffer !== undefined && src.buffer !== null ? num(src.buffer, 0)
        : (src.buf !== undefined && src.buf !== null ? num(src.buf, 0) : Math.round(capacity * P.bufferRatio));
      var minutes = num(src.minutes !== undefined && src.minutes !== null ? src.minutes : src.total, 0);
      days.push({ date: date, minutes: minutes, buffer: buf, capacity: capacity });
    });
    return days;
  }

  function growthOf(baseTotal, newTotal) {
    if (baseTotal <= 0) return newTotal <= 0 ? 0 : 1;
    return (newTotal - baseTotal) / baseTotal;
  }

  /* 弹性位永不被侵占：任一日负载超过其刚性容量即视为侵占 */
  function checkBuffer(loads, days) {
    for (var i = 0; i < days.length; i++) {
      var d = days[i];
      if ((loads[d.date] || 0) > d.capacity) return false;
    }
    return true;
  }

  function isPending(t) {
    return !!t && t.done !== true && t.abandoned !== true;
  }

  function byWeightAsc(a, b) {
    var d = taskWeight(a) - taskWeight(b);
    if (d !== 0) return d;
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  }

  function byWeightDesc(a, b) {
    var d = taskWeight(b) - taskWeight(a);
    if (d !== 0) return d;
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  }

  /* 把 pending 项按顺序塞进未来 7 天的空闲分钟（不侵占弹性池） */
  function placePending(pending, days, P) {
    var loads = {};
    days.forEach(function (d) { loads[d.date] = d.minutes; });
    var placements = [];
    var unplaced = [];
    var order = pending.slice().sort(byWeightDesc);

    order.forEach(function (task) {
      var need = taskMinutes(task);
      if (need <= 0) {
        placements.push({ task: task, segs: [], minutes: 0 });
        return;
      }
      var rest = need;
      var segs = [];
      for (var i = 0; i < days.length && rest > 0; i++) {
        var d = days[i];
        var free = Math.max(0, d.capacity - loads[d.date]);
        if (free <= 0) continue;
        var take = Math.min(free, rest);
        loads[d.date] += take;
        segs.push({ date: d.date, minutes: take });
        rest -= take;
      }
      if (rest > 0) unplaced.push(task);
      placements.push({ task: task, segs: segs, minutes: need - rest });
    });

    var total = 0;
    days.forEach(function (d) { total += loads[d.date]; });
    return { loads: loads, placements: placements, unplaced: unplaced, total: total };
  }

  function deferDiffs(placements) {
    var out = [];
    placements.forEach(function (p) {
      if (!p.minutes || !p.segs.length) return;
      var dates = [];
      p.segs.forEach(function (s) { if (dates.indexOf(s.date) < 0) dates.push(s.date); });
      var to = dates.join('/');
      out.push({
        op: 'defer',
        taskId: String(p.task.id),
        subject: String(p.task.subject !== undefined ? p.task.subject : ''),
        from: p.task.date ? String(p.task.date) : '待排',
        to: to,
        detail: '顺延 ' + p.minutes + ' min 至 ' + to
      });
    });
    return out;
  }

  function weekFrom(days, loads) {
    return days.map(function (d) {
      return {
        date: d.date,
        minutes: loads[d.date] !== undefined ? loads[d.date] : d.minutes,
        buffer: d.buffer,
        capacity: d.capacity
      };
    });
  }

  /* ── L1 顺延 ── */
  function attemptDefer(pending, days, P, baseTotal) {
    var res = placePending(pending, days, P);
    var growth = growthOf(baseTotal, res.total);
    var loadGrowthOk = baseTotal <= 0 ? res.total === 0 : growth <= P.loadGrowthCap + EPS;
    var bufferPreserved = checkBuffer(res.loads, days);
    var placedCount = res.placements.filter(function (p) { return p.minutes > 0; }).length;
    var ok = loadGrowthOk && bufferPreserved && res.unplaced.length === 0;
    var reason;
    if (ok) {
      reason = '顺延 ' + placedCount + ' 项至空闲时段，负载增幅 ' + pct(growth) + ' ≤ ' + pct(P.loadGrowthCap);
    } else if (!loadGrowthOk) {
      reason = '顺延后未来 7 天负载增幅 ' + pct(growth) + ' 超过单次上限 ' + pct(P.loadGrowthCap) + '，回退';
    } else if (!bufferPreserved) {
      reason = '顺延将侵占弹性位，违反「弹性位不得清空」，回退';
    } else {
      reason = '未来 7 天无足够空闲时段容纳 ' + res.unplaced.length + ' 项，回退';
    }
    return {
      ok: ok, reason: reason, diff: deferDiffs(res.placements),
      loads: res.loads, total: res.total, growth: growth,
      tasks: clone(pending),
      guards: { loadGrowthOk: loadGrowthOk, bufferPreserved: bufferPreserved, compressedShareOk: true }
    };
  }

  /* ── L2 压缩（按权重从低到高，下限 = 原工时 × compressFloor，标记 degraded） ── */
  function attemptCompress(pending, days, P, baseTotal, totalWorkload) {
    var work = pending.map(clone);
    var pendingTotal = 0;
    work.forEach(function (t) { pendingTotal += taskMinutes(t); });
    var target = baseTotal * (1 + P.loadGrowthCap);
    var need = (baseTotal + pendingTotal) - target;
    var compressed = [];

    var order = work.slice().sort(byWeightAsc);
    for (var i = 0; i < order.length && need > EPS; i++) {
      var t = order[i];
      var est = taskMinutes(t);
      var floorMin = Math.max(0, Math.floor(est * P.compressFloor));
      var maxSave = est - floorMin;
      if (maxSave <= 0) continue;
      /* 向上取整到整分钟，保证压缩后仍是整数分钟且恰好达标 */
      var save = Math.min(maxSave, Math.max(1, Math.ceil(need - EPS)));
      setMinutes(t, est - save);
      t.compressed = true;
      t.degraded = true;
      compressed.push({ task: t, from: est, to: est - save });
      need -= save;
    }

    var saved = compressed.reduce(function (a, c) { return a + (c.from - c.to); }, 0);
    var share = totalWorkload > 0 ? saved / totalWorkload : 0;
    var compressedShareOk = share <= P.compressedShareCap + EPS;

    var res = placePending(work, days, P);
    var growth = growthOf(baseTotal, res.total);
    var loadGrowthOk = baseTotal <= 0 ? res.total === 0 : growth <= P.loadGrowthCap + EPS;
    var bufferPreserved = checkBuffer(res.loads, days);
    var ok = loadGrowthOk && bufferPreserved && compressedShareOk && res.unplaced.length === 0 && compressed.length > 0;

    var diff = [];
    compressed.forEach(function (c) {
      diff.push({
        op: 'compress',
        taskId: String(c.task.id),
        subject: String(c.task.subject !== undefined ? c.task.subject : ''),
        from: String(c.from),
        to: String(c.to),
        detail: '按权重压缩 ' + c.from + ' → ' + c.to + ' min（degraded，下限 ' + Math.floor(c.from * P.compressFloor) + ' min）'
      });
    });
    diff = diff.concat(deferDiffs(res.placements));

    var reason;
    if (ok) {
      reason = '按权重从低到高压缩 ' + compressed.length + ' 项（-' + saved + ' min），复核通过，负载增幅 ' + pct(growth);
    } else if (!compressed.length) {
      reason = '无可压缩项（均已达下限或无余量），回退';
    } else if (!compressedShareOk) {
      reason = '压缩项占比 ' + pct(share) + ' 超过上限 ' + pct(P.compressedShareCap) + '，回退';
    } else if (!loadGrowthOk) {
      reason = '压缩后未来 7 天负载增幅 ' + pct(growth) + ' 仍超过上限 ' + pct(P.loadGrowthCap) + '，回退';
    } else if (!bufferPreserved) {
      reason = '压缩后仍将侵占弹性位，回退';
    } else {
      reason = '压缩后仍有 ' + res.unplaced.length + ' 项无法排入，回退';
    }

    return {
      ok: ok, reason: reason, diff: diff,
      loads: res.loads, total: res.total, growth: growth,
      tasks: work,
      guards: { loadGrowthOk: loadGrowthOk, bufferPreserved: bufferPreserved, compressedShareOk: compressedShareOk }
    };
  }

  /* ── L3 替代（同知识域内，低频低权重 → 高频高权重） ── */
  function attemptSubstitute(pending, days, P, baseTotal, allTasks) {
    var pendSorted = pending.slice().sort(byWeightAsc);
    for (var i = 0; i < pendSorted.length; i++) {
      var A = pendSorted[i];
      if (!A.domain) continue;
      var cands = allTasks.filter(function (B) {
        return B && B.id !== A.id && B.domain === A.domain && B.done !== true
          && num(B.freq, 0) > num(A.freq, 0)
          && taskWeight(B) > taskWeight(A);
      }).sort(byWeightDesc);
      for (var j = 0; j < cands.length; j++) {
        var B = cands[j];
        var next = pending.filter(function (t) { return t.id !== A.id; });
        var bIsPending = next.some(function (t) { return t.id === B.id; });
        if (!bIsPending) next.push(clone(B));
        var res = placePending(next, days, P);
        var growth = growthOf(baseTotal, res.total);
        var loadGrowthOk = baseTotal <= 0 ? res.total === 0 : growth <= P.loadGrowthCap + EPS;
        var bufferPreserved = checkBuffer(res.loads, days);
        if (!(loadGrowthOk && bufferPreserved && res.unplaced.length === 0)) continue;

        var nextTasks = pending.map(function (t) {
          var c = clone(t);
          if (t.id === A.id) {
            c.substituted = true;
            c.substitutedBy = String(B.id);
          }
          return c;
        });
        if (!bIsPending) {
          var bc = clone(B);
          bc.replaces = String(A.id);
          nextTasks.push(bc);
        }
        var diff = [{
          op: 'substitute',
          taskId: String(A.id),
          subject: String(A.subject !== undefined ? A.subject : ''),
          from: String(A.id) + '（freq ' + num(A.freq, 0).toFixed(2) + ' · weight ' + taskWeight(A).toFixed(2) + '）',
          to: String(B.id) + '（freq ' + num(B.freq, 0).toFixed(2) + ' · weight ' + taskWeight(B).toFixed(2) + '）',
          detail: '同域「' + A.domain + '」内以高频高权重节点 ' + B.id + ' 替换 ' + A.id
        }].concat(deferDiffs(res.placements));

        return {
          ok: true,
          reason: '同域「' + A.domain + '」内以高频高权重节点 ' + B.id + ' 替换 ' + A.id + '，复核通过，负载增幅 ' + pct(growth),
          diff: diff, loads: res.loads, total: res.total, growth: growth, tasks: nextTasks,
          guards: { loadGrowthOk: loadGrowthOk, bufferPreserved: bufferPreserved, compressedShareOk: true }
        };
      }
    }
    return {
      ok: false, reason: '无可替换节点（同域内无更高频且更高权重的节点）',
      diff: [], loads: null, total: null, growth: 0, tasks: pending,
      guards: { loadGrowthOk: false, bufferPreserved: true, compressedShareOk: true }
    };
  }

  /* ── L4 放弃（标记 abandoned，需用户确认） ── */
  function attemptAbandon(pending, days, P, baseTotal) {
    var rest = pending.slice();
    var abandoned = [];
    var guard = 0;
    while (rest.length && guard++ <= pending.length + 1) {
      var victim = rest.slice().sort(byWeightAsc)[0];
      var trial = rest.filter(function (t) { return t.id !== victim.id; });
      var res = placePending(trial, days, P);
      var growth = growthOf(baseTotal, res.total);
      var loadGrowthOk = baseTotal <= 0 ? res.total === 0 : growth <= P.loadGrowthCap + EPS;
      var bufferPreserved = checkBuffer(res.loads, days);
      var pass = loadGrowthOk && bufferPreserved && res.unplaced.length === 0;
      abandoned.push(victim);
      if (pass) {
        var diff = abandoned.map(function (a) {
          return {
            op: 'abandon',
            taskId: String(a.id),
            subject: String(a.subject !== undefined ? a.subject : ''),
            from: String(taskMinutes(a)),
            to: '0',
            detail: '标记 abandoned（-' + taskMinutes(a) + ' min），需用户确认'
          };
        }).concat(deferDiffs(res.placements));
        var nextTasks = pending.map(function (t) {
          var hit = abandoned.some(function (a) { return a.id === t.id; });
          var c = clone(t);
          if (hit) { c.abandoned = true; c.needsConfirmation = true; }
          return c;
        });
        return {
          ok: true,
          reason: '放弃 ' + abandoned.length + ' 项（需用户确认），负载增幅 ' + pct(growth),
          diff: diff, loads: res.loads, total: res.total, growth: growth, tasks: nextTasks,
          guards: { loadGrowthOk: loadGrowthOk, bufferPreserved: bufferPreserved, compressedShareOk: true }
        };
      }
      rest = trial;
    }
    return {
      ok: false, reason: '放弃全部未完成项后仍未通过校验',
      diff: [], loads: null, total: null, growth: 0, tasks: pending,
      guards: { loadGrowthOk: false, bufferPreserved: false, compressedShareOk: true }
    };
  }

  /* ── 主流程 ── */
  function replan(input) {
    var src = input || {};
    var P = normalizeParams(src.params);
    var history = src.history || {};
    var consecutive = num(history.consecutiveNoImprove, 0);
    var tasks = clone(src.tasks || []);
    var weekRaw = clone(src.week || []);
    var days = normalizeDays(weekRaw, P);

    var baseTotal = 0;
    days.forEach(function (d) { baseTotal += d.minutes; });
    var totalWorkload = 0;
    tasks.forEach(function (t) { totalWorkload += taskMinutes(t); });

    var pending = tasks.filter(isPending);
    var snapshot = {
      tasks: clone(tasks),
      week: clone(weekRaw),
      timestamp: src.timestamp === undefined ? null : src.timestamp
    };

    var consecutiveOk = consecutive < P.consecutiveNoImproveCap;
    var guards = {
      loadGrowthOk: false,
      bufferPreserved: true,
      consecutiveOk: consecutiveOk,
      compressedShareOk: true
    };

    function pack(attempts, acceptedIdx) {
      var strategies = [];
      for (var i = 0; i < 4; i++) {
        var level = i + 1;
        var name = LEVEL_NAMES[level];
        if (acceptedIdx !== null && acceptedIdx !== undefined) {
          if (level < acceptedIdx) strategies.push({ level: level, name: name, applied: false, reason: attempts[i].reason });
          else if (level === acceptedIdx) strategies.push({ level: level, name: name, applied: true, reason: attempts[i].reason });
          else strategies.push({ level: level, name: name, applied: false, reason: '前置级别已通过校验，无需进入' });
        } else {
          strategies.push({ level: level, name: name, applied: false, reason: attempts[i].reason });
        }
      }
      if (acceptedIdx === null || acceptedIdx === undefined) {
        strategies[3].reason = strategies[3].reason + '；无可用级别，重排被阻断';
      }
      return strategies;
    }

    /* 断言 3：连续 N 次重排未改善 → 停止并转目标校准 */
    if (!consecutiveOk) {
      var blockedReason = '连续 ' + consecutive + ' 次重排未改善，停止重排并转目标校准';
      var attempts0 = [
        { reason: blockedReason }, { reason: blockedReason }, { reason: blockedReason }, { reason: blockedReason }
      ];
      return {
        strategies: pack(attempts0, null),
        diff: [],
        loadDelta: 0,
        accepted: false,
        verdict: 'blocked',
        snapshot: snapshot,
        guards: guards,
        nextTasks: clone(tasks),
        nextWeek: weekFrom(days, {})
      };
    }

    var attempts = [];
    var l1 = attemptDefer(pending, days, P, baseTotal);
    attempts.push(l1);
    if (l1.ok) {
      return finish(attempts, 1, l1);
    }

    var l2 = attemptCompress(pending, days, P, baseTotal, totalWorkload);
    attempts.push(l2);
    if (l2.ok) {
      return finish(attempts, 2, l2);
    }

    var l3 = attemptSubstitute(pending, days, P, baseTotal, tasks);
    attempts.push(l3);
    if (l3.ok) {
      return finish(attempts, 3, l3);
    }

    var l4 = attemptAbandon(pending, days, P, baseTotal);
    attempts.push(l4);
    if (l4.ok) {
      return finish(attempts, 4, l4);
    }

    guards.loadGrowthOk = false;
    guards.bufferPreserved = l4.guards.bufferPreserved;
    guards.compressedShareOk = l2.guards.compressedShareOk;
    return {
      strategies: pack(attempts, null),
      diff: [],
      loadDelta: 0,
      accepted: false,
      verdict: 'blocked',
      snapshot: snapshot,
      guards: guards,
      nextTasks: clone(tasks),
      nextWeek: weekFrom(days, {})
    };

    function finish(attempts2, level, attempt) {
      var diff = attempt.diff.slice();
      var nextTasks = attempt.tasks;
      /* nextTasks 只保留输入任务全集，压缩/替换/放弃的结果合并回去 */
      var merged = tasks.map(function (t) {
        var hit = null;
        for (var i = 0; i < nextTasks.length; i++) {
          if (nextTasks[i].id === t.id) { hit = nextTasks[i]; break; }
        }
        return hit ? clone(hit) : clone(t);
      });
      /* L3 可能引入新节点 */
      nextTasks.forEach(function (t) {
        var exists = merged.some(function (m) { return m.id === t.id; });
        if (!exists) merged.push(clone(t));
      });

      guards.loadGrowthOk = attempt.guards.loadGrowthOk;
      guards.bufferPreserved = attempt.guards.bufferPreserved;
      guards.compressedShareOk = attempt.guards.compressedShareOk;

      return {
        strategies: pack(attempts2, level),
        diff: diff,
        loadDelta: round(attempt.growth, 4),
        accepted: true,
        verdict: 'ok',
        snapshot: snapshot,
        guards: guards,
        nextTasks: merged,
        nextWeek: weekFrom(days, attempt.loads)
      };
    }
  }

  /* 撤销：反向应用快照，不重算 */
  function undoReplan(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
      throw new TypeError('undoReplan: 需要 snapshot 对象');
    }
    return {
      tasks: clone(snapshot.tasks || []),
      week: clone(snapshot.week || [])
    };
  }

  return { replan: replan, undoReplan: undoReplan };
}));
