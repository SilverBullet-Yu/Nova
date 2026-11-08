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
        '<div class="eyebrow">GOAL · ' + S.goal.deadline + '</div>' +
        '<h1>' + S.goal.name + '<span class="sub">目标 ' + S.goal.target + '</span></h1>' +
        '<p class="vlede">可行性评估只在目标、可用时段或模板变更时重算，不在每次打开时施压。</p>' +
      '</div><div class="vstats">' +
        '<div class="vs"><span>剩余</span><b>' + S.goal.weeks + ' 周</b></div>' +
        '<div class="vs"><span>阶段</span><b>基础期</b></div>' +
        '<div class="vs"><span>单 active 目标</span><b>1</b></div>' +
      '</div></div>' +

      '<div class="sec-h"><span class="n">01</span><span class="t">可行性 R</span><span class="rule"></span>' +
        '<span class="r">T / D · 折扣系数 0.85</span></div>' +
      '<div class="feas">' +
        '<div class="feas-l">' +
          '<div class="r-big"><b>' + f.R.toFixed(2) + '</b><span class="v ' + vc + '">' + f.verdict + '</span></div>' +
          '<div class="formula">T = <b>' + S.feas.weeklyH + ' h/周 × ' + S.feas.weeks + ' 周 × 0.85</b> = ' + f.T + ' h　｜　D = Σ 节点标准工时 × 基础系数 = ' + f.D + ' h</div>' +
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

      '<div class="sec-h"><span class="n">02</span><span class="t">阶段结构</span><span class="rule"></span>' +
        '<span class="r">配比 45 / 35 / 20</span></div>' +
      stageRows() +

      '<div class="sec-h"><span class="n">03</span><span class="t">未来 7 天负载</span><span class="rule"></span>' +
        '<span class="r">' + replanLabel() + '</span></div>' +
      weekChart() +

      '<div class="sec-h"><span class="n">04</span><span class="t">计划项</span><span class="rule"></span>' +
        '<span class="r">plan_item.status 状态机</span></div>' +
      planItems() +
      '<div class="foot-note"><span>planner v1.4</span><span>schedule 68ms</span><span>弹性位 1/1 保留</span></div>' +
    '</div>';
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

  function stageRows() {    var rows = [
      { n: '基础期', w: '第 1–26 周', p: 62, on: true },
      { n: '强化期', w: '第 27–46 周', p: 0, on: false },
      { n: '冲刺期', w: '第 47–58 周', p: 0, on: false }
    ];
    return rows.map(function (r) {
      return '<div class="stage ' + (r.on ? 'on' : '') + '">' +
        '<div class="nm"><i></i><span>' + r.n + '</span></div>' +
        '<div class="bar"><i style="width:' + r.p + '%"></i></div>' +
        '<div class="wk-range">' + r.w + '</div>' +
        '<div class="pct">' + r.p + '%</div>' +
      '</div>';
    }).join('');
  }

  /* 周图数据源：
     基线 = seed.week；重排后 = 引擎 nextWeek 的真实每日负载（口径与「增幅」标签一致）。
     引擎 nextWeek 只给每日总分钟数（无科目分段），故分段色块按 weekShift 的科目占比
     等比缩放到该日真实负载，保证「柱高 = 真实负载」「配色 = 科目构成」同时成立。 */
  function weekChartData() {
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

  function weekChart() {
    var data = weekChartData();
    var max = 360, H = 132;
    var total = data.reduce(function (a, d) { return a + d.total; }, 0);
    var buf = data.reduce(function (a, d) { return a + d.buf; }, 0);
    return '<div class="chart">' +
      '<div class="week">' + data.map(function (d) {
        return '<div class="wk ' + (d.today ? 'on' : '') + '">' +
          '<div class="wk-stack">' +
            d.segs.map(function (s) { return '<i style="height:' + (s[1] / max * H) + 'px;background:' + SUBJ[s[0]].c + '"></i>'; }).join('') +
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
    '</div>';
  }

  function planItems() {
    var S = ZX.state;
    /* 被压缩的计划项，工时取引擎 diff 的实际压缩值（不硬编码 45→30） */
    var polEst = 45;
    var rec = S.replanRecord;
    if (rec && Array.isArray(rec.diff)) {
      rec.diff.forEach(function (d) {
        if (d.op === 'compress' && d.subject === '政治') {
          var n = parseInt(d.to, 10);
          if (!isNaN(n)) polEst = n;
        }
      });
    }
    var items = [
      { id: 'p_1042', n: '高数 · 极限与连续', s: '数学', est: 90, st: ['已排程', 'sch'] },
      { id: 'p_1043', n: '阅读真题 2019 · 精读', s: '英语', est: 60, st: ['已完成', 'done'] },
      { id: 'p_1044', n: '树与二叉树 · 应用', s: '408', est: 75, st: ['已排程', 'sch'] },
      { id: 'p_1045', n: '马原 第 2 章 · 多选', s: '政治', est: polEst, st: [S.replanned ? '降级 压缩' : '已排程', S.replanned ? 'deg' : 'sch'] },
      { id: 'p_1046', n: '线性表 · 选择题 30', s: '408', est: 40, st: ['计划中', ''] },
      { id: 'p_1047', n: '长难句 · 定语从句', s: '英语', est: 35, st: ['计划中', ''] }
    ];
    return '<div class="items">' + items.map(function (i) {
      return '<div class="item">' +
        '<span class="id">' + i.id + '</span>' +
        '<span class="nm">' + i.n + '</span>' +
        '<span class="sub">' + i.s + '</span>' +
        '<span class="sub mono">' + U.hm(i.est) + '</span>' +
        '<span class="st ' + i.st[1] + '">' + i.st[0] + '</span>' +
      '</div>';
    }).join('') + '</div>';
  }

  ZX.views = ZX.views || {};
  ZX.views.plan = plan;

})(window.ZX);
