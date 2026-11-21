/* =========================================================
   诺瓦 Nova · 执行记录（Stage C-1 / F-4.1 F-4.2 F-4.3）
   ---------------------------------------------------------
   · 暂停 / 继续：pausedAt + pausedTotal 存在 state，计时冻结不依赖 DOM
   · 部分完成：结束 → 「记录这次执行」弹层（25/50/75/100 + 状态）
   · 跳过：原因弹层 → skipped=true，折叠区可恢复，不计入欠账
   · 补录：只写 sessions，不改任务的 done / est / actual
   · 经典 script，IIFE 挂 ZX.flows.exec，支持 file:// 双击
   · 弹层 / 轻提示只用 ZX.ui 原语，不另造弹窗
   ========================================================= */
window.ZX = window.ZX || {};

(function (ZX) {
  'use strict';

  var U = ZX.util;

  var PCTS = [25, 50, 75, 100];              /* 完成度四档 */
  var FEELS = ['顺利', '吃力', '分心', '疲惫']; /* 执行状态，可选 */
  var REASONS = ['临时有事', '状态不好', '任务过难', '其他']; /* 跳过原因 */
  var MIN_EST = 15;                          /* 部分完成后剩余工时下限 */

  /* ---------- 状态初始化 ----------
     只新增契约第 4 节预留字段（sessions / pausedAt）与阶段内视图标记：
     · pausedAt    本次暂停起点（ms）；null 表示未暂停
     · pausedTotal 累计暂停毫秒
     · sessions    执行记录数组
     · skippedOpen 「已跳过」折叠区是否展开（纯视图状态，仍放 state 以跨 render 保留） */
  (function initState() {
    var S = ZX.state;
    if (S.pausedAt === undefined) S.pausedAt = null;
    if (typeof S.pausedTotal !== 'number') S.pausedTotal = 0;
    if (!Array.isArray(S.sessions)) S.sessions = [];
    if (typeof S.skippedOpen !== 'boolean') S.skippedOpen = false;
  })();

  /* ---------- 基础 ---------- */
  function tasks() { return ZX.state.tasks; }

  function task(id) {
    return U.findById(tasks(), id);
  }

  /* 参与今日统计的任务：跳过项不算计划、不算剩余、不算达成率分母 */
  function activeTasks() {
    return tasks().filter(function (t) { return !t.skipped && !t.deferred; });
  }

  function colorOf(t) {
    var S = ZX.SUBJ || {};
    return (S[t.s] && S[t.s].c) ? S[t.s].c : 'var(--txt3)';
  }

  /* 对话输出统一走 assistant（exec.js 在 assistant.js 之后加载） */
  function say(html, eng) {
    if (ZX.assistant && typeof ZX.assistant.say === 'function') ZX.assistant.say(html, eng);
  }

  function dayKey(ts) { return U.dayKey(ts); }

  function todayKey() { return U.todayKey(); }

  /* 今日补录分钟（只统计当天写入的补录，不计入达成率） */
  function backfillMin() {
    var k = todayKey();
    return ZX.state.sessions.reduce(function (a, s) {
      if (!s || !s.isBackfill) return a;
      return a + (dayKey(s.endAt || s.startAt) === k ? U.num(s.minutes, 0) : 0);
    }, 0);
  }

  /* 视图层统计：过滤 skipped，不改 state.js 的派生函数语义 */
  function metrics() {
    var list = activeTasks();
    var planned = 0, worked = 0, done = 0;
    list.forEach(function (t) {
      planned += U.num(t.est, 0);
      if (t.done) { worked += U.num(t.actual || t.est, 0); done += 1; }
    });
    return {
      planned: planned,
      worked: worked,
      remain: planned - worked,
      rate: planned ? Math.round(worked / planned * 100) : 0,
      done: done,
      total: list.length,
      skipped: tasks().length - list.length,
      backfill: backfillMin()
    };
  }

  function partialEst(est, completion) {
    return Math.max(MIN_EST, Math.round(U.num(est, 0) * (1 - U.num(completion, 0) / 100)));
  }

  /* ---------- 记录写入 ----------
     status 只承载记录类型（done / partial / skip / backfill，契约第 4 节枚举）；
     感受词（顺利/吃力/分心/疲惫）独立存 feel 字段——不再与类型混用同一字段。 */
  function record(o) {
    var S = ZX.state;
    var now = Date.now();
    var completion = Math.round(U.num(o.completion, 0));
    var sess = {
      id: 's_' + now.toString(36) + '_' + (S.sessions.length + 1),
      taskId: o.taskId,
      planVersion: o.isBackfill ? null : S.currentPlanVersion(),
      startAt: U.num(o.startAt, now),
      endAt: U.num(o.endAt, now),
      minutes: Math.max(0, Math.round(U.num(o.minutes, 0))),
      completion: completion,
      status: o.status || (completion >= 100 ? 'done' : 'partial'),
      feel: o.feel || null,
      isBackfill: !!o.isBackfill
    };
    S.sessions.push(sess);
    U.appendTrace('zx.executionTrace', {
      id: sess.id, tool: 'execution', at: sess.endAt, planVersion: sess.planVersion,
      rulesVersion: 'nova-execution-p0-1', status: 'recorded-local'
    });
    try {
      ZX.api.queueOp({ entity: 'session', entityId: o.taskId, field: 'recorded', value: sess });
    } catch (e) { /* 离线写队列失败不影响本地记录 */ }
    return sess;
  }

  /* 把一次执行落到任务上：100% → 完成；<100% → 累计实际 + 顺延剩余工时 */
  function applyRecord(id, o) {
    var S = ZX.state;
    var t = task(id);
    if (!t) return null;
    var now = Date.now();
    var minutes = Math.max(1, Math.round(U.num(o.minutes, 1)));
    var completion = Math.min(100, Math.max(1, Math.round(U.num(o.completion, 100))));
    var startAt = U.num(o.startAt, now - minutes * 60000);
    var beforeEst = U.num(t.est, 0);

    var sess = record({
      taskId: id,
      startAt: startAt,
      endAt: U.num(o.endAt, now),
      minutes: minutes,
      completion: completion,
      feel: o.feel || null,   /* 记录弹层的「状态」即感受词；status 由完成度推导 */
      isBackfill: false
    });

    if (completion >= 100) {
      t.done = true;
      t.actual = minutes;
      t.completion = 100;
      t.partial = null;
    } else {
      t.done = false;
      t.actual = U.num(t.actual, 0) + minutes;
      t.est = partialEst(beforeEst, completion);
      t.time = U.retime(t.time, t.est);
      t.partial = completion;
      t.completion = completion;
    }

    S.resetTimer();
    return sess;
  }

  /* 时段重算用 util.js 共用的 U.retime（部分完成后避免「45m」与「10:30–12:00」矛盾） */

  /* ---------- 内在 loop：执行 → 偏差识别 → 归因回写（环节⑥⑧） ----------
     每次记录执行后自动跑一遍：输入全部由本地状态推导，不读种子摆拍数据。
     归因结果计入 state.attrCounts（数据页「偏差归因」卡片的真实数据源）。 */
  function timeoutCount() {
    var n = 0;
    (ZX.state.sessions || []).forEach(function (s) {
      if (!s || s.isBackfill) return;
      var t = task(s.taskId);
      if (t && U.num(s.minutes, 0) > U.num(t.est, 0)) n++;
    });
    return n;
  }

  function externalRatio() {
    var skipped = ZX.state.tasks.filter(function (t) { return t.skipped; });
    if (!skipped.length) return 0;
    var ext = skipped.filter(function (t) { return t.skipReason === '临时有事'; }).length;
    return ext / skipped.length;
  }

  function runAttribution(t, sess, beforeEst) {
    var S = ZX.state;
    var m = metrics();
    var input = {
      planLoadRatio: m.planned / Math.max(1, U.num(S.user.dailyCapMin, 300)),
      consecutiveZeroDays: (ZX.flows.rescue ? ZX.flows.rescue.zeroDaysFromSessions() : 0),
      consecutiveTimeoutCount: timeoutCount(),
      efficiencyRatio: U.num(sess.minutes, 0) / Math.max(1, U.num(beforeEst, 1)),
      completion: U.num(sess.completion, 0) / 100,
      externalRatio: externalRatio()
    };
    var res = ZX.engine.attributeNow(input);
    if (res && res.type && res.type !== '无偏差') {
      S.attrCounts[res.type] = U.num(S.attrCounts[res.type], 0) + 1;
    }
    return res;
  }

  /* 归因结果卡片：一句依据 + 一条可执行的下一步（反焦虑：不命中阻断不给按钮） */
  function attributionHtml(attr, interrupted) {
    if (!attr) return '';
    var btn = '';
    if (interrupted) {
      btn = '<button class="btn" data-say="我断了四天">进入挽救</button>';
    } else if (attr.type === '计划过载') {
      btn = '<button class="btn" data-say="这周太乱，帮我重排">重新安排本周</button>';
    } else if (attr.type === '效率不足') {
      btn = '<button class="btn" data-say="今天有点累">降载一点</button>';
    }
    var evidence = attr.evidence || {};
    var matched = Array.isArray(evidence.matched) ? evidence.matched.join('；') : '';
    var values = [
      ['计划负载比', 'planLoadRatio'], ['无记录天数', 'consecutiveZeroDays'],
      ['超时次数', 'consecutiveTimeoutCount'], ['用时／原估时', 'efficiencyRatio'],
      ['完成度（比例）', 'completion'], ['外部原因跳过占比', 'externalRatio']
    ].filter(function (field) { return Number.isFinite(evidence[field[1]]); })
      .map(function (field) { return field[0] + ' ' + evidence[field[1]]; }).join('；');
    return '<div class="ecard sc-attr">' +
      '<div class="ecard-h"><b>偏差归因</b>' +
        '<span class="tag ' + (attr.type === '无偏差' ? 'ok' : 'warn') + '">' + U.esc(attr.type) + '</span></div>' +
      '<div class="ecard-b">' +
        '<p class="note">来源：当前计划与执行记录，由固定规则计算，不是模型推断。</p>' +
        '<p class="note">' + U.esc(values) + '</p>' +
        '<div class="erow"><span class="k">命中规则</span><span class="why">' + U.esc(matched) + '</span>' +
          '<span class="v">规则评分 ' + Math.round(U.num(attr.confidence, 0) * 100) + '%</span></div>' +
        '<div class="ecard-f">' + (btn || '<span class="note">' + U.esc(attr.actions[0] || '保持当前节奏') + '</span>') + '</div>' +
      '</div></div>';
  }

  /* ---------- 计时口径（与 assistant.tickTimer 同源） ---------- */
  function elapsedMin() {
    var ms = (ZX.assistant && ZX.assistant.elapsedMs)
      ? ZX.assistant.elapsedMs()
      : 0;
    return Math.max(1, Math.floor(ms / 60000));
  }

  /* ---------- 暂停 / 继续 ---------- */
  function togglePause(id) {
    var S = ZX.state;
    if (S.running !== id || !S.timerStart) return;
    if (S.pausedAt) {
      S.pausedTotal = U.num(S.pausedTotal, 0) + (Date.now() - S.pausedAt);
      S.pausedAt = null;
    } else {
      S.pausedAt = Date.now();
    }
    ZX.render();
  }

  /* ---------- 部分完成：记录弹层 ---------- */
  /* 分段控件同步：pct 走数值比较 + aria-checked；feel 走字符串比较 + aria-pressed（两处弹层共用） */
  function syncSeg(root, sel, val, checked) {
    var seg = root.querySelector(sel);
    if (!seg) return;
    Array.prototype.forEach.call(seg.querySelectorAll('button'), function (x) {
      var on = checked ? U.num(x.dataset.v, 0) === U.num(val, 0) : x.dataset.v === val;
      x.classList.toggle('on', on);
      x.setAttribute(checked ? 'aria-checked' : 'aria-pressed', String(on));
    });
  }

  function segPct(cur) {
    return '<div class="seg sc-seg" id="sc-pct" role="radiogroup" aria-label="完成度">' +
      PCTS.map(function (p) {
        var on = p === cur;
        return '<button type="button" role="radio" aria-checked="' + on + '"' +
          (on ? ' class="on"' : '') + ' data-sc="pct" data-v="' + p + '">' + p + '%</button>';
      }).join('') + '</div>';
  }

  function segFeel(cur) {
    return '<div class="seg sc-seg sc-feel" id="sc-feel" role="group" aria-label="状态（可选）">' +
      FEELS.map(function (f) {
        var on = f === cur;
        return '<button type="button" aria-pressed="' + on + '"' +
          (on ? ' class="on"' : '') + ' data-sc="feel" data-v="' + f + '">' + f + '</button>';
      }).join('') + '</div>';
  }

  function recordNote(est, completion) {
    if (completion >= 100) return '记为完成：达成率按本次实际时长计入，不做额外追加。';
    return '记为 ' + completion + '%：剩余 ' + U.hm(partialEst(est, completion)) +
      ' 已顺延到弹性位，任务留在今日，可继续计时。';
  }

  function recordBody(t, mins, completion, feel) {
    return '<div class="sc-rec-h">' +
        '<span class="subj" style="--c:' + colorOf(t) + '">' + U.esc(t.s) + '</span>' +
        '<b>' + U.esc(t.title) + '</b>' +
      '</div>' +
      '<div class="sc-rec-kv"><span>本次计时</span><b>' + mins + '</b>' +
        '<i>min 实测 · 已扣除暂停</i></div>' +
      '<div class="field"><label>完成度</label>' + segPct(completion) + '</div>' +
      '<div class="field"><label>状态 <em class="sc-opt-i">可选</em></label>' + segFeel(feel) + '</div>' +
      '<div class="notice sc-note" id="sc-rec-note">' + recordNote(t.est, completion) + '</div>';
  }

  function openRecord(id) {
    var S = ZX.state;
    var t = task(id);
    if (!t || !ZX.ui) return;
    if (S.running !== id || !S.timerStart) {
      /* 没有在计时（例如刷新后）→ 退回按预估记录，避免出现 0 分钟 */
      ZX.assistant.finishTask(id, true);
      return;
    }

    var mins = elapsedMin();
    var completion = 100;
    var feel = '';
    var startAt = S.timerStart;
    var endAt = Date.now();
    var ctl = null;

    ctl = ZX.ui.sheet({
      eyebrow: 'EXEC / 记录',
      title: '记录这次执行',
      sub: '完成度与状态都可以改，默认按 100% 记。',
      body: recordBody(t, mins, completion, feel),
      footer: ZX.ui.footNav({ ns: 'sc', act: 'save-record', label: '记录' }),
      onClose: function () { ctl = null; }
    });

    ctl.root.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-sc]') : null;
      if (!b || !ctl) return;   /* 已关闭：忽略淡出期间的重复点击 */
      var act = b.dataset.sc;

      if (act === 'pct') {
        completion = U.num(b.dataset.v, 100);
        syncSeg(ctl.root, '#sc-pct', completion, true);
        var note = ctl.$('#sc-rec-note');
        if (note) note.textContent = recordNote(t.est, completion);
        return;
      }

      if (act === 'feel') {
        feel = (feel === b.dataset.v) ? '' : b.dataset.v;
        syncSeg(ctl.root, '#sc-feel', feel, false);
        return;
      }

      if (act === 'save-record') {
        var box = ctl;
        ctl = null;
        if (box) box.close('saved');
        commitRecord(id, mins, completion, feel, startAt, endAt);
      }
    });
  }

  function commitRecord(id, mins, completion, feel, startAt, endAt) {
    var S = ZX.state;
    var t = task(id);
    if (!t) return;
    var beforeEst = U.num(t.est, 0);
    var sess = applyRecord(id, {
      minutes: mins, completion: completion, feel: feel,
      startAt: startAt, endAt: endAt
    });

    ZX.render();
    ZX.ui.toast(completion >= 100 ? '已记录 ' + U.hm(mins) : '已记录 ' + completion + '%', 'ok');

    var m = metrics();
    var left = m.total - m.done;
    var head = '已记录：<b>' + U.esc(t.title) + '</b>，' + U.hm(mins) +
      (completion < 100 ? ' · 完成度 ' + completion + '%' : '') +
      (feel ? ' · ' + U.esc(feel) : '') + '。';

    var tail;
    if (completion < 100) {
      tail = '剩余 ' + U.hm(t.est) + ' 已顺延到弹性位（' + beforeEst + ' → ' + t.est +
        ' min），今日达成率 <b class="ac">' + m.rate + '%</b>，还留着 ' + left + ' 项。';
    } else {
      tail = left
        ? '今日达成率 <b class="ac">' + m.rate + '%</b>，还剩 ' + left + ' 项。'
        : '今天 ' + m.total + ' 项全部记录，累计 <b class="ac">' + U.hm(m.worked) + '</b>。弹性位留空 60 分钟。';
    }

    /* 内在 loop：识别偏差（断更由真实记录计算）→ 归因 → 数据回流 + 一键衔接 */
    var interrupted = ZX.flows.rescue ? ZX.flows.rescue.detect() : false;
    var attr = runAttribution(t, sess, beforeEst);

    say((completion >= 100 ? '<img class="msg-state state-done" src="assets/img/mascot-v4-done.svg" width="32" height="28" alt="" />' : '') +
      '<p>' + head + tail + '</p>' +
      (completion < 100
        ? '<p style="color:var(--txt3);font-size:11px">部分完成不追加补作，剩余工时只占用弹性位。</p>' +
          '<div class="ecard-f"><button class="btn" data-say="这周太乱，帮我重排">重新安排本周</button>' +
          '<span class="note">剩余工时已落在弹性位，重排会把它排进新空档</span></div>'
        : (left ? '' : '<p style="color:var(--txt3);font-size:11px">没有追加任务。按计划结束，比多学 20 分钟更重要。</p>')) +
      attributionHtml(attr, interrupted),
      '执行 · 完成 ' + (sess ? sess.completion : 100) + '%');
  }

  /* ---------- 跳过 ---------- */
  function openSkip(id) {
    var S = ZX.state;
    var t = task(id);
    if (!t || !ZX.ui) return;
    if (t.done || t.skipped || S.running === id) return;

    var reason = REASONS[0];
    var ctl = null;

    var opts = REASONS.map(function (r, i) {
      return '<button type="button" class="sc-opt' + (i === 0 ? ' on' : '') + '"' +
        ' role="radio" aria-checked="' + (i === 0) + '" data-sc="reason" data-v="' + U.esc(r) + '">' +
        '<i class="sc-dot" aria-hidden="true"></i><span>' + r + '</span></button>';
    }).join('');

    ctl = ZX.ui.sheet({
      eyebrow: 'EXEC / 跳过',
      title: '跳过这一项',
      sub: U.esc(t.s) + ' · ' + U.esc(t.title) + ' · ' + U.hm(t.est),
      body: '<div class="field"><label>原因</label>' +
          '<div class="sc-opts" role="radiogroup" aria-label="跳过原因">' + opts + '</div></div>' +
        '<div class="notice sc-note">跳过不计入欠账，也不占今日剩余时长。之后可以在「已跳过」里恢复。</div>',
      footer: ZX.ui.footNav({ ns: 'sc', act: 'save-skip', label: '记入跳过' }),
      onClose: function () { ctl = null; }
    });

    ctl.root.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-sc]') : null;
      if (!b || !ctl) return;
      var act = b.dataset.sc;

      if (act === 'reason') {
        reason = b.dataset.v || REASONS[0];
        /* 与记录弹层共用同一分段同步原语（aria-checked / .on 切换一致） */
        syncSeg(ctl.root, '.sc-opts', reason, false);
        return;
      }

      if (act === 'save-skip') {
        var box = ctl;
        ctl = null;
        if (box) box.close('skipped');
        commitSkip(id, reason);
      }
    });
  }

  function commitSkip(id, reason) {
    var S = ZX.state;
    var t = task(id);
    if (!t) return;
    var now = Date.now();
    t.skipped = true;
    t.skipReason = reason;
    t.skippedAt = now;

    record({
      taskId: id, startAt: now, endAt: now,
      minutes: 0, completion: 0, status: 'skip', isBackfill: false
    });

    ZX.render();
    ZX.ui.toast('已跳过 · 不计入欠账');
    say('<p>已跳过：<b>' + U.esc(t.title) + '</b>（' + U.esc(reason) + '）。' +
      '<b>不计入欠账</b>，也不占今日剩余；需要时在「已跳过」里恢复即可。</p>', '执行 · 跳过');
  }

  function restoreTask(id) {
    var t = task(id);
    if (!t) return;
    t.skipped = false;
    t.skipReason = null;
    t.skippedAt = null;
    ZX.render();
    /* 全量重绘会丢焦点：放回同项的「恢复」按钮（该按钮存在时） */
    U.refocus(U.$('[data-sc="restore"][data-id="' + id + '"]'));
    ZX.ui.toast('已恢复', 'ok');
  }

  function toggleSkipped() {
    var S = ZX.state;
    S.skippedOpen = !S.skippedOpen;
    ZX.render();
    U.refocus(U.$('[data-sc="skipped-toggle"]'));
  }

  /* ---------- 补录 ---------- */
  function openBackfill() {
    var S = ZX.state;
    if (!ZX.ui) return;
    var todo = activeTasks().filter(function (t) { return !t.done; });
    if (!todo.length) {
      ZX.ui.toast('今天的任务都已记录，无需补录', 'warn');
      return;
    }

    var taskId = todo[0].id;
    var date = todayKey();
    var mins = 30;
    var completion = 100;
    var ctl = null;

    var options = todo.map(function (t) {
      return '<option value="' + t.id + '">' + U.esc(t.s) + ' · ' + U.esc(t.title) + '（' + U.hm(t.est) + '）</option>';
    }).join('');

    ctl = ZX.ui.sheet({
      eyebrow: 'EXEC / 补录',
      title: '补录一次执行',
      sub: '补录只写执行记录，不改任务的预估与达成率。',
      body: '<div class="field"><label>任务</label>' +
          '<select class="input sc-select" id="sc-bf-task">' + options + '</select></div>' +
        '<div class="row2f">' +
          '<div class="field"><label>日期</label>' +
            '<input class="input mono" type="date" id="sc-bf-date" value="' + date + '"></div>' +
          '<div class="field"><label>实际分钟</label>' +
            '<input class="input mono" type="number" id="sc-bf-min" min="1" max="600" step="5" value="' + mins + '"></div>' +
        '</div>' +
        '<div class="field"><label>完成度</label>' + segPct(100) + '</div>' +
        '<div class="notice sc-note">补录记为「补录」，不计入今日达成率，也不改任务工时。</div>',
      footer: ZX.ui.footNav({ ns: 'sc', act: 'save-backfill', label: '记录补录' }),
      onClose: function () { ctl = null; }
    });

    ctl.root.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-sc]') : null;
      if (!b || !ctl) return;

      if (b.dataset.sc === 'pct') {
        completion = U.num(b.dataset.v, 100);
        syncSeg(ctl.root, '#sc-pct', completion, true);
        return;
      }

      if (b.dataset.sc === 'save-backfill') {
        var selT = ctl.$('#sc-bf-task');
        var selD = ctl.$('#sc-bf-date');
        var selM = ctl.$('#sc-bf-min');
        taskId = (selT && selT.value) ? selT.value : taskId;
        date = (selD && selD.value) ? selD.value : date;
        mins = Math.min(600, Math.max(1, Math.round(U.num(selM && selM.value, 30))));

        var box = ctl;
        ctl = null;
        if (box) box.close('backfilled');
        commitBackfill(taskId, date, mins, completion);
      }
    });
  }

  function commitBackfill(taskId, date, mins, completion) {
    var t = task(taskId);
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
    var start = m
      ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0)
      : new Date();
    if (isNaN(start.getTime())) start = new Date();
    var startAt = start.getTime();
    var endAt = startAt + mins * 60000;

    record({
      taskId: taskId, startAt: startAt, endAt: endAt,
      minutes: mins, completion: completion,
      status: 'backfill', isBackfill: true
    });

    ZX.render();
    ZX.ui.toast('已补录 ' + U.hm(mins));
    say('<p>已补录：<b>' + (t ? U.esc(t.title) : U.esc(taskId)) + '</b>，' + U.hm(mins) +
      ' · 完成度 ' + completion + '%。' +
      '<b>不计入达成率</b>，任务工时也保持不变。</p>', '执行 · 补录');
  }

  /* ---------- 今日页按钮委托（不改 main.js） ---------- */
  document.addEventListener('click', function (e) {
    if (!e.target || !e.target.closest) return;
    var b = e.target.closest('[data-sc]');
    if (!b || b.closest('.ovl')) return;   /* 弹层内部事件由各自 sheet 处理 */
    var act = b.dataset.sc;

    if (act === 'pause') { togglePause(b.dataset.id); return; }
    if (act === 'skip') { openSkip(b.dataset.id); return; }
    if (act === 'restore') { restoreTask(b.dataset.id); return; }
    if (act === 'skipped-toggle') { toggleSkipped(); return; }
    if (act === 'backfill') { openBackfill(); return; }
  });

  ZX.flows = ZX.flows || {};
  /* 仅导出跨模块消费面（视图 / assistant / 测试锚点 record）；
     弹层装配件（openSkip / commitSkip / 补录族）由本文件 [data-sc] 委托内部使用 */
  ZX.flows.exec = {
    metrics: metrics,
    activeTasks: activeTasks,
    elapsedMin: elapsedMin,
    record: record,
    openRecord: openRecord,
    commitRecord: commitRecord
  };

  /* 供其他模块（assistant）复用的小工具 */
  ZX.exec = ZX.flows.exec;

})(window.ZX);
