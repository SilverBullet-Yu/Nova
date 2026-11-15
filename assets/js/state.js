/* =========================================================
   诺瓦 Nova · 应用状态与派生计算
   初始值来自 shared/data/seed.js（全局 Rhythm.seed，index.html 最先加载）。
   种子缺失属于装配错误（文件被删或路径不对），直接抛错，不做静默替换。
   ========================================================= */
window.ZX = window.ZX || {};

(function (ZX) {
  'use strict';

  var U = ZX.util;

  var SUBJ = {
    '数学': { c: 'var(--m-math)' },
    '英语': { c: 'var(--m-en)' },
    '408':  { c: 'var(--m-408)' },
    '政治': { c: 'var(--m-pol)' }
  };

  /* shared/data/seed.js 采用 UMD 命名空间形态：Rhythm.seed = { seed: {...} } */
  function rawSeed() {
    var R = window.Rhythm;
    var cand = null;
    if (R && R.seed) {
      if (R.seed.seed && typeof R.seed.seed === 'object') cand = R.seed.seed;
      else if (Array.isArray(R.seed.tasks)) cand = R.seed;
    }
    if (!cand || !Array.isArray(cand.tasks)) {
      throw new Error('种子数据缺失：shared/data/seed.js 未能加载');
    }
    return cand;
  }

  /* 任务归一：契约用 subject，视图用 s —— 两者同时保留 */
  function normTask(t) {
    var o = {}, k;
    for (k in t) if (Object.prototype.hasOwnProperty.call(t, k)) o[k] = t[k];
    o.id = t.id;
    o.s = t.s || t.subject || '';
    o.subject = t.subject || t.s || '';
    o.title = t.title || '';
    o.est = U.num(t.est, 0);
    o.time = t.time || '';
    o.weight = U.num(t.weight, 0);
    o.done = !!t.done;
    if (t.actual !== undefined && t.actual !== null) o.actual = t.actual;
    return o;
  }

  function normWeek(arr) {
    return (arr || []).map(function (d) {
      var o = Object.assign({}, d);
      o.segs = Array.isArray(d.segs) ? d.segs : [];
      o.buf = U.num(d.buf, 60);
      var sum = 0;
      for (var i = 0; i < o.segs.length; i++) sum += U.num(o.segs[i][1], 0);
      o.total = U.num(d.total, sum);
      return o;
    });
  }

  /* 通知开关：种子为布尔映射 {daily,weekly,alert,rescue}，
     后端 /api/state 返回数组 [{id,kind,enabled,...}] —— 两种形态都归一为布尔映射 */
  function normNotif(raw) {
    var out = { daily: true, weekly: true, alert: true, rescue: true };
    if (!raw) return out;
    if (Array.isArray(raw)) {
      raw.forEach(function (n) {
        if (!n) return;
        var k = n.kind || String(n.id || '').replace(/^n_/, '');
        if (k in out) out[k] = !!n.enabled;
      });
      return out;
    }
    if (typeof raw === 'object') {
      Object.keys(out).forEach(function (k) {
        if (k in raw) out[k] = !!raw[k];
      });
      /* 未知键也保留，便于后端扩展 */
      Object.keys(raw).forEach(function (k) { if (!(k in out)) out[k] = !!raw[k]; });
    }
    return out;
  }

  function normSeed(raw) {
    var r = raw || {};
    var feas = r.feas || {};
    var disc = (feas.discount !== undefined && feas.discount !== null) ? feas.discount : feas.disc;
    var s = {
      user: Object.assign({}, r.user || {}),
      goal: Object.assign({}, r.goal || {}),
      feas: {
        weeklyH: U.num(feas.weeklyH, 0),
        weeks: U.num(feas.weeks, 0),
        discount: U.num(disc, 0),
        demand: U.num(feas.demand, 0)
      },
      tasks: (Array.isArray(r.tasks) ? r.tasks : []).map(normTask),
      buffer: Object.assign({}, r.buffer || {}),
      week: normWeek(r.week),
      weekShift: normWeek(r.weekShift),
      notif: normNotif(r.notif),
      weekStats: Object.assign({}, r.weekStats || {}),
      subjectColors: Object.assign({}, r.subjectColors || {})
    };
    return s;
  }

  var seed = normSeed(rawSeed());

  /* 科目色值：优先取 shared/data/seed.js 的 subjectColors（值与原 CSS 变量一致） */
  (function () {
    var colors = seed.subjectColors || {};
    Object.keys(colors).forEach(function (k) {
      if (!SUBJ[k]) SUBJ[k] = { c: colors[k] };
      else SUBJ[k].c = colors[k];
    });
  })();

  var state = {
    tab: 'chat',   /* 对话是主页面（默认页签）；今日 / 计划 / 数据 / 我的 为菜单子页 */
    user: seed.user,
    goal: seed.goal,
    feas: seed.feas,
    tasks: seed.tasks,
    buffer: seed.buffer,
    week: seed.week,
    weekShift: seed.weekShift,
    notif: seed.notif,
    weekStats: seed.weekStats,

    running: null,
    timerStart: null,
    replanned: false,
    snapshot: null,
    tiredAdopted: false,
    movedOut: null,
    presetActive: true,

    sessions: [],

    /* 环节⑧归因计数：执行记录后由 attribute 引擎回写 {类型: 次数}，数据页消费 */
    attrCounts: {},
    /* 环节⑦重排历史：[{at, loadDelta, undone}]——熔断计数与周报采纳率的数据源 */
    replanHistory: [],

    serverSeq: 88123,
    replanRecord: null,
    lastFeas: null
  };

  /* ---------- 本地持久化（本地优先） ----------
     新目标 / 执行记录（含跳过、补录）此前只存在于内存，刷新即回落种子。
     这里把「用户数据投影」tasks / sessions / goal / feas / week / weekShift
     落入 localStorage（键 zx.overlay）：ZX.render 统一保存（任何状态变更后
     必走渲染，避免逐个改动点补写）；启动时恢复；后端状态合并后再覆写一次
     （本地优先：未上行的本地数据不丢）。删除全部数据时须显式 dropOverlay
     （flows/settings.js 的 wipe），否则重载会复活已删数据。 */
  var OVERLAY_KEY = 'zx.overlay';

  function saveOverlay() {
    try {
      window.localStorage.setItem(OVERLAY_KEY, JSON.stringify({
        tasks: state.tasks,
        sessions: state.sessions || [],
        goal: state.goal,
        feas: state.feas,
        week: state.week,
        weekShift: state.weekShift,
        attrCounts: state.attrCounts || {},
        replanHistory: state.replanHistory || [],
        at: Date.now()
      }));
    } catch (e) { /* 隐私模式 / 配额不足：会话内仍可用，刷新后回落 */ }
  }

  function dropOverlay() {
    try { window.localStorage.removeItem(OVERLAY_KEY); } catch (e) { /* 忽略 */ }
  }

  function applyOverlay() {
    var o = null;
    try { o = JSON.parse(window.localStorage.getItem(OVERLAY_KEY) || 'null'); } catch (e) { o = null; }
    if (!o || typeof o !== 'object') return false;
    if (Array.isArray(o.sessions)) state.sessions = o.sessions;
    if (Array.isArray(o.tasks) && o.tasks.length) state.tasks = o.tasks.map(normTask);
    if (o.goal && typeof o.goal === 'object') state.goal = o.goal;
    if (o.feas && typeof o.feas === 'object') state.feas = o.feas;
    if (Array.isArray(o.week)) state.week = normWeek(o.week);
    if (Array.isArray(o.weekShift)) state.weekShift = normWeek(o.weekShift);
    if (o.attrCounts && typeof o.attrCounts === 'object') state.attrCounts = o.attrCounts;
    if (Array.isArray(o.replanHistory)) state.replanHistory = o.replanHistory;
    return true;
  }

  /* 启动恢复：种子之上叠加本地 overlay（新目标 / 记录 / 跳过 / 补录跨刷新存活） */
  applyOverlay();

  /* ---------- 派生计算 ----------
     计划 / 已投入 / 剩余 / 达成率的统一口径在 flows/exec.metrics（过滤 skipped）；
     这里只保留与视图无关的 workedMin（挽救流程的缺口推演用）。 */
  state.workedMin = function () {
    return state.tasks.filter(function (t) { return t.done; })
      .reduce(function (a, t) { return a + U.num(t.actual || t.est, 0); }, 0);
  };
  /* 计时四元组复位（记录完成 / 目标生效 / 删除数据等收尾共用） */
  state.resetTimer = function () {
    state.running = null;
    state.timerStart = null;
    state.pausedAt = null;
    state.pausedTotal = 0;
  };
  state.feasInput = function () {
    return {
      weeklyH: state.feas.weeklyH,
      weeks: state.feas.weeks,
      discount: state.feas.discount,
      demand: state.feas.demand
    };
  };
  /* 渲染路径：同步本地确定性纯函数（与后端同语义，不产生 UI 抖动） */
  state.feasibility = function () { return ZX.engine.feasibilityNow(state.feasInput()); };
  state.weekInput = function () {
    return state.week.map(function (d) { return { date: d.d, minutes: U.num(d.total, 0), buf: U.num(d.buf, 0) }; });
  };
  /* 「连续未改善」真算：从最近一次重排往回数，连续「被撤销」或「增幅触顶」的次数。
     这是防雪崩断言 3（连续 3 次未改善 → 转目标校准）的数据源，替换原硬编码 0。 */
  var LOAD_GROWTH_CAP = 0.20;
  state.noImproveCount = function () {
    var n = 0;
    var hist = state.replanHistory || [];
    for (var i = hist.length - 1; i >= 0; i--) {
      var r = hist[i] || {};
      if (r.undone === true || U.num(r.loadDelta, 0) >= LOAD_GROWTH_CAP) n++;
      else break;
    }
    return n;
  };
  state.replanInput = function () {
    return {
      /* 原样带上 domain / freq / substituted / abandoned 等语义字段，避免重排丢上下文 */
      tasks: state.tasks.map(function (t) { return U.clone(t); }),
      week: state.weekInput(),
      /* 锁定是硬约束：作为入参进入引擎，而不是在结果上事后过滤 */
      locks: U.clone(state.locks || {}),
      params: {
        loadGrowthCap: LOAD_GROWTH_CAP, compressFloor: 0.60, compressedShareCap: 0.30,
        consecutiveNoImproveCap: 3, bufferRatio: 0.15
      },
      history: { consecutiveNoImprove: state.noImproveCount() },
      timestamp: Date.now()
    };
  };

  /* ---------- 后端状态覆盖（静默拉取成功时调用） ---------- */
  state.adoptServerState = function (payload) {
    if (!payload) return false;
    var changed = false;
    if (payload.seed) {
      var s = normSeed(payload.seed);
      state.user = s.user; state.goal = s.goal; state.feas = s.feas;
      state.tasks = s.tasks; state.buffer = s.buffer; state.week = s.week;
      state.weekShift = s.weekShift; state.notif = s.notif; state.weekStats = s.weekStats;
      changed = true;
    }
    if (payload.notifications) {
      state.notif = normNotif(payload.notifications);
      changed = true;
    }
    if (payload.replan) {
      state.replanRecord = payload.replan;
      if (payload.replan.accepted === true && payload.replan.snapshot) {
        state.snapshot = payload.replan.snapshot;
        state.replanned = true;
        changed = true;
      }
    }
    if (typeof payload.serverSeq === 'number') state.serverSeq = payload.serverSeq;
    return changed;
  };

  ZX.SUBJ = SUBJ;
  ZX.state = state;
  ZX.state.saveOverlay = saveOverlay;
  ZX.state.dropOverlay = dropOverlay;
  ZX.state.applyOverlay = applyOverlay;
  ZX.state.normTask = normTask;

})(window.ZX);
