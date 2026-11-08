/* =========================================================
   诺瓦 Nova · 今日视图
   ========================================================= */
window.ZX = window.ZX || {};

(function (ZX) {
  'use strict';

  var U = ZX.util;
  var SUBJ = ZX.SUBJ;

  function today() {
    var S = ZX.state;
    var p = S.plannedMin(), w = S.workedMin(), r = S.rate();
    var todo = S.tasks.filter(function (t) { return !t.done; });
    return '<div class="wrap">' +
      '<div class="vhead"><div>' +
        '<div class="eyebrow">11.08 · 周日 · 第 3 周</div>' +
        '<h1>今日<span class="sub">基础期 · 距阶段结束 5 周</span></h1>' +
        '<p class="vlede">' + (todo.length ? '还剩 ' + todo.length + ' 项，' + U.hm(S.remainMin()) + '。留一个弹性位，宁可不满，不可缓冲耗尽。' : '今日计划已全部记录，弹性位保留。') + '</p>' +
      '</div>' +
      '<div class="vstats">' +
        '<div class="vs"><span>计划</span><b>' + U.hm(p) + '</b></div>' +
        '<div class="vs"><span>已投入</span><b>' + U.hm(w) + '</b></div>' +
        '<div class="vs"><span>达成率</span><b class="ac">' + r + '%</b></div>' +
        '<div class="vs"><span>弹性位</span><b>' + (S.buffer.free ? '1 空闲' : '占用') + '</b></div>' +
      '</div></div>' +

      '<div class="sec-h"><span class="n">01</span><span class="t">今日任务</span><span class="rule"></span>' +
        '<span class="r">上限 4 项 · 超出部分折叠为可选</span></div>' +
      '<div class="tasks">' + S.tasks.map(function (t, i) { return taskRow(t, i); }).join('') + bufferRow() + movedRow() + '</div>' +

      (w > 0 ? summaryBlock() : '') +
      signalsBlock() +
      '<div class="foot-note"><span>planner v1.4</span><span>cfg-2026.11</span><span>输出确定性 · 可离线重放</span></div>' +
    '</div>';
  }

  function taskRow(t, i) {
    var S = ZX.state;
    var c = SUBJ[t.s].c;
    var running = S.running === t.id;
    var act;
    if (t.done) {
      act = '<span class="rec">已记录 ' + U.hm(t.actual || t.est) + '</span>';
    } else if (running) {
      act = '<span class="timer" id="timer">00:00</span>' +
            '<button class="btn" data-act="finish" data-id="' + t.id + '">结束</button>' +
            '<button class="btn ghost" data-act="done" data-id="' + t.id + '">按预估记录</button>';
    } else {
      act = '<button class="btn" data-act="start" data-id="' + t.id + '">开始</button>' +
            '<button class="btn ghost" data-act="done" data-id="' + t.id + '">完成</button>';
    }
    return '<article class="task ' + (t.done ? 'done' : '') + ' ' + (running ? 'run' : '') + '" data-task="' + t.id + '">' +
      '<div class="tk-idx">' + (t.done ? '✓' : U.pad2(i + 1)) + '</div>' +
      '<div class="tk-main">' +
        '<div class="tk-line"><span class="subj" style="--c:' + c + '">' + t.s + '</span><h3>' + U.esc(t.title) + '</h3></div>' +
        '<div class="tk-meta"><span class="mono">' + U.hm(t.est) + '</span><span class="sep">·</span><span>' + t.time + '</span>' +
          '<span class="sep">·</span><span>权重 ' + t.weight.toFixed(2) + '</span>' +
          (t.why ? '<span class="sep">·</span><span class="why">' + t.why + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<div class="tk-act">' + act + '</div>' +
    '</article>';
  }

  function bufferRow() {
    var S = ZX.state;
    return '<div class="buffer">' +
      '<div class="ico">◇</div>' +
      '<div class="bf-main"><div class="bf-t"><b>弹性位</b><span>' + S.buffer.time + ' · 60 min</span></div>' +
        '<p>刻意留空，用于吸收欠账。每日保留约 15%，自动排程不得占满。</p></div>' +
      '<div class="tk-act"><button class="btn ghost" data-act="buffer">占用</button></div>' +
    '</div>';
  }

  function movedRow() {
    var S = ZX.state;
    if (!S.movedOut) return '';
    return '<div class="buffer">' +
      '<div class="ico">→</div>' +
      '<div class="bf-main"><div class="bf-t"><b>已移出</b><span>' + U.hm(S.movedOut.est) + ' · 周六 15:00 弹性位</span></div>' +
        '<p>' + U.esc(S.movedOut.title) + '　状态不佳时主动降载，不计入断更。</p></div>' +
      '<div class="tk-act"><button class="btn ghost" data-act="tab" data-tab="plan">查看周计划</button></div>' +
    '</div>';
  }

  function summaryBlock() {
    var S = ZX.state;
    var done = S.tasks.filter(function (t) { return t.done; }).length;
    var over = S.tasks.some(function (t) { return t.done && (t.actual || t.est) > t.est; });
    return '<div class="note">' +
      '<div class="note-h">今日总结<span>' + U.nowStr() + '</span></div>' +
      '<p>已完成 <b>' + done + ' / ' + S.tasks.length + '</b> 项，累计 <b>' + U.hm(S.workedMin()) + '</b>，达成率 <b>' + S.rate() + '%</b>。' +
      (over ? '数学超出预估 40 分钟，超出部分已顺延至周六弹性位。' : '剩余任务已顺延至本周弹性位，未占用明天。') +
      ' 今日留白 60 分钟。</p></div>';
  }

  function signalsBlock() {
    return '<div class="sec-h"><span class="n">02</span><span class="t">偏差信号</span><span class="rule"></span>' +
        '<span class="r">detect 10ms · 每 10 分钟扫描</span></div>' +
      '<div class="sig">' +
        '<div class="sig-h">当前命中项<span>insight v1.4</span></div>' +
        '<div class="sig-row"><span class="k">连续低完成</span><span class="m">近 2 日 58% / 62% · 阈值 60%</span><span class="x warn">命中</span></div>' +
        '<div class="sig-row"><span class="k">滚动欠账</span><span class="m">未来 7 天欠账 150 min · 阈值 150</span><span class="x warn">临界</span></div>' +
        '<div class="sig-row"><span class="k">弹性位占用</span><span class="m">0 / 1 · 上限 50%</span><span class="x ok">正常</span></div>' +
        '<div class="sig-row"><span class="k">锁定块变更</span><span class="m">0 项 · 重排保护生效</span><span class="x ok">正常</span></div>' +
      '</div>';
  }

  ZX.views = ZX.views || {};
  ZX.views.today = today;

})(window.ZX);
