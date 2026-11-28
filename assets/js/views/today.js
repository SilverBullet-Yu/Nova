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

  /* 今日弹性位分钟数：取周表中「今天」行的 buf，与 buffer.time 同源；
     按真实时钟星期匹配（seed 的 today 旗标是示例数据，与演示日期无关） */
  function todayBufMin() {
    var S = ZX.state;
    var summary = S.placementSummary ? S.placementSummary() : null;
    if (summary) {
      var day = summary.days.find(function (item) { return item.date === U.todayKey(); });
      return day ? day.bufferCapacityMin : 0;
    }
    var dow = U.todayDow();
    var w = S.week.filter(function (d) { return d.d === dow })[0] || S.week[S.week.length - 1] || {};
    return U.num(w.buf, 0);
  }

  function taskDayTime(task) {
    var S = ZX.state;
    if (!S.placementModel || !S.taskSegments) return task.time;
    var segments = S.taskSegments(task.id, U.todayKey());
    if (!segments.length) return '';
    var first = segments[0];
    var last = segments[segments.length - 1];
    var pad = U.pad2;
    return pad(Math.floor(first.startMin / 60)) + ':' + pad(first.startMin % 60) + '–' +
      pad(Math.floor((last.startMin + last.durMin) / 60)) + ':' + pad((last.startMin + last.durMin) % 60);
  }

  /* KPI 统一取 flows/exec 的 R8 / S2 口径；率是 0..1，null 不伪装成 0%。 */
  function metrics() {
    return ZX.flows.exec.metrics();
  }

  function rateText(rate, basis) {
    if (rate === null || rate === undefined || !Number.isFinite(rate)) {
      return basis === 'unknown' ? '未知' : '—';
    }
    return Math.round(Math.min(1, Math.max(0, rate)) * 100) + '%';
  }

  function stat(label, value, note, accent) {
    return '<div class="vs' + (accent ? ' sc-vs' : '') + '"><span>' + label + '</span><b' +
      (accent ? ' class="ac"' : '') + '>' + value + '</b><i>' + note + '</i></div>';
  }

  function statusSummary(m) {
    return '<p class="note sc-stats-note">部分完成 ' + m.partialCount +
      ' 项（今日待办中已有进度）；跳过 ' + m.skipped + ' 项、暂缓 ' + m.deferred +
      ' 项（不计入任务数 / 计划 / 剩余，已投入仍保留）；锁定 ' + m.locked +
      ' 项（今日任务 locks 标记）；放弃 ' + m.abandoned + ' 项、替代 ' + m.substituted +
      ' 项（退役，不计入剩余）。实际投入仅汇总任务 actual，不含补录。</p>';
  }

  function secondaryStats(m) {
    return '<details class="vs-more"><summary>更多统计</summary><div class="vs-more-body">' +
      stat('计划工时', U.hm(Math.max(0, m.planned)), m.plannedBasis === 'unknown' ? '已知项合计 · 分母不完整' : '原始计划分母') +
      stat('计划工时完成率', rateText(m.plannedRate, m.plannedBasis), m.plannedBasis === 'unknown' ? '旧任务缺原始计划' : '完成项 + 部分项折算', true) +
      backfillStat(m) +
      '<div class="vs"><span>弹性位</span><b>' + (ZX.state.buffer.free ? '1 空闲' : '占用') + '</b></div>' +
      statusSummary(m) + '</div></details>';
  }

  function activeTasks() {
    return ZX.flows.exec.activeTasks();
  }

  function today() {
    var m = metrics();
    var list = activeTasks();
    /* 渐进披露：待办平铺，已完成默认收起——页面长度不随完成数增长 */
    var todo = [], done = [];
    list.forEach(function (t) { (t.done ? done : todo).push(t); });
    return '<div class="wrap">' +
      rescueBanner() +
      '<div class="vhead"><div>' +
        '<div class="eyebrow">' + todayEyebrow() + '</div>' +
        '<h1>今日<span class="sub">基础期</span></h1>' +
      '</div>' +
      '<div class="vstats">' +
        stat('任务完成率', rateText(m.taskRate), m.done + ' / ' + m.total + ' 项', true) +
        stat('实际投入', U.hm(Math.max(0, m.worked)), '任务 actual · 不含补录') +
        stat('剩余预估', U.hm(Math.max(0, m.remain)), '未完成且未退役') +
        secondaryStats(m) +
      '</div></div>' +

      timelineDisclosure() +

      '<div class="sec-h"><span class="n">01</span><span class="t">今日任务</span><span class="rule"></span>' +
        '<span class="r">待办 ' + todo.length + ' 项</span>' +
        '<button type="button" class="sc-link" data-sc="backfill">补录</button></div>' +
      ttTable(todo.map(function (t, i) { return taskRow(t, i); })) +
      bufferRow() +
      doneFold(done) +
      deferredBlock() +
      skippedBlock() +
    '</div>';
  }

  /* 已记录任务折叠区：复用 ui.fold 原语（展开态持久化），累计时长只取 actual。 */
  function doneFold(done) {
    if (!done.length) return '';
    var total = done.reduce(function (a, t) { return a + Math.max(0, U.num(t.actual, 0)); }, 0);
    return ZX.ui.fold('today:done', {
      title: '已记录 ' + done.length + ' 项',
      meta: '累计 ' + U.hm(total),
      body: ttTable(done.map(function (t, i) { return taskRow(t, i); }), true)
    });
  }

  /* 中断挽救 banner（Stage B）：识别与文案都由 ZX.flows.rescue 提供，
     本视图只负责把它插在 wrap 顶部；flows 未加载时返回空串，不影响既有结构。 */
  function rescueBanner() {
    return (ZX.flows && ZX.flows.rescue && ZX.flows.rescue.banner)
      ? ZX.flows.rescue.banner()
      : '';
  }

  /* ---------- 今日时间带：把「课表骨架 + 空档排布」画出来 ----------
     数据全部来自当日真实状态：任务时段 t.time、弹性位 buffer.time、运行态 running。
     带 = 07:00–23:00 十六小时；空档即底面留白，弹性位为斜纹留白（与周图 .buf 同语）。 */
  var TL_FROM = 7 * 60;    /* 07:00 */
  var TL_TO = 23 * 60;     /* 23:00 */
  var TL_SPAN = TL_TO - TL_FROM;

  /* 'HH:MM–HH:MM' → [起, 止] 分钟；无法解析返回 null（不在带上硬画） */
  function parseSpan(str) {
    var m = /^(\d{1,2}):(\d{2})[–-](\d{1,2}):(\d{2})$/.exec(String(str || '').trim());
    if (!m) return null;
    var a = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    var b = parseInt(m[3], 10) * 60 + parseInt(m[4], 10);
    if (b <= a) return null;
    return [a, b];
  }

  function tlPos(min) {
    return Math.min(100, Math.max(0, (min - TL_FROM) / TL_SPAN * 100));
  }

  function tlBlk(span, cls, color, label, title) {
    var left = tlPos(span[0]);
    var right = tlPos(span[1]);
    if (right - left < 0.5) return '';
    return '<i class="tl-blk ' + cls + '" style="left:' + left.toFixed(2) + '%;width:' + (right - left).toFixed(2) + '%;' +
      (color ? '--c:' + color + ';' : '') + '" title="' + U.esc(title) + '">' + U.esc(label) + '</i>';
  }

  function dayBand() {
    var S = ZX.state;
    var blocks = '';
    var label = '';
    var done = 0;
    activeTasks().forEach(function (t) {
      var c = (SUBJ[t.s] || { c: 'var(--txt3)' }).c;
      var cls = t.done ? 'done' : (S.running === t.id ? 'run' : '');
      if (t.done) done++;
      var segments = S.taskSegments ? S.taskSegments(t.id, U.todayKey()) : [];
      if (segments.length) {
        segments.forEach(function (segment) {
          var span = [segment.startMin, segment.startMin + segment.durMin];
          var time = taskDayTime(t);
          label += (label ? '；' : '') + t.s + ' ' + time;
          blocks += tlBlk(span, cls, c, t.s, t.s + ' ' + t.title + ' ' + time + ' · ' + U.hm(segment.durMin) + (segment.isBuffer ? ' · 弹性位' : ''));
        });
      } else {
        var span = parseSpan(t.time);
        if (!span) return;
        label += (label ? '；' : '') + t.s + ' ' + t.time;
        blocks += tlBlk(span, cls, c, t.s, t.s + ' ' + t.title + ' ' + t.time + ' · ' + U.hm(t.est));
      }
    });
    var buf = parseSpan(S.buffer.time);
    if (buf) {
      label += (label ? '；' : '') + '弹性位 ' + S.buffer.time;
      blocks += tlBlk(buf, 'buf', '', '弹性位', '弹性位 ' + S.buffer.time + ' · 刻意留空' + (S.buffer.free ? '' : ' · 已占用'));
    }
    /* 现在时刻：仅落在带内时显示。标签「现在 HH:MM」居中需两侧各约 30px，
       贴边（<7% / >93%）时与帽注两端文字共享 0 间距带、且会出面板框——
       此时只保留线与菱形标记，时刻可从下方刻度读出 */
    var now = new Date();
    var nowMin = now.getHours() * 60 + now.getMinutes();
    var nowHtml = '';
    if (nowMin > TL_FROM && nowMin < TL_TO) {
      var pos = tlPos(nowMin);
      var lab = (pos > 7 && pos < 93)
        ? '<b>现在 ' + U.pad2(now.getHours()) + ':' + U.pad2(now.getMinutes()) + '</b>'
        : '';
      nowHtml = '<span class="tl-now" style="left:' + pos.toFixed(2) + '%">' + lab + '</span>';
    }
    return '<div class="tl" role="img" aria-label="今日时间带：' + U.esc(label || '暂无排程') + '">' +
      '<div class="tl-cap"><span class="t">今日骨架</span>' +
        '<span class="d">' + (done ? '已记录 ' + done + ' 项 · ' : '') + '任务落在空档 · 弹性位刻意留白</span>' +
        '<span class="r">07:00 – 23:00</span></div>' +
      '<div class="tl-track">' + blocks + nowHtml + '</div>' +
      '<div class="tl-scale">' +
        [7, 9, 11, 13, 15, 17, 19, 21, 23].map(function (h) {
          return '<span style="left:' + ((h * 60 - TL_FROM) / TL_SPAN * 100).toFixed(2) + '%">' + U.pad2(h) + '</span>';
        }).join('') +
      '</div>' +
    '</div>';
  }

  function timelineDisclosure() {
    return '<details class="sc-disclosure sc-timeline"><summary><span>今日时间带</span><small>07:00–23:00</small></summary>' +
      dayBand() + '</details>';
  }

  /* 任务表格：列对齐（编号 / 任务 / 时段 / 工时 / 权重 / 操作），等宽数字右对齐。
     移动端隐藏数值列，改由 c-main 内的 .tt-m 元行承载时段 / 工时 / 权重。 */
  function ttHead(sub) {
    var th = function (t, cls) { return '<span class="tt-h' + (cls ? ' ' + cls : '') + '">' + t + '</span>'; };
    return '<div class="tt-head" aria-hidden="true">' +
      th(sub ? '✓' : '#', 'h-idx') + th('任务', 'h-main') + th('时段', 'h-time') +
      th('工时', 'h-est') + th('权重', 'h-wt') + th('操作', 'h-act') +
    '</div>';
  }

  function taskRow(t, i) {
    var S = ZX.state;
    var c = (SUBJ[t.s] || { c: 'var(--txt3)' }).c;
    var running = S.running === t.id;
    var paused = running && !!S.pausedAt;
    var time = taskDayTime(t);
    var act;
    if (t.done) {
      act = '<span class="rec">已记录 ' + U.hm(Math.max(0, U.num(t.actual, 0))) + '</span>';
    } else if (running) {
      act = '<img class="tk-mascot" src="assets/img/mascot-v4-focus.svg" width="24" height="30" alt="" />' +
            '<span class="timer" id="timer">00:00</span>' +
            '<button class="btn" data-sc="pause" data-id="' + U.esc(t.id) + '">' + (paused ? '继续' : '暂停') + '</button>' +
            '<button class="btn" data-act="finish" data-id="' + U.esc(t.id) + '">结束</button>' +
            '<button class="btn ghost" data-act="done" data-id="' + U.esc(t.id) + '">按预估记录</button>';
    } else {
      act = '<button class="btn" data-act="start" data-id="' + U.esc(t.id) + '">开始</button>' +
            '<button class="btn ghost" data-sc="skip" data-id="' + U.esc(t.id) + '">跳过</button>' +
            '<button class="btn ghost" data-act="done" data-id="' + U.esc(t.id) + '">完成</button>';
    }
    var notes = (t.why ? '<span class="why">' + U.esc(t.why) + '</span>' : '') +
      (paused ? '<span class="sc-paused">已暂停</span>' : '') +
      (!t.done && t.partial ? '<span class="sc-part">已完成 ' + U.esc(t.partial) + '% · 余 ' + U.hm(t.est) + '</span>' : '');
    return '<div class="tt-row' + (t.done ? ' done' : '') + (running ? ' run' : '') + (paused ? ' sc-run-paused' : '') + '" data-task="' + U.esc(t.id) + '">' +
      '<span class="c-idx mono">' + (t.done ? '✓' : U.pad2(i + 1)) + '</span>' +
      '<div class="c-main">' +
        '<div class="tt-line"><span class="subj" style="--c:' + c + '">' + U.esc(t.s) + '</span><h3>' + U.esc(t.title) + '</h3></div>' +
        (notes ? '<p class="tt-note">' + notes + '</p>' : '') +
        '<p class="tt-m mono">' + U.esc(time) + ' · ' + U.hm(t.est) + ' · 权重 ' + t.weight.toFixed(2) + '</p>' +
      '</div>' +
      '<span class="c-time mono">' + U.esc(time) + '</span>' +
      '<span class="c-est mono">' + U.hm(t.est) + '</span>' +
      '<span class="c-wt mono">' + t.weight.toFixed(2) + '</span>' +
      '<div class="c-act">' + act + '</div>' +
    '</div>';
  }

  /* 今日暂缓始终可见：它不是真实改期，也不进入今日任务表和时间带。 */
  function deferredBlock() {
    var S = ZX.state;
    var list = S.tasks.filter(function (t) { return t.deferred; });
    if (!list.length) return '';
    return '<div class="sc-skips open" data-deferred-list>' +
      '<div class="sc-skips-h"><span class="sc-skips-t">今日暂缓（未改期）</span>' +
        '<span class="sc-skips-n">不计入今日待办 · 计划日期未变</span></div>' +
      '<div class="sc-skips-b">' + list.map(deferredItem).join('') + '</div></div>';
  }

  function deferredItem(t) {
    var c = (SUBJ[t.s] || { c: 'var(--txt3)' }).c;
    var legacy = t.deferredTo ? ' · 旧版标记（非改期）：' + U.esc(t.deferredTo) : '';
    return '<div class="sc-skip-i">' +
      '<span class="subj" style="--c:' + c + '">' + U.esc(t.s) + '</span>' +
      '<span class="sc-skip-t">' + U.esc(t.title) + '</span>' +
      '<span class="sc-skip-m mono">' + U.hm(t.est) + (t.deferredReason ? ' · ' + U.esc(t.deferredReason) : '') + legacy + '</span>' +
      '<button type="button" class="btn ghost sc-skip-b" data-act="restore-deferred" data-id="' + U.esc(t.id) + '">恢复</button>' +
    '</div>';
  }

  /* 任务表容器：sub = 折叠区内的副表（去上规与投影） */
  function ttTable(rows, sub) {
    if (!rows.length) return '';
    return '<div class="ttable' + (sub ? ' tt-sub' : '') + '">' + ttHead(sub) + rows.join('') + '</div>';
  }

  function bufferRow() {
    var S = ZX.state;
    return '<div class="buffer">' +
      '<div class="ico">◇</div>' +
      '<div class="bf-main"><div class="bf-t"><b>弹性位</b><span>' + U.esc(S.buffer.time) +
        (todayBufMin() ? ' · ' + U.hm(todayBufMin()) : '') +
        (S.buffer.free ? '' : ' · 已占用') + '</span></div></div>' +
      '<div class="c-act">' + (S.placementModel
        ? '<button class="btn ghost" disabled>用量自动记账</button>'
        : '<button class="btn ghost" data-act="buffer">' + (S.buffer.free ? '占用' : '释放') + '</button>') + '</div>' +
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
      '<button type="button" class="btn ghost sc-skip-b" data-sc="restore" data-id="' + U.esc(t.id) + '">恢复</button>' +
    '</div>';
  }

  /* 有补录才显示（不计入达成率） */
  function backfillStat(m) {
    if (!m.backfill) return '';
    return '<div class="vs sc-vs"><span>补录</span><b>' + U.hm(m.backfill) + '</b><i>不计入完成率 / 实际投入</i></div>';
  }

  ZX.views = ZX.views || {};
  ZX.views.today = today;

})(window.ZX);
