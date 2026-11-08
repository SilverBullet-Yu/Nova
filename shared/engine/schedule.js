/* 诺瓦 Nova · 排程装箱引擎（纯函数）
 *
 * 契约：docs/HANDOFF.md §3.2 / §2（UMD 双模）
 * 依赖：无（不读时钟、不读随机数、不做 I/O、不依赖 shared/ 之外的模块）
 *
 * 浏览器：window.Rhythm.schedule.schedule(input)
 * Node   ：require('./schedule.js').schedule(input)
 *
 * ── 装箱模型（契约未展开的细节，此处为显式裁决，README 同步说明）────────────────
 * 1. 硬约束一：available === false 的时段永远不排入。
 * 2. 硬约束二：单日总时长 ≤ params.dailyCapMin（默认 300 min），弹性位占用计入。
 * 3. 硬约束三：同一日期、同一科目的连续占用 ≤ params.maxContiguousMin（默认 150 min）。
 * 4. 硬约束四：弹性 Slot（isBuffer）优先级最低，仅在无其他选择时使用；
 *    但「指定时段固定」的任务（带 date + startMin）先入箱，可优先占用弹性位
 *    —— 即弹性位优先给非弹性（刚性）任务。
 * 5. params.bufferRatio：每日按 bufferRatio 预留弹性余量，
 *    非弹性任务当日占用 ≤ dailyCapMin − round(dailyCapMin × bufferRatio)。
 * 6. params.deadlineMs：时间预算。纯函数不读时钟，改以「固定轮次上界」体现
 *    （非弹性轮 + 弹性位兜底轮，共 2 轮），结果与时间无关。
 * 7. params.slotMinutes：仅作为校验用的粒度参考（排程以 slot 自身 durMin 为准）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.Rhythm = root.Rhythm || {}; root.Rhythm.schedule = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = 'planner-1.0.0';

  function num(v, dflt) {
    return typeof v === 'number' && isFinite(v) ? v : dflt;
  }

  function normalizeParams(params) {
    var p = params || {};
    return {
      slotMinutes: num(p.slotMinutes, 30),
      bufferRatio: num(p.bufferRatio, 0.15),
      maxContiguousMin: num(p.maxContiguousMin, 150),
      deadlineMs: num(p.deadlineMs, 200),
      dailyCapMin: num(p.dailyCapMin, 300)
    };
  }

  function normalizeTask(t, idx) {
    var src = t || {};
    return {
      id: String(src.id !== undefined ? src.id : ('t' + (idx + 1))),
      subject: String(src.subject !== undefined ? src.subject : (src.s !== undefined ? src.s : '未分类')),
      estMin: num(src.estMin !== undefined ? src.estMin : src.est, 0),
      weight: num(src.weight, 0),
      date: src.date !== undefined && src.date !== null ? String(src.date) : null,
      startMin: src.startMin !== undefined && src.startMin !== null ? num(src.startMin, null) : null,
      title: src.title !== undefined ? String(src.title) : ''
    };
  }

  function normalizeSlot(s, idx) {
    var src = s || {};
    return {
      idx: idx,
      date: String(src.date !== undefined ? src.date : ''),
      startMin: num(src.startMin, 0),
      durMin: num(src.durMin, 0),
      available: src.available !== false,
      isBuffer: src.isBuffer === true
    };
  }

  /* ---------- 区间工具（用于单科目连续约束） ---------- */

  function mergeIntervals(list) {
    var sorted = list.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    var out = [];
    for (var i = 0; i < sorted.length; i++) {
      var cur = sorted[i];
      var last = out[out.length - 1];
      if (last && cur[0] <= last[1]) {
        if (cur[1] > last[1]) last[1] = cur[1];
      } else {
        out.push([cur[0], cur[1]]);
      }
    }
    return out;
  }

  function pushInterval(bag, key, s, e) {
    if (!bag[key]) bag[key] = [];
    bag[key].push([s, e]);
    bag[key].sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
  }

  /**
   * 计算「同科目连续」约束下，从 s0 起最多可连续占用多少分钟。
   * 同日期、同科目的既有占用若与新区间首尾相接即视为连续。
   */
  function contiguousAllowance(intervals, s0, max) {
    if (!max || max <= 0) return 0;
    var clusters = mergeIntervals(intervals || []);
    var lo = s0;
    var hi = s0;
    var i;

    /* 左侧紧邻簇链 */
    for (i = clusters.length - 1; i >= 0; i--) {
      var c = clusters[i];
      if (c[1] === lo) lo = c[0];
      else if (c[1] > lo) { /* 理论不会出现重叠 */ lo = Math.min(lo, c[0]); hi = Math.max(hi, c[1]); break; }
      else break;
    }

    /* 恰好从 s0 开始的右侧簇 */
    var nextStart = null;
    var nextLen = 0;
    for (i = 0; i < clusters.length; i++) {
      var c2 = clusters[i];
      if (c2[0] === s0) { hi = c2[1]; }
      if (c2[0] > s0) { nextStart = c2[0]; nextLen = c2[1] - c2[0]; break; }
    }

    var base = hi - lo;
    var allowance = max - base;
    if (allowance < 0) allowance = 0;

    if (nextStart !== null) {
      var gap = nextStart - s0;
      if (gap < allowance) allowance = gap;
      /* 恰好顶到 nextStart 会与该簇相连，需把合并后总长一并校验 */
      if (allowance === gap && base + gap + nextLen > max) {
        allowance = gap > 0 ? gap - 1 : 0;
      }
    }
    return allowance;
  }

  /* ---------- 装箱 ---------- */

  function initState(slots, P) {
    var st = {
      P: P,
      reserveMin: Math.round(P.dailyCapMin * P.bufferRatio),
      slots: slots,
      slotUsed: [],
      days: {},
      dayOrder: []
    };
    for (var i = 0; i < slots.length; i++) st.slotUsed.push(0);
    slots.forEach(function (slot) {
      var d = st.days[slot.date];
      if (!d) {
        d = st.days[slot.date] = { date: slot.date, total: 0, nonBuffer: 0, bufferUsed: 0, bufferCap: 0, intervals: {} };
        st.dayOrder.push(slot.date);
      }
      if (slot.isBuffer) d.bufferCap += slot.durMin;
    });
    return st;
  }

  function dayRoom(st, date, isBuffer) {
    var d = st.days[date];
    if (!d) return 0;
    var room = st.P.dailyCapMin - d.total;
    if (!isBuffer) {
      room = Math.min(room, (st.P.dailyCapMin - st.reserveMin) - d.nonBuffer);
    }
    return room > 0 ? room : 0;
  }

  /* 把 need 分钟填入候选时段序列（候选序列已按优先级排好） */
  function fillInto(st, task, need, candIdx) {
    var placed = 0;
    var segs = [];
    var cause = { unavailable: false, noTail: false, dayFull: false, bufferFull: false, contiguous: false };

    for (var i = 0; i < candIdx.length && placed < need; i++) {
      var si = candIdx[i];
      var slot = st.slots[si];
      if (!slot.available) { cause.unavailable = true; continue; }
      var tail = slot.durMin - st.slotUsed[si];
      if (tail <= 0) { cause.noTail = true; continue; }
      var day = st.days[slot.date];
      if (!day) { cause.noTail = true; continue; }

      var room = dayRoom(st, slot.date, slot.isBuffer);
      if (room <= 0) { cause.dayFull = true; continue; }
      if (slot.isBuffer && day.bufferUsed >= day.bufferCap) { cause.bufferFull = true; continue; }

      var s0 = slot.startMin + st.slotUsed[si];
      var allow = contiguousAllowance(day.intervals[task.subject], s0, st.P.maxContiguousMin);
      if (allow <= 0) { cause.contiguous = true; continue; }

      var take = Math.min(tail, need - placed, room, allow);
      if (slot.isBuffer) take = Math.min(take, day.bufferCap - day.bufferUsed);
      if (take <= 0) { cause.bufferFull = true; continue; }

      st.slotUsed[si] += take;
      day.total += take;
      if (slot.isBuffer) day.bufferUsed += take; else day.nonBuffer += take;
      pushInterval(day.intervals, task.subject, s0, s0 + take);
      segs.push({ slot: slot, startMin: s0, durMin: take });
      placed += take;
    }
    return { placed: placed, segs: segs, cause: cause };
  }

  function candidateOrder(slots, allowBuffer) {
    var out = [];
    for (var i = 0; i < slots.length; i++) {
      if (!allowBuffer && slots[i].isBuffer) continue;
      out.push(i);
    }
    return out;
  }

  function anchorCandidates(slots, task) {
    var out = [];
    for (var i = 0; i < slots.length; i++) {
      if (slots[i].date === task.date && slots[i].startMin === task.startMin) out.push(i);
    }
    return out;
  }

  function reasonOf(cause, task, remaining, P) {
    if (task.date && task.startMin !== null && cause.unavailable && !cause.dayFull && !cause.contiguous) {
      return '指定时段不可用或不存在（' + task.date + ' ' + fmtMin(task.startMin) + '）';
    }
    if (cause.bufferFull && !cause.dayFull && !cause.contiguous) return '弹性位已用尽，无法兜底';
    if (cause.contiguous && !cause.dayFull) {
      return '单科目连续上限 ' + P.maxContiguousMin + ' min 限制，剩余 ' + remaining + ' min 未排入';
    }
    if (cause.dayFull) return '日上限 ' + P.dailyCapMin + ' min 已满，剩余 ' + remaining + ' min 未排入';
    if (cause.noTail) return '无可用时段，剩余 ' + remaining + ' min 未排入';
    return '无可用时段，剩余 ' + remaining + ' min 未排入';
  }

  function fmtMin(m) {
    var h = Math.floor(m / 60);
    var mm = m % 60;
    return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm;
  }

  function main(input) {
    var src = input || {};
    var P = normalizeParams(src.params);
    var tasks = (src.tasks || []).map(normalizeTask);
    var slots = (src.slots || []).map(normalizeSlot);
    var st = initState(slots, P);

    /* 排序：指定时段的刚性任务优先（先入箱 → 可优先占用弹性位），
       其余按 权重↓ → 工时↓ → id↑ 排序，保证确定性。 */
    var locked = [];
    var flexible = [];
    tasks.forEach(function (t) {
      if (t.date !== null && t.startMin !== null) locked.push(t);
      else flexible.push(t);
    });
    locked.sort(function (a, b) {
      if (a.date < b.date) return -1;
      if (a.date > b.date) return 1;
      if (a.startMin !== b.startMin) return a.startMin - b.startMin;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    flexible.sort(function (a, b) {
      return b.weight - a.weight
        || b.estMin - a.estMin
        || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });

    var blocks = [];
    var unplanned = [];
    var seq = 0;

    function commit(task, segs, isLocked) {
      for (var i = 0; i < segs.length; i++) {
        var seg = segs[i];
        seq += 1;
        var reason = isLocked ? '任务指定时段，固定锁定'
          : seg.slot.isBuffer ? '弹性位兜底：无其他可用时段'
          : '按权重优先排入空闲时段';
        blocks.push({
          id: 'b' + seq,
          taskId: task.id,
          subject: task.subject,
          date: seg.slot.date,
          startMin: seg.startMin,
          durMin: seg.durMin,
          isBuffer: seg.slot.isBuffer === true,
          locked: isLocked,
          reason: reason
        });
      }
    }

    /* ── 刚性任务：锚定在指定时段 ── */
    locked.forEach(function (task) {
      if (task.estMin <= 0) {
        unplanned.push({ taskId: task.id, reason: '标准工时为 0，无可排内容' });
        return;
      }
      var anchors = anchorCandidates(slots, task);
      if (!anchors.length) {
        unplanned.push({ taskId: task.id, reason: '指定时段不存在（' + task.date + ' ' + fmtMin(task.startMin) + '）' });
        return;
      }
      var anchorSlot = slots[anchors[0]];
      if (!anchorSlot.available) {
        unplanned.push({ taskId: task.id, reason: '指定时段不可用或不存在（' + task.date + ' ' + fmtMin(task.startMin) + '）' });
        return;
      }
      /* 锚点之后按时间连续的同日时段顺延（与 slots 输入顺序无关） */
      var chain = [];
      var usedSlots = {};
      chain.push(anchors[0]);
      usedSlots[anchors[0]] = true;
      var cursorEnd = anchorSlot.startMin + anchorSlot.durMin;
      var guard = 0;
      while (guard++ < slots.length) {
        var found = -1;
        var blocked = false;
        for (var j = 0; j < slots.length; j++) {
          if (usedSlots[j]) continue;
          var s = slots[j];
          if (s.date !== task.date) continue;
          if (s.startMin !== cursorEnd) continue;
          if (!s.available) { blocked = true; break; }
          found = j;
          break;
        }
        if (blocked || found < 0) break;
        chain.push(found);
        usedSlots[found] = true;
        cursorEnd = slots[found].startMin + slots[found].durMin;
      }
      var res = fillInto(st, task, task.estMin, chain);
      if (res.placed > 0) commit(task, res.segs, true);
      if (res.placed < task.estMin) {
        unplanned.push({
          taskId: task.id,
          reason: '指定时段之后可用余量不足，剩余 ' + (task.estMin - res.placed) + ' min 未排入'
        });
      }
    });

    /* ── 弹性任务：先非弹性时段，不够再兜底弹性位 ── */
    flexible.forEach(function (task) {
      if (task.estMin <= 0) {
        unplanned.push({ taskId: task.id, reason: '标准工时为 0，无可排内容' });
        return;
      }
      var res = fillInto(st, task, task.estMin, candidateOrder(slots, false));
      if (res.placed < task.estMin) {
        var res2 = fillInto(st, task, task.estMin - res.placed, candidateOrder(slots, true));
        res.segs = res.segs.concat(res2.segs);
        res.placed += res2.placed;
        res.cause.unavailable = res.cause.unavailable || res2.cause.unavailable;
        res.cause.noTail = res.cause.noTail || res2.cause.noTail;
        res.cause.dayFull = res.cause.dayFull || res2.cause.dayFull;
        res.cause.bufferFull = res.cause.bufferFull || res2.cause.bufferFull;
        res.cause.contiguous = res.cause.contiguous || res2.cause.contiguous;
      }
      if (res.placed > 0) commit(task, res.segs, false);
      if (res.placed < task.estMin) {
        unplanned.push({
          taskId: task.id,
          reason: reasonOf(res.cause, task, task.estMin - res.placed, P)
        });
      }
    });

    /* ── 汇总 ── */
    var loadByDay = {};
    blocks.forEach(function (b) {
      loadByDay[b.date] = (loadByDay[b.date] || 0) + b.durMin;
    });

    var bufferCap = 0;
    slots.forEach(function (s) { if (s.isBuffer && s.available) bufferCap += s.durMin; });
    var bufferUsed = 0;
    blocks.forEach(function (b) { if (b.isBuffer) bufferUsed += b.durMin; });

    var softScore = 0;
    var placedByTask = {};
    blocks.forEach(function (b) { placedByTask[b.taskId] = (placedByTask[b.taskId] || 0) + b.durMin; });
    tasks.forEach(function (t) {
      if (t.estMin <= 0) return;
      var cov = Math.min(1, (placedByTask[t.id] || 0) / t.estMin);
      softScore += t.weight * cov * 100;
    });

    return {
      blocks: blocks,
      unplanned: unplanned,
      softScore: Math.round(softScore * 100) / 100,
      truncated: unplanned.length > 0,
      version: VERSION,
      loadByDay: loadByDay,
      bufferUsedRatio: bufferCap > 0 ? Math.round((bufferUsed / bufferCap) * 10000) / 10000 : 0
    };
  }

  return { schedule: main, VERSION: VERSION };
}));
