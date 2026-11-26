/* =========================================================
   诺瓦 Nova · 对话式需求澄清 flow（LLM 理解与分析层）
   ---------------------------------------------------------
   目标工作流：多轮澄清（整体→局部）→ 画像确认 → LLM 拆解建议
   → 可行性校准（R<0.70 时三条路径，与 goal.js 同口径）→ 引擎排程落地。
   架构裁决（2026-11-22）：LLM 只做理解与分析（追问 / 画像 / 拆解建议），
   R 值判定与排程块仍由确定性引擎产出——LLM 输出一律结构化 JSON，
   服务端已做 schema 归一，这里再做边界夹紧与 HTML 转义（防注入）。
   约束：
   · 经典 script，IIFE 挂 ZX.flows.clarify，支持 file:// 双击
   · 落地复用 goal.js 已导出的 apply()（排程→生效→复核全链路不重写）
   · 降级链：LLM 未配置（E5010）/ 离线 / 调用失败 / 输出非法
     → say 说明后自动回落 ZX.flows.goal.open() 表单，零损失接管
   · 画像会话与对话流同生命周期（刷新即清）；落地后的数据走既有 overlay
   ========================================================= */
window.ZX = window.ZX || {};

(function (ZX) {
  'use strict';

  var U = ZX.util;

  function say(html, eng) {
    if (ZX.assistant && typeof ZX.assistant.say === 'function') ZX.assistant.say(html, eng);
  }
  function typing() {
    return ZX.assistant && typeof ZX.assistant.typing === 'function' ? ZX.assistant.typing() : null;
  }

  /* 与 goal.js 同一产品口径：折扣、门槛、校准目标、单项时长边界 */
  var DISCOUNT = 0.85;
  var GATE = 0.7;
  var TARGET_R = 0.9;
  var MAX_TASKS = 8;

  /* ---------- 会话态 ---------- */
  var phase = 'idle';       /* idle | ask | confirm | calib */
  var profile = null;       /* 需求画像（服务端归一后的形态） */
  var history = [];         /* [{role:'user'|'assistant', content}] */
  var busy = false;         /* 一轮 LLM 往返进行中，忽略新输入 */
  var llmDown = false;      /* E5010 未配置：置位后 start 直接降级，不再打必败请求 */
  var sug = null;           /* analyze 建议 + 校准态 { weeklyH, weeks, demand } */
  var session = 0;          /* 会话代号：退出再重开后，迟到响应不得污染新会话 */
  var revision = 0;         /* 每次渲染可操作卡片都换版本，聊天记录里的旧卡不可复用 */
  var currentCard = null;
  var cardPlanVersion = null;
  var submitAttempt = 0;

  function beginCard(actions) {
    revision++;
    cardPlanVersion = null;
    currentCard = { phase: phase, actions: actions };
  }
  function actionAttrs(act) {
    return ' data-cl="' + act + '" data-cl-session="' + session +
      '" data-cl-revision="' + revision + '" data-cl-phase="' + phase + '"' +
      (cardPlanVersion ? ' data-cl-plan="' + U.esc(cardPlanVersion) + '"' : '');
  }

  function active() { return phase !== 'idle'; }

  function endSession() {
    currentCard = null;
    phase = 'idle';
    profile = null;
    history = [];
    busy = false;
    sug = null;
    session++;
  }

  /* ---------- 校准求解：只调参数，复算走引擎，不复制公式 ---------- */
  function feasOf(weeklyH, weeks, demand) {
    return ZX.engine.feasibilityNow({ weeklyH: weeklyH, weeks: weeks, discount: DISCOUNT, demand: demand });
  }
  function solveWeekly(target) {
    for (var w = 1; w <= 80; w++) {
      if (feasOf(w, sug.weeks, sug.demand).R >= target) return w;
    }
    return 0;   /* 80 h/周仍不达标 */
  }
  function solveWeeks(target) {
    for (var k = 1; k <= 520; k++) {
      if (feasOf(sug.weeklyH, k, sug.demand).R >= target) return k;
    }
    return 0;   /* 520 周仍不达标 */
  }
  function weeksFromDeadline(day) {
    var d = U.parseDay(day);
    if (!d) return 1;
    return Math.max(1, Math.floor((d.getTime() - U.today0().getTime()) / 604800000));
  }

  /* ---------- 澄清一轮 ---------- */
  function sendTurn(text) {
    currentCard = null;
    history.push({ role: 'user', content: text });
    busy = true;
    var t = typing();
    var turn = history.length;          /* 轮次角标 */
    var my = session;
    ZX.api.llmClarify({ messages: history, profile: profile }).then(function (r) {
      if (t) t.remove();
      if (my !== session || phase === 'idle') return;   /* 迟到响应：会话已更换 */
      busy = false;
      profile = r.profile;
      history.push({ role: 'assistant', content: r.reply });
      say('<p>' + U.esc(r.reply).replace(/\n/g, '<br>') + '</p>', '智能澄清 · 第 ' + turn + ' 轮');
      if (r.done) { phase = 'confirm'; renderConfirm(); }
    }, function (e) {
      if (t) t.remove();
      if (my !== session || phase === 'idle') return;
      busy = false;
      degrade(e);
    });
  }

  /* ---------- 降级链：LLM 不可用 → 表单流程零损失接管 ---------- */
  function degrade(e) {
    var code = e && e.code ? e.code : '';
    var why = code === 'E5010'
      ? '智能澄清需要服务端配置 LLM（LLM_BASE_URL / LLM_API_KEY / LLM_MODEL），当前未启用。'
      : (ZX.api && ZX.api.isOnline && !ZX.api.isOnline())
        ? '现在离线，智能澄清需要服务端在线。'
        : '智能澄清这会儿没有接通（' + (code || '网络异常') + '）。';
    endSession();
    if (code === 'E5010') llmDown = true;
    say('<p>' + why + '先用四步表单定目标，设定、可行性、拆解、生效一步不少。</p>' +
      '<p style="color:var(--txt3);font-size:11px">服务端配置好 LLM 后再说「新建目标」，就能回到对话式澄清。</p>',
      '澄清 · 降级表单');
    if (ZX.flows && ZX.flows.goal) ZX.flows.goal.open();
  }

  /* ---------- 入口 ---------- */
  function start(trigger) {
    if (phase !== 'idle') { say('<p>澄清已经在进行中，直接继续说就行。</p>', '澄清 · 进行中'); return; }
    if (!ZX.api || typeof ZX.api.llmClarify !== 'function') { degrade({ code: 'E5010' }); return; }
    if (llmDown) { degrade({ code: 'E5010' }); return; }
    phase = 'ask';
    profile = null;
    history = [];
    say('<p>好，我们先把想法理清楚再排计划。我会从目标、时间、现状一路问到具体安排，' +
      '想到哪说到哪就行；随时说<b>「退出澄清」</b>回到指令模式。</p>', '智能澄清 · 开始');
    sendTurn(trigger || '我想定一个学习目标');
  }

  function endByUser() {
    endSession();
    say('<p>已退出澄清。快捷指令照常可用，想再澄清就说「新建目标」。</p>', '澄清 · 结束');
  }

  /* ---------- 确认卡（画像汇总） ----------
     画像字段一律渲染时 U.esc，不在存储层转义（落地后的 state 必须是原始值） */
  function renderConfirm() {
    beginCard(['build', 'edit', 'cancel']);
    var p = profile || {};
    var weeks = weeksFromDeadline(p.deadline);
    var rows =
      '<div class="erow"><span class="k">目标</span><span class="why" style="flex:1;color:var(--txt2)">' + U.esc(p.goalName || '') +
        '（' + U.esc(p.goalType || '未确认') + '）</span></div>' +
      '<div class="erow"><span class="k">截止</span><span class="why" style="flex:1;color:var(--txt2)">' + U.esc(p.deadline || '') +
        '（约 ' + weeks + ' 周）</span></div>' +
      '<div class="erow"><span class="k">每周</span><span class="why" style="flex:1;color:var(--txt2)">' + U.num(p.weeklyH, 0) + ' h</span></div>' +
      '<div class="erow"><span class="k">现状</span><span class="why" style="flex:1;color:var(--txt2)">' + U.esc(p.level || '未确认') + '</span></div>' +
      (p.subjects && p.subjects.length ? '<div class="erow"><span class="k">科目</span><span class="why" style="flex:1;color:var(--txt2)">' + U.esc(p.subjects.join(' / ')) + '</span></div>' : '') +
      (p.preferences ? '<div class="erow"><span class="k">偏好</span><span class="why" style="flex:1;color:var(--txt2)">' + U.esc(p.preferences) + '</span></div>' : '');
    say('<p>画像齐了，确认一下，有不对的地方直接说，我改完再排。</p>' +
      '<div class="ecard"><div class="ecard-h"><b>需求画像</b><span class="tag ok">待确认</span></div>' +
      '<div class="ecard-b">' + rows + '</div>' +
      '<div class="ecard-f">' +
        '<button class="btn"' + actionAttrs('build') + '>按此制订计划</button>' +
        '<button class="btn ghost"' + actionAttrs('edit') + '>继续调整</button>' +
        '<button class="btn ghost"' + actionAttrs('cancel') + '>取消</button>' +
      '</div></div>', '澄清 · 画像确认');
  }

  /* ---------- 拆解建议（LLM 分析 → 建议卡） ---------- */
  function buildPlan() {
    currentCard = null;
    busy = true;
    var t = typing();
    var my = session;
    ZX.api.llmAnalyze({ profile: profile }).then(function (r) {
      if (t) t.remove();
      if (my !== session || phase === 'idle') return;
      busy = false;
      /* 边界夹紧：服务端已归一，这里对齐引擎口径再兜一层 */
      sug = {
        summary: r.summary,
        demand: Math.max(60, Math.round(U.num(r.demandH, 600))),
        weeklyH: Math.max(1, Math.min(80, Math.round(U.num(r.weeklyH, profile.weeklyH || 15)))),
        weeks: weeksFromDeadline(profile.deadline),
        tasks: (r.tasks || []).slice(0, MAX_TASKS).map(function (x, i) {
          return {
            id: 'd_' + (i + 1),
            s: x.s || (profile.subjects[0] || '学习'),
            title: x.title || '',
            est: Math.max(15, Math.min(240, Math.round(U.num(x.est, 45)))),
            weight: Math.max(0.1, Math.min(1, U.num(x.weight, 0.6))),
            order: i
          };
        }),
        risks: (r.risks || []).slice(0, 3),
        advice: r.advice || ''
      };
      phase = 'calib';
      renderSuggestion();
    }, function (e) {
      if (t) t.remove();
      if (my !== session || phase === 'idle') return;
      busy = false;
      degrade(e);
    });
  }

  function suggestRows() {
    return sug.tasks.map(function (x) {
      return '<div class="erow"><span class="k">' + U.esc(x.s) + '</span>' +
        '<span class="why" style="flex:1;color:var(--txt2)">' + U.esc(x.title) + '</span>' +
        '<span class="v">' + U.hm(x.est) + '</span></div>';
    }).join('');
  }

  function renderSuggestion() {
    var f = feasOf(sug.weeklyH, sug.weeks, sug.demand);
    if (f.R < GATE) { renderCalibration(f); return; }
    beginCard(['apply', 'edit']);
    var ok = f.R >= TARGET_R;
    var riskHtml = sug.risks.length
      ? '<div class="erow"><span class="k">风险</span><span class="why" style="flex:1;color:var(--txt2)">' + U.esc(sug.risks.join('；')) + '</span></div>' : '';
    say('<p>' + (sug.summary ? U.esc(sug.summary) : '拆解建议出来了') +
      '。先给可行性和拆解，确认后由引擎排入你的可用时段。</p>' +
      '<div class="ecard"><div class="ecard-h"><b>计划建议</b><span class="tag ' + (f.R >= TARGET_R ? 'ok' : 'warn') + '">' +
        f.verdict + ' · R ' + f.R.toFixed(2) + '</span></div>' +
      '<div class="ecard-b">' + suggestRows() +
        '<div class="erow"><span class="k">可行性</span><span class="why" style="flex:1;color:var(--txt3)">每周 ' + sug.weeklyH +
        ' h × ' + sug.weeks + ' 周 × ' + DISCOUNT + ' 折算，需求 ' + sug.demand + ' h</span>' +
        '<span class="v ' + (ok ? 'ac' : 'warn') + '">' + f.R.toFixed(2) + '</span></div>' + riskHtml +
        (sug.advice ? '<div class="erow"><span class="k">建议</span><span class="why" style="flex:1;color:var(--txt2)">' + U.esc(sug.advice) + '</span></div>' : '') +
      '</div>' +
      '<div class="ecard-f">' +
        '<button class="btn"' + actionAttrs('apply') + '>确认，开始排程</button>' +
        '<button class="btn ghost"' + actionAttrs('edit') + '>回去调整</button>' +
      '</div></div>' +
      '<p style="color:var(--txt3);font-size:11px">拆解内容来自 LLM 建议，R 值与排程块由确定性引擎产出；生效后可在计划页拖动改期、锁定。</p>',
      '计划建议 · R ' + f.R.toFixed(2));
  }

  /* ---------- 校准卡（R < 0.70，三条路径与 goal.js 同口径，可叠加） ---------- */
  function renderCalibration(f) {
    beginCard(['edit']);
    var rows = [];
    if (f.R >= TARGET_R) {
      rows.push(calRow('提高周投入', '已满足 R ≥ 0.90', '当前 ' + sug.weeklyH + ' h/周', false));
    } else {
      var needW = solveWeekly(TARGET_R);
      if (needW) {
        var rw = feasOf(needW, sug.weeks, sug.demand);
        rows.push(calRow('提高周投入', 'R ' + f.R.toFixed(2) + ' → ' + rw.R.toFixed(2),
          sug.weeklyH + ' → ' + needW + ' h/周', true, 'cal-h'));
      } else {
        rows.push(calRow('提高周投入', '80 h/周仍不达标', '建议延长周期或缩小范围', false));
      }
    }
    if (f.R >= TARGET_R) {
      rows.push(calRow('延长周期', '已满足 R ≥ 0.90', '当前 ' + sug.weeks + ' 周', false));
    } else {
      var needK = solveWeeks(TARGET_R);
      if (needK) {
        var rk = feasOf(sug.weeklyH, needK, sug.demand);
        var newDay = U.isoDay(U.addDays(U.today0(), needK * 7));
        rows.push(calRow('延长周期', 'R ' + f.R.toFixed(2) + ' → ' + rk.R.toFixed(2),
          sug.weeks + ' → ' + needK + ' 周（截止随之改为 ' + newDay + '）', true, 'cal-w'));
      } else {
        rows.push(calRow('延长周期', '520 周仍不达标', '建议缩小范围', false));
      }
    }
    if (f.R >= TARGET_R) {
      rows.push(calRow('缩小范围', '已满足 R ≥ 0.90', '需求 ' + sug.demand + ' h', false));
    } else {
      var nd = Math.round(sug.demand * 0.85);
      var rd = feasOf(sug.weeklyH, sug.weeks, nd);
      rows.push(calRow('缩小范围', 'R ' + f.R.toFixed(2) + ' → ' + rd.R.toFixed(2),
        '需求 ' + sug.demand + ' → ' + nd + ' h（−15%）', true, 'cal-d'));
    }
    say('<div class="ecard"><div class="ecard-h"><b>可行性偏紧</b><span class="tag warn">R ' + f.R.toFixed(2) + '</span></div>' +
      '<div class="ecard-b"><div class="notice warn">R 低于 0.70：先把可行性拉回可执行区间，再谈排程。三条路径可以叠加，每应用一次立即重算。</div>' +
      rows.join('') + '</div>' +
      '<div class="ecard-f"><button class="btn ghost"' + actionAttrs('edit') + '>回去调整画像</button></div></div>',
      '校准 · 三条路径');
  }

  function calRow(title, sub, detail, enabled, act) {
    if (enabled) currentCard.actions.push(act);
    return '<div class="erow"><span class="k">' + title + '</span>' +
      '<span class="why" style="flex:1;color:var(--txt2)">' + U.esc(sub) + ' · ' + U.esc(detail) + '</span>' +
      (enabled ? '<button class="btn"' + actionAttrs(act) + '>应用</button>' : '<span class="v">已达标</span>') +
      '</div>';
  }

  function applyCal(act) {
    if (act === 'cal-h') {
      var w = solveWeekly(TARGET_R);
      if (w) sug.weeklyH = w;
    } else if (act === 'cal-w') {
      var k = solveWeeks(TARGET_R);
      if (k) { sug.weeks = k; profile.deadline = U.isoDay(U.addDays(U.today0(), k * 7)); }
    } else if (act === 'cal-d') {
      sug.demand = Math.round(sug.demand * 0.85);
    }
    renderSuggestion();
  }

  /* ---------- 落地：组装草案后交给 goal.apply()（排程→生效全链路） ---------- */
  function renderRetry(planVersion) {
    beginCard(['retry-apply', 'edit']);
    cardPlanVersion = planVersion;
    say('<p>排程没有完成，当前计划未变更。建议仍保留，可以重试；如果计划已变化，需要重新确认。</p>' +
      '<div class="ecard"><div class="ecard-h"><b>排程待重试</b><span class="tag warn">建议已保留</span></div>' +
      '<div class="ecard-b">' + suggestRows() + '</div>' +
      '<div class="ecard-f"><button class="btn"' + actionAttrs('retry-apply') + '>重试排程</button>' +
      '<button class="btn ghost"' + actionAttrs('edit') + '>回去调整</button></div></div>', '澄清 · 排程重试');
  }

  function applySuggestion() {
    if (!sug || !sug.tasks.length || busy) return;
    var deadline = U.parseDay(profile.deadline);
    if (!deadline || deadline <= U.today0() || !isFinite(sug.weeklyH) || sug.weeklyH < 1 || sug.weeklyH > 80) {
      say('<p>截止日期必须晚于今天，每周投入需为 1–80 小时；请先修正，当前计划未变更。</p>', '澄清 · 校验');
      return;
    }
    var S = ZX.state;
    if (!S || typeof ZX.flows.goal.apply !== 'function') return;
    S.goalDraft = {
      type: profile.goalType || '其他',
      name: profile.goalName,
      deadline: profile.deadline,
      weeklyH: sug.weeklyH,
      weeks: sug.weeks,
      base: profile.level || '一轮',
      demand: sug.demand,
      discount: DISCOUNT,
      source: 'clarify'
    };
    S.planDraft = sug.tasks.map(function (x) {
      return { id: x.id, s: x.s, title: x.title, est: x.est, weight: x.weight, order: x.order };
    });
    var planVersion = S.currentPlanVersion ? S.currentPlanVersion() : null;
    var attempt = ++submitAttempt;
    busy = true;
    currentCard = null;
    say('<p>好，按这份建议提交引擎排程。可用时段来自「我的」页 7×4 设置，弹性位照常保留。</p>', '澄清 · 提交排程');
    var submission;
    try {
      submission = ZX.flows.goal.apply();
    } catch (e) {
      submission = false;
    }
    if (!submission || typeof submission.then !== 'function') {
      busy = false;
      if (submission === false) renderRetry(planVersion);
      else endSession();
      return;
    }
    Promise.resolve(submission).then(function (ok) {
      if (attempt !== submitAttempt || phase === 'idle') return;
      busy = false;
      if (ok !== false) { endSession(); return; }
      renderRetry(planVersion);
    }, function () {
      if (attempt !== submitAttempt || phase === 'idle') return;
      busy = false;
      renderRetry(planVersion);
    });
  }

  /* ---------- 路由钩子：assistant.route() 在关键词匹配前调用 ---------- */
  function hook(text) {
    if (phase === 'idle') return false;
    var t = String(text || '').toLowerCase().replace(/\s/g, '');
    if (t === '退出澄清' || t === '取消澄清' || t === '结束澄清' || t === '不聊了') { endByUser(); return true; }
    if (busy) { say('<p>等我看完这条再继续，马上。</p>', '澄清 · 处理中'); return true; }
    if (phase === 'ask' || phase === 'confirm' || phase === 'calib') {
      /* 确认 / 校准阶段继续说话 = 回到澄清继续修改 */
      phase = 'ask';
      sendTurn(text);
      return true;
    }
    return false;
  }

  /* ---------- 事件委托（chat 卡片按钮，不改 main.js） ---------- */
  document.addEventListener('click', function (e) {
    if (!e.target || !e.target.closest) return;
    var b = e.target.closest('[data-cl]');
    if (!b) return;
    var data = b.dataset;
    if (!data || !active() || busy || !currentCard) return;
    var act = data.cl;
    if (data.clSession !== String(session) || data.clRevision !== String(revision) ||
        data.clPhase !== phase || currentCard.phase !== phase || currentCard.actions.indexOf(act) === -1) return;
    if (act === 'cancel') { endSession(); return; }
    if (act === 'edit') { currentCard = null; phase = 'ask'; say('<p>好，说说不满意的地方。</p>', '澄清 · 继续调整'); return; }
    if (act === 'build') { buildPlan(); return; }
    if (act === 'retry-apply') {
      var expectedPlan = data.clPlan;
      var currentPlan = ZX.state.currentPlanVersion ? ZX.state.currentPlanVersion() : null;
      if (expectedPlan && expectedPlan !== currentPlan) {
        say('<p>计划已变化，旧重试卡已失效；请查看最新建议后重新确认。</p>', '澄清 · 重试已失效');
        renderSuggestion();
        return;
      }
      applySuggestion();
      return;
    }
    if (act === 'apply') { applySuggestion(); return; }
    if (act === 'cal-h' || act === 'cal-w' || act === 'cal-d') { applyCal(act); return; }
  });

  ZX.flows = ZX.flows || {};
  ZX.flows.clarify = {
    start: start,
    hook: hook,
    active: active
  };

})(window.ZX);
