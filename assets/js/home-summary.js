/* 首页今日摘要：只读取现有今日任务，不改写业务状态。 */
window.ZX = window.ZX || {};
(function (ZX) {
  'use strict';
  function rateText(rate, basis) {
    if (rate === null || rate === undefined || !Number.isFinite(rate)) {
      return basis === 'unknown' ? '未知' : '—';
    }
    return Math.round(Math.min(1, Math.max(0, rate)) * 100) + '%';
  }

  function metricsHtml(m) {
    if (!m || typeof m.taskRate !== 'number' ||
        !Object.prototype.hasOwnProperty.call(m, 'plannedRate')) return '';
    var U = ZX.util;
    var num = function (value) { return Math.max(0, U.num(value, 0)); };
    return '<section class="home-summary-stats" aria-label="今日统计">' +
      '<article class="home-task"><span class="home-time">任务完成率</span><strong>' +
        rateText(m.taskRate) + '</strong><span class="home-time">' + num(m.done) + ' / ' + num(m.total) + ' 项</span></article>' +
      '<article class="home-task"><span class="home-time">计划工时完成率</span><strong>' +
        rateText(m.plannedRate, m.plannedBasis) + '</strong><span class="home-time">' +
        (m.plannedBasis === 'unknown' ? '旧任务缺原始计划 · 分母未知' : '原始计划 ' + U.hm(num(m.planned)) + ' · 部分项按进度折算') + '</span></article>' +
      '<article class="home-task"><span class="home-time">实际投入</span><strong>' + U.hm(num(m.worked)) +
        '</strong><span class="home-time">任务 actual · 不含补录</span></article>' +
      '<article class="home-task"><span class="home-time">剩余预估</span><strong>' + U.hm(num(m.remain)) +
        '</strong><span class="home-time">未完成且未退役</span></article>' +
      '<article class="home-task"><span class="home-time">部分完成 / 跳过 / 暂缓 / 锁定</span><strong>' +
        num(m.partialCount) + ' / ' + num(m.skipped) + ' / ' + num(m.deferred) + ' / ' + num(m.locked) +
        '</strong><span class="home-time">放弃 ' + num(m.abandoned) + ' 项 · 替代 ' + num(m.substituted) +
        ' 项；跳过 / 暂缓不计入剩余，已投入保留</span></article>' +
    '</section>';
  }

  function render() {
    var exec = ZX.flows.exec;
    var list = exec.activeTasks().filter(function (t) { return !t.done; });
    var overview = typeof exec.metrics === 'function' ? metricsHtml(exec.metrics()) : '';
    if (!list.length) return overview + '<p class="home-empty">今日暂无待办任务</p>';
    return overview + list.map(function (t) {
      var title = t.title || t.subject || t.s || '未命名任务';
      var time = t.time ? '<span class="home-time">' + ZX.util.esc(t.time) + '</span>' : '<span class="home-time">时间未设置</span>';
      return '<article class="home-task">' + time + '<strong>' + ZX.util.esc(title) + '</strong></article>';
    }).join('');
  }
  ZX.homeSummary = { render: render };
})(window.ZX);
