/* 诺瓦 Nova · 四级重排引擎（纯函数）
 *
 * 契约：docs/HANDOFF.md §3.3 / §2（UMD 双模）
 * 依赖：无（不读时钟、不读随机数、不做 I/O、不依赖 shared/ 之外的模块）
 *
 * 浏览器：window.Rhythm.replan.replan(input) / window.Rhythm.replan.undoReplan(snapshot)
 * Node   ：require('./replan.js').replan(input) / .undoReplan(snapshot)
 *
 * ── 模型说明（契约未展开处的显式裁决）────────────────────────────────────────
 * · 「未来 7 天实际总负载」= week 中各日 minutes + bufferUsed；顺延把待办重新装入
 *   释放后的普通容量与（可选启用的）弹性容量。增幅 = (新实际总负载 − 原实际总负载) / 原实际总负载。
 * · week 元素格式：{ date, minutes, buffer, capacity?, bufferUsed?, releasedMinutes?, releasedBufferMinutes? }。
 *   输入顺序即周内顺序；capacity 缺省取 dailyCapMin，新增数值字段缺省为 0。
 * · 先释放本周已重排任务，再装载待办：normal = max(0, minutes − releasedMinutes)，
 *   buffer load = max(0, bufferUsed − releasedBufferMinutes)。普通容量装满后才可使用弹性容量。
 * · input.allowBuffer === true 才允许占用弹性池；默认仍只使用普通 capacity，绝不侵占 buffer。
 *   零实际总负载基线不计算百分比增幅，只由容量守卫决定是否接受。
 * · 任务工时统一读 est（与前端 state.tasks 同格式；schedule 引擎用 estMin，各自钉死）。
 * · compressedShareCap 解释为「被压缩掉的分钟数 / 输入全部任务的总分钟数」的上限。
 * · L1 顺延：按权重从高到低把未完成项填入未来 7 天 capacity 以内的空闲分钟。
 *   allowBuffer=false 时只使用普通容量；v3 调用方可显式允许使用独立弹性容量。
 *   语义与文案一致表述为「顺延到未来 7 天容量内的空闲时段」。
 * · L2 压缩：仅当待排分钟超出未来 7 天剩余容量（overflow > 0）时触发，
 *   目标 saved ≥ overflow；负载增幅上限只作为压缩后的事后守卫，不再参与触发判定。
 * · L3 替代要求任务带 domain / freq 字段（同知识域内，低频低权重 → 高频高权重）。
 *   被替代的原任务标记 substituted 并退出待办集合，下一次重排不会重复替换。
 * · L4 放弃：只给出建议，返回 needsConfirmation=true 且 accepted=false；
 *   调用方必须用 confirmReplan(result) 确认后才可落库。
 * · locks（{ taskId: true }）：硬约束——锁定任务不参与顺延装载，也不会被压缩、替代或放弃；
 *   diff 中不会出现锁定任务（不是事后过滤）。
 * · snapshot.timestamp 由调用方通过 input.timestamp 注入，本模块绝不读时钟。
 * · 契约未定义「重排后的状态」，本模块额外返回 nextTasks / nextWeek / needsConfirmation
 *   （附加字段，不影响契约字段）。
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

  function isFiniteNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function round(v, p) {
    var f = Math.pow(10, p);
    return Math.round(v * f) / f;
  }

  function pct(v) {
    return (v * 100).toFixed(1) + '%';
  }

  /* 任务工时统一读 est（唯一生产者 = 前端 state.tasks，同格式；
     schedule 引擎用 estMin，两个引擎各自钉死单一格式，不做双写兼容） */
  function taskMinutes(t) {
    return t ? num(t.est, 0) : 0;
  }

  function setMinutes(t, v) {
    t.est = v;
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
      dailyCapMin: num(p.dailyCapMin, 300),
      maxTasks: Math.min(500, Math.max(1, Math.floor(num(p.maxTasks, 500)))),
      maxOperations: Math.min(50000, Math.max(1, Math.floor(num(p.maxOperations, 50000))))
    };
  }

  /* 周负载格式如上；新增释放量字段保留，缺省按 0 处理，不引入其他模块依赖 */
  function normalizeDays(week, P) {
    var days = [];
    var seen = Object.create(null);
    (week || []).forEach(function (w) {
      var src = w || {};
      var date = String(src.date !== undefined && src.date !== null ? src.date : '');
      if (!date || seen[date]) return;
      seen[date] = true;
      var capacity = num(src.capacity, P.dailyCapMin);
      var buf = num(src.buffer, 0);
      var minutes = num(src.minutes, 0);
      days.push({
        date: date,
        minutes: minutes,
        buffer: buf,
        capacity: capacity,
        bufferUsed: Math.max(0, num(src.bufferUsed, 0)),
        releasedMinutes: Math.max(0, num(src.releasedMinutes, 0)),
        releasedBufferMinutes: Math.max(0, num(src.releasedBufferMinutes, 0))
      });
    });
    return days;
  }

  function growthOf(baseTotal, newTotal) {
    if (baseTotal <= 0) return null;
    return (newTotal - baseTotal) / baseTotal;
  }

  function pctOfGrowth(growth, applicable) {
    return applicable ? pct(growth) : '增幅不适用（零基线）';
  }

  /* 非零基线仍保留原单次增幅守卫；零基线不再按 100% 阻断，只检查两类容量。 */
  function growthGuard(baseTotal, growth, bufferPreserved, P) {
    return bufferPreserved && (baseTotal <= EPS || growth <= P.loadGrowthCap + EPS);
  }

  /* 普通负载与弹性负载分别受 capacity / buffer 约束，互不挪用。 */
  function checkBuffer(loads, days) {
    for (var i = 0; i < days.length; i++) {
      var d = days[i];
      var load = loads[d.date] || { normal: 0, buffer: 0 };
      if (load.normal > d.capacity || load.buffer > d.buffer) return false;
    }
    return true;
  }

  /* 待办集合：未完成、未跳过、未暂缓、未放弃、未被替代
     —— skipped / deferred 是退出待办的独立状态，不参与重排，也不作为替代候选 */
  function isPending(t) {
    return !!t && t.done !== true && t.skipped !== true && t.deferred !== true && t.abandoned !== true && t.substituted !== true;
  }

  function isLocked(t, locks) {
    return !!(locks && t && locks[String(t.id)] === true);
  }

  /* locks 归一：只认显式 true 的键，其余一律视为未锁定 */
  function normalizeLocks(locks) {
    var out = Object.create(null);
    if (locks && typeof locks === 'object' && !Array.isArray(locks)) {
      Object.keys(locks).forEach(function (k) {
        if (locks[k] === true) out[String(k)] = true;
      });
    }
    return out;
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

  /* pending 按权重从高到低重装：先普通容量，再可选弹性容量。
     锁定项保持既有 week 负载，不装载、不进入 diff，placements 中 segs 为空。 */
  function placePending(pending, days, P, locks, allowBuffer, preSorted) {
    var loads = Object.create(null);
    days.forEach(function (d) {
      loads[d.date] = {
        normal: Math.max(0, d.minutes - d.releasedMinutes),
        buffer: Math.max(0, d.bufferUsed - d.releasedBufferMinutes)
      };
    });
    var placements = [];
    var unplaced = [];
    var order = preSorted || pending.slice().sort(byWeightDesc);

    function placeInto(task, rest, segs, isBuffer) {
      for (var i = 0; i < days.length && rest > 0; i++) {
        var d = days[i];
        if (isBuffer && !allowBuffer) continue;
        var load = loads[d.date];
        var free = Math.max(0, (isBuffer ? d.buffer : d.capacity) - load[isBuffer ? 'buffer' : 'normal']);
        if (free <= 0) continue;
        var take = Math.min(free, rest);
        load[isBuffer ? 'buffer' : 'normal'] += take;
        segs.push({ date: d.date, minutes: take, isBuffer: isBuffer });
        rest -= take;
      }
      return rest;
    }

    order.forEach(function (task) {
      if (isLocked(task, locks)) {
        placements.push({ task: task, segs: [], minutes: 0, locked: true });
        return;
      }
      var need = taskMinutes(task);
      if (need <= 0) {
        placements.push({ task: task, segs: [], minutes: 0 });
        return;
      }
      var segs = [];
      var rest = placeInto(task, need, segs, false);
      rest = placeInto(task, rest, segs, true);
      if (rest > 0) unplaced.push(task);
      placements.push({ task: task, segs: segs, minutes: need - rest });
    });

    var total = 0;
    days.forEach(function (d) {
      total += loads[d.date].normal + loads[d.date].buffer;
    });
    return { loads: loads, placements: placements, unplaced: unplaced, total: total };
  }

  function deferDiffs(placements) {
    var out = [];
    placements.forEach(function (p) {
      if (!p.minutes || !p.segs.length) return;
      var dates = [];
      p.segs.forEach(function (s) { if (dates.indexOf(s.date) < 0) dates.push(s.date); });
      var to = dates.join(' / ');
      out.push({
        op: 'defer',
        taskId: String(p.task.id),
        subject: String(p.task.subject !== undefined ? p.task.subject : ''),
        from: p.task.date ? String(p.task.date) : '待排',
        to: to,
        segments: clone(p.segs),
        detail: '顺延 ' + p.minutes + ' min 至 ' + to
      });
    });
    return out;
  }

  function weekFrom(days, loads, released) {
    return days.map(function (d) {
      var load = loads[d.date];
      var release = released && released[d.date];
      return {
        date: d.date,
        minutes: load ? load.normal : d.minutes,
        bufferUsed: load ? load.buffer : d.bufferUsed,
        buffer: d.buffer,
        capacity: d.capacity,
        releasedMinutes: release ? release.normal : d.releasedMinutes,
        releasedBufferMinutes: release ? release.buffer : d.releasedBufferMinutes
      };
    });
  }

  /* ── L1 顺延 ── */
  function attemptDefer(pending, days, P, baseTotal, locks, allowBuffer) {
    var res = placePending(pending, days, P, locks, allowBuffer);
    var growth = growthOf(baseTotal, res.total);
    var growthApplicable = growth !== null;
    var bufferPreserved = checkBuffer(res.loads, days);
    var loadGrowthOk = growthGuard(baseTotal, growth, bufferPreserved, P);
    var placedCount = res.placements.filter(function (p) { return p.minutes > 0; }).length;
    var ok = loadGrowthOk && res.unplaced.length === 0;
    var reason;
    if (ok) {
      reason = '顺延 ' + placedCount + ' 项至未来 7 天容量内的空闲时段，' + pctOfGrowth(growth, growthApplicable);
      if (growthApplicable) reason += ' ≤ ' + pct(P.loadGrowthCap);
    } else if (!bufferPreserved) {
      reason = '输入负载已超出某日普通容量或弹性池，顺延无法恢复，回退';
    } else if (!growthApplicable) {
      reason = '增幅不适用（零基线），但未来 7 天容量不足，回退';
    } else if (!loadGrowthOk) {
      reason = '顺延后未来 7 天负载增幅 ' + pct(growth) + ' 超过单次上限 ' + pct(P.loadGrowthCap) + '，回退';
    } else {
      reason = '未来 7 天容量内无足够空闲时段容纳 ' + res.unplaced.length + ' 项，回退';
    }
    return {
      ok: ok, reason: reason, diff: deferDiffs(res.placements),
      loads: res.loads, total: res.total, growth: growth, growthApplicable: growthApplicable,
      nextPlacements: res.placements,
      tasks: clone(pending),
      guards: { loadGrowthOk: loadGrowthOk, bufferPreserved: bufferPreserved, compressedShareOk: true }
    };
  }

  /* ── L2 压缩（仅容量溢出时触发，目标 saved ≥ overflow；按权重从低到高，下限 = 原工时 × compressFloor） ── */
  function attemptCompress(pending, days, P, baseTotal, totalWorkload, locks, allowBuffer) {
    /* 锁定任务不参与压缩，也不计入可压缩的溢出量。 */
    var movable = pending.filter(function (t) { return !isLocked(t, locks); });
    var pendingTotal = 0;
    movable.forEach(function (t) { pendingTotal += taskMinutes(t); });

    /* 本周重排任务先从实际负载释放，不能把同一批任务再次当成新增负载。 */
    var retainedTotal = 0;
    var totalCapacity = 0;
    days.forEach(function (d) {
      retainedTotal += Math.max(0, d.minutes - d.releasedMinutes) +
        Math.max(0, d.bufferUsed - d.releasedBufferMinutes);
      totalCapacity += d.capacity + (allowBuffer ? d.buffer : 0);
    });
    var freeMin = Math.max(0, totalCapacity - retainedTotal);
    var overflow = Math.max(0, pendingTotal - freeMin);
    var guards = { loadGrowthOk: false, bufferPreserved: true, compressedShareOk: true };

    if (overflow <= EPS) {
      return {
        ok: false,
        reason: '未来 7 天容量未溢出（可用 ' + freeMin + ' min ≥ 待排 ' + pendingTotal + ' min），压缩不适用',
        diff: [], loads: null, total: null, growth: growthOf(baseTotal, retainedTotal), growthApplicable: baseTotal > EPS,
        tasks: pending, guards: guards
      };
    }

    var work = movable.map(clone);
    var need = overflow;
    var compressed = [];

    var order = work.slice().sort(byWeightAsc);
    for (var i = 0; i < order.length && need > EPS; i++) {
      var t = order[i];
      var est = taskMinutes(t);
      var floorMin = Math.max(0, Math.floor(est * P.compressFloor));
      var maxSave = est - floorMin;
      if (maxSave <= 0) continue;
      /* 向上取整到整分钟，保证压缩后仍是整数分钟且恰好补齐溢出 */
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

    var res = placePending(work, days, P, locks, allowBuffer);
    var growth = growthOf(baseTotal, res.total);
    var growthApplicable = growth !== null;
    var bufferPreserved = checkBuffer(res.loads, days);
    var loadGrowthOk = growthGuard(baseTotal, growth, bufferPreserved, P);
    /* 事后校验：必须真正补上容量溢出，且全部待排项都能装下 */
    var enough = saved + EPS >= overflow && res.unplaced.length === 0;
    var ok = enough && loadGrowthOk && bufferPreserved && compressedShareOk && compressed.length > 0;

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
      reason = '按权重从低到高压缩 ' + compressed.length + ' 项（-' + saved + ' min），补齐容量溢出 ' + overflow +
        ' min，复核通过，' + pctOfGrowth(growth, growthApplicable);
    } else if (!compressed.length) {
      reason = '无可压缩项（均已达下限或无余量），回退';
    } else if (!enough) {
      reason = '压缩到下限仍差 ' + Math.max(0, overflow - saved) + ' min 无法排入（溢出 ' + overflow + ' min），回退';
    } else if (!compressedShareOk) {
      reason = '压缩项占比 ' + pct(share) + ' 超过上限 ' + pct(P.compressedShareCap) + '，回退';
    } else if (!loadGrowthOk) {
      reason = '压缩后未来 7 天负载增幅 ' + pct(growth) + ' 仍超过上限 ' + pct(P.loadGrowthCap) + '（事后守卫），回退';
    } else if (!bufferPreserved) {
      reason = '压缩后仍将侵占弹性位，回退';
    } else {
      reason = '压缩后仍有 ' + res.unplaced.length + ' 项无法排入，回退';
    }

    return {
      ok: ok, reason: reason, diff: diff,
      loads: res.loads, total: res.total, growth: growth, growthApplicable: growthApplicable,
      nextPlacements: res.placements,
      tasks: work,
      guards: { loadGrowthOk: loadGrowthOk, bufferPreserved: bufferPreserved, compressedShareOk: compressedShareOk }
    };
  }

  /* ── L3 替代（同知识域内，低频低权重 → 高频高权重）
     · 原任务 A 标记 substituted 并退出待办集合（下次不再重复替换），B 记录 replaces
     · 锁定任务既不能作为被替换方，也不能作为替换方 */
  function attemptSubstitute(pending, days, P, baseTotal, allTasks, locks, allowBuffer) {
    var pendSorted = pending.slice().sort(byWeightAsc);
    var pendingIds = Object.create(null);
    pending.forEach(function (task) { pendingIds[task.id] = true; });
    var byDomain = Object.create(null);
    allTasks.forEach(function (task) {
      if (!task || !task.domain || !isPending(task) || isLocked(task, locks)) return;
      if (!byDomain[task.domain]) byDomain[task.domain] = [];
      byDomain[task.domain].push(task);
    });
    Object.keys(byDomain).forEach(function (domain) { byDomain[domain].sort(byWeightDesc); });

    for (var i = 0; i < pendSorted.length; i++) {
      var A = pendSorted[i];
      if (!A.domain || isLocked(A, locks)) continue;
      var candidates = byDomain[A.domain] || [];
      var withoutA = null;
      var pendingPlacementFailed = false;
      for (var j = 0; j < candidates.length; j++) {
        var B = candidates[j];
        if (B.id === A.id || num(B.freq, 0) <= num(A.freq, 0) || taskWeight(B) <= taskWeight(A)) continue;
        var bIsPending = pendingIds[B.id] === true;
        /* 已在 pending 的候选产生同一待排集合；首次放置失败后无需重复计算。 */
        if (bIsPending && pendingPlacementFailed) continue;
        if (!withoutA) withoutA = pending.filter(function (t) { return t.id !== A.id; });
        var next = bIsPending ? withoutA : withoutA.concat(clone(B));
        var res = placePending(next, days, P, locks, allowBuffer);
        var growth = growthOf(baseTotal, res.total);
        var growthApplicable = growth !== null;
        var bufferPreserved = checkBuffer(res.loads, days);
        var loadGrowthOk = growthGuard(baseTotal, growth, bufferPreserved, P);
        if (!(loadGrowthOk && res.unplaced.length === 0)) {
          if (bIsPending) pendingPlacementFailed = true;
          continue;
        }

        var nextTasks = pending.map(function (t) {
          var c = clone(t);
          if (t.id === A.id) {
            c.substituted = true;
            c.substitutedBy = String(B.id);
          }
          if (t.id === B.id) c.replaces = String(A.id);
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
          reason: '同域「' + A.domain + '」内以高频高权重节点 ' + B.id + ' 替换 ' + A.id + '，复核通过，' + pctOfGrowth(growth, growthApplicable),
          diff: diff, loads: res.loads, total: res.total, growth: growth, growthApplicable: growthApplicable,
          nextPlacements: res.placements, tasks: nextTasks,
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

  /* ── L4 放弃（只出建议：needsConfirmation，确认后才生效） ── */
  function attemptAbandon(pending, days, P, baseTotal, locks, allowBuffer) {
    /* 锁定任务是硬约束，永远不进入放弃候选 */
    var rest = pending.filter(function (t) { return !isLocked(t, locks); });
    if (!rest.length) {
      return {
        ok: false, reason: '全部未完成项均已锁定，没有可放弃的候选',
        diff: [], loads: null, total: null, growth: 0, tasks: pending,
        guards: { loadGrowthOk: false, bufferPreserved: false, compressedShareOk: true }
      };
    }
    var abandoned = [];
    var order = rest.slice().sort(byWeightAsc);
    var locked = pending.filter(function (t) { return isLocked(t, locks); });
    for (var i = 0; i < order.length; i++) {
      var victim = order[i];
      var trial = order.slice(i + 1);
      /* 放弃候选逐个移出，但锁定项仍进入放置结果以保留其空分段占位。 */
      var res = placePending(trial.concat(locked), days, P, locks, allowBuffer);
      var growth = growthOf(baseTotal, res.total);
      var growthApplicable = growth !== null;
      var bufferPreserved = checkBuffer(res.loads, days);
      var loadGrowthOk = growthGuard(baseTotal, growth, bufferPreserved, P);
      var pass = loadGrowthOk && res.unplaced.length === 0;
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
          reason: '放弃 ' + abandoned.length + ' 项（需用户确认），' + pctOfGrowth(growth, growthApplicable),
          diff: diff, loads: res.loads, total: res.total, growth: growth, growthApplicable: growthApplicable,
          nextPlacements: res.placements, tasks: nextTasks,
          guards: { loadGrowthOk: loadGrowthOk, bufferPreserved: bufferPreserved, compressedShareOk: true }
        };
      }
    }
    return {
      ok: false, reason: '放弃全部未完成项后仍未通过校验',
      diff: [], loads: null, total: null, growth: 0, tasks: pending,
      guards: { loadGrowthOk: false, bufferPreserved: false, compressedShareOk: true }
    };
  }

  /* ── 主流程 ── */
  function validateInput(src, P) {
    if (!Array.isArray(src.tasks) || !Array.isArray(src.week)) throw new TypeError('replan: tasks / week 必须是数组');
    if (src.week.length < 1 || src.week.length > 7) throw new RangeError('replan: week 必须包含 1–7 个日期');
    var taskIds = Object.create(null);
    src.tasks.forEach(function (t, i) {
      if (!t || typeof t.id !== 'string' || !t.id) throw new TypeError('replan: tasks[' + i + '].id 必须是非空字符串');
      if (taskIds[t.id]) throw new TypeError('replan: 任务 ID 重复：' + t.id);
      taskIds[t.id] = true;
      if (!isFiniteNumber(t.est) || t.est < 0) throw new TypeError('replan: 任务工时必须是非负有限数：' + t.id);
      if (t.weight !== undefined && (!isFiniteNumber(t.weight) || t.weight < 0)) throw new TypeError('replan: 任务权重必须是非负有限数：' + t.id);
    });
    var dates = Object.create(null);
    src.week.forEach(function (d, i) {
      if (!d || typeof d.date !== 'string' || !d.date) throw new TypeError('replan: week[' + i + '].date 必须是非空字符串');
      if (dates[d.date]) throw new TypeError('replan: 周日期重复：' + d.date);
      dates[d.date] = true;
      ['minutes', 'buffer', 'capacity', 'bufferUsed', 'releasedMinutes', 'releasedBufferMinutes'].forEach(function (key) {
        var value = d[key] === undefined ? 0 : d[key];
        if (!isFiniteNumber(value) || value < 0) throw new TypeError('replan: week[' + i + '].' + key + ' 必须是非负有限数');
      });
      if ((d.releasedMinutes || 0) > (d.minutes || 0)) throw new RangeError('replan: releasedMinutes 不得超过 minutes');
      if ((d.releasedBufferMinutes || 0) > (d.bufferUsed || 0)) throw new RangeError('replan: releasedBufferMinutes 不得超过 bufferUsed');
    });
    if (!Number.isInteger(P.maxTasks) || !Number.isInteger(P.maxOperations)) throw new RangeError('replan: 计算预算必须是整数');
  }

  function replan(input) {
    var src = input || {};
    var P = normalizeParams(src.params);
    validateInput(src, P);
    var history = src.history || {};
    var consecutive = num(history.consecutiveNoImprove, 0);
    var tasks = clone(src.tasks || []);
    var weekRaw = clone(src.week || []);
    var days = normalizeDays(weekRaw, P);
    if (tasks.length > P.maxTasks) {
      throw new RangeError('重排任务规模超过上限：' + P.maxTasks);
    }
    var estimatedOperations = tasks.length * Math.max(1, days.length) * 8;
    if (estimatedOperations > P.maxOperations) {
      throw new RangeError('重排计算预算不足：预计 ' + estimatedOperations + ' 次操作，预算 ' + P.maxOperations);
    }
    /* 锁定集合：硬约束，直接参与各等级判定，不做事后过滤 */
    var locks = normalizeLocks(src.locks);
    var allowBuffer = src.allowBuffer === true;

    /* 实际总负载同时包含普通分钟和已占用的弹性分钟。 */
    var baseTotal = 0;
    days.forEach(function (d) { baseTotal += d.minutes + d.bufferUsed; });
    var growthApplicable = baseTotal > EPS;
    var totalWorkload = 0;
    tasks.forEach(function (t) { totalWorkload += taskMinutes(t); });

    var pending = tasks.filter(isPending);
    var snapshot = {
      tasks: clone(tasks),
      week: clone(weekRaw),
      timestamp: src.timestamp === undefined ? null : src.timestamp
    };
    if (src.placementModel !== undefined) snapshot.placementModel = clone(src.placementModel);

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
        /* growth：该级的负载增幅数值（前端直接消费，不再从 reason 文本正则抠）；
           被短路跳过的级别没有对应的 attempt，记 0 */
        var g = (attempts[i] ? round(num(attempts[i].growth, 0), 4) : 0);
        if (acceptedIdx !== null && acceptedIdx !== undefined) {
          if (level < acceptedIdx) strategies.push({ level: level, name: name, applied: false, growth: g, reason: attempts[i].reason });
          else if (level === acceptedIdx) strategies.push({ level: level, name: name, applied: true, growth: g, reason: attempts[i].reason });
          else strategies.push({ level: level, name: name, applied: false, growth: 0, reason: '前置级别已通过校验，无需进入' });
        } else {
          strategies.push({ level: level, name: name, applied: false, growth: g, reason: attempts[i].reason });
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
        { reason: blockedReason, growth: 0 }, { reason: blockedReason, growth: 0 },
        { reason: blockedReason, growth: 0 }, { reason: blockedReason, growth: 0 }
      ];
      return {
        strategies: pack(attempts0, null),
        diff: [],
        loadDelta: growthApplicable ? 0 : null,
        growthApplicable: growthApplicable,
        accepted: false,
        needsConfirmation: false,
        verdict: 'blocked',
        snapshot: snapshot,
        guards: guards,
        nextTasks: clone(tasks),
        nextWeek: weekFrom(days, {})
      };
    }

    var attempts = [];
    var l1 = attemptDefer(pending, days, P, baseTotal, locks, allowBuffer);
    attempts.push(l1);
    if (l1.ok) {
      return finish(attempts, 1, l1);
    }

    var l2 = attemptCompress(pending, days, P, baseTotal, totalWorkload, locks, allowBuffer);
    attempts.push(l2);
    if (l2.ok) {
      return finish(attempts, 2, l2);
    }

    var l3 = attemptSubstitute(pending, days, P, baseTotal, tasks, locks, allowBuffer);
    attempts.push(l3);
    if (l3.ok) {
      return finish(attempts, 3, l3);
    }

    var l4 = attemptAbandon(pending, days, P, baseTotal, locks, allowBuffer);
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
      loadDelta: growthApplicable ? 0 : null,
      growthApplicable: growthApplicable,
      accepted: false,
      needsConfirmation: false,
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
      var byId = Object.create(null);
      var taskIds = Object.create(null);
      nextTasks.forEach(function (task) { byId[task.id] = task; });
      tasks.forEach(function (task) { taskIds[task.id] = true; });
      var merged = tasks.map(function (task) {
        return clone(byId[task.id] || task);
      });
      /* L3 可能引入新节点 */
      nextTasks.forEach(function (task) {
        if (!taskIds[task.id]) merged.push(clone(task));
      });

      guards.loadGrowthOk = attempt.guards.loadGrowthOk;
      guards.bufferPreserved = attempt.guards.bufferPreserved;
      guards.compressedShareOk = attempt.guards.compressedShareOk;

      /* L4 只出建议：未确认前不得视为已接受，也不得落库 */
      var needsConfirmation = level === 4;
      /* 本轮已装入的待办分钟在 nextWeek 中标记为可释放，回灌同一 week 不会重复计入基线。 */
      var released = Object.create(null);
      attempt.nextPlacements.forEach(function (placement) {
        placement.segs.forEach(function (segment) {
          if (!released[segment.date]) released[segment.date] = { normal: 0, buffer: 0 };
          released[segment.date][segment.isBuffer ? 'buffer' : 'normal'] += segment.minutes;
        });
      });
      return {
        strategies: pack(attempts2, level),
        diff: diff,
        loadDelta: attempt.growthApplicable ? round(attempt.growth, 4) : null,
        growthApplicable: attempt.growthApplicable,
        accepted: !needsConfirmation,
        needsConfirmation: needsConfirmation,
        verdict: needsConfirmation ? 'needsConfirmation' : 'ok',
        snapshot: snapshot,
        guards: guards,
        nextTasks: merged,
        nextPlacements: attempt.nextPlacements,
        nextWeek: weekFrom(days, attempt.loads, released)
      };
    }
  }

  /* 确认落库：仅接受 needsConfirmation=true 的结果，返回新的已确认对象（不修改入参） */
  function confirmReplan(result) {
    if (!result || typeof result !== 'object') {
      throw new TypeError('confirmReplan: 需要重排结果对象');
    }
    if (result.needsConfirmation !== true) {
      throw new TypeError('confirmReplan: 该结果无需确认，不能重复确认');
    }
    if (result.verdict !== 'needsConfirmation' || !Array.isArray(result.strategies) || result.strategies.length !== 4 ||
        !Array.isArray(result.diff) || !result.snapshot || typeof result.snapshot !== 'object' || Array.isArray(result.snapshot) ||
        !Array.isArray(result.snapshot.tasks) || !Array.isArray(result.snapshot.week) || !Array.isArray(result.nextTasks) || !Array.isArray(result.nextPlacements)) {
      throw new TypeError('confirmReplan: 重排结果结构不完整，拒绝确认');
    }
    var out = clone(result);
    out.accepted = true;
    out.needsConfirmation = false;
    out.verdict = 'ok';
    return out;
  }

  /* 撤销：反向应用快照，不重算 */
  function undoReplan(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
      throw new TypeError('undoReplan: 需要 snapshot 对象');
    }
    var out = {
      tasks: clone(snapshot.tasks || []),
      week: clone(snapshot.week || [])
    };
    if (snapshot.placementModel !== undefined) out.placementModel = clone(snapshot.placementModel);
    return out;
  }

  return { replan: replan, confirmReplan: confirmReplan, undoReplan: undoReplan };
}));
