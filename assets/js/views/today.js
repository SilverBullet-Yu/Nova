/* =========================================================
   诺瓦 Nova · 今日视图
   ========================================================= */
window.ZX = window.ZX || {};

(function (ZX) {
  'use strict';

  var U = ZX.util;
  var SUBJ = ZX.SUBJ;
  var WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  /* 头部日期取真实日期（MM.DD · 周X）；阶段周数无数据源，不再展示 */
  function todayEyebrow() {
    var d = new Date();
    return U.pad2(d.getMonth() + 1) + '.' + U.pad2(d.getDate()) + ' · ' + WD[d.getDay()];
  }

  /* 今日弹性位分钟数：取周表中 today 行的 buf，与 buffer.time 同源 */
  function todayBufMin() {
    var S = ZX.state;
    var w = S.week.filter(function (d) { return d.today; })[0] || S.week[S.week.length - 1] || {};
    return U.num(w.buf, 0);
  }

  /* Stage C-1：计划 / 已投入 / 达成率改为视图层口径（过滤 skipped），
     核心派生函数留在 state.js 不动；exec.js 未加载时退回原口径。 */
  function metrics() {
    var S = ZX.state;
    if (ZX.flows && ZX.flows.exec && ZX.flows.exec.metrics) return ZX.flows.exec.metrics();
    return {
      planned: S.plannedMin(), worked: S.workedMin(), remain: S.remainMin(),
      rate: S.rate(),
      done: S.tasks.filter(function (t) { return t.done; }).length,
      total: S.tasks.length, skipped: 0, backfill: 0
    };
  }

  function activeTasks() {
    var S = ZX.state;
    if (ZX.flows && ZX.flows.exec && ZX.flows.exec.activeTasks) return ZX.flows.exec.activeTasks();
    return S.tasks.filter(function (t) { return !t.skipped; });
  }

  function today() {
    var S = ZX.state;
    var m = metrics();
    var list = activeTasks();
    return '<div class="wrap">' +
      rescueBanner() +
      '<div class="vhead"><div>' +
        '<div class="eyebrow">' + todayEyebrow() + '</div>' +
        '<h1>今日<span class="sub">基础期</span></h1>' +
      '</div>' +
      '<div class="vstats">' +
        '<div class="vs"><span>计划</span><b>' + U.hm(m.planned) + '</b></div>' +
        '<div class="vs"><span>已投入</span><b>' + U.hm(m.worked) + '</b></div>' +
        '<div class="vs"><span>达成率</span><b class="ac">' + m.rate + '%</b></div>' +
        backfillStat(m) +
        '<div class="vs"><span>弹性位</span><b>' + (S.buffer.free ? '1 空闲' : '占用') + '</b></div>' +
      '</div></div>' +

      '<div class="sec-h"><span class="n">01</span><span class="t">今日任务</span><span class="rule"></span>' +
        '<span class="r">共 ' + list.length + ' 项</span>' +
        '<button type="button" class="sc-link" data-sc="backfill">补录</button></div>' +
      '<div class="tasks">' + list.map(function (t, i) { return taskRow(t, i); }).join('') + bufferRow() + movedRow() + '</div>' +
      skippedBlock() +
    '</div>';
  }

  /* 中断挽救 banner（Stage B）：识别与文案都由 ZX.flows.rescue 提供，
     本视图只负责把它插在 wrap 顶部；flows 未加载时返回空串，不影响既有结构。 */
  function rescueBanner() {
    return (ZX.flows && ZX.flows.rescue && ZX.flows.rescue.banner)
      ? ZX.flows.rescue.banner()
      : '';
  }

  function taskRow(t, i) {
    var S = ZX.state;
    var c = (SUBJ[t.s] || { c: 'var(--txt3)' }).c;
    var running = S.running === t.id;
    var paused = running && !!S.pausedAt;
    var act;
    if (t.done) {
      act = '<span class="rec">已记录 ' + U.hm(t.actual || t.est) + '</span>';
    } else if (running) {
      act = '<span class="timer" id="timer">00:00</span>' +
            '<button class="btn" data-sc="pause" data-id="' + t.id + '">' + (paused ? '继续' : '暂停') + '</button>' +
            '<button class="btn" data-act="finish" data-id="' + t.id + '">结束</button>' +
            '<button class="btn ghost" data-act="done" data-id="' + t.id + '">按预估记录</button>';
    } else {
      act = '<button class="btn" data-act="start" data-id="' + t.id + '">开始</button>' +
            '<button class="btn ghost" data-sc="skip" data-id="' + t.id + '">跳过</button>' +
            '<button class="btn ghost" data-act="done" data-id="' + t.id + '">完成</button>';
    }
    return '<article class="task ' + (t.done ? 'done' : '') + ' ' + (running ? 'run' : '') + (paused ? ' sc-run-paused' : '') + '" data-task="' + t.id + '">' +
      '<div class="tk-idx">' + (t.done ? '✓' : U.pad2(i + 1)) + '</div>' +
      '<div class="tk-main">' +
        '<div class="tk-line"><span class="subj" style="--c:' + c + '">' + U.esc(t.s) + '</span><h3>' + U.esc(t.title) + '</h3></div>' +
        '<div class="tk-meta"><span class="mono">' + U.hm(t.est) + '</span><span class="sep">·</span><span>' + U.esc(t.time) + '</span>' +
          '<span class="sep">·</span><span>权重 ' + t.weight.toFixed(2) + '</span>' +
          (t.why ? '<span class="sep">·</span><span class="why">' + U.esc(t.why) + '</span>' : '') +
          (paused ? '<span class="sc-paused">已暂停</span>' : '') +
          (!t.done && t.partial ? '<span class="sc-part">已完成 ' + t.partial + '% · 余 ' + U.hm(t.est) + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<div class="tk-act">' + act + '</div>' +
    '</article>';
  }

  function bufferRow() {
    var S = ZX.state;
    return '<div class="buffer">' +
      '<div class="ico">◇</div>' +
      '<div class="bf-main"><div class="bf-t"><b>弹性位</b><span>' + U.esc(S.buffer.time) +
        (todayBufMin() ? ' · ' + U.hm(todayBufMin()) : '') + '</span></div></div>' +
      '<div class="tk-act"><button class="btn ghost" data-act="buffer">占用</button></div>' +
    '</div>';
  }

  function movedRow() {
    var S = ZX.state;
    if (!S.movedOut) return '';
    return '<div class="buffer">' +
      '<div class="ico">→</div>' +
      '<div class="bf-main"><div class="bf-t"><b>已移出</b><span>' + U.esc(S.movedOut.title) + ' · ' + U.hm(S.movedOut.est) + '</span></div></div>' +
      '<div class="tk-act"><button class="btn ghost" data-act="tab" data-tab="plan">查看周计划</button></div>' +
    '</div>';
  }

  /* Stage C-1：已跳过折叠区（默认收起，恢复即 skipped=false） */
  function skippedBlock() {
    var S = ZX.state;
    var list = S.tasks.filter(function (t) { return t.skipped; });
    if (!list.length) return '';
    var open = !!S.skippedOpen;
    return '<div class="sc-skips' + (open ? ' open' : '') + '">' +
      '<button type="button" class="sc-skips-h" data-sc="skipped-toggle" aria-expanded="' + open + '">' +
        '<span class="sc-skips-t">已跳过 ' + list.length + ' 项 · 恢复</span>' +
        '<span class="sc-skips-n">不计入欠账</span>' +
        '<span class="sc-skips-c" aria-hidden="true">' + (open ? '▴' : '▾') + '</span>' +
      '</button>' +
      (open ? '<div class="sc-skips-b">' + list.map(skipItem).join('') + '</div>' : '') +
    '</div>';
  }

  function skipItem(t) {
    var c = (SUBJ[t.s] || { c: 'var(--txt3)' }).c;
    return '<div class="sc-skip-i">' +
      '<span class="subj" style="--c:' + c + '">' + U.esc(t.s) + '</span>' +
      '<span class="sc-skip-t">' + U.esc(t.title) + '</span>' +
      '<span class="sc-skip-m mono">' + U.hm(t.est) + (t.skipReason ? ' · ' + U.esc(t.skipReason) : '') + '</span>' +
      '<button type="button" class="btn ghost sc-skip-b" data-sc="restore" data-id="' + t.id + '">恢复</button>' +
    '</div>';
  }

  /* 有补录才显示（不计入达成率） */
  function backfillStat(m) {
    if (!m.backfill) return '';
    return '<div class="vs sc-vs"><span>补录</span><b>' + U.hm(m.backfill) + '</b><i>不计入达成率</i></div>';
  }

  ZX.views = ZX.views || {};
  ZX.views.today = today;

})(window.ZX);
