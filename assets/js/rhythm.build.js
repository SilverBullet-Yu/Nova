/* 自动生成文件，请勿手改。
 * 来源：shared/engine/feasibility.js、schedule.js、replan.js、attribute.js
 * 生成：node scripts/build-engine.js（npm run build:engine）
 */

/* ==== shared/engine/feasibility.js ==== */
/* 诺瓦 Nova · 可行性评估引擎（纯函数）
 *
 * 契约：docs/HANDOFF.md §3.1 / §2（UMD 双模）
 * 依赖：无（不读时钟、不读随机数、不做 I/O、不依赖 shared/ 之外的模块）
 *
 * 浏览器：window.Rhythm.feasibility.feasibility(input)
 * Node   ：require('./feasibility.js').feasibility(input)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.Rhythm = root.Rhythm || {}; root.Rhythm.feasibility = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 四档阈值（契约硬编码，不可随请求变化） */
  var THRESHOLD = { ample: 1.2, reasonable: 0.9, tight: 0.7 };

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  /**
   * 可行性评估：T = round(weeklyH * weeks * discount)，R = T / D（保留 2 位小数）
   * @param {{weeklyH:number, weeks:number, discount:number, demand:number}} input
   * @returns {{T:number, D:number, R:number, margin:number, verdict:string, threshold:object}}
   */
  function feasibility(input) {
    var src = input || {};
    var weeklyH = src.weeklyH;
    var weeks = src.weeks;
    var discount = src.discount;
    var demand = src.demand;

    if (!isNum(weeklyH) || !isNum(weeks) || !isNum(discount) || !isNum(demand)) {
      throw new TypeError('feasibility: weeklyH / weeks / discount / demand 必须为有限数值');
    }
    if (demand <= 0) {
      throw new TypeError('feasibility: demand 必须大于 0');
    }

    var T = Math.round(weeklyH * weeks * discount);
    var D = demand;
    /* 与现有 demo 保持一致：先按 2 位小数取整再判档 */
    var R = Number((T / D).toFixed(2));
    var margin = T - D;

    var verdict = R >= THRESHOLD.ample ? '充裕'
      : R >= THRESHOLD.reasonable ? '合理'
      : R >= THRESHOLD.tight ? '偏紧'
      : '阻断';

    return {
      T: T,
      D: D,
      R: R,
      margin: margin,
      verdict: verdict,
      threshold: { ample: THRESHOLD.ample, reasonable: THRESHOLD.reasonable, tight: THRESHOLD.tight }
    };
  }

  return { feasibility: feasibility, THRESHOLD: THRESHOLD };
}));

/* ==== shared/engine/schedule.js ==== */
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
 * 6. 任务工时统一读 estMin（唯一生产者 = 目标 flow 的拆解草案，同格式）；
 *    排程以 slot 自身 durMin 为准，粒度由调用方构造 slots 时决定。
 * 7. 输出钉死为 { blocks, unplanned, version }：时间预算（原 deadlineMs）在纯函数里
 *    以「固定轮次上界」体现（非弹性轮 + 弹性位兜底轮），不引入时间参数与评分输出。
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
      bufferRatio: num(p.bufferRatio, 0.15),
      maxContiguousMin: num(p.maxContiguousMin, 150),
      dailyCapMin: num(p.dailyCapMin, 300)
    };
  }

  /* 任务统一格式：estMin + subject（不做 est / s 别名兼容） */
  function normalizeTask(t, idx) {
    var src = t || {};
    return {
      id: String(src.id !== undefined ? src.id : ('t' + (idx + 1))),
      subject: String(src.subject !== undefined ? src.subject : '未分类'),
      estMin: num(src.estMin, 0),
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

    /* ── 汇总：输出钉死为 { blocks, unplanned, version }，不附评分 / 统计字段 ── */
    return {
      blocks: blocks,
      unplanned: unplanned,
      version: VERSION
    };
  }

  return { schedule: main, VERSION: VERSION };
}));

