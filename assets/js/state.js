/* =========================================================
   诺瓦 Nova · 应用状态与派生计算
   初始值来自 shared/data/seed.js（全局 Rhythm.seed）；
   shared/ 尚未就位时使用下方 FALLBACK_SEED（与契约同构的本地镜像），
   保证 file:// 双击打开时行为与视觉完全一致。
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

  /* 与 shared/data/seed.js 契约一致的本地镜像（仅在共享种子缺失时启用） */
  var FALLBACK_SEED = {
    user: { id: 'u_demo', name: '林清', tz: 'Asia/Shanghai', dailyCapMin: 300, weeklyH: 20 },
    goal: { id: 'g_2027', name: '2027 考研 · 计算机', target: '380 分', deadline: '2027-12-25', weeks: 58 },
    feas: { weeklyH: 20, weeks: 58, discount: 0.85, demand: 913 },
    tasks: [
      { id: 't1', subject: '英语', title: '阅读真题 2019 Text 3–4 精读', est: 60, time: '09:00–10:00', weight: 0.78, done: true, actual: 60 },
      { id: 't2', subject: '数学', title: '高数 · 第 3 章 极限 40 题', est: 90, time: '10:30–12:00', weight: 0.92, done: false, why: '考频权重 0.92 · 匹配历史高效时段' },
      { id: 't3', subject: '408', title: '数据结构 · 树与二叉树 应用', est: 75, time: '14:00–15:15', weight: 0.86, done: false },
      { id: 't4', subject: '政治', title: '马原 第 2 章 多选 60 题', est: 45, time: '17:00–17:45', weight: 0.41, done: false }
    ],
    buffer: { time: '20:30–21:30', free: true },
    week: [
      { d: '一', segs: [['数学', 60], ['408', 45]], buf: 60, total: 105 },
      { d: '二', segs: [['英语', 60], ['政治', 30]], buf: 60, total: 90 },
      { d: '三', segs: [['数学', 90], ['408', 60]], buf: 60, total: 150 },
      { d: '四', segs: [['英语', 45]], buf: 60, total: 45 },
      { d: '五', segs: [['数学', 60], ['政治', 45]], buf: 60, total: 105 },
      { d: '六', segs: [['408', 90], ['数学', 60]], buf: 60, total: 150 },
      { d: '日', segs: [['数学', 90], ['408', 75], ['政治', 45], ['英语', 60]], buf: 60, total: 270, today: true }
    ],
    weekShift: [
      { d: '一', segs: [['数学', 60], ['408', 45]], buf: 60, total: 105 },
      { d: '二', segs: [['英语', 60], ['政治', 30], ['数学', 30]], buf: 60, total: 120 },
      { d: '三', segs: [['数学', 90], ['408', 60]], buf: 60, total: 150 },
      { d: '四', segs: [['英语', 45], ['408', 45]], buf: 60, total: 90 },
      { d: '五', segs: [['数学', 60], ['政治', 30]], buf: 60, total: 90 },
      { d: '六', segs: [['408', 90], ['数学', 60], ['数学', 45]], buf: 60, total: 195 },
      { d: '日', segs: [['数学', 90], ['408', 75], ['英语', 60]], buf: 60, total: 225, today: true }
    ],
    notif: { daily: true, weekly: true, alert: true, rescue: true },
    weekStats: {
      WEEKS: [52, 61, 58, 66, 71, 74, 72, 68],
      kpis: {
        effectiveHours: 11.2,
        targetHours: 15,
        achievementRate: 68,
        achievementDeltaPt: -6,
        replanAdopted: 3,
        replanTotal: 4,
        replanRate: 75,
        recordedDays: 5,
        totalDays: 7
      },
      subjectMix: { '数学': 45, '专业课': 30, '英语': 20, '政治': 5 },
      attribution: { '计划过载': 40, '执行中断': 35, '效率不足': 25 },
      actions: [
        '周日上午 08:00–10:00 固定为政治时段',
        '周三晚弹性位扩容 30 分钟'
      ]
    },
    subjectColors: {
      '数学': 'var(--m-math)',
      '英语': 'var(--m-en)',
      '408': 'var(--m-408)',
      '政治': 'var(--m-pol)'
    }
  };

  /* shared/data/seed.js 采用 UMD 命名空间形态：Rhythm.seed = { seed: {...} }
     同时兼容直接挂对象的老写法 */
  function rawSeed() {
    var R = window.Rhythm;
    if (!R || !R.seed) return FALLBACK_SEED;
    var cand = null;
    if (R.seed.seed && typeof R.seed.seed === 'object') cand = R.seed.seed;
    else if (Array.isArray(R.seed.tasks)) cand = R.seed;
    return (cand && Array.isArray(cand.tasks)) ? cand : FALLBACK_SEED;
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
    var s = {
      user: Object.assign({}, FALLBACK_SEED.user, r.user || {}),
      goal: Object.assign({}, FALLBACK_SEED.goal, r.goal || {}),
      feas: Object.assign({}, FALLBACK_SEED.feas, r.feas || {}),
      tasks: Array.isArray(r.tasks) ? r.tasks.map(normTask) : FALLBACK_SEED.tasks.map(normTask),
      buffer: Object.assign({}, FALLBACK_SEED.buffer, r.buffer || {}),
      week: Array.isArray(r.week) ? normWeek(r.week) : normWeek(FALLBACK_SEED.week),
      weekShift: Array.isArray(r.weekShift) ? normWeek(r.weekShift) : normWeek(FALLBACK_SEED.weekShift),
      notif: normNotif(r.notif),
      weekStats: Object.assign({}, FALLBACK_SEED.weekStats, r.weekStats || {}),
      subjectColors: Object.assign({}, FALLBACK_SEED.subjectColors, r.subjectColors || {})
    };
    if (r.feas) {
      var disc = (r.feas.discount !== undefined && r.feas.discount !== null) ? r.feas.discount : r.feas.disc;
      s.feas = {
        weeklyH: U.num(r.feas.weeklyH, FALLBACK_SEED.feas.weeklyH),
        weeks: U.num(r.feas.weeks, FALLBACK_SEED.feas.weeks),
        discount: U.num(disc, FALLBACK_SEED.feas.discount),
        demand: U.num(r.feas.demand, FALLBACK_SEED.feas.demand)
      };
    }
    if (r.weekStats && !Array.isArray(r.weekStats.WEEKS)) {
      s.weekStats.WEEKS = FALLBACK_SEED.weekStats.WEEKS;
    }
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

    serverSeq: 88123,
    replanRecord: null,
    lastFeas: null
  };

  /* ---------- 派生计算 ---------- */
  state.plannedMin = function () {
    return state.tasks.reduce(function (a, t) { return a + U.num(t.est, 0); }, 0);
  };
  state.workedMin = function () {
    return state.tasks.filter(function (t) { return t.done; })
      .reduce(function (a, t) { return a + U.num(t.actual || t.est, 0); }, 0);
  };
  state.remainMin = function () { return state.plannedMin() - state.workedMin(); };
  state.rate = function () {
    var p = state.plannedMin();
    return p ? Math.round(state.workedMin() / p * 100) : 0;
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
  state.replanInput = function () {
    return {
      tasks: state.tasks.map(function (t) {
        return {
          id: t.id, subject: t.s, title: t.title, est: t.est,
          time: t.time, weight: t.weight, done: t.done, actual: t.actual
        };
      }),
      week: state.weekInput(),
      params: {
        loadGrowthCap: 0.20, compressFloor: 0.60, compressedShareCap: 0.30,
        consecutiveNoImproveCap: 3, bufferRatio: 0.15
      },
      history: { consecutiveNoImprove: 0 },
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
  ZX.state.seedSource = (window.Rhythm && window.Rhythm.seed && rawSeed() !== FALLBACK_SEED) ? 'shared' : 'fallback';
  ZX.state.normTask = normTask;
  ZX.state.normNotif = normNotif;

})(window.ZX);
