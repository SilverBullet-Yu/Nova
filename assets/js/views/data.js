/* =========================================================
   诺瓦 Nova · 数据视图
   ========================================================= */
window.ZX = window.ZX || {};

(function (ZX) {
  'use strict';

  var U = ZX.util;
  var WEEKS = [52, 61, 58, 66, 71, 74, 72, 68];

  function weeks() {
    var w = ZX.state.weekStats && ZX.state.weekStats.WEEKS;
    return (Array.isArray(w) && w.length) ? w : WEEKS;
  }

  function data() {
    return '<div class="wrap">' +
      '<div class="vhead"><div>' +
        '<div class="eyebrow">WEEK 45 · 11.02 – 11.08</div>' +
        '<h1>数据<span class="sub">周报与归因</span></h1>' +
        '<p class="vlede">北极星：人均有效学习周数。达成率 ≥ 70% 且有效学习 ≥ 目标 60% 才计为一周。</p>' +
      '</div></div>' +

      '<div class="sec-h"><span class="n">01</span><span class="t">本周概览</span><span class="rule"></span></div>' +
      '<div class="kpis">' +
        '<div class="kpi"><span>有效学习</span><b>11.2<span class="u">h</span></b><span class="d">目标 15 h</span></div>' +
        '<div class="kpi"><span>达成率</span><b>68<span class="u">%</span></b><span class="d dn">较上周 −6 pt</span></div>' +
        '<div class="kpi"><span>重排采纳</span><b>3<span class="u">/ 4</span></b><span class="d up">采纳率 75%</span></div>' +
        '<div class="kpi"><span>记录天数</span><b>5<span class="u">/ 7</span></b><span class="d">无中断</span></div>' +
      '</div>' +

      '<div class="sec-h"><span class="n">02</span><span class="t">达成率趋势</span><span class="rule"></span>' +
        '<span class="r">8 周 · 虚线为 70% 目标</span></div>' +
      lineChart() +

      '<div class="sec-h"><span class="n">03</span><span class="t">结构与归因</span><span class="rule"></span></div>' +
      '<div class="grid2">' + subjectBars() + attribution() + '</div>' +

      '<div class="sec-h"><span class="n">04</span><span class="t">本周周报</span><span class="rule"></span>' +
        '<span class="r">结论 / 依据 / 已执行的动作</span></div>' +
      reportBlock() +
      '<div class="foot-note"><span>insight v1.4</span><span>聚合 41ms</span><span>建议必须预置为具体 block</span></div>' +
    '</div>';
  }

  function lineChart() {
    var W = 640, H = 168, L = 30, R = 12, T = 14, B = 26;
    var data = weeks();
    var iw = W - L - R, ih = H - T - B;
    var y = function (v) { return T + ih - (v - 40) / 50 * ih; };
    var x = function (i) { return L + i / (data.length - 1) * iw; };
    var pts = data.map(function (v, i) { return [x(i), y(v)]; });
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
    var area = line + ' L' + x(data.length - 1).toFixed(1) + ' ' + (T + ih) + ' L' + L + ' ' + (T + ih) + ' Z';
    var grid = '';
    [40, 55, 70, 85, 100].forEach(function (v) {
      grid += '<line class="grid-l" x1="' + L + '" y1="' + y(v) + '" x2="' + (W - R) + '" y2="' + y(v) + '"/>' +
              '<text class="axis" x="' + (L - 8) + '" y="' + (y(v) + 3) + '" text-anchor="end">' + v + '</text>';
    });
    var labels = data.map(function (v, i) { return '<text class="axis" x="' + x(i) + '" y="' + (H - 8) + '" text-anchor="middle">W' + (38 + i) + '</text>'; }).join('');
    var dots = pts.map(function (p, i) { return '<circle class="pt" cx="' + p[0] + '" cy="' + p[1] + '" r="' + (i === pts.length - 1 ? 3.4 : 2.1) + '"/>'; }).join('');
    var last = pts[pts.length - 1];
    return '<div class="chart"><div class="chart-h"><b>周达成率</b><span class="r">最新 68% · 连续 2 周低于目标</span></div>' +
      '<svg class="ch" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
        '<defs><linearGradient id="lg" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" stop-color="rgba(216,246,92,.16)"/><stop offset="100%" stop-color="rgba(216,246,92,0)"/>' +
        '</linearGradient></defs>' +
        grid +
        '<line class="thr" x1="' + L + '" y1="' + y(70) + '" x2="' + (W - R) + '" y2="' + y(70) + '"/>' +
        '<path class="line-a" d="' + area + '"/>' +
        '<path class="line" d="' + line + '"/>' +
        dots + labels +
        '<text class="axis" x="' + (last[0] - 6) + '" y="' + (last[1] - 9) + '" text-anchor="end" fill="var(--ac)">68</text>' +
      '</svg></div>';
  }

  function subjectBars() {
    var data = [['数学', 45, 'var(--m-math)'], ['专业课', 30, 'var(--m-408)'], ['英语', 20, 'var(--m-en)'], ['政治', 5, 'var(--m-pol)']];
    return '<div class="panel"><div class="panel-h">科目结构<span>有效时长占比</span></div><div class="panel-b">' +
      '<div class="bars">' + data.map(function (d) {
        return '<div class="brow"><span class="n">' + d[0] + '</span><span class="t"><i style="width:' + d[1] + '%;background:' + d[2] + '"></i></span><span class="p">' + d[1] + '%</span></div>';
      }).join('') + '</div>' +
      '<p style="margin:12px 0 0;font-size:10px;color:var(--txt3);line-height:1.55">政治连续 3 周低于 10%，已被归因引擎标记为结构性缺口。</p>' +
    '</div></div>';
  }

  function attribution() {
    var data = [
      ['计划过载', 40, 'var(--warn)', '下调密度，提高弹性位比例'],
      ['执行中断', 35, 'var(--bad)', '转入恢复流程，不追加任务'],
      ['效率不足', 25, 'var(--m-math)', '校准标准工时，建议拆分']
    ];
    return '<div class="panel"><div class="panel-h">偏差归因<span>顺序即优先级</span></div><div class="panel-b">' +
      '<div class="attr">' + data.map(function (d) {
        return '<div class="acard"><div class="h"><b>' + d[1] + '%</b><span>' + d[0] + '</span></div>' +
          '<div class="t"><i style="width:' + d[1] + '%;background:' + d[2] + '"></i></div><p>' + d[3] + '</p></div>';
      }).join('') + '</div>' +
      '<p style="margin:11px 0 0;font-size:10px;color:var(--txt3);line-height:1.55">固定判定顺序：先排除计划问题，再归因用户侧。把「过载」误判为「执行力不足」，系统就会加压。</p>' +
    '</div></div>';
  }

  function reportBlock() {
    var S = ZX.state;
    return '<div class="report">' +
      '<div class="report-h"><b>第 45 周 · 周报</b><span>11.08 20:00 生成</span></div>' +
      '<div class="rp-row"><div class="k">结论</div><div class="v">本周达成率 <b>68%</b>，较上周下降 6 个百分点；有效学习 <b>11.2 小时</b>（目标 15 小时）。计划仍然存活，缺口 3.8 小时。</div></div>' +
      '<div class="rp-row"><div class="k">依据</div><div class="v">科目分布 数学 45% / 专业课 30% / 英语 20% / 政治 5%；归因 计划过载 40%、执行中断 35%、效率不足 25%。周三、周五各出现一次超时。</div></div>' +
      '<div class="rp-row"><div class="k">已执行</div><div class="v">下周计划已预置两处调整：周日上午 <b>08:00–10:00</b> 固定为政治时段；周三晚弹性位扩容 30 分钟。<b>不是建议，是已经排进日程的 block。</b></div></div>' +
      '<div class="preset"><span class="tx">预置：<b>周日 08:00–10:00 政治 · 马原第 3 章</b></span><span class="spacer"></span>' +
        '<button class="btn ghost" data-act="preset">' + (S.presetActive ? '撤销预置' : '已撤销') + '</button></div>' +
    '</div>';
  }

  ZX.views = ZX.views || {};
  ZX.views.data = data;

})(window.ZX);