/* ==== shared/engine/replan.js ==== */
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
 * · week 元素统一格式：{ date, minutes, buffer, capacity? }（capacity 缺省取 dailyCapMin）。
 *   输入顺序即周内顺序（不做字典序排序，避免 '一' '二' '三' 被重排）。
 * · capacity = 该日刚性学习分钟上限（默认 params.dailyCapMin = 300）；
 *   buffer = 该日弹性池（必填，前端由 state.weekInput 给出）。
 *   弹性池在容量之外，重排只占用 capacity 以内的空闲分钟，绝不侵占弹性池。
 * · 任务工时统一读 est（与前端 state.tasks 同格式；schedule 引擎用 estMin，各自钉死）。
 * · compressedShareCap 解释为「被压缩掉的分钟数 / 输入全部任务的总分钟数」的上限。
 * · L1 顺延：按权重从高到低把未完成项填入未来 7 天 capacity 以内的空闲分钟。
 *   不按 task.date 改变装载顺序，也不占用 buffer——弹性池是保留余量，任何级别都不得侵占。
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
      dailyCapMin: num(p.dailyCapMin, 300)
    };
  }

  /* 周负载统一格式 { date, minutes, buffer, capacity? }（capacity 缺省取 dailyCapMin），
     不再兼容 d / total / buf 等别名写法 */
  function normalizeDays(week, P) {
    var days = [];
    var seen = {};
    (week || []).forEach(function (w) {
      var src = w || {};
      var date = String(src.date !== undefined && src.date !== null ? src.date : '');
      if (!date || seen[date]) return;
      seen[date] = true;
      var capacity = num(src.capacity, P.dailyCapMin);
      var buf = num(src.buffer, 0);
      var minutes = num(src.minutes, 0);
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

  /* 待办集合：未完成、未放弃、未被替代
     —— substituted 必须排除，否则下一次重排会再次替换同一项 */
  function isPending(t) {
    return !!t && t.done !== true && t.abandoned !== true && t.substituted !== true;
  }

  function isLocked(t, locks) {
    return !!(locks && t && locks[String(t.id)] === true);
  }

  /* locks 归一：只认显式 true 的键，其余一律视为未锁定 */
  function normalizeLocks(locks) {
    var out = {};
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

  /* 把 pending 项按权重从高到低塞进未来 7 天的空闲分钟（不侵占弹性池）
     · 锁定任务视为保持当前落点：不装载、不出现在 diff 中，其负载已包含在 week.minutes 内 */
  function placePending(pending, days, P, locks) {
    var loads = {};
    days.forEach(function (d) { loads[d.date] = d.minutes; });
    var placements = [];
    var unplaced = [];
    var order = pending.slice().sort(byWeightDesc);

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
  function attemptDefer(pending, days, P, baseTotal, locks) {
    var res = placePending(pending, days, P, locks);
    var growth = growthOf(baseTotal, res.total);
    var loadGrowthOk = baseTotal <= 0 ? res.total === 0 : growth <= P.loadGrowthCap + EPS;
    var bufferPreserved = checkBuffer(res.loads, days);
    var placedCount = res.placements.filter(function (p) { return p.minutes > 0; }).length;
    var ok = loadGrowthOk && bufferPreserved && res.unplaced.length === 0;
    var reason;
    if (ok) {
      reason = '顺延 ' + placedCount + ' 项至未来 7 天容量内的空闲时段，负载增幅 ' + pct(growth) + ' ≤ ' + pct(P.loadGrowthCap);
    } else if (!loadGrowthOk) {
      reason = '顺延后未来 7 天负载增幅 ' + pct(growth) + ' 超过单次上限 ' + pct(P.loadGrowthCap) + '，回退';
    } else if (!bufferPreserved) {
      reason = '输入负载已超出某日容量，顺延无法恢复到弹性位保留状态，回退';
    } else {
      reason = '未来 7 天容量内无足够空闲时段容纳 ' + res.unplaced.length + ' 项，回退';
    }
    return {
      ok: ok, reason: reason, diff: deferDiffs(res.placements),
      loads: res.loads, total: res.total, growth: growth,
      tasks: clone(pending),
      guards: { loadGrowthOk: loadGrowthOk, bufferPreserved: bufferPreserved, compressedShareOk: true }
    };
  }

  /* ── L2 压缩（仅容量溢出时触发，目标 saved ≥ overflow；按权重从低到高，下限 = 原工时 × compressFloor） ── */
  function attemptCompress(pending, days, P, baseTotal, totalWorkload, locks) {
    /* 锁定任务不参与压缩，也不计入可压缩的溢出量 */
    var movable = pending.filter(function (t) { return !isLocked(t, locks); });
    var pendingTotal = 0;
    movable.forEach(function (t) { pendingTotal += taskMinutes(t); });

    var totalCapacity = 0;
    days.forEach(function (d) { totalCapacity += d.capacity; });
    var freeMin = Math.max(0, totalCapacity - baseTotal);
    var overflow = Math.max(0, pendingTotal - freeMin);
    var guards = { loadGrowthOk: false, bufferPreserved: true, compressedShareOk: true };

    if (overflow <= EPS) {
      return {
        ok: false,
        reason: '未来 7 天容量未溢出（可用 ' + freeMin + ' min ≥ 待排 ' + pendingTotal + ' min），压缩不适用',
        diff: [], loads: null, total: null, growth: 0, tasks: pending, guards: guards
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

    var res = placePending(work, days, P, locks);
    var growth = growthOf(baseTotal, res.total);
    var loadGrowthOk = baseTotal <= 0 ? res.total === 0 : growth <= P.loadGrowthCap + EPS;
    var bufferPreserved = checkBuffer(res.loads, days);
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
        ' min，复核通过，负载增幅 ' + pct(growth);
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
      loads: res.loads, total: res.total, growth: growth,
      tasks: work,
      guards: { loadGrowthOk: loadGrowthOk, bufferPreserved: bufferPreserved, compressedShareOk: compressedShareOk }
    };
  }

  /* ── L3 替代（同知识域内，低频低权重 → 高频高权重）
     · 原任务 A 标记 substituted 并退出待办集合（下次不再重复替换），B 记录 replaces
     · 锁定任务既不能作为被替换方，也不能作为替换方 */
  function attemptSubstitute(pending, days, P, baseTotal, allTasks, locks) {
    var pendSorted = pending.slice().sort(byWeightAsc);
    for (var i = 0; i < pendSorted.length; i++) {
      var A = pendSorted[i];
      if (!A.domain || isLocked(A, locks)) continue;
      var cands = allTasks.filter(function (B) {
        return B && B.id !== A.id && B.domain === A.domain && isPending(B) && !isLocked(B, locks)
          && num(B.freq, 0) > num(A.freq, 0)
          && taskWeight(B) > taskWeight(A);
      }).sort(byWeightDesc);
      for (var j = 0; j < cands.length; j++) {
        var B = cands[j];
        var next = pending.filter(function (t) { return t.id !== A.id; });
        var bIsPending = next.some(function (t) { return t.id === B.id; });
        if (!bIsPending) next.push(clone(B));
        var res = placePending(next, days, P, locks);
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

  /* ── L4 放弃（只出建议：needsConfirmation，确认后才生效） ── */
  function attemptAbandon(pending, days, P, baseTotal, locks) {
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
    var guard = 0;
    while (rest.length && guard++ <= pending.length + 1) {
      var victim = rest.slice().sort(byWeightAsc)[0];
      var trial = rest.filter(function (t) { return t.id !== victim.id; });
      var res = placePending(trial, days, P, locks);
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
    /* 锁定集合：硬约束，直接参与各等级判定，不做事后过滤 */
    var locks = normalizeLocks(src.locks);

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
        loadDelta: 0,
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
    var l1 = attemptDefer(pending, days, P, baseTotal, locks);
    attempts.push(l1);
    if (l1.ok) {
      return finish(attempts, 1, l1);
    }

    var l2 = attemptCompress(pending, days, P, baseTotal, totalWorkload, locks);
    attempts.push(l2);
    if (l2.ok) {
      return finish(attempts, 2, l2);
    }

    var l3 = attemptSubstitute(pending, days, P, baseTotal, tasks, locks);
    attempts.push(l3);
    if (l3.ok) {
      return finish(attempts, 3, l3);
    }

    var l4 = attemptAbandon(pending, days, P, baseTotal, locks);
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

      /* L4 只出建议：未确认前不得视为已接受，也不得落库 */
      var needsConfirmation = level === 4;
      return {
        strategies: pack(attempts2, level),
        diff: diff,
        loadDelta: round(attempt.growth, 4),
        accepted: !needsConfirmation,
        needsConfirmation: needsConfirmation,
        verdict: needsConfirmation ? 'needsConfirmation' : 'ok',
        snapshot: snapshot,
        guards: guards,
        nextTasks: merged,
        nextWeek: weekFrom(days, attempt.loads)
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
    return {
      tasks: clone(snapshot.tasks || []),
      week: clone(snapshot.week || [])
    };
  }

  return { replan: replan, confirmReplan: confirmReplan, undoReplan: undoReplan };
}));

/* ==== shared/engine/attribute.js ==== */
/* 诺瓦 Nova · 偏差归因引擎（纯函数）
 *
 * 契约：docs/HANDOFF.md §3.4 / §2（UMD 双模）
 * 依赖：无（不读时钟、不读随机数、不做 I/O、不依赖 shared/ 之外的模块）
 *
 * 浏览器：window.Rhythm.attribute.attribute(input)
 * Node   ：require('./attribute.js').attribute(input)
 *
 * 判定顺序固定（顺序即优先级）：
 *   1. 计划过载  planLoadRatio > 1.1 || consecutiveTimeoutCount >= 3
 *   2. 执行中断  consecutiveZeroDays >= 2
 *   3. 效率不足  efficiencyRatio > 1.4 && completion >= 0.6
 *   4. 外部干扰  externalRatio > 0.3
 *   5. 无偏差
 * 先排除计划问题再归因用户侧：把「过载」误判为「执行力不足」，系统就会加压。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.Rhythm = root.Rhythm || {}; root.Rhythm.attribute = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function num(v, dflt) {
    return typeof v === 'number' && isFinite(v) ? v : dflt;
  }

  function clamp01(v) {
    if (v < 0) return 0;
    if (v > 1) return 1;
    return v;
  }

  function round(v, p) {
    var f = Math.pow(10, p);
    return Math.round(v * f) / f;
  }

  function attribute(input) {
    var src = input || {};
    var planLoadRatio = num(src.planLoadRatio, 0);
    var consecutiveZeroDays = num(src.consecutiveZeroDays, 0);
    var consecutiveTimeoutCount = num(src.consecutiveTimeoutCount, 0);
    var efficiencyRatio = num(src.efficiencyRatio, 1);
    var completion = num(src.completion, 0);
    var externalRatio = num(src.externalRatio, 0);

    var evidence = {
      planLoadRatio: planLoadRatio,
      consecutiveZeroDays: consecutiveZeroDays,
      consecutiveTimeoutCount: consecutiveTimeoutCount,
      efficiencyRatio: efficiencyRatio,
      completion: completion,
      externalRatio: externalRatio
    };

    var type;
    var confidence;
    var actions;
    var matched = [];

    if (planLoadRatio > 1.1 || consecutiveTimeoutCount >= 3) {
      type = '计划过载';
      confidence = round(clamp01(
        0.55
        + 0.30 * clamp01((planLoadRatio - 1.1) / 0.5)
        + 0.15 * (consecutiveTimeoutCount >= 3 ? 1 : 0)
      ), 2);
      actions = ['下调密度，提高弹性位比例'];
      if (planLoadRatio > 1.1) matched.push('planLoadRatio > 1.1');
      if (consecutiveTimeoutCount >= 3) matched.push('consecutiveTimeoutCount >= 3');
    } else if (consecutiveZeroDays >= 2) {
      type = '执行中断';
      confidence = round(clamp01(0.60 + 0.40 * clamp01((consecutiveZeroDays - 2) / 3)), 2);
      actions = ['转入恢复流程，不追加任务'];
      matched.push('consecutiveZeroDays >= 2');
    } else if (efficiencyRatio > 1.4 && completion >= 0.6) {
      type = '效率不足';
      confidence = round(clamp01(
        0.50
        + 0.30 * clamp01((efficiencyRatio - 1.4) / 0.6)
        + 0.20 * clamp01((completion - 0.6) / 0.4)
      ), 2);
      actions = ['校准标准工时，建议拆分'];
      matched.push('efficiencyRatio > 1.4 && completion >= 0.6');
    } else if (externalRatio > 0.3) {
      type = '外部干扰';
      confidence = round(clamp01(0.50 + 0.50 * clamp01((externalRatio - 0.3) / 0.4)), 2);
      actions = ['预留缓冲，将干扰时段移出计划'];
      matched.push('externalRatio > 0.3');
    } else {
      type = '无偏差';
      confidence = 0.60;
      actions = ['保持当前节奏，下周不做结构调整'];
      matched.push('无阈值命中');
    }

    evidence.matched = matched;

    return {
      type: type,
      confidence: confidence,
      actions: actions,
      evidence: evidence
    };
  }

  return { attribute: attribute };
}));
