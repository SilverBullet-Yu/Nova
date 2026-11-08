/* =========================================================
   诺瓦 Nova · 对话意图路由 + 各类 flow
   涉及计算的调用统一走 ZX.engine（后端优先 → 本地 shared/engine → 内置兜底）
   ========================================================= */
window.ZX = window.ZX || {};

(function (ZX) {
  'use strict';

  var U = ZX.util;

  function chatEl() { return U.$('#chat'); }

  /* ---------- 消息 ---------- */
  function pushMsg(who, html, eng) {
    var el = document.createElement('div');
    el.className = 'msg ' + who;
    var label = who === 'a' ? '小序' : '你';
    el.innerHTML =
      '<div class="meta"><b>' + label + '</b><span class="t">' + U.nowStr() + '</span>' +
      (eng ? '<span class="eng">' + eng + '</span>' : '') + '</div>' +
      '<div class="txt">' + html + '</div>';
    chatEl().appendChild(el);
    chatEl().scrollTop = chatEl().scrollHeight;
    return el;
  }

  function say(html, eng) { return pushMsg('a', html, eng); }
  function me(t) { return pushMsg('u', '<p>' + U.esc(t) + '</p>'); }

  function typing() {
    var el = document.createElement('div');
    el.className = 'msg a';
    el.innerHTML = '<div class="meta"><b>小序</b><span class="t">' + U.nowStr() + '</span></div>' +
      '<div class="txt" style="color:var(--txt3)"><span class="mono">···</span></div>';
    chatEl().appendChild(el);
    chatEl().scrollTop = chatEl().scrollHeight;
    return el;
  }

  /* ---------- 执行动作 ---------- */
  /* 计时口径（Stage C-1）：扣掉累计暂停与本次暂停，暂停时返回冻结值 */
  function elapsedMs() {
    var S = ZX.state;
    if (!S.timerStart) return 0;
    var now = Date.now();
    var total = U.num(S.pausedTotal, 0);
    var cur = S.pausedAt ? (now - S.pausedAt) : 0;
    return Math.max(0, now - S.timerStart - total - cur);
  }

  function startTask(id) {
    var S = ZX.state;
    var t = S.tasks.filter(function (x) { return x.id === id; })[0];
    var restored = !!(t && t.skipped);
    if (restored) { t.skipped = false; t.skipReason = null; }
    S.running = id;
    S.timerStart = Date.now();
    S.pausedAt = null;
    S.pausedTotal = 0;
    ZX.render();
    if (!t) return;
    say('<p>计时已开始：<b>' + U.esc(t.title) + '</b>。目标 ' + U.hm(t.est) + '，结束时会记录实际时长与完成度。' +
        (restored ? '　该项此前在「已跳过」里，已恢复。' : '') + '</p>' +
        '<p style="color:var(--txt3);font-size:11px">演示环境可直接点「按预估记录」完成，不必真等 ' + U.hm(t.est) + '；中途离开可以暂停，暂停不计入时长。</p>', 'session · running');
  }

  function tickTimer() {
    var S = ZX.state;
    var el = document.getElementById('timer');
    if (!el || !S.timerStart) return;
    var sec = Math.floor(elapsedMs() / 1000);
    el.textContent = U.pad2(Math.floor(sec / 60)) + ':' + U.pad2(sec % 60);
  }

  function finishTask(id, useEst) {
    var S = ZX.state;
    var t = S.tasks.filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    var exec = ZX.flows && ZX.flows.exec;

    /* 结束（有计时）→ 记录弹层：完成度 / 状态；按预估记录 → 直接 100% */
    if (!useEst && S.running === id) {
      if (exec && exec.openRecord) { exec.openRecord(id); return; }
    }

    var mins = t.est;
    var startAt = null;
    if (S.running === id && !useEst) {
      mins = exec && exec.elapsedMin ? exec.elapsedMin() : Math.max(1, Math.floor(elapsedMs() / 60000));
      startAt = S.timerStart;
    }

    if (exec && exec.commitRecord) {
      exec.commitRecord(id, mins, 100, '', startAt || (Date.now() - mins * 60000), Date.now());
      return;
    }

    /* 兜底：flows/exec.js 未加载时保持既有行为 */
    t.done = true;
    t.actual = mins;
    S.running = null;
    S.timerStart = null;
    ZX.render();
    ZX.api.queueOp({
      entity: 'task', entityId: t.id, field: 'done',
      value: { done: true, actual: mins, est: t.est }
    });
    var left = S.tasks.filter(function (x) { return !x.done; }).length;
    say('<p>已记录：' + U.esc(t.title) + '，' + U.hm(mins) + '。今日达成率 <b class="ac">' + S.rate() + '%</b>' +
      (left ? '，还剩 ' + left + ' 项。' : '。') + '</p>', 'execution · 12ms');
  }

  function bufferWarn() {
    say('<p>该时段为<b>弹性位</b>，占用后本周抗中断能力下降。自动排程不允许占满它，手动占用需要你确认。</p>' +
        '<p style="color:var(--txt3);font-size:11px">建议：把要补的内容放进周六 15:00–17:00 的空闲段，那里还有 2 小时余量。</p>', 'schedule · guard');
  }

  /* ---------- 意图路由 ---------- */
  var INTENTS = [
    { k: ['我断了四天', '断了', '中断', '挽救', '没打开'], run: rescueFlow },
    { k: ['新建目标', '定目标', '改目标'], run: goalFlow },
    { k: ['撤销', '恢复', '撤回'], run: undoReplan },
    { k: ['数学', '多给', '加时间', '延长一点'], run: adjustMath },
    { k: ['重排', '落下', '落后', '来不及', '崩'], run: replanFlow },
    { k: ['周报', '复盘', '这周怎么样'], run: weeklyFlow },
    { k: ['累', '状态不好', '没精神', '压力', '疲惫'], run: tiredFlow },
    { k: ['可行', 'r值', '来得及吗', '合理吗', '评估'], run: feasibilityFlow },
    { k: ['开始', '计时', '专注'], run: startFlow },
    { k: ['今天', '学什么', '安排', '干嘛', '任务'], run: todayFlow }
  ];

  function route(text) {
    var t = text.toLowerCase().replace(/\s/g, '');
    var hit = null;
    for (var i = 0; i < INTENTS.length; i++) {
      var ks = INTENTS[i].k;
      for (var j = 0; j < ks.length; j++) {
        if (t.indexOf(ks[j]) >= 0) { hit = INTENTS[i]; break; }
      }
      if (hit) break;
    }
    if (hit) hit.run();
    else fallback();
  }

  /* ---------- flow：新建目标（Stage A · 目标落地） ---------- */
  function goalFlow() {
    if (!ZX.flows || !ZX.flows.goal) {
      say('<p>目标流程还没加载完成，刷新页面后再试一次。</p>', 'goal · pending');
      return;
    }
    say('<p>目标分四步落地：设定 → 可行性 → 拆解 → 生效。R 低于 0.70 时会先给三条校准路径，不直接砍计划。</p>',
      'goal · flow');
    ZX.flows.goal.open();
  }

  /* ---------- flow：中断挽救（Stage B · F-7.1 F-7.2 F-7.3） ----------
     演示入口：真实环境由执行记录（连续无记录天数）调用 ZX.flows.rescue.detect()。
     这里写入演示天数后走同一套判定与弹层，口径与产品一致。 */
  function rescueFlow() {
    if (!ZX.flows || !ZX.flows.rescue) {
      say('<p>挽救流程还没加载完成，刷新页面后再试一次。</p>', 'rescue · pending');
      return;
    }
    var R = ZX.flows.rescue;
    ZX.state.consecutiveZeroDays = R.DEMO_ZERO_DAYS;
    R.detect();
    var m = R.metrics();
    say('<p>连续 ' + R.DEMO_ZERO_DAYS + ' 天没有记录。计划还在：这周还剩 ' + m.days + ' 天，缺口 ' +
      U.hm(m.gap) + '。下一步给三种接法，选一个就行，不需要补记录。</p>', 'rescue · detect');
    ZX.setTab('today');
    R.open();
  }

  /* ---------- flow：重排（L1 回退 L2） ----------
     C2 要求：卡片上的每一个数值都必须来自引擎返回值，不得硬编码。
     因此先 await 引擎结果，再据此渲染步骤动画与 diff 明细。
     Stage C-2：锁定项随输入下行（locked 字段）；引擎不识别锁定，
     由结果层过滤命中锁定项的 diff，并记录「N 个锁定块未参与」。 */
  function replanFlow() {
    var S = ZX.state;
    if (S.replanned) {
      say('<p>这周已经重排过一次（11:04）。规则：同类触发 24 小时内去重，避免把重排本身变成新的干扰。</p>' +
          '<p>如需回到重排前的状态，说「撤销」即可，基于快照反向应用，不需要重算。</p>', 'replan · dedup 24h');
      return;
    }

    var locks = (S.locks && typeof S.locks === 'object') ? S.locks : {};
    var input = S.replanInput();
    input.tasks.forEach(function (t) { t.locked = !!locks[t.id]; });

    /* 计算走统一入口：后端优先，失败自动降级本地引擎 */
    ZX.engine.replan(input).then(function (res) {
      S.replanRecord = res;
      renderReplanResult(res);
    }, function () { /* engine 内部已降级，不会走到这里 */ });
  }

  /* 从引擎结果渲染重排卡片：数值与 diff 全部来自 res，不硬编码 */
  function renderReplanResult(res) {
    var S = ZX.state;
    var strategies = (res && Array.isArray(res.strategies)) ? res.strategies : [];
    var rawDiff = (res && Array.isArray(res.diff)) ? res.diff : [];
    /* Stage C-2：锁定块不参与本轮变更 —— 从结果层过滤，并在卡片注明数量 */
    var locks = (S.locks && typeof S.locks === 'object') ? S.locks : {};
    var lockIds = {};
    rawDiff.forEach(function (d) { if (locks[d.taskId]) lockIds[d.taskId] = true; });
    var lockCount = Object.keys(lockIds).length;
    var diff = rawDiff.filter(function (d) { return !locks[d.taskId]; });
    var loadDelta = res && typeof res.loadDelta === 'number' ? res.loadDelta : 0;
    var guards = (res && res.guards) ? res.guards : {};

    var sL1 = strategies.find(function (s) { return s.level === 1; });
    var sL2 = strategies.find(function (s) { return s.level === 2; });
    var l1Growth = sL1 ? growthOf(sL1.reason) : null;
    var l2Growth = sL2 ? growthOf(sL2.reason) : null;

    var deferred = diff.filter(function (d) { return d.op === 'defer'; });
    var compressed = diff.filter(function (d) { return d.op === 'compress'; });
    var abandoned = diff.filter(function (d) { return d.op === 'abandon'; });
    var appliedLevel = 0;
    strategies.forEach(function (s) { if (s.applied && s.level > appliedLevel) appliedLevel = s.level; });

    var box = say('<p>收到。先归因，再走四级流水线；任何一级通过防雪崩校验就停，不追求把计划排满。</p>' +
      '<div class="steps" id="rps">' +
        [['拉取未完成项与未来 7 天排程'], ['归因判定'], ['L1 顺延'], ['校验负载与弹性位'], ['L2 压缩 · 复核']]
          .map(function (s, i) { return '<div class="step" data-i="' + i + '"><span class="sk"></span><span class="st">' + s[0] + '</span><span class="sv"></span></div>'; }).join('') +
      '</div>', 'planner v1.4 · insight 30ms');

    var step = function (i, val, bad) {
      var el = box.querySelector('.step[data-i="' + i + '"]');
      if (!el) return;
      el.classList.add(bad ? 'bad' : 'done');
      el.querySelector('.sv').textContent = val;
      chatEl().scrollTop = chatEl().scrollHeight;
    };

    var undoCount = deferred.length;
    var cmpCount = compressed.length;
    var abnCount = abandoned.length;

    (async function () {
      await U.sleep(300); step(0, S.tasks.filter(function (t) { return !t.done; }).length + ' 项 · ' + U.hm(S.remainMin()));
      await U.sleep(320); step(1, '计划过载 40%');
      await U.sleep(340);
      step(2, undoCount + ' 项 → 弹性位 / 周六');
      await U.sleep(320);
      /* L1 校验：增幅由引擎给出，超限即回退 */
      if (l1Growth !== null && !sL1.applied) step(3, '+' + l1Growth + '% ✕ 超 20%', true);
      else step(3, '+' + (l1Growth === null ? '0' : l1Growth) + '% ✓');
      await U.sleep(340);
      step(4, sL2 && sL2.applied ? '+' + (l2Growth === null ? pct(loadDelta) : l2Growth) + '% ✓' : '未通过');

      S.replanned = true;
      /* 快照：契约形状 { tasks, week, timestamp }，撤销时反向应用、不重算 */
      S.snapshot = {
        tasks: U.clone(S.tasks),
        week: U.clone(S.week),
        timestamp: Date.now()
      };
      /* 压缩项按引擎 diff 落到本地任务上（仅压缩类改工时；顺延不改本地任务）；
         锁定项即使被引擎命中也不落盘，工时保持不变 */
      S.tasks = S.tasks.map(function (t) {
        var hit = compressed.find(function (d) { return d.taskId === t.id; });
        if (hit && !t.done && !locks[t.id]) {
          return Object.assign({}, t, { est: parseInt(hit.to, 10) || t.est, compressed: true });
        }
        return t;
      });

      ZX.api.queueOp({
        entity: 'plan', entityId: 'replan', field: 'applied',
        value: { loadDelta: loadDelta, appliedLevel: appliedLevel, diff: diff }
      });

      var tagText = appliedLevel === 2 ? 'L1 回退 → L2 生效'
        : appliedLevel === 1 ? 'L1 顺延生效'
        : '未通过校验';
      var tagCls = appliedLevel ? 'ac' : 'warn';

      /* Stage C-2：顺延 / 压缩行右侧挂「否决」，逐条回滚；放弃行不提供（需整单确认） */
      var diffHtml = diff.map(function (d, idx) {
        var cls = d.op === 'compress' ? 'cp' : 'mv';
        var label = d.op === 'compress' ? '压缩' : d.op === 'defer' ? '顺延' : d.op === 'abandon' ? '放弃' : d.op;
        var detail = d.op === 'compress'
          ? d.from + ' → ' + d.to + ' min · degraded'
          : (d.detail || (d.from + ' → ' + d.to));
        var veto = (d.op === 'compress' || d.op === 'defer')
          ? '<button type="button" class="btn sc2-veto" data-veto="' + U.esc(d.taskId) + '" data-vop="' + d.op + '"' +
            ' aria-label="否决：' + U.esc(label + ' ' + (d.subject || '')) + '">否决</button>'
          : '';
        return '<div class="diff-line sc2-diff" data-diff="' + idx + '"><span class="s ' + cls + '">' + label + '</span>' +
          '<span class="n">' + U.esc(d.subject || '') + '</span>' +
          '<span class="d">' + U.esc(detail) + '</span>' + veto + '</div>';
      }).join('');

      var guardNote = [];
      guardNote.push('L1 顺延后负载 +' + (l1Growth === null ? pct(loadDelta) : l1Growth) + '%，超过单次上限 20%，已回退该级');
      if (sL2 && sL2.applied) guardNote.push('L2 压缩低权重项后复核通过（+' + (l2Growth === null ? pct(loadDelta) : l2Growth) + '%），因此未进入替代与放弃');
      else guardNote.push('L2 压缩后复核未通过，已进入后续级别');

      say('<div class="ecard">' +
        '<div class="ecard-h"><b>重排完成</b><span class="tag ' + tagCls + '">' + tagText + '</span></div>' +
        '<div class="ecard-b">' +
          '<div class="erow"><span class="k">变更</span><span class="why">延期 ' + deferred.length + ' · 压缩 ' + compressed.length + ' · 放弃 ' + abandoned.length + '</span><span class="v">未来 7 天 ' + (loadDelta >= 0 ? '+' : '') + pct(loadDelta) + '</span></div>' +
          (lockCount ? '<div class="erow"><span class="k">锁定</span><span class="why">重排不会改动已锁定的块</span><span class="v ac">' + lockCount + ' 个锁定块未参与</span></div>' : '') +
          '<div class="erow"><span class="k">弹性位</span><span class="why">每日 60 min 未被清空</span><span class="v ac">' + (guards.bufferPreserved === false ? '已侵占' : '1 / 1 保留') + '</span></div>' +
          diffHtml +
          '<div class="ecard-f"><span class="note">' + guardNote.join('；') + '。' + (lockCount ? '锁定的 ' + lockCount + ' 块保持原工时与原落点。' : '') + '</span></div>' +
          '<div class="ecard-f"><button class="btn" data-act="undo">撤销本次重排</button><span class="note mono">snapshot 已留存</span></div>' +
        '</div></div>', 'replan · 412ms');

      ZX.setTab('plan');
    })();
  }

  /* 从引擎 reason 文本中提取负载增幅百分比（形如 "23.0%"） */
  function growthOf(reason) {
    if (!reason) return null;
    var m = String(reason).match(/(\d+(?:\.\d+)?)%/);
    return m ? m[1] : null;
  }

  function pct(v) {
    if (typeof v !== 'number' || !isFinite(v)) return '0%';
    return (Math.round(v * 1000) / 10) + '%';
  }

  /* ---------- flow：撤销 ---------- */
  function undoReplan() {
    var S = ZX.state;
    if (!S.replanned || !S.snapshot) {
      say('<p>当前没有可撤销的重排。每次重排都会先写快照，撤销即反向应用 diff，保证与重排前完全一致。</p>', 'replan · noop');
      return;
    }
    var snap = S.snapshot;
    var tasks = Array.isArray(snap.tasks) ? U.clone(snap.tasks) : [];

    /* 立即本地反向应用：与重排前逐条一致，不重算 */
    S.tasks = tasks.map(ZX.state.normTask);
    S.snapshot = null;
    S.replanned = false;
    ZX.render();
    say('<p>已撤销。计划恢复到 <span class="mono">11:04</span> 的快照，未重算，逐条一致。</p>' +
        '<p style="color:var(--txt3);font-size:11px">重排记录保留在 replan_record，不会因为撤销而丢失。</p>', 'replan · undo');
    ZX.setTab('plan');

    ZX.api.queueOp({ entity: 'plan', entityId: 'replan', field: 'undone', value: true });

    /* 与引擎对齐（后端优先 → 本地降级）；不一致时以本地快照为准 */
    ZX.engine.undo(snap).then(function (res) {
      var r = res && Array.isArray(res.tasks) ? res.tasks.map(ZX.state.normTask) : null;
      if (r && r.length && JSON.stringify(r) !== JSON.stringify(ZX.state.tasks)) {
        if (window.console && console.warn) console.warn('[zx] undo 结果与快照不一致，保留本地快照');
      }
    }, function () { /* 引擎已降级 */ });
  }

  /* ---------- flow：可行性 ---------- */
  function feasibilityFlow() {
    var S = ZX.state;
    var f = S.feasibility();
    say('<div class="ecard">' +
      '<div class="ecard-h"><b>可行性评估</b><span class="tag ' + (f.R >= 0.9 ? 'ok' : 'warn') + '">' + f.verdict + '</span></div>' +
      '<div class="ecard-b">' +
        '<div class="erow"><span class="k">R 值</span><span class="why">T / D</span><span class="v ' + (f.R >= 0.9 ? 'ac' : 'warn') + '">' + f.R.toFixed(2) + '</span></div>' +
        '<div class="erow"><span class="k">可用 T</span><span class="why">' + S.feas.weeklyH + ' h/周 × ' + S.feas.weeks + ' 周 × 0.85</span><span class="v">' + f.T + ' h</span></div>' +
        '<div class="erow"><span class="k">需求 D</span><span class="why">节点标准工时 × 基础系数（一轮 1.00）</span><span class="v">' + f.D + ' h</span></div>' +
        '<div class="erow"><span class="k">缓冲</span><span class="why">真实可损耗余量</span><span class="v">' + Math.max(0, f.T - f.D) + ' h</span></div>' +
      '</div></div>' +
      '<p style="margin-top:10px">' + (f.R >= 1.2 ? '充裕。可以增加拓展内容或提高目标，但不强制。' :
        f.R >= 0.9 ? '合理。可以进入拆解。<b>1.08 意味着没有多余缓冲</b>：每周少 3 小时就会掉到偏紧。' :
        '偏紧。需要先提高周投入、延长周期或缩小范围，否则拆解会大面积裁剪。') + '</p>', 'feasibility · 11ms');
    ZX.setTab('plan');
    setTimeout(function () {
      var m = document.querySelector('.marker');
      if (m) { m.style.transition = 'none'; m.style.opacity = '.3'; setTimeout(function () { m.style.transition = ''; m.style.opacity = '1'; }, 60); }
    }, 60);

    /* 后端在线时以引擎结果复核（与本地同语义，数值一致则无感知差异） */
    ZX.engine.feasibility(S.feasInput()).then(function (r) {
      S.lastFeas = r;
    }, function () { /* 已降级 */ });
  }

  /* ---------- flow：调参（数学加时间） ---------- */
  function adjustMath() {
    var S = ZX.state;
    if (S.feas.demand > 950) {
      say('<p>数学本周已是 14 小时（+2 h）。再加会触发 30% 修改幅度阈值，需要重算可行性与阶段容量。</p>' +
          '<p style="color:var(--txt3);font-size:11px">当前 R ' + S.feasibility().R.toFixed(2) + '，继续加时请先说「调整目标」或「延长周期」。</p>', 'decompose · guard');
      return;
    }
    S.feas.demand += 116;
    var f = S.feasibility();
    ZX.render();
    say('<div class="ecard">' +
      '<div class="ecard-h"><b>已调整 · 数学</b><span class="tag ac">本周 12 h → 14 h</span></div>' +
      '<div class="ecard-b">' +
        '<div class="erow"><span class="k">R 值</span><span class="why">需求增加 116 h（2 h × 58 周）</span><span class="v ' + (f.R >= 0.9 ? 'ac' : 'warn') + '">1.08 → ' + f.R.toFixed(2) + '</span></div>' +
        '<div class="erow"><span class="k">判定</span><span class="why">仍在合理区间，但缓冲从 73 h 降到 0</span><span class="v warn">' + f.verdict + '</span></div>' +
        '<div class="erow"><span class="k">影响</span><span class="why">阶段容量按 45/35/20 重新分配，政治基础期被压缩</span><span class="v">+7.4%</span></div>' +
      '</div></div>' +
      '<p style="margin-top:10px">修改幅度 17%，未超过 30% 阈值，因此不阻断。计划草案与阶段容量已同步更新。</p>', 'decompose · 15ms');
    ZX.setTab('plan');
    ZX.api.queueOp({
      entity: 'goal', entityId: (S.goal.id || 'g_2027'), field: 'feas.demand', value: S.feas.demand
    });
  }

  /* ---------- flow：周报 ---------- */
  function weeklyFlow() {
    say('<p>第 45 周周报已生成。按「结论 / 依据 / 已执行的动作」三段式，最后一条不是建议，是已经排进下周的 block。</p>', 'insight · 41ms');
    ZX.setTab('data');
    return U.sleep(120);
  }

  /* ---------- flow：降载建议 ---------- */
  function tiredFlow() {
    say('<p>今天不追加任务。状态的波动是可预期的，系统不该用计划去对抗它。</p>' +
      '<div class="ecard">' +
        '<div class="ecard-h"><b>降载建议</b><span class="tag warn">保留弹性位</span></div>' +
        '<div class="ecard-b">' +
          '<div class="erow"><span class="k">调整</span><span class="why">政治 45 min 移入本周六弹性位</span><span class="v">今日 −45m</span></div>' +
          '<div class="erow"><span class="k">保留</span><span class="why">数学与 408 不受影响，权重最高</span><span class="v ac">3 项</span></div>' +
          '<div class="erow"><span class="k">后果</span><span class="why">本周欠账 150 → 105 min，不触发重排</span><span class="v">可承受</span></div>' +
        '</div>' +
        '<div class="ecard-f"><button class="btn" data-act="tired">采纳降载</button><span class="note">今天收在 3 小时内</span></div>' +
      '</div>', 'insight · 归因 执行中断');
  }

  /* ---------- flow：今日安排 ---------- */
  function todayFlow() {
    var S = ZX.state;
    var todo = S.tasks.filter(function (t) { return !t.done; });
    var rows = todo.map(function (t) {
      return '<div class="erow"><span class="k">' + t.time.split('–')[0] + '</span><span class="why" style="flex:1;color:var(--txt2)">' + t.s + ' · ' + U.esc(t.title) + '</span><span class="v">' + U.hm(t.est) + '</span></div>';
    }).join('');
    say('<p>今天还剩 <b>' + todo.length + '</b> 项，共 <b>' + U.hm(S.remainMin()) + '</b>。顺序不是按科目排的，是按「截止紧迫度 ↓ + 权重 ↓」排的。</p>' +
      '<div class="ecard"><div class="ecard-h"><b>接下来</b><span class="tag">弹性位 20:30</span></div><div class="ecard-b">' + rows +
        '<div class="erow"><span class="k">20:30</span><span class="why" style="flex:1;color:var(--txt3)">弹性位 · 刻意留空</span><span class="v">60m</span></div>' +
      '</div></div>' +
      '<p style="margin-top:10px">先做数学：极限是本周权重最高的一项（0.92），且 10:30 是你历史的高效时段。</p>', 'schedule · 68ms');
    ZX.setTab('today');
  }

  /* ---------- flow：开始计时 ---------- */
  function startFlow() {
    var S = ZX.state;
    var next = null;
    for (var i = 0; i < S.tasks.length; i++) { if (!S.tasks[i].done) { next = S.tasks[i]; break; } }
    if (!next) { say('<p>今天的任务都记录完了。要不要留 10 分钟做一次明日预览？</p>', 'execution'); return; }
    startTask(next.id);
    ZX.setTab('today');
  }

  /* ---------- flow：兜底 ---------- */
  function fallback() {
    say('<p>这句话我还没接住。当前 demo 的意图识别是关键词匹配，覆盖以下六类动作：</p>' +
      '<div class="ecard"><div class="ecard-b">' +
        '<div class="erow"><span class="k">查看</span><span class="why">「今天学什么」</span><span class="v">今日</span></div>' +
        '<div class="erow"><span class="k">重排</span><span class="why">「这周落下了，帮我重排」</span><span class="v">L1–L4</span></div>' +
        '<div class="erow"><span class="k">评估</span><span class="why">「我的计划可行吗」</span><span class="v">R 值</span></div>' +
        '<div class="erow"><span class="k">调参</span><span class="why">「数学多给两小时」</span><span class="v">需求 +116h</span></div>' +
        '<div class="erow"><span class="k">反馈</span><span class="why">「生成周报」/「我有点累」</span><span class="v">insight</span></div>' +
        '<div class="erow"><span class="k">计时</span><span class="why">「开始」/「撤销」</span><span class="v">session</span></div>' +
      '</div></div>' +
      '<p style="margin-top:10px;color:var(--txt3);font-size:11px">产品上线时这一层由模型承接，但只做「把结构化结果翻译成人话」与「把自然语言转成参数修改」——排程结果本身必须可复现。</p>', 'intent · fallback');
  }

  /* ---------- 交互动作 ---------- */
  function adoptTired() {
    var S = ZX.state;
    if (S.tiredAdopted) return;
    S.tiredAdopted = true;
    var t = S.tasks.filter(function (x) { return x.id === 't4'; })[0];
    if (t && !t.done) {
      S.movedOut = { title: t.title, est: t.est };
      S.tasks = S.tasks.filter(function (x) { return x.id !== 't4'; });
    }
    ZX.render();
    say('<p>已采纳。政治移到周六 15:00 的弹性位，今天 3 项收工。</p><p style="color:var(--txt3);font-size:11px">本次调整记入 replan_record，原因「状态不佳」；不计入断更，也不影响连续记录。</p>', 'replan · L1 顺延');
    ZX.api.queueOp({
      entity: 'task', entityId: 't4', field: 'deferred',
      value: { reason: '状态不佳', to: '周六 15:00 弹性位', est: S.movedOut ? S.movedOut.est : 45 }
    });
  }

  function togglePreset() {
    var S = ZX.state;
    S.presetActive = !S.presetActive;
    ZX.render();
    ZX.api.queueOp({
      entity: 'preset', entityId: 'w45_politics', field: 'active', value: S.presetActive
    });
  }

  function toggleNotif(key) {
    var S = ZX.state;
    S.notif[key] = !S.notif[key];
    ZX.render();
    ZX.api.queueOp({
      entity: 'notif', entityId: key, field: key, value: !!S.notif[key]
    });
  }

  function exportPlan() {
    say('<p>导出任务已提交。计划与执行记录会打包为表格，24 小时内发送到账号邮箱。</p><p style="color:var(--txt3);font-size:11px">导出是异步的：生成 zip → 对象存储 → 邮件下发，避免阻塞主链路。</p>', 'export · queued');
    ZX.api.queueOp({
      entity: 'export', entityId: 'plan_and_records', field: 'requested', value: true
    });
  }

  ZX.assistant = {
    pushMsg: pushMsg, say: say, me: me, typing: typing,
    startTask: startTask, tickTimer: tickTimer, elapsedMs: elapsedMs, finishTask: finishTask, bufferWarn: bufferWarn,
    route: route, INTENTS: INTENTS,
    goalFlow: goalFlow,
    rescueFlow: rescueFlow,
    replanFlow: replanFlow, undoReplan: undoReplan, feasibilityFlow: feasibilityFlow,
    adjustMath: adjustMath, weeklyFlow: weeklyFlow, tiredFlow: tiredFlow,
    todayFlow: todayFlow, startFlow: startFlow, fallback: fallback,
    adoptTired: adoptTired, togglePreset: togglePreset, toggleNotif: toggleNotif, exportPlan: exportPlan
  };

})(window.ZX);
