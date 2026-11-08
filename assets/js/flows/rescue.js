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
     THRESHOLD / DEMO_ZERO_DAYS / REMAIN_DAYS 是演示参数；
     缺口、工时、容量本身一律由 state 推导，改 state 就会跟着变。 */
  var THRESHOLD = 3;         /* 连续 ≥3 天无记录判定为中断 */
  var DEMO_ZERO_DAYS = 4;    /* 演示入口写入的连续无记录天数 */
  var REMAIN_DAYS = 3;       /* 演示口径：中断 4 天后本周只剩 3 天 */
  var COMPRESS_RATE = 0.40;  /* 压缩：剩余工时下调 40% */
  var MIN_EST = 15;          /* 压缩下限 15 分钟 */
  var DEFER_DAYS = 7;        /* 顺延：截止日期 +7 天、周容量 +1 周 */
  var DOWN_POINTS = 30;      /* 降级：目标值下调 30 分 */

  var api = null;            /* ZX.ui.sheet 控制器 */
  var screen = 1;            /* 1 缺口 / 2 方式 / 3 确认 */
  var choice = 'compress';   /* 默认压缩 */
  var resumeBannerSeen = false;  /* 零惩罚回归提示是否已被用户收起 */

  /* ---------- 状态初始化（只新增契约第 4 节预留字段） ---------- */
  (function initState() {
    var S = ZX.state;
    if (typeof S.consecutiveZeroDays !== 'number') S.consecutiveZeroDays = 0;
    if (S.interrupted === undefined) S.interrupted = null;
    if (S.rescueRecord === undefined) S.rescueRecord = null;
  })();

  /* ---------- 缺口口径 ---------- */
  function weekPlannedMin() {
    return (ZX.state.week || []).reduce(function (a, d) { return a + U.num(d.total, 0); }, 0);
  }

  function dailyAvailMin() {
    return U.num(ZX.state.feas.weeklyH, 0) * 60 / 7;
  }

  /* 剩余可用 = 每日可用 × 剩余天数（不取整，取整只发生在展示层） */
  function availMin(days) {
    return dailyAvailMin() * U.num(days === undefined ? REMAIN_DAYS : days, REMAIN_DAYS);
  }

  /* 缺口 = max(0, 计划 − 已投入 − 剩余可用) */
  function gapOf(planMin, days) {
    return Math.max(0, Math.round(U.num(planMin, 0) - ZX.state.workedMin() - availMin(days)));
  }

  function metrics() {
    var S = ZX.state;
    var planned = weekPlannedMin();
    var worked = S.workedMin();
    var avail = availMin(REMAIN_DAYS);
    return {
      planned: planned,
      worked: worked,
      daily: dailyAvailMin(),
      days: REMAIN_DAYS,
      avail: avail,
      gap: Math.max(0, Math.round(planned - worked - avail))
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
    return ZX.state.tasks.filter(function (t) { return !t.done; });
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

  function dateOf(str) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || ''));
    if (!m) return null;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    d.setHours(0, 0, 0, 0);
    return isNaN(d.getTime()) ? null : d;
  }

  function isoDay(d) {
    return d.getFullYear() + '-' + U.pad2(d.getMonth() + 1) + '-' + U.pad2(d.getDate());
  }

  function plusDays(d, n) {
    var x = new Date(d.getTime());
    x.setDate(x.getDate() + n);
    return x;
  }

  /* 压缩后按新工时重排结束时刻，保持 HH:MM–HH:MM 形态 */
  function retime(time, est) {
    var m = /^(\d{2}):(\d{2})/.exec(String(time || ''));
    if (!m) return time;
    var start = Number(m[1]) * 60 + Number(m[2]);
    var end = start + U.num(est, 0);
    return m[1] + ':' + m[2] + '–' + U.pad2(Math.floor(end / 60) % 24) + ':' + U.pad2(end % 60);
  }

  /* ---------- 三种挽救方式的推演（同一套缺口公式） ----------
     压缩 / 降级会删减或压缩本周工作，因此「计划」收敛为
       已投入 + 策略调整后仍未完成的工时（已流失的天不再补排）；
     顺延不删不压，计划保持本周原样，剩余可用 +1 周。 */
  function optionOf(key) {
    var S = ZX.state;
    var rest = undone();

    if (key === 'defer') {
      var planMin = weekPlannedMin();
      var days = REMAIN_DAYS + DEFER_DAYS;
      var base = dateOf(S.goal.deadline) || new Date();
      return {
        key: 'defer', label: '顺延',
        planMin: planMin, days: days,
        avail: availMin(days),
        gap: gapOf(planMin, days),
        items: [],
        dropped: [],
        weeksAfter: U.num(S.feas.weeks, 1) + 1,
        deadlineAfter: isoDay(plusDays(base, DEFER_DAYS))
      };
    }

    if (key === 'downgrade') {
      var dropN = Math.min(2, Math.max(0, rest.length - 1));
      var dropped = byWeightAsc(rest).slice(0, dropN).map(dropItem);
      var dropIds = dropped.map(function (d) { return d.id; });
      var keep = rest.filter(function (t) { return dropIds.indexOf(t.id) < 0; });
      var planD = S.workedMin() + sumEst(keep);
      var cur = parseInt(String(S.goal.target || ''), 10);
      return {
        key: 'downgrade', label: '降级',
        planMin: planD, days: REMAIN_DAYS,
        avail: availMin(REMAIN_DAYS),
        gap: gapOf(planD, REMAIN_DAYS),
        items: [],
        dropped: dropped,
        targetFrom: isFinite(cur) ? cur : null,
        targetAfter: isFinite(cur) ? Math.max(1, cur - DOWN_POINTS) : null
      };
    }

    /* compress */
    var dropC = byWeightAsc(rest).slice(0, Math.min(1, Math.max(0, rest.length - 1))).map(dropItem);
    var dropCIds = dropC.map(function (d) { return d.id; });
    var items = rest.filter(function (t) { return dropCIds.indexOf(t.id) < 0; }).map(function (t) {
      var from = U.num(t.est, 0);
      return {
        id: t.id, title: t.title, subject: t.s,
        from: from,
        est: Math.max(MIN_EST, Math.round(from * (1 - COMPRESS_RATE)))
      };
    });
    var planC = S.workedMin() + sumEst(items);
    return {
      key: 'compress', label: '压缩',
      planMin: planC, days: REMAIN_DAYS,
      avail: availMin(REMAIN_DAYS),
      gap: gapOf(planC, REMAIN_DAYS),
      items: items,
      dropped: dropC
    };
  }

  /* ---------- banner（今日页顶部） ---------- */
  function banner() {
    var S = ZX.state;
    var m = metrics();

    if (S.interrupted === true) {
      return '<div class="banner sb-banner">' +
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

  /* ---------- 识别 ---------- */
  /* 真实环境：由执行记录（sessions / 每日是否记录）算出连续无记录天数后调用；
     这里只做判定，不伪造数据。 */
  function detect() {
    var S = ZX.state;
    var n = U.num(S.consecutiveZeroDays, 0);
    S.consecutiveZeroDays = n;
    S.interrupted = n >= THRESHOLD ? true : (S.interrupted === true ? false : S.interrupted);
    return S.interrupted === true;
  }

  /* ---------- 弹层骨架 ---------- */
  function stepMarks(active) {
    var names = ['01 缺口', '02 方式', '03 确认'];
    return names.map(function (n, i) {
      return '<i class="' + (i + 1 === active ? 'on' : '') + '">' + n + '</i>';
    }).join('');
  }

  function setHead(eyebrow, title, sub) {
    if (!api) return;
    var h = api.root.querySelector('.sheet-h');
    if (!h) return;
    var e = h.querySelector('.sheet-eyebrow');
    if (e) e.textContent = eyebrow;
    var t = h.querySelector('h2');
    if (t) t.textContent = title;
    var p = h.querySelector('p');
    if (p) p.textContent = sub;
  }

  function recallFocus() {
    var el = document.activeElement;
    if (!el || !api || !api.root.contains(el) || !el.dataset) return null;
    if (!el.dataset.sb) return null;
    return { act: el.dataset.sb, val: el.dataset.v || '' };
  }

  function restoreFocus(keep) {
    if (!api) return;
    var root = api.root;
    if (keep) {
      var sel = '[data-sb="' + keep.act + '"]' + (keep.val ? '[data-v="' + keep.val + '"]' : '');
      var back = root.querySelector(sel);
      if (back && !back.disabled) { try { back.focus(); return; } catch (e) { /* 忽略 */ } }
    }
    if (root.contains(document.activeElement)) return;
    var el = root.querySelector('.sheet-b button:not([disabled])') ||
      root.querySelector('.sheet-f .btn.pri:not([disabled])') ||
      root.querySelector('.sheet-f button:not([disabled])');
    if (el) { try { el.focus(); } catch (e2) { /* 忽略 */ } }
  }

  function render() {
    if (!api) return;
    var keep = recallFocus();
    var head;
    if (screen === 1) {
      head = ['RESCUE / 缺口', '把计划接回来', '先看这周缺口有多大，再决定怎么接；任何一步都不需要补记录。'];
      api.setBody(bodyGap());
      api.setFooter(footGap());
    } else if (screen === 2) {
      head = ['RESCUE / 方式', '选一种接法', '三种方式都会让缺口归零，区别只在代价。'];
      api.setBody(bodyChoice());
      api.setFooter(footChoice());
    } else {
      head = ['RESCUE / 确认', '确认并恢复', '确认后立即生效；关闭或取消不会写入任何状态。'];
      api.setBody(bodyConfirm());
      api.setFooter(footConfirm());
    }
    setHead(head[0], head[1], head[2]);
    restoreFocus(keep);
  }

  /* ---------- 第 1 屏：缺口四宫格 ---------- */
  function cell(label, val, note, cls) {
    return '<div class="sb-cell ' + (cls || '') + '">' +
      '<span>' + label + '</span><b>' + val + '</b><i>' + note + '</i></div>';
  }

  function bodyGap() {
    var m = metrics();
    var zero = m.gap === 0;
    return '<div class="sb-steps">' + stepMarks(1) + '</div>' +
      '<div class="sb-metrics">' +
        cell('本周原计划', U.hm(m.planned), '7 天合计 · ' + m.planned + ' min') +
        cell('已投入', U.hm(m.worked), '已记录的完成时长 · ' + m.worked + ' min') +
        cell('剩余可用', U.hm(Math.round(m.avail)), '每日 ' + U.hm(Math.round(m.daily)) + ' × ' + m.days + ' 天') +
        cell('缺口', U.hm(m.gap), zero ? '本周没有硬缺口' : m.gap + ' min · 需要重排的量', 'gap' + (zero ? ' zero' : '')) +
      '</div>' +
      '<div class="notice sb-note">缺口 = 本周原计划 − 已投入 − 剩余可用。' +
        '这 ' + m.days + ' 天每天可用 ' + U.hm(Math.round(m.daily)) + '，合计 ' + U.hm(Math.round(m.avail)) + '。' +
        (zero
          ? '本周没有硬缺口，可选择降载保节奏。'
          : '三种方式都会把它归零，代价各不相同，下一步逐条列出。') +
      '</div>' +
      '<p class="sb-hint">中断天数由执行记录计算：连续 ' + U.num(ZX.state.consecutiveZeroDays, 0) +
        ' 天没有记录，达到 ' + THRESHOLD + ' 天即进入挽救。</p>';
  }

  function footGap() {
    return '<button type="button" class="btn ghost" data-close>取消</button>' +
      '<button type="button" class="btn pri" data-sb="next">下一步 · 选择方式</button>';
  }

  /* ---------- 第 2 屏：三选项 ---------- */
  function optCard(key, act, cost, extra) {
    var o = optionOf(key);
    var on = choice === key;
    var m = metrics();
    var impact = '缺口 ' + U.hm(m.gap) + ' → ' + U.hm(o.gap) +
      (o.gap === 0 ? ' · 归零' : '');
    return '<button type="button" class="sb-opt' + (on ? ' on' : '') + '" role="radio" aria-checked="' + on + '"' +
        ' data-sb="pick" data-v="' + key + '">' +
        '<div class="sb-opt-h"><b>' + o.label + '</b>' +
          (key === 'compress' ? '<span class="sb-tag">默认</span>' : '') +
          '<span class="sb-opt-k">' + (on ? '已选择' : '选择') + '</span></div>' +
        '<p class="sb-opt-a">' + act + '</p>' +
        '<p class="sb-opt-c">代价：' + cost + '</p>' +
        '<div class="sb-opt-i"><span>' + impact + '</span><i>' + extra + '</i></div>' +
      '</button>';
  }

  function bodyChoice() {
    var cmp = optionOf('compress');
    var dfr = optionOf('defer');
    var dwn = optionOf('downgrade');
    var m = metrics();
    var cmpTxt = cmp.items.length
      ? cmp.items.map(function (i) { return i.from + ' → ' + i.est; }).join('、') + ' min'
      : '已无未完成项';
    return '<div class="sb-steps">' + stepMarks(2) + '</div>' +
      '<div class="sb-opts" role="radiogroup" aria-label="挽救方式">' +
        optCard('compress',
          '今天剩下的 ' + (cmp.items.length + cmp.dropped.length) + ' 项按 60% 重排，放弃权重最低的 1 项。',
          '工时下调 40%（' + cmpTxt + '，不低于 15 分钟），这些项标记为降级完成。',
          '本周计划 ' + U.hm(m.planned) + ' → ' + U.hm(cmp.planMin) + ' · 放弃 ' + cmp.dropped.length + ' 项') +
        optCard('defer',
          '截止日期 +7 天、周期 +1 周；任务一项不删，工时一项不压。',
          '整体完成时间推后 7 天，截止 ' + dfr.deadlineAfter + '。',
          '剩余可用 ' + U.hm(Math.round(m.avail)) + ' → ' + U.hm(Math.round(dfr.avail)) + ' · 任务数不变') +
        optCard('downgrade',
          '目标值下调，放弃权重最低的 2 项。',
          (dwn.targetFrom ? '目标 ' + dwn.targetFrom + ' → ' + dwn.targetAfter + ' 分，' : '') +
            '放弃 ' + dwn.dropped.length + ' 项，重心收在权重最高的项上。',
          '本周计划 ' + U.hm(m.planned) + ' → ' + U.hm(dwn.planMin) + ' · 放弃 ' + dwn.dropped.length + ' 项') +
      '</div>' +
      '<p class="sb-hint">以上数字由同一套公式实时算出：计划 − 已投入 − 剩余可用。选择不会立即生效，下一步确认。</p>';
  }

  function footChoice() {
    return '<button type="button" class="btn ghost" data-close>取消</button>' +
      '<button type="button" class="btn" data-sb="back">上一步</button>' +
      '<button type="button" class="btn pri" data-sb="next">下一步 · 确认摘要</button>';
  }

  /* ---------- 第 3 屏：确认摘要 ---------- */
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
        ? o.dropped.length + ' 项 · ' + o.dropped.map(function (d) { return d.subject + ' · ' + d.title + '（' + d.est + ' min）'; }).join('、')
        : '0 项'));
    } else if (o.key === 'defer') {
      rows.push(row('顺延', DEFER_DAYS + ' 天 · 截止 ' + o.deadlineAfter));
      rows.push(row('周期', U.num(ZX.state.feas.weeks, 1) + ' → ' + o.weeksAfter + ' 周 · 剩余可用 +1 周'));
      rows.push(row('放弃', '0 项 · 工时不变'));
    } else {
      rows.push(row('目标', (o.targetFrom ? o.targetFrom + ' → ' + o.targetAfter + ' 分' : '已下调')));
      rows.push(row('放弃', o.dropped.length
        ? o.dropped.length + ' 项 · ' + o.dropped.map(function (d) { return d.subject + ' · ' + d.title + '（' + d.est + ' min）'; }).join('、')
        : '0 项'));
    }

    rows.push(row('缺口', U.hm(m.gap) + ' → ' + U.hm(o.gap) + (o.gap === 0 ? ' · 归零' : '')));
    rows.push(o.key === 'defer'
      ? row('剩余可用', U.hm(Math.round(m.avail)) + ' → ' + U.hm(Math.round(o.avail)))
      : row('本周计划', U.hm(m.planned) + ' → ' + U.hm(o.planMin)));
    rows.push(row('连续记录', '从今天重新开始，之前的 ' + U.num(ZX.state.consecutiveZeroDays, 0) + ' 天不计为欠账'));

    return '<div class="sb-steps">' + stepMarks(3) + '</div>' +
      '<div class="sb-sum">' + rows.join('') + '</div>' +
      '<p class="sb-sum-note">确认后：任务工时 / 周期 / 截止日期按上面一行改写，连续记录归零重计，' +
        '并在对话里留一条说明。关闭或取消不会写入任何状态。</p>';
  }

  function footConfirm() {
    return '<button type="button" class="btn ghost" data-close>取消</button>' +
      '<button type="button" class="btn" data-sb="back">上一步</button>' +
      '<button type="button" class="btn pri" data-sb="apply">确认并恢复</button>';
  }

  /* ---------- 生效 ---------- */
  function apply() {
    var S = ZX.state;
    var o = optionOf(choice);
    var before = metrics();
    var stamp = Date.now();
    var zeroDays = U.num(S.consecutiveZeroDays, 0);
    var weeksBefore = U.num(S.feas.weeks, 1);

    if (o.key === 'compress') {
      var dropIds = o.dropped.map(function (d) { return d.id; });
      S.tasks = S.tasks.filter(function (t) { return dropIds.indexOf(t.id) < 0; }).map(function (t) {
        var hit = null;
        for (var i = 0; i < o.items.length; i++) if (o.items[i].id === t.id) { hit = o.items[i]; break; }
        if (!hit) return t;
        var next = Object.assign({}, t, { est: hit.est, time: retime(t.time, hit.est), degraded: true });
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
    S.rescueRecord = {
      strategy: o.key,
      at: stamp,
      deltaMin: Math.max(0, before.gap - o.gap),
      dropped: o.dropped.slice(),
      gapBefore: before.gap,
      gapAfter: o.gap
    };

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
    screen = 1;
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
        (o.dropped.length ? '，放弃 ' + o.dropped.length + ' 项（' + o.dropped[0].title + '，权重 ' + o.dropped[0].weight.toFixed(2) + '）' : '') +
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
        (o.dropped.length ? '（' + o.dropped.map(function (d) { return d.title; }).join('、') + '）' : '') +
        '。缺口 ' + U.hm(before.gap) + ' → ' + U.hm(o.gap) + '。</p>');
      lines.push('<p style="color:var(--txt3);font-size:11px">目标下调后，剩下的项按原工时执行，不再往前追赶。</p>');
    }

    lines.push('<p style="color:var(--txt3);font-size:11px">连续记录从今天重新开始，之前的 ' +
      zeroDays + ' 天不计为欠账。</p>');

    ZX.assistant.say(lines.join(''), 'rescue · ' + o.key);
  }

  /* ---------- 事件 ---------- */
  function onClick(e) {
    if (!api) return;
    var t = e.target.closest ? e.target.closest('[data-sb]') : null;
    if (!t) return;
    var act = t.dataset.sb;

    if (act === 'pick') {
      choice = t.dataset.v || 'compress';
      render();
      return;
    }
    if (act === 'next') {
      screen = Math.min(3, screen + 1);
      render();
      return;
    }
    if (act === 'back') {
      screen = Math.max(1, screen - 1);
      render();
      return;
    }
    if (act === 'apply') { apply(); return; }
  }

  /* ---------- 入口 ---------- */
  function open() {
    if (api) return;
    if (!ZX.ui) return;
    screen = 1;
    choice = 'compress';

    api = ZX.ui.sheet({
      eyebrow: 'RESCUE / 缺口',
      title: '把计划接回来',
      sub: '先看这周缺口有多大，再决定怎么接；任何一步都不需要补记录。',
      body: bodyGap(),
      footer: footGap(),
      wide: true,
      onClose: function () {
        /* 关闭 / 取消：不写任何状态 */
        api = null;
        screen = 1;
      }
    });

    api.root.addEventListener('click', onClick);
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
  ZX.flows.rescue = {
    THRESHOLD: THRESHOLD,
    DEMO_ZERO_DAYS: DEMO_ZERO_DAYS,
    detect: detect,
    open: open,
    banner: banner,
    metrics: metrics,
    optionOf: optionOf,
    apply: apply
  };

})(window.ZX);
