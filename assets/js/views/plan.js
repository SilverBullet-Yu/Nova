/* =========================================================
   诺瓦 Nova · 计划视图
   ========================================================= */
window.ZX = window.ZX || {};

(function (ZX) {
  'use strict';

  var U = ZX.util;
  var SUBJ = ZX.SUBJ;

  function plan() {
    var S = ZX.state;
    var f = S.feasibility();
    var pos = Math.min(100, f.R / 1.6 * 100);
    var vc = f.verdict === '充裕' || f.verdict === '合理' ? '' : 'warn';
    return '<div class="wrap">' +
      '<div class="vhead"><div>' +
        '<div class="eyebrow">目标 · ' + U.esc(S.goal.deadline) + '</div>' +
        '<h1>' + U.esc(S.goal.name) + '<span class="sub">目标 ' + U.esc(S.goal.target) + '</span></h1>' +
        '<div class="sa-goal-act"><button type="button" class="btn sa-goal-new" data-goal-new>新建目标</button>' +
          '<button type="button" class="btn sc2-replan" data-replan-run>重新安排</button>' +
          '</div>' +
      '</div><div class="vstats">' +
        '<div class="vs"><span>剩余</span><b>' + S.goal.weeks + ' 周</b></div>' +
        '<div class="vs"><span>阶段</span><b>基础期</b></div>' +
      '</div></div>' +

      rhythmBand() +

      '<div class="sec-h"><span class="n">01</span><span class="t">可行性 R</span><span class="rule"></span>' +
        '<span class="r">T / D · 折扣系数 ' + S.feas.discount + '</span></div>' +
      '<div class="feas">' +
        '<div class="feas-l">' +
          '<div class="r-big"><b>' + f.R.toFixed(2) + '</b><span class="v ' + vc + '">' + f.verdict + '</span></div>' +
          '<div class="formula">T = <b>' + S.feas.weeklyH + ' h/周 × ' + S.feas.weeks + ' 周 × ' + S.feas.discount + '</b> = ' + f.T + ' h　｜　D = Σ 节点标准工时 × 基础系数 = ' + f.D + ' h</div>' +
          '<div class="meter"><div class="meter-track">' +
            '<div class="zone z1" style="width:43.75%"></div><div class="zone z2" style="width:12.5%"></div>' +
            '<div class="zone z3" style="width:18.75%"></div><div class="zone z4" style="width:25%"></div>' +
          '</div><div class="marker" style="left:' + pos.toFixed(2) + '%"><b>' + f.R.toFixed(2) + '</b></div></div>' +
          '<div class="meter-lab"><span>0</span><span>0.7</span><span>0.9</span><span>1.2</span></div>' +
        '</div>' +
        '<div class="feas-r">' +
          '<div class="kv"><span>总可用</span><b>' + f.T + '</b><span class="u">h</span></div>' +
          '<div class="kv"><span>需求</span><b>' + f.D + '</b><span class="u">h</span></div>' +
          '<div class="kv"><span>缓冲</span><b>' + Math.max(0, f.T - f.D) + '</b><span class="u">h</span></div>' +
          '<p class="feas-note">' + (f.R >= 0.9 ? '可正常进入拆解。若每周再减少 3 h，R 将降至 ' + ((f.T - 3 * S.feas.weeks * S.feas.discount) / f.D).toFixed(2) + '，仍可执行但缓冲消失。' : '低于 0.9，需提高周投入、延长周期或缩小范围后再拆解。') + '</p>' +
        '</div>' +
      '</div>' +

      boardHtml() +
      '<div class="sec-h"><span class="n">02</span><span class="t">未来 7 天负载</span>' +
        (loadWarnFlag() ? '<img class="warn-flag" src="assets/img/mascot-v4-warn.svg" width="22" height="19" alt="负载预警：增幅已达防雪崩阈值" />' : '') +
        '<span class="rule"></span>' +
        '<span class="r">' + replanLabel() + '</span></div>' +
      weekChart() +
    '</div>';
  }

  /* ---------- 学期节律带：把「周期按阶段律动」画出来 ----------
     阶段配比 45 / 35 / 20 取自 PRD §8.2 原文值（demo 考研语境），
     周数 = goal.weeks（剩余）按配比折算，四舍五入后不改动 vstats 的「剩余」事实；
     当前阶段沿用本视图既有的「基础期」口径，不新增数据来源。 */
  var STAGES = [
    { n: '基础期', r: 45 },
    { n: '强化期', r: 35 },
    { n: '冲刺期', r: 20 }
  ];

  function rhythmBand() {
    var S = ZX.state;
    var weeks = U.num(S.goal.weeks, 0);
    if (!weeks) return '';
    var segs = STAGES.map(function (st, i) {
      var w = Math.round(weeks * st.r / 100);
      var on = i === 0;   /* 当前阶段：与头部「阶段 基础期」同口径 */
      return '<div class="rhythm-seg' + (on ? ' on' : '') + '" style="width:' + st.r + '%">' +
        '<b>' + st.n + '</b><i>约 ' + w + ' 周 · ' + st.r + '%</i>' +
        (on ? '<span class="cur">当前</span>' : '') +
      '</div>';
    }).join('');
    return '<div class="rhythm">' +
      '<div class="rhythm-cap"><span class="t">学期节律</span>' +
        '<span class="d">剩余 ' + weeks + ' 周按阶段配比推进 · 节奏可查，不催促</span>' +
        '<span class="r">45 / 35 / 20</span></div>' +
      '<div class="rhythm-band">' + segs + '</div>' +
      '<p class="rhythm-note">带上的周数为按配比折算的预估视图，不构成排程依据；阶段边界随可行性 R 与偏差归因校准。</p>' +
    '</div>';
  }

  /* 负载预警：重排后未来 7 天负载增幅 ≥ 20%（与防雪崩断言同阈值）→ 显示提醒态 */
  function loadWarnFlag() {
    var S = ZX.state;
    if (!S.replanned || !S.replanRecord) return false;
    var d = S.replanRecord.loadDelta;
    return typeof d === 'number' && d >= 0.2;
  }

  /* 重排标签：增幅取自引擎结果（state.replanRecord.loadDelta），不硬编码 */
  function replanLabel() {
    var S = ZX.state;
    if (!S.replanned) return '未重排 · 基线';
    var rec = S.replanRecord;
    if (!rec || typeof rec.loadDelta !== 'number') return '已重排';
    var pct = (Math.round(rec.loadDelta * 1000) / 10) + '%';
    return '已重排 · 增幅 +' + pct;
  }

  /* 周图数据源：
     基线 = seed.week；重排后 = 引擎 nextWeek 的真实每日负载（口径与「增幅」标签一致）。
     引擎 nextWeek 只给每日总分钟数（无科目分段），故分段色块按 weekShift 的科目占比
     等比缩放到该日真实负载，保证「柱高 = 真实负载」「配色 = 科目构成」同时成立。
     Stage C-2：再叠加手工改期（state.dayAssign）的每日增量，色段按新总量等比缩放。 */
  function baseWeekData() {
    var S = ZX.state;
    if (!S.replanned) return S.week.map(function (d) {
      return { d: d.d, segs: d.segs, buf: d.buf, total: d.total, today: d.today };
    });

    var rec = S.replanRecord;
    var engineWeek = (rec && Array.isArray(rec.nextWeek)) ? rec.nextWeek : null;
    var base = S.weekShift.map(function (d) {
      return { d: d.d, segs: d.segs, buf: d.buf, total: d.total, today: d.today };
    });

    if (!engineWeek) return base;

    return base.map(function (d, i) {
      var ew = engineWeek[i];
      if (!ew) return d;
      var real = typeof ew.minutes === 'number' ? ew.minutes : d.total;
      var segSum = d.segs.reduce(function (a, s) { return a + (s[1] || 0); }, 0);
      var segs = segSum > 0
        ? d.segs.map(function (s) { return [s[0], Math.round(s[1] / segSum * real)]; })
        : d.segs;
      return { d: d.d, segs: segs, buf: d.buf, total: real, today: d.today };
    });
  }

  /* delta = 迁入 − 迁出（见 flows/planedit.js weekDeltas） */
  function weekChartData() {
    var data = baseWeekData();
    /* 「今天」按真实时钟的星期打标：seed 的 today 旗标是示例数据（测试有断言），
       与演示日期（如 11.14 周六）无关，直接消费会造成高亮与日期眉标矛盾 */
    var dow = U.todayDow();
    data.forEach(function (d) { d.today = d.d === dow; });
    var deltas = ZX.flows.planedit.weekDeltas() || {};
    return data.map(function (d) {
      var delta = U.num(deltas[d.d], 0);
      if (!delta) return d;
      var real = Math.max(0, d.total + delta);
      var segSum = d.segs.reduce(function (a, s) { return a + (s[1] || 0); }, 0);
      var segs = segSum > 0
        ? d.segs.map(function (s) { return [s[0], Math.round(s[1] / segSum * real)]; })
        : d.segs;
      return { d: d.d, segs: segs, buf: d.buf, total: real, today: d.today };
    });
  }

  /* 本周日程块（Stage C-2） */
  function boardHtml() {
    return ZX.flows.planedit.board();
  }

  function chartNote() {
    var n = ZX.flows.planedit.movedCount();
    if (!n) return '';
    var lk = ZX.flows.planedit.lockedCount ? ZX.flows.planedit.lockedCount() : 0;
    return '<div class="sc2-chart-note"><span>含手工改期 ' + n + ' 项</span>' +
      (lk ? '<span>已锁定 ' + lk + ' 项</span>' : '') + '</div>';
  }

  function weekChart() {
    var data = weekChartData();
    var max = 360, H = 132;
    var total = data.reduce(function (a, d) { return a + d.total; }, 0);
    var buf = data.reduce(function (a, d) { return a + d.buf; }, 0);
    return '<div class="chart">' +
      '<div class="week">' + data.map(function (d) {
        return '<div class="wk ' + (d.today ? 'on' : '') + '">' +
          '<div class="wk-stack">' +
            d.segs.map(function (s) { return '<i style="height:' + (s[1] / max * H) + 'px;background:' + (SUBJ[s[0]] || { c: 'var(--txt3)' }).c + '"></i>'; }).join('') +
            '<i class="buf" style="height:' + (d.buf / max * H) + 'px"></i>' +
          '</div>' +
          '<div class="wk-lab">' + d.d + '</div>' +
          '<div class="wk-val">' + U.hm(d.total) + '</div>' +
        '</div>';
      }).join('') +
      '</div>' +
      '<div class="legend">' +
        Object.keys(SUBJ).map(function (k) { return '<span><i style="background:' + SUBJ[k].c + '"></i>' + k + '</span>'; }).join('') +
        '<span><i class="hatch"></i>弹性位</span>' +
        '<span class="load-sum">计划 ' + U.hm(total) + ' · 缓冲 ' + U.hm(buf) + '</span>' +
      '</div>' +
      chartNote() +
    '</div>';
  }
  ZX.views = ZX.views || {};
  ZX.views.plan = plan;

})(window.ZX);
