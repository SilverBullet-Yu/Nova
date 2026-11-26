/* =========================================================
   诺瓦 Nova · 中断识别与挽救（Stage B / F-7.1 F-7.2 F-7.3）
   ---------------------------------------------------------
   · 连续 ≥3 天无记录 → interrupted = true → 今日页顶部 banner
   · 弹层三步：缺口量化 → 压缩 / 顺延 / 降级 → 确认摘要
   · 所有数值由 ZX.state 推导（week / tasks / feas），不写死
   · 经典 script，IIFE 挂 ZX.flows.rescue，支持 file:// 双击
   · 弹层 / 轻提示只用 ZX.ui 原语，不另造弹窗
   ========================================================= */
window.ZX = window.ZX || {};

(function (ZX) {
  'use strict';

  var U = ZX.util;

  /* ---------- 口径常量 ----------
     THRESHOLD 是真实中断阈值；DEMO_ZERO_DAYS 只供独立演示预览使用。
     剩余天数由局部传入天数或真实断更天数推导；缺口、工时、容量由 state 只读计算。 */
  var THRESHOLD = 3;         /* 连续 ≥3 天无记录判定为中断 */
  var DEMO_ZERO_DAYS = 4;    /* 独立演示入口的局部连续无记录天数，不写真实 state */
  var COMPRESS_RATE = 0.40;  /* 压缩：剩余工时下调 40% */
  var MIN_EST = 15;          /* 压缩下限 15 分钟 */
  var DEFER_DAYS = 7;        /* 顺延：截止日期 +7 天、周容量 +1 周 */
  var DOWN_POINTS = 30;      /* 降级：目标值下调 30 分 */

  var api = null;            /* ZX.ui.sheet 控制器（flow.open() 产出） */
  var flow = null;           /* ZX.ui.flowSheet 步骤控制器 */
  var choice = 'compress';   /* 默认压缩 */
  var resumeBannerSeen = false;  /* 零惩罚回归提示是否已被用户收起 */

  /* ---------- 状态初始化（只新增契约第 4 节预留字段） ----------
     初始化后立即按真实执行记录识别一次：断更 ≥ 阈值时今日页 banner 直接出现，
     不再依赖用户先在对话里说「我断了几天」。 */
  (function initState() {
    var S = ZX.state;
    if (typeof S.consecutiveZeroDays !== 'number') S.consecutiveZeroDays = 0;
    if (S.interrupted === undefined) S.interrupted = null;
    if (S.rescueRecord === undefined) S.rescueRecord = null;
    if (S.rescueRecord && U.dayKey(S.rescueRecord.at) === U.todayKey()) {
      S.consecutiveZeroDays = 0;
      S.interrupted = false;
    } else {
      detect();
    }
  })();

  /* ---------- 缺口口径 ---------- */
  function placementApi() {
    return window.Rhythm && window.Rhythm.placementModel;
  }

  function weekPlannedMin() {
    var S = ZX.state;
    if (S.placementModel) {
      var P = placementApi();
      if (!P) throw new Error('落点模型未加载');
      return P.summary(S.placementModel).totals.usedMin;
    }
    return (S.week || []).reduce(function (a, d) { return a + U.num(d.total, 0); }, 0);
  }

  function remainingWorkloadMin() {
    return ZX.state.placementModel ? sumEst(undone()) : weekPlannedMin();
  }

  function dailyAvailMin() {
    return U.num(ZX.state.feas.weeklyH, 0) * 60 / 7;
  }

  /* 剩余天数真算：一周 7 天 − 已断更天数（下限 1）。
     独立演示可局部传天数；真实流程从 state.consecutiveZeroDays 推导。 */
  function remainDays(explicitDays) {
    var n = typeof explicitDays === 'number' && isFinite(explicitDays)
      ? explicitDays : U.num(ZX.state.consecutiveZeroDays, 0);
    return Math.max(1, 7 - U.num(n, 0));
  }

  /* 剩余可用 = 每日可用 × 剩余天数（不取整，取整只发生在展示层） */
  function availMin(days) {
    return dailyAvailMin() * U.num(days, remainDays());
  }

  /* 缺口 = max(0, 计划 − 已投入 − 剩余可用)。
     v3 的 planMin 统一传剩余计划；legacy 的周计划含已投入，仍在这里扣减。 */
  function gapOf(planMin, days) {
    var remaining = U.num(planMin, 0) - (ZX.state.placementModel ? 0 : ZX.state.workedMin());
    return Math.max(0, Math.round(remaining - availMin(days)));
  }

  function metrics(explicitDays) {
    var S = ZX.state;
    var planned = weekPlannedMin();
    var workload = remainingWorkloadMin();
    var worked = S.workedMin();
    var days = remainDays(explicitDays);
    var avail = availMin(days);
    return {
      planned: planned,
      workload: workload,
      worked: worked,
      daily: dailyAvailMin(),
      zeroDays: typeof explicitDays === 'number' && isFinite(explicitDays)
        ? U.num(explicitDays, 0) : U.num(S.consecutiveZeroDays, 0),
      days: days,
      avail: avail,
      gap: gapOf(workload, days)
    };
  }

  /* ---------- 文本 ---------- */
  function hmCn(n) {
    var v = Math.max(0, Math.round(U.num(n, 0)));
    var h = Math.floor(v / 60), m = v % 60;
    if (!h) return m + ' 分钟';
    if (!m) return h + ' 小时';
    return h + ' 小时 ' + m + ' 分';
  }

  function undone() {
    return ZX.state.tasks.filter(function (t) { return !t.done && !t.skipped && !t.deferred && !t.abandoned && !t.substituted; });
  }

  function byWeightAsc(list) {
    return list.slice().sort(function (a, b) {
      return (U.num(a.weight, 0) - U.num(b.weight, 0)) || (U.num(a.est, 0) - U.num(b.est, 0));
    });
  }

  function dropItem(t) {
    return {
      id: t.id, title: t.title, subject: t.s,
      est: U.num(t.est, 0), weight: U.num(t.weight, 0), abandoned: true
    };
  }

  function sumEst(list) {
    return list.reduce(function (a, t) { return a + U.num(t.est, 0); }, 0);
  }

  /* 日期 / 时段助手（parseDay / isoDay / addDays / retime）用 util.js 共用实现 */

  /* ---------- 三种挽救方式的推演（同一套缺口公式） ----------
     压缩 / 降级会删减或压缩本周工作：v3 直接收敛为调整后的剩余工时，
     legacy 则保留「已投入 + 调整后未完成工时」的原口径。
     顺延不删不压，计划保持本周原样，剩余可用 +1 周。 */
  function optionOf(key, explicitDays) {
    var S = ZX.state;
    var days = remainDays(explicitDays);
    var rest = undone();
    var eligible = rest.filter(function (t) { return !(S.locks && S.locks[t.id]); });

    if (key === 'defer') {
      var planMin = remainingWorkloadMin();
      var deferDays = days + DEFER_DAYS;
      var base = U.parseDay(S.goal.deadline) || new Date();
      return {
        key: 'defer', label: '顺延',
        planMin: planMin, days: deferDays,
        avail: availMin(deferDays),
        gap: gapOf(planMin, deferDays),
        items: [],
        dropped: [],
        weeksAfter: U.num(S.feas.weeks, 1) + 1,
        deadlineAfter: U.isoDay(U.addDays(base, DEFER_DAYS))
      };
    }

    if (key === 'downgrade') {
      var dropN = Math.min(2, Math.max(0, rest.length - 1));
      var dropped = byWeightAsc(eligible).slice(0, dropN).map(dropItem);
      var dropIds = dropped.map(function (d) { return d.id; });
      var keep = rest.filter(function (t) { return dropIds.indexOf(t.id) < 0; });
      /* v3 的 weekPlannedMin / gapOf 已使用剩余模型工时，不能再加 worked。 */
      var planD = (S.placementModel ? 0 : S.workedMin()) + sumEst(keep);
      var cur = parseInt(String(S.goal.target || ''), 10);
      return {
        key: 'downgrade', label: '降级',
        planMin: planD, days: days,
        avail: availMin(days),
        gap: gapOf(planD, days),
        items: [],
        dropped: dropped,
        targetFrom: isFinite(cur) ? cur : null,
        targetAfter: isFinite(cur) ? Math.max(1, cur - DOWN_POINTS) : null
      };
    }

    /* compress */
    var dropC = byWeightAsc(eligible).slice(0, Math.min(1, Math.max(0, rest.length - 1))).map(dropItem);
    var dropCIds = dropC.map(function (d) { return d.id; });
    var items = eligible.filter(function (t) { return dropCIds.indexOf(t.id) < 0; }).map(function (t) {
      var from = U.num(t.est, 0);
      return {
        id: t.id, title: t.title, subject: t.s,
        from: from,
        est: Math.max(MIN_EST, Math.round(from * (1 - COMPRESS_RATE)))
      };
    });
    var planC = (S.placementModel ? 0 : S.workedMin()) + sumEst(items) + sumEst(rest.filter(function (t) { return S.locks && S.locks[t.id]; }));
    return {
      key: 'compress', label: '压缩',
      planMin: planC, days: days,
      avail: availMin(days),
      gap: gapOf(planC, days),
      items: items,
      dropped: dropC
    };
  }

  /* 独立演示预览：天数只作为局部参数参与计算，不调用 detect，不写业务状态。 */
  function preview(explicitDays) {
    var days = Math.max(0, U.num(explicitDays, DEMO_ZERO_DAYS));
    return {
      zeroDays: days,
      metrics: metrics(days),
      options: ['compress', 'defer', 'downgrade'].map(function (key) { return optionOf(key, days); })
    };
  }

  /* ---------- banner（今日页顶部） ---------- */
  function banner() {
    var S = ZX.state;
    var m = metrics();

    if (S.interrupted === true) {
      return '<div class="banner sb-banner">' +
        '<img class="sb-mascot" src="assets/img/mascot-v4-rescue.svg" width="32" height="28" alt="" />' +
        '<div class="sb-b-main">' +
          '<div class="bt">这周还剩 ' + m.days + ' 天，落下的 ' + hmCn(m.gap) + '可以重排</div>' +
          '<div class="bs">连续 ' + U.num(S.consecutiveZeroDays, 0) + ' 天没有记录。计划还在，选一种方式把它接回来。</div>' +
        '</div>' +
        '<div class="spacer"></div>' +
        '<button type="button" class="btn pri sb-b-btn" data-sb="enter">进入挽救</button>' +
      '</div>';
    }

    if (S.interrupted === false && S.rescueRecord && !resumeBannerSeen) {
      var r = S.rescueRecord;
      return '<div class="banner sb-banner sb-banner-ok">' +
        '<img class="sb-mascot" src="assets/img/mascot-v4-done.svg" width="32" height="28" alt="" />' +
        '<div class="sb-b-main">' +
          '<div class="bt">计划已接回。连续记录从今天重新开始，之前的不计为欠账。</div>' +
          '<div class="bs">方式 ' + U.esc(strategyLabel(r.strategy)) +
            ' · 缺口 ' + U.hm(U.num(r.gapBefore, 0)) + ' → ' + U.hm(U.num(r.gapAfter, 0)) + '</div>' +
        '</div>' +
        '<div class="spacer"></div>' +
        '<button type="button" class="btn ghost sb-b-btn" data-sb="dismiss">知道了</button>' +
      '</div>';
    }

    return '';
  }

  function strategyLabel(key) {
    return key === 'defer' ? '顺延' : key === 'downgrade' ? '降级' : '压缩';
  }

  /* ---------- 识别 ----------
     数据源 = 执行记录：从 sessions 统计「最近一次有记录的日子距今天几天」。
     · 今天有记录 → 0；从未有记录（新用户 / 纯种子态）→ 0，不把首日判成中断
     · detect() 无参调用即为真实计算；显式传天数仅保留为兼容测试锚点
     · 独立演示使用 preview(days) 局部计算，不调用 detect */
  function zeroDaysFromSessions() {
    var S = ZX.state;
    var list = Array.isArray(S.sessions) ? S.sessions : [];
    if (!list.length) return 0;
    var days = {};
    list.forEach(function (s) {
      var k = U.dayKey(s && (s.endAt || s.startAt));
      if (k) days[k] = true;
    });
    var base = U.today0();
    if (days[U.isoDay(base)]) return 0;
    for (var i = 1; i <= 60; i++) {
      if (days[U.isoDay(U.addDays(base, -i))]) return i;
    }
    return 60;   /* 有记录但已超出回看窗口：按窗口上限计 */
  }

  function detect(explicitDays) {
    var S = ZX.state;
    var n = (typeof explicitDays === 'number') ? explicitDays : zeroDaysFromSessions();
    S.consecutiveZeroDays = n;
    S.interrupted = n >= THRESHOLD ? true : (S.interrupted === true ? false : S.interrupted);
    return S.interrupted === true;
  }

  /* ---------- 弹层骨架（flowSheet 统一步骤编排） ----------
     两屏：01 缺口与方式（四宫格 + 三选一）→ 02 确认摘要。
     中断后用户耐心极低，把「看缺口」与「选接法」合并成一屏，全流程两步走完。 */
  function stepMarks(active) {
    var names = ['01 缺口与方式', '02 确认'];
    return names.map(function (n, i) {
      return '<i class="' + (i + 1 === active ? 'on' : '') + '">' + n + '</i>';
    }).join('');
  }

  function stepDef(n) {
    if (n === 1) {
      return {
        head: ['RESCUE / 缺口', '把计划接回来', '先看缺口有多大，再选一种接法；任何一步都不需要补记录。'],
        body: bodyGapAndChoice(),
        footer: ZX.ui.footNav({ ns: 'sb', act: 'next', label: '下一步 · 确认摘要' }),
        wide: true
      };
    }
    return {
      head: ['RESCUE / 确认', '确认并恢复', '确认后立即生效；关闭或取消不会写入任何状态。'],
      body: bodyConfirm(),
      footer: ZX.ui.footNav({ ns: 'sb', back: true, act: 'apply', label: '确认并恢复' }),
      wide: true
    };
  }

  /* ---------- 第 1 屏：缺口四宫格 + 三选一（一次算齐，不再重复推演） ---------- */
  function cell(label, val, note, cls) {
    return '<div class="sb-cell ' + (cls || '') + '">' +
      '<span>' + label + '</span><b>' + val + '</b><i>' + note + '</i></div>';
  }

  function bodyGapAndChoice() {
    var m = metrics();
    var zero = m.gap === 0;
    var cmp = optionOf('compress');
    var dfr = optionOf('defer');
    var dwn = optionOf('downgrade');
    var cmpTxt = cmp.items.length
      ? cmp.items.map(function (i) { return i.from + ' → ' + i.est; }).join('、') + ' min'
      : '没有可压缩项';
    return '<div class="sb-steps">' + stepMarks(1) + '</div>' +
      '<div class="sb-metrics">' +
        cell('本周原计划', U.hm(m.planned), '7 天合计 · ' + m.planned + ' min') +
        cell('已投入', U.hm(m.worked), '已记录的完成时长 · ' + m.worked + ' min') +
        cell('剩余可用', U.hm(Math.round(m.avail)), '每日 ' + U.hm(Math.round(m.daily)) + ' × ' + m.days + ' 天') +
        cell('缺口', U.hm(m.gap), zero ? '本周没有硬缺口' : m.gap + ' min · 需要重排的量', 'gap' + (zero ? ' zero' : '')) +
      '</div>' +
      '<div class="notice sb-note">缺口 = 本周原计划 − 已投入 − 剩余可用。' +
        '这 ' + m.days + ' 天每天可用 ' + U.hm(Math.round(m.daily)) + '，合计 ' + U.hm(Math.round(m.avail)) + '。' +
        (zero ? '本周没有硬缺口，可选择降载保节奏。' : '各方案可能仍有缺口，请比较下方计算结果。') +
      '</div>' +
      '<div class="sb-opts" role="radiogroup" aria-label="挽救方式">' +
        optCard(cmp,
          '压缩 ' + cmp.items.length + ' 项，放弃 ' + cmp.dropped.length + ' 项。',
          '工时下调 40%（' + cmpTxt + '，不低于 15 分钟），压缩项标记为降级，未自动记为完成。',
          '本周计划 ' + U.hm(m.planned) + ' → ' + U.hm(cmp.planMin) + ' · 放弃 ' + cmp.dropped.length + ' 项') +
        optCard(dfr,
          '截止日期 +7 天、周期 +1 周；任务一项不删，工时一项不压。',
          '整体完成时间推后 7 天，截止 ' + dfr.deadlineAfter + '。',
          '剩余可用 ' + U.hm(Math.round(m.avail)) + ' → ' + U.hm(Math.round(dfr.avail)) + ' · 任务数不变') +
        optCard(dwn,
          '按规则调整目标，放弃 ' + dwn.dropped.length + ' 项。',
          (dwn.targetFrom ? '目标 ' + dwn.targetFrom + ' → ' + dwn.targetAfter + ' 分，' : '') +
            '放弃 ' + dwn.dropped.length + ' 项，重心收在权重最高的项上。',
          '本周计划 ' + U.hm(m.planned) + ' → ' + U.hm(dwn.planMin) + ' · 放弃 ' + dwn.dropped.length + ' 项') +
      '</div>' +
      '<p class="sb-hint">中断天数由执行记录计算：连续 ' + U.num(ZX.state.consecutiveZeroDays, 0) +
        ' 天没有记录，达到 ' + THRESHOLD + ' 天即进入挽救。以上数字根据当前计划与可用时间按固定规则计算；锁定任务不压缩、不放弃。选择不会立即生效。</p>';
  }

  function optCard(o, act, cost, extra) {
    var on = choice === o.key;
    var impact = '缺口 ' + U.hm(metrics().gap) + ' → ' + U.hm(o.gap) +
      (o.gap === 0 ? ' · 归零' : '');
    return '<button type="button" class="sb-opt' + (on ? ' on' : '') + '" role="radio" aria-checked="' + on + '"' +
        ' tabindex="' + (on ? '0' : '-1') + '"' +   /* roving tabindex：Tab 只进选中项，方向键在组内移动 */
        ' data-sb="pick" data-v="' + o.key + '">' +
        '<div class="sb-opt-h"><b>' + o.label + '</b>' +
          (o.key === 'compress' ? '<span class="sb-tag">默认</span>' : '') +
          '<span class="sb-opt-k">' + (on ? '已选择' : '选择') + '</span></div>' +
        '<p class="sb-opt-a">' + act + '</p>' +
        '<p class="sb-opt-c">代价：' + cost + '</p>' +
        '<div class="sb-opt-i"><span>' + impact + '</span><i>' + extra + '</i></div>' +
      '</button>';
  }

  /* ---------- 第 2 屏：确认摘要 ---------- */
  function row(label, val) {
    return '<div class="sb-row"><span>' + label + '</span><b>' + val + '</b></div>';
  }

  function bodyConfirm() {
    var o = optionOf(choice);
    var m = metrics();
    var rows = [];
    rows.push(row('方式', o.label));

    if (o.key === 'compress') {
      rows.push(row('压缩', o.items.length + ' 项 · ' +
        o.items.map(function (i) { return i.from + ' → ' + i.est + ' min'; }).join('、')));
      rows.push(row('放弃', o.dropped.length
        ? o.dropped.length + ' 项 · ' + o.dropped.map(function (d) { return U.esc(d.subject) + ' · ' + U.esc(d.title) + '（' + d.est + ' min）'; }).join('、')
        : '0 项'));
    } else if (o.key === 'defer') {
      rows.push(row('顺延', DEFER_DAYS + ' 天 · 截止 ' + o.deadlineAfter));
      rows.push(row('周期', U.num(ZX.state.feas.weeks, 1) + ' → ' + o.weeksAfter + ' 周 · 剩余可用 +1 周'));
      rows.push(row('放弃', '0 项 · 工时不变'));
    } else {
      rows.push(row('目标', (o.targetFrom ? o.targetFrom + ' → ' + o.targetAfter + ' 分' : '已下调')));
      rows.push(row('放弃', o.dropped.length
        ? o.dropped.length + ' 项 · ' + o.dropped.map(function (d) { return U.esc(d.subject) + ' · ' + U.esc(d.title) + '（' + d.est + ' min）'; }).join('、')
        : '0 项'));
    }

    rows.push(row('缺口', U.hm(m.gap) + ' → ' + U.hm(o.gap) + (o.gap === 0 ? ' · 归零' : '')));
    rows.push(o.key === 'defer'
      ? row('剩余可用', U.hm(Math.round(m.avail)) + ' → ' + U.hm(Math.round(o.avail)))
      : row('本周计划', U.hm(m.planned) + ' → ' + U.hm(o.planMin)));
    rows.push(row('连续记录', '从今天重新开始，之前的 ' + U.num(ZX.state.consecutiveZeroDays, 0) + ' 天不计为欠账'));

    return '<div class="sb-steps">' + stepMarks(2) + '</div>' +
      '<div class="sb-sum">' + rows.join('') + '</div>' +
      '<p class="sb-sum-note">确认后：任务工时 / 周期 / 截止日期按上面一行改写，连续记录归零重计，' +
        '并在对话里留一条说明。关闭或取消不会写入任何状态。</p>';
  }

  /* ---------- 生效 ---------- */
  function goalRemoved() {
    if (!ZX.state.goal || ZX.state.goal.source === 'removed') {
      if (ZX.ui) ZX.ui.toast('请先设置阶段目标，再进行中断挽救。', 'warn');
      return true;
    }
    return false;
  }

  var approvedPreview = null;
  function previewKey(option) {
    var S = ZX.state;
    return JSON.stringify([option, S.tasks, S.locks, S.dayAssign, S.placementModel, S.goal, S.feas, S.week, S.avail, metrics()]);
  }

  function checkedModel(result, label) {
    if (!result || result.ok !== true || !result.model) {
      throw new TypeError((result && result.reason) || label + '失败');
    }
    return result.model;
  }

  function placementTime(P, model, taskId) {
    var segments = P.taskSegments(model, taskId);
    if (!segments.length) return '';
    var first = segments[0];
    var last = segments[segments.length - 1];
    var from = U.pad2(Math.floor(first.startMin / 60)) + ':' + U.pad2(first.startMin % 60);
    var to = U.pad2(Math.floor((last.startMin + last.durMin) / 60)) + ':' + U.pad2((last.startMin + last.durMin) % 60);
    return first.date === last.date ? from + '–' + to
      : first.date.slice(5) + ' ' + from + '–' + last.date.slice(5) + ' ' + to;
  }

  function projectPlacementTasks(P, model, tasks) {
    return tasks.map(function (task) {
      var segments = P.taskSegments(model, task.id);
      var next = Object.assign({}, task, {
        time: placementTime(P, model, task.id),
        date: segments.length ? segments[0].date : null
      });
      var unplaced = model.unplanned.find(function (item) { return item.taskId === task.id; });
      if (unplaced) {
        next.unplanned = true;
        next.unplannedReason = unplaced.reason;
      } else {
        delete next.unplanned;
        delete next.unplannedReason;
      }
      return next;
    });
  }

  /* v3 先在独立副本上完成释放/缩放与任务投影；任何失败都发生在状态赋值前。
     顺延只改周期与截止日期，不重建模型，也不改写任务落点。 */
  function preparePlacementPatch(S, o, stamp) {
    var P = placementApi();
    if (!P) throw new Error('落点模型未加载');
    var prefix = 'pm_rescue_' + stamp.toString(36) + '_';
    var nextTasks = o.key === 'defer' ? S.tasks : S.tasks.map(function (task) {
      if (U.findById(o.dropped, task.id)) return Object.assign({}, task, { abandoned: true, abandonedAt: stamp });
      var hit = o.key === 'compress' && U.findById(o.items, task.id);
      return hit ? Object.assign({}, task, { est: hit.est, degraded: true }) : task;
    });
    var nextGoal = Object.assign({}, S.goal || {});
    var nextFeas = Object.assign({}, S.feas || {});
    var patch = { tasks: nextTasks, goal: nextGoal, feas: nextFeas };

    if (o.key === 'defer') {
      nextFeas.weeks = o.weeksAfter;
      nextGoal.weeks = o.weeksAfter;
      nextGoal.deadline = o.deadlineAfter;
      return patch;
    }

    var nextModel = S.placementModel;
    o.dropped.forEach(function (dropped) {
      nextModel = checkedModel(P.releaseTask(nextModel, dropped.id, '中断挽救放弃', prefix), '释放放弃任务');
    });
    if (o.key === 'compress') {
      var unplannedIds = Object.create(null);
      nextModel.unplanned.forEach(function (item) { unplannedIds[item.taskId] = true; });
      o.items.forEach(function (item) {
        if (unplannedIds[item.id]) return;
        nextModel = checkedModel(P.resizeTask(nextModel, item.id, item.est, prefix), '压缩任务 ' + item.id);
      });
    } else if (o.targetAfter !== null) {
      nextGoal.target = o.targetAfter + ' 分';
    }
    patch.placementModel = nextModel;
    patch.tasks = projectPlacementTasks(P, nextModel, nextTasks);
    return patch;
  }

  function commitPlacementPatch(S, patch) {
    var previous = {};
    var keys = Object.keys(patch).concat(['week', 'weekShift', 'dayAssign', 'buffer']);
    keys.forEach(function (key) { previous[key] = S[key]; });
    try {
      Object.assign(S, patch);
      if (S.placementModel) {
        if (typeof S.syncPlacementProjection !== 'function') throw new Error('缺少落点投影同步');
        if (S.syncPlacementProjection() === false) throw new Error('落点投影同步失败');
      }
    } catch (err) {
      /* 同步阶段也保持整笔回滚，避免 week/dayAssign/buffer 只写了一半。 */
      keys.forEach(function (key) { S[key] = previous[key]; });
      throw err;
    }
  }

  function apply() {
    if (goalRemoved() || !approvedPreview) return;
    var S = ZX.state;
    var o = optionOf(choice);
    if (approvedPreview !== previewKey(o)) {
      approvedPreview = null;
      flow.go(1);
      ZX.ui.toast('计划已变化，请重新预览并确认。', 'warn');
      return;
    }
    var before = metrics();
    var stamp = Date.now();
    var zeroDays = U.num(S.consecutiveZeroDays, 0);
    var weeksBefore = U.num(S.feas.weeks, 1);
    var record = {
      strategy: o.key,
      at: stamp,
      deltaMin: Math.max(0, before.gap - o.gap),
      dropped: o.dropped.slice(),
      gapBefore: before.gap,
      gapAfter: o.gap
    };

    if (S.placementModel) {
      try {
        var patch = preparePlacementPatch(S, o, stamp);
        patch.consecutiveZeroDays = 0;
        patch.interrupted = false;
        patch.rescueRecord = record;
        commitPlacementPatch(S, patch);
      } catch (err) {
        ZX.ui.toast('挽救未能应用：' + (err && err.message ? err.message : String(err)) + '。当前计划未变更。', 'warn');
        return;
      }
    } else {
      /* legacy 保留原物理删除与 U.retime 压缩行为，兼容旧周投影测试。 */
      if (o.key === 'compress') {
        var dropIds = o.dropped.map(function (d) { return d.id; });
        S.tasks = S.tasks.filter(function (t) { return dropIds.indexOf(t.id) < 0; }).map(function (t) {
          var hit = U.findById(o.items, t.id);
          if (!hit) return t;
          var next = Object.assign({}, t, { est: hit.est, time: U.retime(t.time, hit.est), degraded: true });
          return S.normTask ? S.normTask(next) : next;
        });
      } else if (o.key === 'downgrade') {
        var dropIds2 = o.dropped.map(function (d) { return d.id; });
        S.tasks = S.tasks.filter(function (t) { return dropIds2.indexOf(t.id) < 0; });
        if (o.targetAfter !== null) S.goal.target = o.targetAfter + ' 分';
      } else {
        S.feas.weeks = o.weeksAfter;
        S.goal.weeks = o.weeksAfter;
        S.goal.deadline = o.deadlineAfter;
      }

      S.consecutiveZeroDays = 0;
      S.interrupted = false;
      S.rescueRecord = record;
    }

    approvedPreview = null;

    var payload = {
      strategy: o.key,
      at: stamp,
      deltaMin: S.rescueRecord.deltaMin,
      dropped: o.dropped.slice(),
      gapBefore: before.gap,
      gapAfter: o.gap,
      planBefore: before.planned,
      planAfter: o.planMin,
      deadline: S.goal.deadline,
      weeks: S.feas.weeks,
      target: S.goal.target
    };
    try {
      ZX.api.queueOp({ entity: 'rescue', entityId: 'w1', field: 'applied', value: payload });
    } catch (e) { /* 离线写队列失败不影响本地生效 */ }

    resumeBannerSeen = false;
    var ctl = api;
    api = null;
    flow = null;
    if (ctl) ctl.close('applied');

    if (S.tab !== 'today') ZX.setTab('today');
    else ZX.render();

    ZX.ui.toast('已恢复', 'ok');
    sayReply(o, before, zeroDays, weeksBefore);
  }

  function sayReply(o, before, zeroDays, weeksBefore) {
    if (!ZX.assistant || typeof ZX.assistant.say !== 'function') return;
    var lines = [];

    if (o.key === 'compress') {
      lines.push('<p>按「压缩」把计划接回来了：' + o.items.length + ' 项工时下调到 ' +
        o.items.map(function (i) { return i.est + ' 分钟'; }).join(' / ') +
        (o.dropped.length ? '，放弃 ' + o.dropped.length + ' 项（' + U.esc(o.dropped[0].title) + '，权重 ' + o.dropped[0].weight.toFixed(2) + '）' : '') +
        '。缺口 ' + U.hm(before.gap) + ' → ' + U.hm(o.gap) + '。</p>');
      lines.push('<p style="color:var(--txt3);font-size:11px">压缩项标记为降级完成，按「做完」记录即可，不再追加补作。</p>');
    } else if (o.key === 'defer') {
      lines.push('<p>按「顺延」把计划接回来了：截止日期顺延到 <b>' + o.deadlineAfter + '</b>，周期 ' +
        weeksBefore + ' → ' + o.weeksAfter + ' 周。任务一项没删、工时一项没压，缺口 ' +
        U.hm(before.gap) + ' → ' + U.hm(o.gap) + '。</p>');
      lines.push('<p style="color:var(--txt3);font-size:11px">本周剩余几天按原计划走，做不完的部分由多出的这一周承接。</p>');
    } else {
      lines.push('<p>按「降级」把计划接回来了：目标 ' +
        (o.targetFrom ? o.targetFrom + ' → ' + o.targetAfter + ' 分' : '已下调') + '，放弃权重最低的 ' +
        o.dropped.length + ' 项' +
        (o.dropped.length ? '（' + o.dropped.map(function (d) { return U.esc(d.title); }).join('、') + '）' : '') +
        '。缺口 ' + U.hm(before.gap) + ' → ' + U.hm(o.gap) + '。</p>');
      lines.push('<p style="color:var(--txt3);font-size:11px">目标下调后，剩下的项按原工时执行，不再往前追赶。</p>');
    }

    lines.push('<p style="color:var(--txt3);font-size:11px">连续记录从今天重新开始，之前的 ' +
      zeroDays + ' 天不计为欠账。</p>');

    ZX.assistant.say(lines.join(''), '挽救 · ' + o.key);
  }

  /* ---------- 事件 ---------- */
  function onClick(e) {
    if (!api) return;
    var t = e.target.closest ? e.target.closest('[data-sb]') : null;
    if (!t) return;
    var act = t.dataset.sb;

    if (act === 'pick') {
      choice = t.dataset.v || 'compress';
      flow.render();
      return;
    }
    if (act === 'next') {
      approvedPreview = previewKey(optionOf(choice));
      flow.go(2);
      return;
    }
    if (act === 'back') {
      approvedPreview = null;
      flow.go(1);
      return;
    }
    if (act === 'apply') { apply(); return; }
  }

  /* ---------- 入口 ---------- */
  function open() {
    if (api) return;
    if (!ZX.ui || goalRemoved()) return;
    choice = 'compress';

    flow = ZX.ui.flowSheet({
      ns: 'sb',
      step: 1,
      steps: { 1: stepDef, 2: stepDef },
      bind: function (a) {
        a.root.addEventListener('click', onClick);
        /* 三选一卡片的方向键导航（radio 惯例）：←↑ 上一项，→↓ 下一项，循环 */
        a.root.addEventListener('keydown', function (e) {
          if (!api || flow.step() !== 1) return;
          var delta = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1
            : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : 0;
          if (!delta) return;
          var cards = a.root.querySelectorAll('[data-sb="pick"]');
          if (!cards.length) return;
          var idx = -1;
          for (var i = 0; i < cards.length; i++) if (cards[i] === document.activeElement) idx = i;
          if (idx < 0) return;   /* 焦点不在选项上：不接管方向键 */
          e.preventDefault();
          var next = (idx + delta + cards.length) % cards.length;
          choice = cards[next].dataset.v || choice;
          U.refocus(cards[next]);
          flow.render();
        });
      },
      onClose: function () {
        /* 关闭 / 取消：不写任何业务状态 */
        approvedPreview = null;
        api = null;
        flow = null;
      }
    });
    api = flow.open();
  }

  /* 今日页 banner 的按钮在视图里，事件在这里委托（不改 main.js） */
  document.addEventListener('click', function (e) {
    if (!e.target || !e.target.closest) return;
    if (e.target.closest('[data-sb="enter"]') && !api) { open(); return; }
    if (e.target.closest('[data-sb="dismiss"]')) {
      resumeBannerSeen = true;
      ZX.render();
    }
  });

  ZX.flows = ZX.flows || {};
  /* apply / optionOf 保留为测试锚点（rescue-no-goal / rescue-confirm） */
  ZX.flows.rescue = {
    THRESHOLD: THRESHOLD,
    DEMO_ZERO_DAYS: DEMO_ZERO_DAYS,
    detect: detect,
    zeroDaysFromSessions: zeroDaysFromSessions,
    open: open,
    banner: banner,
    metrics: metrics,
    optionOf: optionOf,
    preview: preview,
    apply: apply
  };

})(window.ZX);
