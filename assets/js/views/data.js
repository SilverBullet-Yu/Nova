/* =========================================================
   诺瓦 Nova · 数据视图
   KPI / 周报 / 结构与归因全部取自 ZX.state.weekStats，不写死数值；
   周数与日期范围由当前时间推导（ISO 周）。
   ========================================================= */
window.ZX = window.ZX || {};

(function (ZX) {
  'use strict';

  var U = ZX.util;
  var FALLBACK_WEEKS = [52, 61, 58, 66, 71, 74, 72, 68];   /* weekStats.WEEKS 异常时的兜底（与 seed 同源） */
  var NORTH_STAR = 70;                                      /* 北极星口径：达成率 ≥ 70% 计为有效周（与页面说明一致） */
  var MIX_COLOR = { '数学': 'var(--m-math)', '专业课': 'var(--m-408)', '英语': 'var(--m-en)', '政治': 'var(--m-pol)' };
  var ATTR_META = {
    '计划过载': ['var(--warn)', '下调密度，提高弹性位比例'],
    '执行中断': ['var(--bad)', '转入恢复流程，不追加任务'],
    '效率不足': ['var(--m-math)', '校准标准工时，建议拆分'],
    '外部干扰': ['var(--m-en)', '重排弹性位，避开不可用时段']
  };

  function stats() { return ZX.state.weekStats || {}; }
  function kpis() { return stats().kpis || {}; }

  function weeks() {
    var w = stats().WEEKS;
    return (Array.isArray(w) && w.length) ? w : FALLBACK_WEEKS;
  }

  /* 当前 ISO 周的周一至周日（MM.DD – MM.DD） */
  function weekRange() {
    var now = new Date();
    var mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
    var sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
    return U.pad2(mon.getMonth() + 1) + '.' + U.pad2(mon.getDate()) + ' – ' +
      U.pad2(sun.getMonth() + 1) + '.' + U.pad2(sun.getDate());
  }

  function genStamp() {
    var d = new Date();
    return U.pad2(d.getMonth() + 1) + '.' + U.pad2(d.getDate()) + ' ' + U.nowStr();
  }

  function data() {
    var k = kpis();
    var attr = stats().attribution || {};
    var delta = U.num(k.achievementDeltaPt, 0);
    return '<div class="wrap">' +
      '<div class="vhead"><div>' +
        '<div class="eyebrow">WEEK ' + U.isoWeek() + ' · ' + weekRange() + '</div>' +
        '<h1>数据<span class="sub">周报与归因</span></h1>' +
      '</div></div>' +

      '<div class="sec-h"><span class="n">01</span><span class="t">本周概览</span><span class="rule"></span></div>' +
      '<div class="kpis">' +
        '<div class="kpi"><span>有效学习</span><b>' + U.num(k.effectiveHours, 0) + '<span class="u">h</span></b><span class="d">目标 ' + U.num(k.targetHours, 0) + ' h</span></div>' +
        '<div class="kpi"><span>达成率</span><b>' + U.num(k.achievementRate, 0) + '<span class="u">%</span></b><span class="d ' + (delta < 0 ? 'dn' : 'up') + '">较上周 ' + (delta >= 0 ? '+' : '−') + Math.abs(delta) + ' pt</span></div>' +
        '<div class="kpi"><span>重排采纳</span><b>' + U.num(k.replanAdopted, 0) + '<span class="u">/ ' + U.num(k.replanTotal, 0) + '</span></b><span class="d up">采纳率 ' + U.num(k.replanRate, 0) + '%</span></div>' +
        '<div class="kpi"><span>记录天数</span><b>' + U.num(k.recordedDays, 0) + '<span class="u">/ ' + U.num(k.totalDays, 0) + '</span></b><span class="d">' +
          (U.num(k.recordedDays, 0) >= U.num(k.totalDays, 0) ? '无中断' : '有 ' + (U.num(k.totalDays, 0) - U.num(k.recordedDays, 0)) + ' 天未记录') + '</span></div>' +
      '</div>' +

      '<div class="sec-h"><span class="n">02</span><span class="t">本周周报</span><span class="rule"></span>' +
        '<span class="r">结论 / 依据 / 已执行的动作</span></div>' +
      reportBlock() +
      ZX.ui.fold('data:trend', {
        title: '趋势与归因',
        meta: weeks().length + ' 周达成率 · 科目结构 · ' + Math.max(1, Object.keys(attr).length) + ' 类归因',
        body:
          '<div class="sec-h"><span class="n">03</span><span class="t">达成率趋势</span><span class="rule"></span><span class="r">' + weeks().length + ' 周 · 虚线为 ' + NORTH_STAR + '% 目标</span></div>' +
          lineChart() +
          '<div class="sec-h"><span class="n">04</span><span class="t">结构与归因</span><span class="rule"></span></div>' +
          '<div class="grid2">' + subjectBars() + attribution() + '</div>'
      }) +
    '</div>';
  }

  function lineChart() {
    var W = 640, H = 168, L = 30, R = 12, T = 14, B = 26;
    var data = weeks();
    var iw = W - L - R, ih = H - T - B;
    var y = function (v) { return T + ih - (v - 40) / 50 * ih; };
    var span = Math.max(1, data.length - 1);   /* 单元素数据时避免除零产生 NaN */
    var x = function (i) { return L + i / span * iw; };
    var pts = data.map(function (v, i) { return [x(i), y(v)]; });
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
    var area = line + ' L' + x(data.length - 1).toFixed(1) + ' ' + (T + ih) + ' L' + L + ' ' + (T + ih) + ' Z';
    var grid = '';
    [40, 55, 70, 85, 100].forEach(function (v) {
      grid += '<line class="grid-l" x1="' + L + '" y1="' + y(v) + '" x2="' + (W - R) + '" y2="' + y(v) + '"/>' +
              '<text class="axis" x="' + (L - 8) + '" y="' + (y(v) + 3) + '" text-anchor="end">' + v + '</text>';
    });
    var base = U.isoWeek() - data.length + 1;
    var labels = data.map(function (v, i) { return '<text class="axis" x="' + x(i) + '" y="' + (H - 8) + '" text-anchor="middle">W' + (base + i) + '</text>'; }).join('');
    var dots = pts.map(function (p, i) { return '<circle class="pt" cx="' + p[0] + '" cy="' + p[1] + '" r="' + (i === pts.length - 1 ? 3.4 : 2.1) + '"/>'; }).join('');
    var last = pts[pts.length - 1];
    var latest = data[data.length - 1];
    var streak = 0;
    for (var i = data.length - 1; i >= 0 && data[i] < NORTH_STAR; i--) streak++;
    var streakTxt = streak >= 2 ? '连续 ' + streak + ' 周低于目标'
      : streak === 1 ? '低于 ' + NORTH_STAR + '% 目标'
      : '达到 ' + NORTH_STAR + '% 目标';
    return '<div class="chart"><div class="chart-h"><b>周达成率</b><span class="r">最新 ' + latest + '% · ' + streakTxt + '</span></div>' +
      '<svg class="ch" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img"' +
        ' aria-label="近 ' + data.length + ' 周达成率趋势，最新 ' + latest + '%">' +
        '<defs><linearGradient id="lg" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" style="stop-color:var(--ac)" stop-opacity=".16"/><stop offset="100%" style="stop-color:var(--ac)" stop-opacity="0"/>' +
        '</linearGradient></defs>' +
        grid +
        '<line class="thr" x1="' + L + '" y1="' + y(NORTH_STAR) + '" x2="' + (W - R) + '" y2="' + y(NORTH_STAR) + '"/>' +
        '<path class="line-a" d="' + area + '"/>' +
        '<path class="line" d="' + line + '"/>' +
        dots + labels +
        '<text class="axis" x="' + (last[0] - 6) + '" y="' + (last[1] - 9) + '" text-anchor="end" fill="var(--ac)">' + latest + '</text>' +
      '</svg></div>';
  }

  function subjectBars() {
    var mix = stats().subjectMix || {};
    var keys = Object.keys(mix);
    return '<div class="panel"><div class="panel-h">科目结构<span>有效时长占比</span></div><div class="panel-b">' +
      (keys.length
        ? '<div class="bars">' + keys.map(function (n) {
            return '<div class="brow"><span class="n">' + U.esc(n) + '</span>' +
              '<span class="t"><i style="width:' + U.num(mix[n], 0) + '%;background:' + (MIX_COLOR[n] || 'var(--txt3)') + '"></i></span>' +
              '<span class="p">' + U.num(mix[n], 0) + '%</span></div>';
          }).join('') + '</div>'
        : '<div class="empty">暂无科目数据</div>') +
    '</div></div>';
  }

  function attribution() {
    var attr = stats().attribution || {};
    var keys = Object.keys(attr);
    return '<div class="panel"><div class="panel-h">偏差归因<span>顺序即优先级</span></div><div class="panel-b">' +
      (keys.length
        ? '<div class="attr">' + keys.map(function (n) {
            var meta = ATTR_META[n] || ['var(--txt3)', '待定'];
            return '<div class="acard"><div class="h"><b>' + U.num(attr[n], 0) + '%</b><span>' + U.esc(n) + '</span></div>' +
              '<div class="t"><i style="width:' + U.num(attr[n], 0) + '%;background:' + meta[0] + '"></i></div><p>' + meta[1] + '</p></div>';
          }).join('') + '</div>'
        : '<div class="empty">暂无归因数据</div>') +
    '</div></div>';
  }

  function reportBlock() {
    var S = ZX.state;
    var k = kpis();
    var mix = stats().subjectMix || {};
    var attr = stats().attribution || {};
    var actions = Array.isArray(stats().actions) ? stats().actions : [];
    var delta = U.num(k.achievementDeltaPt, 0);
    var gap = Math.round(Math.max(0, U.num(k.targetHours, 0) - U.num(k.effectiveHours, 0)) * 10) / 10;   /* 消除浮点误差（15-11.2=3.800…07） */
    var mixTxt = Object.keys(mix).map(function (n) { return n + ' ' + U.num(mix[n], 0) + '%'; }).join(' / ');
    var attrTxt = Object.keys(attr).map(function (n) { return n + ' ' + U.num(attr[n], 0) + '%'; }).join('、');
    return '<div class="report">' +
      '<div class="report-h"><b>第 ' + U.isoWeek() + ' 周 · 周报</b><span>' + genStamp() + ' 生成</span></div>' +
      '<div class="rp-row"><div class="k">结论</div><div class="v">本周达成率 <b>' + U.num(k.achievementRate, 0) + '%</b>，较上周' +
        (delta >= 0 ? '上升' : '下降') + ' ' + Math.abs(delta) + ' 个百分点；有效学习 <b>' + U.num(k.effectiveHours, 0) + ' 小时</b>（目标 ' + U.num(k.targetHours, 0) + ' 小时）' +
        (gap > 0 ? '。计划仍然存活，缺口 ' + gap + ' 小时。' : '。') + '</div></div>' +
      '<div class="rp-row"><div class="k">依据</div><div class="v">' +
        (mixTxt ? '科目分布 ' + U.esc(mixTxt) + '；' : '') +
        (attrTxt ? '归因 ' + U.esc(attrTxt) + '。' : '') + '</div></div>' +
      '<div class="rp-row"><div class="k">已执行</div><div class="v">' +
        (actions.length
          ? '下周计划已预置 ' + actions.length + ' 处调整：' + U.esc(actions.join('；')) + '。<b>不是建议，是已经排进日程的 block。</b>'
          : '本周没有预置调整。') + '</div></div>' +
      '<div class="preset"><span class="tx">预置：<b>周日 08:00–10:00 政治 · 马原第 3 章</b></span><span class="spacer"></span>' +
        '<button class="btn ghost" data-act="preset">' + (S.presetActive ? '撤销预置' : '恢复预置') + '</button></div>' +
    '</div>';
  }

  ZX.views = ZX.views || {};
  ZX.views.data = data;

})(window.ZX);
