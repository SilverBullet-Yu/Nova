/* =========================================================
   诺瓦 Nova · 对话意图路由 + 各类 flow
   涉及计算的调用统一走 ZX.engine（后端优先 → 本地引擎产物，无内置副本）
   重排域（预览 / 确认 / 撤销）在 flows/replan.js，本文件只做路由转发
   ========================================================= */
window.ZX = window.ZX || {};

(function (ZX) {
  'use strict';

  var U = ZX.util;
  var tiredPreview = null;

  function chatEl() { return U.$('#chat'); }

  /* ---------- 消息 ---------- */
  /* 助理消息右下角盖「诺」印落款：与 mascot 胸口印同源的身份锚点（IP-DESIGN §4） */
  function pushMsg(who, html, eng) {
    var el = document.createElement('div');
    el.className = 'msg ' + who;
    var label = who === 'a' ? '诺瓦' : '你';
    var seal = who === 'a' ? '<span class="seal-no" aria-hidden="true">诺</span>' : '';
    el.innerHTML =
      '<div class="meta"><b>' + label + '</b><span class="t">' + U.nowStr() + '</span>' +
      (eng ? '<span class="eng">' + U.esc(eng) + '</span>' : '') + '</div>' +
      '<div class="txt">' + html + seal + '</div>';
    var box = chatEl();
    /* 对话日志上限：超出后丢弃最早节点，避免长会话 DOM 无限增长 */
    while (box.children.length >= 120) box.removeChild(box.firstChild);
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
    return el;
  }

  function say(html, eng) { return pushMsg('a', html, eng); }
  function me(t) { return pushMsg('u', '<p>' + U.esc(t) + '</p>'); }

  function typing() {
    var el = document.createElement('div');
    el.className = 'msg a typing';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<div class="meta"><b>诺瓦</b><span class="t">' + U.nowStr() + '</span>' +
      '<span class="eng">处理中</span></div>' +
      '<div class="txt"><img class="msg-state state-calc" src="assets/img/mascot-v4-calc.svg" width="24" height="21" alt="" />' +
      '<span class="typing-dots" role="status" aria-label="正在输入"><i></i><i></i><i></i></span></div>';
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
    /* 旧卡片不能复活退役或今日暂缓任务，也不能覆盖其他任务的计时。 */
    if (!t || t.done || t.deferred || t.abandoned || t.substituted) return;
    if (S.running) {
      ZX.ui.toast('已有任务正在计时，请先结束并记录，再开始其他任务', 'warn');
      return;
    }
    var restored = !!t.skipped;
    if (!restored && S.placementModel && (!S.taskSegments || !S.taskSegments(id, U.todayKey()).length)) {
      ZX.ui.toast('该任务不在今日计划中，不能开始计时', 'warn');
      return;
    }
    if (restored && S.placementModel) {
      var P = window.Rhythm && window.Rhythm.placementModel;
      var placement = P.restoreTask(S.placementModel, id, 'pm_start_' + Date.now().toString(36) + '_', t.est);
      if (!placement.ok) {
        ZX.ui.toast(placement.reason, 'warn');
        return;
      }
      S.placementModel = placement.model;
      S.syncPlacementProjection();
    }
    if (restored) { t.skipped = false; t.skipReason = null; t.skippedAt = null; }
    S.running = id;
    S.timerStart = Date.now();
    S.pausedAt = null;
    S.pausedTotal = 0;
    ZX.render();
    if (!t) return;
    say('<p>计时已开始：<b>' + U.esc(t.title) + '</b>。目标 ' + U.hm(t.est) + '，结束时会记录实际时长与完成度。' +
        (restored ? '　该项此前在「已跳过」里，已恢复。' : '') + '</p>' +
        '<p style="color:var(--txt3);font-size:11px">演示环境可直接点「按预估记录」完成，不必真等 ' + U.hm(t.est) + '；中途离开可以暂停，暂停不计入时长。</p>', '计时 · 进行中');
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
    if (!t || t.done || t.skipped || t.deferred || t.abandoned || t.substituted) return;
    var exec = ZX.flows.exec;

    /* 结束（有计时）→ 记录弹层：完成度 / 状态；按预估记录 → 直接 100% */
    if (!useEst && S.running === id) {
      exec.openRecord(id);
      return;
    }

    /* 计时结束路径已在上方进入 openRecord 弹层；此处只处理按预估直接记录。 */
    exec.commitRecord(id, t.est, 100, '', Date.now() - t.est * 60000, Date.now());
  }

  /* ---------- 弹性位占用 / 释放（真交互） ----------
     占用需二次确认（反焦虑：提示代价，不诱导）；释放即时生效。 */
  function toggleBuffer() {
    var S = ZX.state;
    if (S.placementModel) {
      ZX.ui.toast('弹性位用量由实际任务落点自动记账，请拖动任务或使用重排', 'warn');
      return;
    }
    var t = (S.buffer && S.buffer.time) || '';
    if (S.buffer.free) {
      ZX.ui.confirm({
        eyebrow: '排程 / 弹性位',
        title: '占用弹性位？',
        text: '弹性位是本周的抗中断余量。占用后 再遇到突发，就只剩压缩或顺延两条路。',
        okText: '占用'
      }).then(function (ok) {
        if (!ok) return;
        S.buffer.free = false;
        ZX.render();
        ZX.ui.toast('弹性位已占用', 'warn');
        say('<p>弹性位（' + U.esc(t) + '）已标记为<b>占用</b>。本周的抗中断余量用掉了，之后的突发要走重排。</p>' +
            '<p style="color:var(--txt3);font-size:11px">随时可以在同一位置释放，不影响任何任务。</p>', '排程 · 弹性位');
        ZX.api.queueOp({ entity: 'buffer', entityId: 'today', field: 'occupied', value: true });
      });
    } else {
      S.buffer.free = true;
      ZX.render();
      ZX.ui.toast('弹性位已释放', 'ok');
      say('<p>弹性位（' + U.esc(t) + '）已释放，重新留空。自动排程不会占满它。</p>', '排程 · 弹性位');
      ZX.api.queueOp({ entity: 'buffer', entityId: 'today', field: 'occupied', value: false });
    }
  }

  /* ---------- 意图路由 ----------
     重排三态（预览 / 确认 / 撤销）在 flows/replan.js，路由经运行时查找解耦 */
  var INTENTS = [
    { k: ['确认重排', '确认放弃'], run: function () { if (ZX.flows.replan) ZX.flows.replan.confirmReplan(); } },
    { k: ['演示挽救', '挽救演示'], run: demoRescueFlow },
    { k: ['我断了四天', '断了', '中断', '挽救', '没打开'], run: rescueFlow },
    { k: ['新建目标', '定目标', '改目标'], run: goalFlow },
    { k: ['撤销', '恢复', '撤回'], run: function () { if (ZX.flows.replan) ZX.flows.replan.undoReplan(); } },
    { k: ['多给', '加时间', '延长一点'], run: adjustMath },
    { k: ['重排', '落下', '落后', '来不及', '崩'], run: function () { if (ZX.flows.replan) ZX.flows.replan.replanFlow(); } },
    { k: ['周报', '复盘', '这周怎么样'], run: weeklyFlow },
    { k: ['累', '状态不好', '没精神', '压力', '疲惫'], run: tiredFlow },
    { k: ['可行', 'r值', '来得及吗', '合理吗', '评估'], run: feasibilityFlow },
    { k: ['开始', '计时', '专注'], run: startFlow },
    { k: ['今天', '学什么', '安排', '干嘛', '任务'], run: todayFlow }
  ];

  function route(text) {
    /* 对话式澄清激活时接管一切输入（退出词/画像追问），关键词路由在其后 */
    if (ZX.flows && ZX.flows.clarify && ZX.flows.clarify.active() &&
        typeof ZX.flows.clarify.hook === 'function' && ZX.flows.clarify.hook(text)) return;
    var t = text.toLowerCase().replace(/\s/g, '');
    var hit = null;
    for (var i = 0; i < INTENTS.length; i++) {
      var ks = INTENTS[i].k;
      for (var j = 0; j < ks.length; j++) {
        if (t.indexOf(ks[j]) >= 0) { hit = INTENTS[i]; break; }
      }
      if (hit) break;
    }
    if (hit) hit.run(text);
    else fallback();
  }

  /* ---------- flow：新建目标（Stage A · 目标落地） ----------
     优先走对话式澄清（LLM 驱动，clarify.js 内部自带降级链：
     未配置 / 离线 / 失败时自动回落四步表单），clarify 未装配时直接开表单 */
  function goalFlow(trigger) {
    if (!ZX.flows || !ZX.flows.goal) {
      say('<p>目标流程还没加载完成，刷新页面后再试一次。</p>', '目标 · 待加载');
      return;
    }
    if (ZX.flows.clarify && typeof ZX.flows.clarify.start === 'function') {
      ZX.flows.clarify.start(trigger);
      return;
    }
    say('<p>目标分四步落地：设定 → 可行性 → 拆解 → 生效。R 低于 0.70 时会先给三条校准路径，不直接砍计划。</p>',
      '目标 · 流程');
    ZX.flows.goal.open();
  }

  /* ---------- flow：中断挽救（Stage B · F-7.1 F-7.2 F-7.3） ----------
     真实对话只按 sessions 判定；演示天数走独立入口，不注入真实状态。 */
  function rescueFlow() {
    if (!ZX.flows || !ZX.flows.rescue) {
      say('<p>挽救流程还没加载完成，刷新页面后再试一次。</p>', '挽救 · 待加载');
      return;
    }
    var R = ZX.flows.rescue;
    var interrupted = R.detect();
    if (!interrupted) {
      say('<p>尚未达到连续 ' + R.THRESHOLD + ' 天：目前连续 ' +
        U.num(ZX.state.consecutiveZeroDays, 0) + ' 天没有记录。暂不打开挽救，也不会改变当前计划。</p>', '挽救 · 未达标');
      return;
    }
    var m = R.metrics();
    say('<p>连续 ' + U.num(ZX.state.consecutiveZeroDays, 0) + ' 天没有记录。计划还在：这周还剩 ' + m.days + ' 天，缺口 ' +
      U.hm(m.gap) + '。下一步给三种接法，选一个就行，不需要补记录。</p>', '挽救 · 判定');
    ZX.setTab('today');
    R.open();
  }

  /* ---------- flow：独立中断挽救演示 ----------
     只读取当前计划，用局部演示天数生成预览；不 detect / open / apply / render。 */
  function demoRescueFlow() {
    if (!ZX.flows || !ZX.flows.rescue) {
      say('<p>挽救演示还没加载完成，刷新页面后再试一次。</p>', '挽救演示 · 待加载');
      return null;
    }
    var R = ZX.flows.rescue;
    var preview = R.preview(R.DEMO_ZERO_DAYS);
    var m = preview.metrics;
    var options = preview.options.map(function (o) {
      var effect = o.key === 'defer'
        ? '截止 ' + U.esc(o.deadlineAfter) + ' · 周期 ' + o.weeksAfter + ' 周'
        : '本周计划 ' + U.hm(o.planMin) + ' · 放弃 ' + o.dropped.length + ' 项';
      return '<div class="erow"><span class="k">' + U.esc(o.label) + '</span>' +
        '<span class="why">' + effect + '</span><span class="v">缺口 ' + U.hm(o.gap) + '</span></div>';
    }).join('');
    say('<div class="ecard" style="border:2px solid var(--warn,#b7791f)">' +
      '<div class="ecard-h"><b>中断挽救演示</b><span class="tag warn">演示数据 · 不会修改真实计划</span></div>' +
      '<div class="ecard-b">' +
        '<div class="notice sb-note" style="border:2px solid var(--warn,#b7791f)"><b>演示数据 · 不会修改真实计划</b><br>' +
          '连续 ' + preview.zeroDays + ' 天没有记录，演示剩余 ' + m.days + ' 天。仅使用局部演示天数与当前计划的只读快照。</div>' +
        '<div class="erow"><span class="k">演示缺口</span><span class="why">计划 ' + U.hm(m.planned) +
          ' − 已投入 ' + U.hm(m.worked) + ' − 剩余可用 ' + U.hm(Math.round(m.avail)) + '</span>' +
          '<span class="v warn">' + U.hm(m.gap) + '</span></div>' + options +
      '</div><div class="ecard-f"><span class="note">仅供预览，不会打开真实挽救，也不会提交任何方案。</span></div></div>',
      '挽救演示 · 只读预览');
    return preview;
  }

  /* ---------- flow：可行性 ---------- */
  function feasibilityFlow() {
    var S = ZX.state;
    var f = S.feasibility();
    if (!f) {
      say('<p>还没有阶段目标，先新建目标，再评估可行性。</p>', '可行性 · 未设定');
      ZX.setTab('plan');
      return;
    }
    say('<div class="ecard">' +
      '<div class="ecard-h"><b>可行性评估</b><span class="tag ' + (f.R >= 0.9 ? 'ok' : 'warn') + '">' + U.esc(f.verdict) + '</span></div>' +
      '<div class="ecard-b">' +
        '<div class="erow"><span class="k">R 值</span><span class="why">T / D</span><span class="v ' + (f.R >= 0.9 ? 'ac' : 'warn') + '">' + f.R.toFixed(2) + '</span></div>' +
        '<div class="erow"><span class="k">可用 T</span><span class="why">' + S.feas.weeklyH + ' h/周 × ' + S.feas.weeks + ' 周 × 0.85</span><span class="v">' + f.T + ' h</span></div>' +
        '<div class="erow"><span class="k">需求 D</span><span class="why">节点标准工时 × 基础系数（一轮 1.00）</span><span class="v">' + f.D + ' h</span></div>' +
        '<div class="erow"><span class="k">缓冲</span><span class="why">真实可损耗余量</span><span class="v">' + Math.max(0, f.T - f.D) + ' h</span></div>' +
      '</div></div>' +
      '<p style="margin-top:10px">' + (f.R >= 1.2 ? '充裕。可以增加拓展内容或提高目标，但不强制。' :
        f.R >= 0.9 ? '合理。可以进入拆解。<b>' + f.R.toFixed(2) + ' 意味着没有多余缓冲</b>：每周少 3 小时就会掉到偏紧。' :
        '偏紧。需要先提高周投入、延长周期或缩小范围，否则拆解会大面积裁剪。') + '</p>', '可行性 · 11ms');
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

  /* ---------- flow：调参（数学加时间） ----------
     卡片数值全部由前后两次可行性真算得出，不写死演示数字。 */
  function adjustMath() {
    var S = ZX.state;
    var ADD_H = 116;                       /* 单次加的需求工时（演示口径：约 +2 h/周 × 58 周） */
    var AMP_CAP = 0.30;                    /* 与拆解草案同一修改幅度阈值 */
    var before = U.num(S.feas.demand, 0);
    var beforeFeas = S.feasibility();
    if (!beforeFeas) {
      say('<p>还没有阶段目标，先设定目标后再调整科目投入。</p>', '拆解 · 未设定');
      ZX.setTab('plan');
      return;
    }
    var amp = before > 0 ? ADD_H / before : 0;
    if (before <= 0 || amp > AMP_CAP) {
      say('<p>当前需求 <b>' + Math.round(before) + ' h</b>，再加 ' + ADD_H + ' h 的修改幅度 ' +
          U.pct(amp) + ' 已超过 30% 阈值，需要重算可行性与阶段容量。</p>' +
          '<p style="color:var(--txt3);font-size:11px">当前 R ' + beforeFeas.R.toFixed(2) + '，继续加时请先说「调整目标」或「延长周期」。</p>', '拆解 · 阈值守护');
      return;
    }
    S.feas.demand = before + ADD_H;
    var f = S.feasibility();
    ZX.render();
    var buf0 = Math.max(0, beforeFeas.T - beforeFeas.D);
    var buf1 = Math.max(0, f.T - f.D);
    say('<div class="ecard">' +
      '<div class="ecard-h"><b>已调整 · 数学</b><span class="tag ac">需求 +' + ADD_H + ' h（≈ +' + (Math.round(ADD_H / Math.max(1, S.feas.weeks) * 10) / 10) + ' h/周）</span></div>' +
      '<div class="ecard-b">' +
        '<div class="erow"><span class="k">R 值</span><span class="why">需求 ' + Math.round(before) + ' → ' + Math.round(S.feas.demand) + ' h</span><span class="v ' + (f.R >= 0.9 ? 'ac' : 'warn') + '">' + beforeFeas.R.toFixed(2) + ' → ' + f.R.toFixed(2) + '</span></div>' +
        '<div class="erow"><span class="k">缓冲</span><span class="why">真实可损耗余量随之收窄</span><span class="v ' + (buf1 > 0 ? 'ac' : 'warn') + '">' + buf0 + ' → ' + buf1 + ' h</span></div>' +
        '<div class="erow"><span class="k">判定</span><span class="why">修改幅度 ' + U.pct(amp) + '，未超过 30% 阈值</span><span class="v ' + (f.R >= 0.9 ? 'ac' : 'warn') + '">' + U.esc(f.verdict) + '</span></div>' +
      '</div></div>' +
      '<p style="margin-top:10px">可行性已按新需求重算' + (buf1 > 0 ? '，仍有缓冲，不阻断。' : '，缓冲归零：再加就会大面积裁剪。') + '</p>', '拆解 · 15ms');
    ZX.setTab('plan');
    ZX.api.queueOp({
      entity: 'feas', entityId: 'current', field: 'demand', value: S.feas.demand
    });
  }

  /* ---------- flow：周报 ---------- */
  function weeklyFlow() {
    say('<p>第 ' + U.isoWeek() + ' 周周报已生成。周报展示执行统计、归因依据和演示预置；生成周报不会修改计划。</p>', '洞察 · 周报');
    ZX.setTab('data');
  }

  /* ---------- flow：降载建议 ----------
     顺延对象 = 当前权重最低的未完成项（与 adoptTired 同一选取逻辑），数值全部由 state 推导 */
  function lowestWeightTask() {
    var pick = null;
    ZX.state.tasks.forEach(function (x) {
      if (x.done || x.skipped || x.abandoned || x.substituted || (ZX.state.locks && ZX.state.locks[x.id]) || x.deferred || x.id === ZX.state.running) return;
      if (!pick || U.num(x.weight, 0) < U.num(pick.weight, 0)) pick = x;
    });
    return pick;
  }

  function tiredFlow() {
    var S = ZX.state;
    if (S.tiredAdopted) {
      say('<p>本次计划已采纳过一次降载。若今天仍吃紧，可到「计划」页用重排调整，不必反复顺延。</p>', '洞察 · 归因');
      return;
    }
    var pick = lowestWeightTask();
    tiredPreview = pick ? { taskId: pick.id, planVersion: S.currentPlanVersion ? S.currentPlanVersion() : null } : null;
    var est = pick ? U.num(pick.est, 0) : 0;
    /* 计划口径与今日页 KPI 同源（exec.metrics 过滤跳过项） */
    var before = ZX.flows.exec.metrics().planned;
    var after = before - est;
    var keepN = S.tasks.filter(function (x) { return !x.done && !x.skipped && !x.abandoned && !x.substituted && !x.deferred && (!pick || x.id !== pick.id); }).length;
    say('<p>今天不追加任务。状态的波动是可预期的，系统不该用计划去对抗它。</p>' +
      '<div class="ecard">' +
        '<div class="ecard-h"><b>降载建议</b><span class="tag warn">保留弹性位</span></div>' +
        '<div class="ecard-b">' +
          '<div class="erow"><span class="k">调整</span><span class="why">' + (pick ? U.esc(pick.s) + ' ' + U.hm(est) + ' 仅标记顺延（仅今日暂缓），不会修改计划日期' : '今天没有可暂缓的未完成项') + '</span><span class="v">' + (est ? '今日 −' + U.hm(est) : '—') + '</span></div>' +
          '<div class="erow"><span class="k">保留</span><span class="why">权重更高的项不受影响</span><span class="v ac">' + keepN + ' 项</span></div>' +
          '<div class="erow"><span class="k">后果</span><span class="why">今日计划 ' + U.hm(before) + ' → ' + U.hm(after) + '，不触发重排</span><span class="v">可承受</span></div>' +
        '</div>' +
        '<div class="ecard-f"><button class="btn" data-act="tired"' + (pick ? '' : ' disabled') + '>采纳降载</button><span class="note">不施压，只收窄今天</span></div>' +
      '</div>', '洞察 · 归因');
  }

  /* ---------- flow：今日安排 ---------- */
  function todayFlow() {
    var S = ZX.state;
    var todo = ZX.flows.exec.activeTasks().filter(function (t) { return !t.done; });
    /* 剩余量口径与今日页 KPI 同源（exec.metrics 过滤跳过项） */
    var mD = ZX.flows.exec.metrics();
    var rows = todo.map(function (t) {
      return '<div class="erow"><span class="k">' + U.esc(t.time.split('–')[0]) + '</span><span class="why" style="flex:1;color:var(--txt2)">' + U.esc(t.s) + ' · ' + U.esc(t.title) + '</span><span class="v">' + U.hm(t.est) + '</span></div>';
    }).join('');
    var bufTime = (S.buffer && S.buffer.time ? S.buffer.time : '20:30–21:30').split('–')[0];
    say('<p>今天还剩 <b>' + todo.length + '</b> 项，共 <b>' + U.hm(mD.remain) + '</b>。顺序不是按科目排的，是按「截止紧迫度 ↓ + 权重 ↓」排的。</p>' +
      '<div class="ecard"><div class="ecard-h"><b>接下来</b><span class="tag">弹性位 ' + U.esc(bufTime) + '</span></div><div class="ecard-b">' + rows +
        '<div class="erow"><span class="k">' + U.esc(bufTime) + '</span><span class="why" style="flex:1;color:var(--txt3)">弹性位 · 刻意留空</span><span class="v">60m</span></div>' +
      '</div></div>' +
      '<p style="margin-top:10px;color:var(--txt3)">以上顺序来自当前任务的截止时间与权重字段；未启用历史行为模型，不推断个人高效时段。</p>', '排程 · 确定性计算');
    ZX.setTab('today');
  }

  /* ---------- flow：开始计时 ---------- */
  function startFlow() {
    var S = ZX.state;
    var active = ZX.flows.exec.activeTasks().filter(function (t) { return !t.done && !t.skipped && !t.deferred && !t.abandoned && !t.substituted; });
    var next = active[0];
    if (!next) { say('<p>今天的任务都记录完了。要不要留 10 分钟做一次明日预览？</p>', '执行'); return; }
    startTask(next.id);
    ZX.setTab('today');
  }

  /* ---------- flow：兜底 ---------- */
  function fallback() {
    say('<img class="msg-state state-unknown" src="assets/img/mascot-v4-unknown.svg" width="32" height="28" alt="" />' +
      '<p>这句话我还没接住。可以直接说「新建目标」进入对话式澄清，或用这些快捷指令：</p>' +
      '<div class="ecard"><div class="ecard-b">' +
        '<div class="erow"><span class="k">定目标</span><span class="why">「新建目标」→ 对话式澄清（LLM）</span><span class="v">clarify</span></div>' +
        '<div class="erow"><span class="k">查看</span><span class="why">「今天学什么」</span><span class="v">今日</span></div>' +
        '<div class="erow"><span class="k">重排</span><span class="why">「这周落下了，帮我重排」</span><span class="v">L1–L4</span></div>' +
        '<div class="erow"><span class="k">评估</span><span class="why">「我的计划可行吗」</span><span class="v">R 值</span></div>' +
        '<div class="erow"><span class="k">调参</span><span class="why">「数学多给两小时」</span><span class="v">需求 +116h</span></div>' +
        '<div class="erow"><span class="k">反馈</span><span class="why">「生成周报」/「我有点累」</span><span class="v">insight</span></div>' +
        '<div class="erow"><span class="k">演示</span><span class="why">「演示挽救」查看隔离示例，不修改真实计划</span><span class="v">demo</span></div>' +
        '<div class="erow"><span class="k">计时</span><span class="why">「开始」/「撤销」</span><span class="v">session</span></div>' +
      '</div></div>' +
      '<p style="margin-top:10px;color:var(--txt3);font-size:11px">澄清与拆解建议由 LLM 承接；R 值与排程始终由确定性引擎产出，同输入必得同输出。</p>', '意图 · 兜底');
  }

  /* ---------- 交互动作 ---------- */
  function adoptTired() {
    var S = ZX.state;
    if (S.tiredAdopted) return;
    var previewTask = tiredPreview && S.tasks.filter(function (x) { return x.id === tiredPreview.taskId; })[0];
    var currentVersion = S.currentPlanVersion ? S.currentPlanVersion() : null;
    if (!previewTask || (tiredPreview.planVersion !== null && tiredPreview.planVersion !== currentVersion) ||
        previewTask.done || previewTask.skipped || previewTask.abandoned || previewTask.substituted || previewTask.deferred ||
        previewTask.id === S.running || (S.locks && S.locks[previewTask.id]) || lowestWeightTask() !== previewTask) {
      say('<p>降载预览已失效，请重新生成建议；现有计划未改动。</p>', '洞察 · 归因');
      return;
    }
    S.tiredAdopted = true;
    /* 与 tiredFlow 同一选取：只暂缓当前权重最低的未完成项，不写真实改期 */
    var t = previewTask;
    var at = Date.now();
    t.deferred = true;
    t.deferredAt = at;
    t.deferredReason = '状态不佳';
    var left = ZX.flows.exec.activeTasks().filter(function (x) { return !x.done; }).length;
    ZX.render();
    say('<p>已采纳。' + (t ? U.esc(t.s) + '（' + U.hm(t.est) + '）仅标记顺延（仅今日暂缓，未修改计划日期）；今天剩 ' + left + ' 项收工。' : '今天没有需要暂缓的项。') + '</p><p style="color:var(--txt3);font-size:11px">本次调整只写入今日暂缓状态，原因「状态不佳」；不计入断更，也不影响连续记录。</p>', '执行 · 今日暂缓');
    ZX.api.queueOp({
      entity: 'task', entityId: t ? t.id : '', field: 'deferred',
      value: { reason: t.deferredReason, at: at, est: U.num(t.est, 0) }
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

  ZX.assistant = {
    pushMsg: pushMsg, say: say, me: me, typing: typing,
    startTask: startTask, tickTimer: tickTimer, elapsedMs: elapsedMs, finishTask: finishTask, toggleBuffer: toggleBuffer,
    route: route,
    goalFlow: goalFlow,
    rescueFlow: rescueFlow,
    demoRescueFlow: demoRescueFlow,
    feasibilityFlow: feasibilityFlow,
    adjustMath: adjustMath, weeklyFlow: weeklyFlow, tiredFlow: tiredFlow,
    todayFlow: todayFlow, startFlow: startFlow, fallback: fallback,
    adoptTired: adoptTired, toggleNotif: toggleNotif
  };

})(window.ZX);
