/* =========================================================
   诺瓦 Nova · 数据视图
   周报按本地周汇总执行记录；今日达成率单独展示。
   ========================================================= */
window.ZX = window.ZX || {};

(function (ZX) {
  'use strict';

  var U = ZX.util;
  var MIX_COLOR = { '数学': 'var(--m-math)', '专业课': 'var(--m-408)', '英语': 'var(--m-en)', '政治': 'var(--m-pol)' };
  var ATTR_META = {
    '计划过载': ['var(--warn)', '下调密度，提高弹性位比例'],
    '执行中断': ['var(--bad)', '转入恢复流程，不追加任务'],
    '效率不足': ['var(--m-math)', '校准标准工时，建议拆分'],
    '外部干扰': ['var(--m-en)', '重排弹性位，避开不可用时段']
  };

  /* ---------- 周报真算（不读种子摆拍） ---------- */
  function realStats() {
    var S = ZX.state;
    var mon = weekStart();
    var next = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 7);
    var sess = Array.isArray(S.sessions) ? S.sessions : [];

    /* 有效学习 / 科目结构 / 记录天数：来自执行记录（补录不计） */
    var effMin = 0;
    var bySubject = {};
    var daySet = {};
    sess.forEach(function (s) {
      if (!s || s.isBackfill) return;
      var at = s.endAt ?? s.startAt;
      if (!Number.isFinite(at) || at < mon.getTime() || at >= next.getTime()) return;
      var min = U.num(s.minutes, 0);
      if (!Number.isFinite(min) || min < 0) return;
      effMin += min;
      var t = U.findById(S.tasks, s.taskId);
      var key = t ? t.s : '其他';
      bySubject[key] = U.num(bySubject[key], 0) + min;
      var k = U.dayKey(at);
      if (k) daySet[k] = true;
    });

    /* 重排采纳：来自重排历史（撤销不计为采纳） */
    var hist = Array.isArray(S.replanHistory) ? S.replanHistory : [];
    var adopted = hist.filter(function (r) { return r && r.undone !== true; }).length;

    var seedStats = S.weekStats || {};

    var kpis = {
      effectiveHours: Math.round(effMin / 60 * 10) / 10,
      replanAdopted: adopted,
      replanTotal: hist.length,
      replanRate: hist.length ? Math.round(adopted / hist.length * 100) : null,
      recordedDays: Object.keys(daySet).length,
      totalDays: 7
    };

    /* 科目结构：会话分钟 → 占比 */
    var subjectMix = {};
    var mixSum = 0;
    Object.keys(bySubject).forEach(function (k) { mixSum += bySubject[k]; });
    if (mixSum > 0) {
      Object.keys(bySubject).forEach(function (k) {
        subjectMix[k] = Math.round(bySubject[k] / mixSum * 100);
      });
    }

    /* 归因分布：执行后的归因计数 → 占比 */
    var counts = S.attrCounts || {};
    var cSum = 0;
    Object.keys(counts).forEach(function (k) { cSum += U.num(counts[k], 0); });
    var attribution = {};
    if (cSum > 0) {
      Object.keys(counts).forEach(function (k) {
        attribution[k] = Math.round(U.num(counts[k], 0) / cSum * 100);
      });
    }

    return {
      kpis: kpis,
      subjectMix: subjectMix,
      attribution: attribution,
      actions: Array.isArray(seedStats.actions) ? seedStats.actions : []
    };
  }

  function stats() { return realStats(); }
  function kpis() { return stats().kpis; }

  /* 当前 ISO 周的周一至周日（MM.DD – MM.DD） */
  function weekStart() {
    var now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  }

  function weekRange() {
    var mon = weekStart();
    var sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
    return U.pad2(mon.getMonth() + 1) + '.' + U.pad2(mon.getDate()) + ' – ' +
      U.pad2(sun.getMonth() + 1) + '.' + U.pad2(sun.getDate());
  }

  function genStamp() {
    var d = new Date();
    return U.pad2(d.getMonth() + 1) + '.' + U.pad2(d.getDate()) + ' ' + U.nowStr();
  }

  /* 新调用方只认 0..1 的 taskRate / plannedRate；旧隔离测试桩只有百分比 rate，
     仅在两个新字段都缺席时兼容，且 null 仍显示未知。 */
  function todayMetrics() {
    var m = ZX.flows.exec.metrics();
    if (Object.prototype.hasOwnProperty.call(m, 'taskRate') &&
        Object.prototype.hasOwnProperty.call(m, 'plannedRate')) return m;
    var legacy = m.plannedRate === null || m.rate === null || m.rate === undefined
      ? null : U.num(m.rate, null);
    return {
      taskRate: 0,
      plannedRate: legacy === null ? null : legacy / 100,
      plannedBasis: m.plannedBasis || (legacy === null ? 'unknown' : 'known'),
      planned: U.num(m.planned, 0),
      done: U.num(m.done, 0),
      total: U.num(m.total, 0),
      worked: U.num(m.worked, 0),
      remain: U.num(m.remain, 0),
      partialCount: U.num(m.partialCount, 0),
      skipped: U.num(m.skipped, 0),
      deferred: U.num(m.deferred, 0),
      abandoned: U.num(m.abandoned, 0),
      substituted: U.num(m.substituted, 0),
      locked: U.num(m.locked, 0),
      backfill: U.num(m.backfill, 0)
    };
  }

  function rateText(rate, basis) {
    if (rate === null || rate === undefined || !Number.isFinite(rate)) {
      return basis === 'unknown' ? '未知' : '—';
    }
    return Math.round(Math.min(1, Math.max(0, rate)) * 100) + '%';
  }

  function minutesText(value) {
    var minutes = Math.max(0, U.num(value, 0));
    return typeof U.hm === 'function' ? U.hm(minutes) : minutes + ' min';
  }

  function data() {
    /* 单次渲染只算一次全量统计，向下传递，避免重复遍历会话与重排历史。 */
    var s = stats();
    var k = s.kpis;
    var attr = s.attribution || {};
    var today = todayMetrics();
    return '<div class="wrap">' +
      '<div class="vhead"><div>' +
        '<div class="eyebrow">第 ' + U.isoWeek() + ' 周 · ' + weekRange() + '</div>' +
        '<h1>数据<span class="sub">周报与归因</span></h1>' +
      '</div></div>' +

      '<div class="sec-h"><span class="n">01</span><span class="t">本周概览</span><span class="rule"></span></div>' +
      '<div class="kpis">' +
        '<div class="kpi"><span>有效学习</span><b>' + U.num(k.effectiveHours, 0) + '<span class="u">h</span></b><span class="d">仅计本周非补录会话</span></div>' +
        '<div class="kpi"><span>重排采纳（累计）</span><b>' + U.num(k.replanAdopted, 0) + '<span class="u">/ ' + U.num(k.replanTotal, 0) + '</span></b><span class="d">' +
          (k.replanRate === null ? '暂无重排记录' : '采纳率 ' + U.num(k.replanRate, 0) + '%') + '</span></div>' +
        '<div class="kpi"><span>记录天数</span><b>' + U.num(k.recordedDays, 0) + '<span class="u">/ ' + U.num(k.totalDays, 0) + '</span></b><span class="d">' +
          (U.num(k.recordedDays, 0) >= U.num(k.totalDays, 0) ? '无中断' : '有 ' + (U.num(k.totalDays, 0) - U.num(k.recordedDays, 0)) + ' 天未记录') + '</span></div>' +
      '</div>' +

      '<div class="sec-h"><span class="n">02</span><span class="t">本周周报</span><span class="rule"></span>' +
        '<span class="r">结论 / 依据 / 演示预置</span></div>' +
      '<div class="kpis">' +
        '<div class="kpi"><span>任务完成率</span><b>' + rateText(today.taskRate) + '</b><span class="d">' +
          U.num(today.done, 0) + ' / ' + U.num(today.total, 0) + ' 项 · 仅今日 activeTasks</span></div>' +
        '<div class="kpi"><span>今日达成率</span><b>' + rateText(today.plannedRate, today.plannedBasis) + '</b><span class="d">计划工时完成率 · ' +
          (today.plannedBasis === 'unknown' ? '旧任务缺原始计划，分母未知' : '原始计划 ' + minutesText(today.planned)) + '</span></div>' +
        '<div class="kpi"><span>实际投入</span><b>' + minutesText(today.worked) + '</b><span class="d">今日任务 actual · 不含补录</span></div>' +
        '<div class="kpi"><span>剩余预估</span><b>' + minutesText(today.remain) + '</b><span class="d">未完成且未退役</span></div>' +
      '</div>' +
      '<p class="note">部分完成 ' + U.num(today.partialCount, 0) + ' 项；跳过 ' + U.num(today.skipped, 0) +
        ' 项、暂缓 ' + U.num(today.deferred, 0) + ' 项、锁定 ' + U.num(today.locked, 0) +
        ' 项；放弃 ' + U.num(today.abandoned, 0) + ' 项、替代 ' + U.num(today.substituted, 0) +
        ' 项。跳过 / 暂缓不计入任务数、计划和剩余，此前实际投入仍保留。</p>' +
      reportBlock(s) +
      ZX.ui.fold('data:trend', {
        title: '科目结构与归因',
        meta: '科目结构 · ' + Math.max(1, Object.keys(attr).length) + ' 类归因',
        body:
          '<div class="sec-h"><span class="n">03</span><span class="t">结构与归因</span><span class="rule"></span></div>' +
          '<div class="grid2">' + subjectBars(s) + attribution(s) + '</div>'
      }) +
    '</div>';
  }

  function subjectBars(s) {
    var mix = (s || stats()).subjectMix || {};
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

  function attribution(s) {
    var attr = (s || stats()).attribution || {};
    var keys = Object.keys(attr);
    return '<div class="panel"><div class="panel-h">累计偏差归因' +
      '<img class="warn-flag" src="assets/img/mascot-v4-warn.svg" width="22" height="19" alt="偏差提醒" />' +
      '<span>顺序即优先级</span></div><div class="panel-b">' +
      (keys.length
        ? '<div class="attr">' + keys.map(function (n) {
            var meta = ATTR_META[n] || ['var(--txt3)', '待定'];
            return '<div class="acard"><div class="h"><b>' + U.num(attr[n], 0) + '%</b><span>' + U.esc(n) + '</span></div>' +
              '<div class="t"><i style="width:' + U.num(attr[n], 0) + '%;background:' + meta[0] + '"></i></div><p>' + meta[1] + '</p></div>';
          }).join('') + '</div>'
        : '<div class="empty">暂无归因数据</div>') +
    '</div></div>';
  }

  function reportBlock(s) {
    var S = ZX.state;
    var d = s || stats();
    var k = d.kpis;
    var mix = d.subjectMix || {};
    var attr = d.attribution || {};
    var actions = Array.isArray(d.actions) ? d.actions : [];
    var mixTxt = Object.keys(mix).map(function (n) { return n + ' ' + U.num(mix[n], 0) + '%'; }).join(' / ');
    var attrTxt = Object.keys(attr).map(function (n) { return n + ' ' + U.num(attr[n], 0) + '%'; }).join('、');
    return '<div class="report">' +
      '<div class="report-h"><b>第 ' + U.isoWeek() + ' 周 · 周报</b><span>' + genStamp() + ' 生成</span></div>' +
      /* 荧光笔静态用法（清晰线遗留项）：结论行的关键数字「划重点」，仅装饰、不承载语义 */
      '<div class="rp-row"><div class="k">结论</div><div class="v">周达成率暂无数据（缺少本周计划基准）；有效学习 <b class="hl">' + U.num(k.effectiveHours, 0) + ' 小时</b>。</div></div>' +
      '<div class="rp-row"><div class="k">依据</div><div class="v">' +
        (mixTxt ? '科目分布 ' + U.esc(mixTxt) + '；' : '') +
        (attrTxt ? '累计归因 ' + U.esc(attrTxt) + '。' : '') + '</div></div>' +
      '<div class="rp-row"><div class="k">演示预置</div><div class="v">' +
        (actions.length
          ? '演示数据中的调整示例：' + U.esc(actions.join('；')) + '。生成周报不会将示例写入日程。'
          : '暂无演示调整。') + '</div></div>' +
      '<div class="preset"><span class="tx">演示预置：<b>周日 08:00–10:00 政治 · 马原第 3 章</b> · 仅示例，不写入日程</span></div>' +
    '</div>';
  }

  ZX.views = ZX.views || {};
  ZX.views.data = data;

})(window.ZX);
