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
  var THRESHOLD = Object.freeze({ ample: 1.2, reasonable: 0.9, tight: 0.7 });

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
    if (!isNum(T) || !isNum(R) || !isNum(margin)) {
      throw new RangeError('feasibility: 计算结果超出有限数值范围');
    }

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
    var estMin = num(src.estMin, 0);
    var startMin = src.startMin !== undefined && src.startMin !== null ? num(src.startMin, null) : null;
    if (!Number.isInteger(estMin) || estMin < 0) throw new TypeError('schedule: estMin 必须是非负整数分钟');
    if (startMin !== null && (!Number.isInteger(startMin) || startMin < 0)) throw new TypeError('schedule: startMin 必须是非负整数分钟');
    var id = String(src.id !== undefined ? src.id : ('t' + (idx + 1)));
    if (!id) throw new TypeError('schedule: 任务 ID 必须是非空字符串');
    return {
      id: id,
      subject: String(src.subject !== undefined ? src.subject : '未分类'),
      estMin: estMin,
      weight: num(src.weight, 0),
      date: src.date !== undefined && src.date !== null ? String(src.date) : null,
      startMin: startMin,
      title: src.title !== undefined ? String(src.title) : ''
    };
  }

  function normalizeSlot(s, idx) {
    var src = s || {};
    var startMin = num(src.startMin, 0);
    var durMin = num(src.durMin, 0);
    if (!Number.isInteger(startMin) || startMin < 0) throw new TypeError('schedule: slot.startMin 必须是非负整数分钟');
    if (!Number.isInteger(durMin) || durMin < 0) throw new TypeError('schedule: slot.durMin 必须是非负整数分钟');
    return {
      idx: idx,
      date: String(src.date !== undefined ? src.date : ''),
      startMin: startMin,
      durMin: durMin,
      available: src.available !== false,
      isBuffer: src.isBuffer === true
    };
  }

  /* 每个可用时段独立记账，规范化后拒绝同日重叠；只排序副本，保留候选优先级。 */
  function validateSlots(slots) {
    var available = slots.filter(function (s) { return s.available && s.durMin > 0; });
    available.sort(function (a, b) {
      if (a.date < b.date) return -1;
      if (a.date > b.date) return 1;
      return a.startMin - b.startMin || a.idx - b.idx;
    });
    for (var i = 1; i < available.length; i++) {
      var prev = available[i - 1];
      var cur = available[i];
      if (cur.date === prev.date && cur.startMin < prev.startMin + prev.durMin) {
        throw new TypeError('同日期的可用时段不能重叠（' + cur.date + '，slots[' + prev.idx + '] / slots[' + cur.idx + ']）');
      }
    }
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
      if (c[0] > lo) continue;
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
      days: Object.create(null),
      dayOrder: []
    };
    for (var i = 0; i < slots.length; i++) st.slotUsed.push(0);
    slots.forEach(function (slot) {
      var d = st.days[slot.date];
      if (!d) {
        d = st.days[slot.date] = { date: slot.date, total: 0, nonBuffer: 0, bufferUsed: 0, bufferCap: 0, intervals: Object.create(null) };
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
    var cause = { unavailable: false, noTail: false, dayFull: false, bufferFull: false, contiguous: false, anchorOccupied: false };
    var anchored = task.date !== null && task.startMin !== null;

    for (var i = 0; i < candIdx.length && placed < need; i++) {
      /* 固定任务必须从锚点起排，首槽失败不得跳到后续槽。 */
      if (anchored && placed === 0 && i > 0) break;
      var si = candIdx[i];
      var slot = st.slots[si];
      if (anchored && placed === 0 && st.slotUsed[si] > 0) {
        cause.anchorOccupied = true;
        break;
      }
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
      if (take < need - placed) {
        if (take === room) cause.dayFull = true;
        if (take === allow) cause.contiguous = true;
        if (slot.isBuffer && take === day.bufferCap - day.bufferUsed) cause.bufferFull = true;
      }

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
    var usable = [];
    for (var i = 0; i < slots.length; i++) {
      if (slots[i].date === task.date && slots[i].startMin === task.startMin) {
        out.push(i);
        if (slots[i].available && slots[i].durMin > 0) usable.push(i);
      }
    }
    return usable.length ? usable : out;
  }

  function reasonOf(cause, task, remaining, P) {
    if (cause.anchorOccupied) {
      return '指定时段已被占用（' + task.date + ' ' + fmtMin(task.startMin) + '），固定起点冲突';
    }
    if (task.date && task.startMin !== null && cause.unavailable && !cause.dayFull && !cause.contiguous) {
      return '指定时段不可用或不存在（' + task.date + ' ' + fmtMin(task.startMin) + '）';
    }
    if (cause.bufferFull && !cause.dayFull && !cause.contiguous) return '弹性位已用尽，无法兜底';
    if (cause.contiguous && !cause.dayFull) {
      return '单科目连续上限 ' + P.maxContiguousMin + ' min 限制，剩余 ' + remaining + ' min 未排入';
    }
    if (cause.dayFull) return '日上限 ' + P.dailyCapMin + ' min 已满，剩余 ' + remaining + ' min 未排入';
    if (task.date !== null && task.startMin !== null) {
      return '指定时段之后可用余量不足，剩余 ' + remaining + ' min 未排入';
    }
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
    var taskIds = Object.create(null);
    tasks.forEach(function (task) {
      if (taskIds[task.id]) throw new TypeError('schedule: 任务 ID 重复：' + task.id);
      taskIds[task.id] = true;
    });
    var slots = (src.slots || []).map(normalizeSlot);
    validateSlots(slots);
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
        for (var j = 0; j < slots.length; j++) {
          if (usedSlots[j]) continue;
          var s = slots[j];
          if (s.date !== task.date) continue;
          if (s.startMin !== cursorEnd || !s.available || s.durMin <= 0) continue;
          found = j;
          break;
        }
        if (found < 0) break;
        chain.push(found);
        usedSlots[found] = true;
        cursorEnd = slots[found].startMin + slots[found].durMin;
      }
      var res = fillInto(st, task, task.estMin, chain);
      if (res.placed > 0) commit(task, res.segs, true);
      if (res.placed < task.estMin) {
        unplanned.push({
          taskId: task.id,
          reason: reasonOf(res.cause, task, task.estMin - res.placed, P)
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

    var work = pending.map(clone);
    var need = overflow;
    var compressed = [];

    var order = work.filter(function (t) { return !isLocked(t, locks); }).sort(byWeightAsc);
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
      if (!isFiniteNumber(t.est) || !Number.isInteger(t.est) || t.est < 0) throw new TypeError('replan: 任务工时必须是非负整数分钟：' + t.id);
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

  function isObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function validId(v) {
    return typeof v === 'string' && v.length > 0;
  }

  function validTask(t) {
    return isObject(t) && validId(t.id) && isFiniteNumber(t.est) && Number.isInteger(t.est) && t.est >= 0;
  }

  function validateConfirmResult(result) {
    if (!Array.isArray(result.strategies) || result.strategies.length !== 4 ||
        !Array.isArray(result.diff) || !isObject(result.snapshot) ||
        !Array.isArray(result.snapshot.tasks) || !result.snapshot.tasks.every(validTask) ||
        !Array.isArray(result.snapshot.week) || !result.snapshot.week.every(function (day) { return isObject(day) && validId(day.date); }) ||
        (result.snapshot.placementModel !== undefined && !isObject(result.snapshot.placementModel)) ||
        !Array.isArray(result.nextTasks) || !Array.isArray(result.nextPlacements) ||
        !isObject(result.guards)) {
      throw new TypeError('confirmReplan: 重排结果结构不完整，拒绝确认');
    }
    result.strategies.forEach(function (strategy, i) {
      if (!isObject(strategy) || strategy.level !== i + 1 || strategy.name !== LEVEL_NAMES[i + 1] ||
          typeof strategy.applied !== 'boolean' || !isFiniteNumber(strategy.growth) || typeof strategy.reason !== 'string') {
        throw new TypeError('confirmReplan: 重排策略结构非法，拒绝确认');
      }
    });
    result.diff.forEach(function (item) {
      if (!isObject(item) || ['defer', 'compress', 'substitute', 'abandon'].indexOf(item.op) < 0 ||
          !validId(item.taskId) || typeof item.from !== 'string' || typeof item.to !== 'string' || typeof item.detail !== 'string') {
        throw new TypeError('confirmReplan: 重排差异结构非法，拒绝确认');
      }
    });
    ['loadGrowthOk', 'bufferPreserved', 'consecutiveOk', 'compressedShareOk'].forEach(function (key) {
      if (typeof result.guards[key] !== 'boolean') throw new TypeError('confirmReplan: 重排守卫结构非法，拒绝确认');
    });
    var taskIds = Object.create(null);
    result.nextTasks.forEach(function (task) {
      if (!validTask(task) || taskIds[task.id]) throw new TypeError('confirmReplan: 重排任务结构非法，拒绝确认');
      taskIds[task.id] = true;
    });
    var placementIds = Object.create(null);
    result.nextPlacements.forEach(function (placement) {
      if (!isObject(placement)) throw new TypeError('confirmReplan: 重排落点结构非法，拒绝确认');
      var native = !Object.prototype.hasOwnProperty.call(placement, 'taskId') && isObject(placement.task) && Array.isArray(placement.segs);
      var taskId = native ? placement.task.id : placement.taskId;
      var segments = native ? placement.segs : placement.segments;
      if (!validId(taskId) || !taskIds[taskId] || placementIds[taskId] || !Array.isArray(segments) ||
          !Number.isInteger(placement.minutes) || placement.minutes < 0 ||
          (native ? (placement.locked !== undefined && typeof placement.locked !== 'boolean') : typeof placement.locked !== 'boolean')) {
        throw new TypeError('confirmReplan: 重排落点结构非法，拒绝确认');
      }
      var total = 0;
      segments.forEach(function (segment) {
        if (!isObject(segment) || !validId(segment.date) || !Number.isInteger(segment.minutes) || segment.minutes <= 0 ||
            typeof segment.isBuffer !== 'boolean') {
          throw new TypeError('confirmReplan: 重排落点分段非法，拒绝确认');
        }
        total += segment.minutes;
      });
      if (total !== placement.minutes || (placement.minutes === 0 && segments.length)) {
        throw new TypeError('confirmReplan: 重排落点分钟不一致，拒绝确认');
      }
      placementIds[taskId] = true;
    });
  }

  /* 确认落库：仅接受 needsConfirmation=true 的结果，返回新的已确认对象（不修改入参） */
  function confirmReplan(result) {
    if (!isObject(result)) {
      throw new TypeError('confirmReplan: 需要重排结果对象');
    }
    if (result.needsConfirmation !== true) {
      throw new TypeError('confirmReplan: 该结果无需确认，不能重复确认');
    }
    if (result.verdict !== 'needsConfirmation') {
      throw new TypeError('confirmReplan: 重排结果状态非法，拒绝确认');
    }
    validateConfirmResult(result);
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
