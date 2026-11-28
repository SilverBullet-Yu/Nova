/* =========================================================
   诺瓦 Nova · 应用状态与派生计算
   初始值来自 shared/data/seed.js（全局 Rhythm.seed，index.html 最先加载）。
   种子缺失属于装配错误（文件被删或路径不对），直接抛错，不做静默替换。
   ========================================================= */
window.ZX = window.ZX || {};

(function (ZX) {
  'use strict';

  var U = ZX.util;
  function placementModel() { return window.Rhythm && window.Rhythm.placementModel; }

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
    if (t.partial !== undefined && t.partial !== null) o.partial = Math.min(100, Math.max(0, U.num(t.partial, 0)));
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
      sessions: U.clone(Array.isArray(r.sessions) ? r.sessions : []),
      buffer: Object.assign({}, r.buffer || {}),
      week: normWeek(r.week),
      weekShift: normWeek(r.weekShift),
      /* 服务端回放的手工改期 / 锁定（op 只写不读缺口的回读面） */
      dayAssign: (r.dayAssign && typeof r.dayAssign === 'object') ? r.dayAssign : {},
      locks: (r.locks && typeof r.locks === 'object') ? r.locks : {},
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
    placementModel: null,
    notif: seed.notif,
    weekStats: seed.weekStats,

    running: null,
    timerStart: null,
    replanned: false,
    snapshot: null,
    tiredAdopted: false,
    movedOut: null,

    sessions: seed.sessions,

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
     （flows/settings.js 的 wipe），否则重载会复活已删数据。
     删除只处理业务 overlay；旧 zx.op_queue 与 zx.pending_plan 原样保留隔离。 */
  var OVERLAY_KEY = 'zx.overlay';
  var OVERLAY_FORMAT = 'nova-overlay';
  var OVERLAY_VERSION = 3;
  var INSTALL_KEY = 'zx.install_id';
  var SNAPSHOT_FIELDS = ZX.util.SNAPSHOT_FIELDS;
  var OPTIONAL_SNAPSHOT_FIELDS = ZX.util.OPTIONAL_SNAPSHOT_FIELDS || [];

  var installId = null;
  function getInstallId() {
    if (installId) return installId;
    var stored = null;
    try { stored = window.localStorage.getItem(INSTALL_KEY); } catch (e) { stored = null; }
    if (typeof stored === 'string' && stored.trim()) {
      installId = stored;
      return installId;
    }
    installId = 'install-' + U.randHex();
    try {
      window.localStorage.setItem(INSTALL_KEY, installId);
      if (window.localStorage.getItem(INSTALL_KEY) !== installId) throw new Error('install id not saved');
    } catch (e) {
      installId = null;
      throw e;
    }
    return installId;
  }

  var versionId = null;
  var versionInput = null;
  function planInput() {
    var days = state.dayAssign || {}, locks = state.locks || {};
    return JSON.stringify([state.goal, state.feas, state.week, state.avail, state.placementModel,
      state.tasks.map(function (t) { return [t.id, t.subject, t.est, t.time, !!t.done, !!t.skipped, !!t.deferred, !!t.abandoned, !!t.substituted, days[t.id] || '日', !!locks[t.id]]; })]);
  }
  state.currentPlanVersion = function () {
    var input = planInput();
    if (input !== versionInput || !versionId) {
      versionId = 'plan-' + U.randHex();
      versionInput = input;
    }
    return versionId;
  };

  var overlayRevision = 0;
  var overlayUpdatedAt = 0;
  var overlayConflict = false;
  var lastOverlayRaw = null;
  var lastPersistedBusiness = null;
  var unreadableOverlayRaw = null;
  var overlayWriteAttempt = null;
  var overlayVerifiedRaw = null;
  var localLoadError = null;
  var localLoadBlocked = false;

  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function snapshotFromState() {
    var out = { planVersion: state.currentPlanVersion() };
    SNAPSHOT_FIELDS.forEach(function (key) {
      var value = state[key];
      if (key === 'replanSnapshot') value = state.replanned ? state.snapshot : null;
      if (key === 'interrupted') value = state.interrupted === true;
      if (key === 'consecutiveZeroDays') value = U.num(state.consecutiveZeroDays, 0);
      if (value === undefined) {
        value = (key === 'dayAssign' || key === 'locks' || key === 'attrCounts') ? {}
          : (key === 'consecutiveZeroDays' ? 0 : key === 'interrupted' ? false : key === 'replanHistory' ? [] : null);
      }
      out[key] = value;
    });
    if (!state.placementModel) {
      OPTIONAL_SNAPSHOT_FIELDS.forEach(function (key) { out[key] = U.clone(state[key]); });
    }
    return out;
  }

  function exportSnapshot() {
    return U.clone(snapshotFromState());
  }

  var TRANSACTION_KEYS = SNAPSHOT_FIELDS.concat([
    'snapshot', 'replanned', 'replanRecord', 'buffer', 'tiredAdopted', 'movedOut',
    'goalDraft', 'planDraft', 'running', 'timerStart', 'pausedAt', 'pausedTotal'
  ]);
  state.transact = function (mutate, options) {
    if (typeof mutate !== 'function') throw new TypeError('state.transact 需要函数');
    var before = {};
    TRANSACTION_KEYS.forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(state, key)) before[key] = U.clone(state[key]);
    });
    var previousRaw = null;
    var rawRead = false;
    try { previousRaw = window.localStorage.getItem(OVERLAY_KEY); rawRead = true; }
    catch (e) { /* 存储不可用时仍提供内存回滚 */ }
    try {
      var result = mutate();
      if (!options || options.save !== false) {
        if (saveOverlay() === false) throw new Error('本机保存失败，变更已回滚');
      }
      return result;
    } catch (error) {
      TRANSACTION_KEYS.forEach(function (key) {
        if (!Object.prototype.hasOwnProperty.call(before, key)) return;
        state[key] = before[key];
      });
      versionId = null;
      versionInput = null;
      if (rawRead && (!options || options.save !== false)) {
        try {
          var currentRaw = window.localStorage.getItem(OVERLAY_KEY);
          if (currentRaw === previousRaw || currentRaw === overlayWriteAttempt || currentRaw === overlayVerifiedRaw) {
            if (previousRaw === null) window.localStorage.removeItem(OVERLAY_KEY);
            else window.localStorage.setItem(OVERLAY_KEY, previousRaw);
          }
        } catch (rollbackError) { /* 外部变更或存储不可读时不覆盖 */ }
      }
      lastOverlayRaw = previousRaw;
      lastPersistedBusiness = businessJson(snapshotFromState());
      setOverlaySaveStatus(true);
      throw error;
    }
  };

  /* 启动渲染无权替用户决定“覆盖损坏数据”。只有显式导入或删除才能解除熔断。 */
  function setLocalLoadFailure(kind, message) {
    localLoadError = { kind: kind, message: message, at: Date.now() };
    localLoadBlocked = true;
    state.localLoadFailed = true;
    state.localLoadError = localLoadError;
    setOverlaySaveStatus(true);
    if (window.console && typeof window.console.warn === 'function') {
      window.console.warn('[zx] 本地 overlay 加载失败，已暂停覆盖：' + kind + ' · ' + message);
    }
  }

  function clearLocalLoadFailure() {
    localLoadError = null;
    localLoadBlocked = false;
    state.localLoadFailed = false;
    state.localLoadError = null;
  }

  function validateOverlayShape(o) {
    var arrayFields = ['tasks', 'sessions', 'week', 'weekShift', 'replanHistory'];
    var objectFields = ['goal', 'feas', 'dayAssign', 'locks', 'attrCounts'];
    var i;
    for (i = 0; i < arrayFields.length; i++) {
      if (o[arrayFields[i]] !== undefined && (!Array.isArray(o[arrayFields[i]]) ||
          o[arrayFields[i]].some(function (item) { return !isObject(item); }))) return false;
    }
    for (i = 0; i < objectFields.length; i++) {
      if (o[objectFields[i]] !== undefined && !isObject(o[objectFields[i]])) return false;
    }
    if (o.avail !== undefined && o.avail !== null &&
        (!Array.isArray(o.avail) || o.avail.length !== 7 || o.avail.some(function (row) {
          return !Array.isArray(row) || row.length !== 4;
        }))) return false;
    if (o.availSource !== undefined && o.availSource !== null &&
        ['default', 'user', 'legacy'].indexOf(o.availSource) < 0) return false;
    if (o.notif !== undefined && o.notif !== null && !isObject(o.notif) && !Array.isArray(o.notif)) return false;
    if (o.consecutiveZeroDays !== undefined && (typeof o.consecutiveZeroDays !== 'number' || !isFinite(o.consecutiveZeroDays))) return false;
    if (o.interrupted !== undefined && o.interrupted !== null && typeof o.interrupted !== 'boolean') return false;
    if (o.buffer !== undefined && (!isObject(o.buffer) || typeof o.buffer.free !== 'boolean' ||
        (o.buffer.time !== undefined && typeof o.buffer.time !== 'string'))) return false;
    if (o.tiredAdopted !== undefined && typeof o.tiredAdopted !== 'boolean') return false;
    if (o.rescueRecord !== undefined && o.rescueRecord !== null && !isObject(o.rescueRecord)) return false;
    if (['week', 'weekShift'].some(function (key) {
      return Array.isArray(o[key]) && o[key].some(function (day) {
        return day.segs !== undefined && (!Array.isArray(day.segs) || day.segs.some(function (seg) {
          return !((Array.isArray(seg) && seg.length >= 2) ||
            (typeof seg === 'number' && isFinite(seg)));
        }));
      });
    })) return false;
    if (o.replanSnapshot !== undefined && o.replanSnapshot !== null &&
        (!isObject(o.replanSnapshot) || !Array.isArray(o.replanSnapshot.tasks) ||
        o.replanSnapshot.tasks.some(function (task) { return !isObject(task); }))) return false;
    if (o.planVersion !== undefined && typeof o.planVersion !== 'string') return false;
    var taskIds = Object.create(null);
    function invalidNumbers(obj, keys) {
      return keys.some(function (key) {
        return obj[key] !== undefined && obj[key] !== null &&
          (typeof obj[key] !== 'number' || !isFinite(obj[key]) || obj[key] < 0);
      });
    }
    if (Array.isArray(o.tasks)) {
      for (i = 0; i < o.tasks.length; i++) {
        var task = o.tasks[i];
        if (typeof task.id !== 'string' || !task.id || taskIds[task.id]) return false;
        taskIds[task.id] = true;
        if (invalidNumbers(task, ['est', 'weight', 'actual', 'plannedEst', 'completion', 'partial'])) return false;
        if (task.time !== undefined && typeof task.time !== 'string') return false;
      }
    }
    if (Array.isArray(o.sessions)) {
      var sessionIds = Object.create(null);
      for (i = 0; i < o.sessions.length; i++) {
        var session = o.sessions[i];
        if (typeof session.id !== 'string' || !session.id || sessionIds[session.id]) return false;
        sessionIds[session.id] = true;
        if (typeof session.taskId !== 'string' || (taskIds && !taskIds[session.taskId])) return false;
        if (invalidNumbers(session, ['minutes', 'startAt', 'endAt', 'completion'])) return false;
      }
    }
    if (o.goal && o.goal.weeks !== undefined && (typeof o.goal.weeks !== 'number' || !isFinite(o.goal.weeks) || o.goal.weeks < 0)) return false;
    if (o.feas) {
      if (invalidNumbers(o.feas, ['weeklyH', 'weeks', 'discount', 'demand'])) return false;
      if (o.feas.discount !== undefined && o.feas.discount > 1) return false;
    }
    if (o.dayAssign && Object.keys(o.dayAssign).some(function (id) {
      return !taskIds || !taskIds[id] || ['日', '一', '二', '三', '四', '五', '六'].indexOf(o.dayAssign[id]) < 0;
    })) return false;
    if (o.locks && Object.keys(o.locks).some(function (id) { return !taskIds || !taskIds[id]; })) return false;
    if (o.attrCounts && invalidNumbers(o.attrCounts, Object.keys(o.attrCounts))) return false;
    if (o.placementModel !== undefined && o.placementModel !== null) {
      var P = placementModel();
      if (!P || !Array.isArray(o.tasks)) return false;
      try {
        var model = P.normalizeModel(o.placementModel);
        var taskIds = Object.create(null);
        o.tasks.forEach(function (task) { taskIds[String(task.id)] = true; });
        if (model.placements.some(function (placement) { return !taskIds[placement.taskId]; }) ||
            model.unplanned.some(function (item) { return !taskIds[item.taskId]; })) return false;
      } catch (e) { return false; }
    }
    return true;
  }

  function setOverlaySaveStatus(failed) {
    state.overlaySaveFailed = failed;
    state.overlayConflict = overlayConflict;
    /* main.js 挂载回调前由 state.js 先置位；settings.init 再补显式告警。 */
    if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
      var warning = document.getElementById('saveWarning');
      if (warning) {
        warning.hidden = !failed;
        warning.textContent = localLoadError
          ? '本地数据加载失败，原数据已保留且暂停覆盖。请导入完整备份，或确认后删除全部数据。'
          : overlayConflict
            ? '另一标签页已修改本机数据，当前页面已暂停保存以免覆盖。请先导出本页备份，再刷新页面。'
            : '本机保存失败，当前修改可能在刷新后丢失。';
      }
    }
    if (typeof ZX.onOverlaySaveStatus === 'function') {
      try { ZX.onOverlaySaveStatus(); } catch (e) { /* 提示失败不改变写入结果 */ }
    }
  }

  function businessJson(snapshot) {
    return JSON.stringify([snapshot.planVersion].concat(SNAPSHOT_FIELDS.map(function (key) {
      return snapshot[key] === undefined ? null : snapshot[key];
    })).concat(OPTIONAL_SNAPSHOT_FIELDS.map(function (key) {
      return snapshot[key] === undefined ? null : snapshot[key];
    })));
  }

  function setOverlayConflict() {
    overlayConflict = true;
    setOverlaySaveStatus(true);
  }

  function acceptOverlayMetadata(raw, stored) {
    lastOverlayRaw = raw;
    overlayRevision = Number.isInteger(stored.revision) && stored.revision >= 0 ? stored.revision : overlayRevision;
    overlayUpdatedAt = typeof stored.updatedAt === 'number' && isFinite(stored.updatedAt) ? stored.updatedAt : overlayUpdatedAt;
    state.overlayRevision = overlayRevision;
    state.overlayUpdatedAt = overlayUpdatedAt;
  }

  function saveOverlay(forceReplace, replaceRaw) {
    overlayWriteAttempt = null;
    overlayVerifiedRaw = null;
    if (localLoadBlocked) {
      setOverlaySaveStatus(true);
      return false;
    }
    if (overlayConflict) {
      setOverlaySaveStatus(true);
      return false;
    }
    try {
      var snapshot = snapshotFromState();
      var currentBusiness = businessJson(snapshot);
      var storedRaw = window.localStorage.getItem(OVERLAY_KEY);
      if (storedRaw === undefined) storedRaw = null;
      var canForceReplace = forceReplace === true && storedRaw === replaceRaw;
      if (canForceReplace) {
        try {
          var replacement = JSON.parse(storedRaw);
          if (isObject(replacement) && Number.isSafeInteger(replacement.revision) && replacement.revision >= 0) {
            overlayRevision = Math.max(overlayRevision, replacement.revision);
          }
        } catch (e) { /* 非法 JSON 没有可保留的 revision */ }
      }
      if (!canForceReplace && storedRaw !== lastOverlayRaw) {
        if (storedRaw === null) {
          if (lastPersistedBusiness !== null) {
            setOverlayConflict();
            return false;
          }
        } else {
          var stored = JSON.parse(storedRaw);
          if (!isObject(stored) || businessJson(stored) !== lastPersistedBusiness ||
              typeof stored.revision !== 'number' || !Number.isInteger(stored.revision) || stored.revision < 0) {
            setOverlayConflict();
            return false;
          }
          acceptOverlayMetadata(storedRaw, stored);
        }
      }
      var now = Date.now();
      var revision = overlayRevision + 1;
      var raw = JSON.stringify(Object.assign({
        format: OVERLAY_FORMAT,
        version: OVERLAY_VERSION,
        installId: getInstallId(),
        syncMode: 'local-only',
        revision: revision,
        updatedAt: now,
        at: now
      }, snapshot));
      overlayWriteAttempt = raw;
      window.localStorage.setItem(OVERLAY_KEY, raw);
      if (window.localStorage.getItem(OVERLAY_KEY) !== raw) throw new Error('overlay not saved');
      overlayVerifiedRaw = raw;
      overlayWriteAttempt = null;
      lastOverlayRaw = raw;
      lastPersistedBusiness = currentBusiness;
      overlayRevision = revision;
      overlayUpdatedAt = now;
      state.overlayRevision = revision;
      state.overlayUpdatedAt = now;
      setOverlaySaveStatus(false);
      return true;
    } catch (e) {
      /* 会话内仍可用，但必须提示刷新可能丢失；不记录错误内容或用户数据。 */
      setOverlaySaveStatus(true);
      return false;
    }
  }

  function canDropOverlay() {
    if (overlayConflict) return false;
    try {
      var raw = window.localStorage.getItem(OVERLAY_KEY);
      if (raw === undefined) raw = null;
      return raw === lastOverlayRaw;
    } catch (e) {
      return false;
    }
  }

  function dropOverlay() {
    if (overlayConflict) return false;
    try {
      var storedRaw = window.localStorage.getItem(OVERLAY_KEY);
      if (storedRaw === undefined) storedRaw = null;
      if (storedRaw !== lastOverlayRaw) {
        setOverlayConflict();
        return false;
      }
      window.localStorage.removeItem(OVERLAY_KEY);
      if (window.localStorage.getItem(OVERLAY_KEY) != null) throw new Error('overlay not removed');
    } catch (e) {
      var absent = false;
      try { absent = window.localStorage.getItem(OVERLAY_KEY) == null; } catch (readError) { /* 无法确认 */ }
      setOverlaySaveStatus(true);
      return absent ? 'unverified' : false;
    }
    lastOverlayRaw = null;
    lastPersistedBusiness = null;
    overlayRevision = 0;
    overlayUpdatedAt = 0;
    state.overlayRevision = 0;
    state.overlayUpdatedAt = 0;
    clearLocalLoadFailure();
    setOverlaySaveStatus(false);
    if (ZX.api && ZX.api.invalidatePendingSync) ZX.api.invalidatePendingSync();
    /* 旧队列与待复核计划只隔离、不删除，避免破坏独立审查要求保留的原字节。 */
    try { window.localStorage.removeItem('zx.replanTrace'); } catch (e) { /* 忽略 */ }
    try { window.localStorage.removeItem('zx.scheduleTrace'); } catch (e) { /* 忽略 */ }
    try { window.localStorage.removeItem('zx.executionTrace'); } catch (e) { /* 忽略 */ }
    try { window.localStorage.removeItem('zx.syncTrace'); } catch (e) { /* 忽略 */ }
    return true;
  }

  /* 启动时是否已加载本机 overlay；本地主数据不采纳服务端业务状态。 */
  var bootOverlayLoaded = false;

  function applyBusinessOverlay(o) {
    if (Array.isArray(o.sessions)) state.sessions = o.sessions;
    if (Array.isArray(o.tasks)) state.tasks = o.tasks.map(normTask);
    if (isObject(o.goal)) state.goal = o.goal;
    if (isObject(o.feas)) state.feas = o.feas;
    if (Array.isArray(o.week)) state.week = normWeek(o.week);
    if (Array.isArray(o.weekShift)) state.weekShift = normWeek(o.weekShift);
    var P = placementModel();
    state.placementModel = o.placementModel == null ? null : P.normalizeModel(o.placementModel);
    if (state.placementModel) {
      syncPlacementProjection();
    }
    /* 手工改期 / 锁定 / 可用时段 / 通知开关：此前只发 op 不入 overlay，刷新即丢 */
    if (isObject(o.dayAssign)) state.dayAssign = o.dayAssign;
    if (isObject(o.locks)) state.locks = o.locks;
    if (Array.isArray(o.avail) && o.avail.length === 7) {
      state.avail = o.avail;
      state.availSource = ['default', 'user', 'legacy'].indexOf(o.availSource) >= 0 ? o.availSource : 'legacy';
    } else if (o.avail === null) {
      state.avail = null;
      state.availSource = o.availSource === undefined ? null : o.availSource;
    }
    if (isObject(o.notif)) state.notif = o.notif;
    else if (Array.isArray(o.notif)) state.notif = normNotif(o.notif);
    if (isObject(o.attrCounts)) state.attrCounts = o.attrCounts;
    if (!state.placementModel) {
      if (isObject(o.buffer)) state.buffer = Object.assign({}, state.buffer || {}, o.buffer);
      if (typeof o.tiredAdopted === 'boolean') state.tiredAdopted = o.tiredAdopted;
    }
    if (typeof o.consecutiveZeroDays === 'number' && isFinite(o.consecutiveZeroDays)) state.consecutiveZeroDays = o.consecutiveZeroDays;
    if (typeof o.interrupted === 'boolean') state.interrupted = o.interrupted;
    if (o.rescueRecord === null || isObject(o.rescueRecord)) state.rescueRecord = o.rescueRecord;
    if (Array.isArray(o.replanHistory)) state.replanHistory = o.replanHistory;
    if (Object.prototype.hasOwnProperty.call(o, 'replanSnapshot')) {
      var snap = o.replanSnapshot;
      state.snapshot = isObject(snap) && Array.isArray(snap.tasks) ? snap : null;
      state.replanned = state.snapshot !== null;
    }
    versionId = /^plan-[0-9a-f]{32}$/.test(o.planVersion) ? o.planVersion : null;
    versionInput = planInput();
  }

  function applyOverlay() {
    var raw, o;
    try { raw = window.localStorage.getItem(OVERLAY_KEY); } catch (e) {
      setLocalLoadFailure('storage', '无法读取本机数据');
      return false;
    }
    if (raw === null || raw === undefined) {
      clearLocalLoadFailure();
      setOverlaySaveStatus(false);
      return false;
    }
    lastOverlayRaw = raw;
    unreadableOverlayRaw = raw;
    try { o = JSON.parse(raw); } catch (e) {
      setLocalLoadFailure('corrupt', '本地数据不是有效 JSON');
      return false;
    }
    if (!isObject(o)) {
      setLocalLoadFailure('invalid', '本地数据格式无效');
      return false;
    }
    var v = o.version === undefined ? 1 : o.version;
    if (typeof v === 'number' && Number.isInteger(v) && v > OVERLAY_VERSION) {
      setLocalLoadFailure('future-version', '本地数据来自更新版本（version=' + v + '）');
      return false;
    }
    if (!Number.isInteger(v) || v < 1 || (o.format !== undefined && o.format !== OVERLAY_FORMAT)) {
      setLocalLoadFailure('unsupported', '本地数据格式或版本不受支持');
      return false;
    }
    if (v >= 2 && (o.format !== OVERLAY_FORMAT || o.syncMode !== 'local-only' ||
        typeof o.installId !== 'string' || !o.installId.trim() ||
        !Number.isInteger(o.revision) || o.revision < 0 ||
        typeof o.updatedAt !== 'number' || !isFinite(o.updatedAt))) {
      setLocalLoadFailure('invalid', '本地数据元数据不完整');
      return false;
    }
    if (v >= 3 && (typeof o.planVersion !== 'string' || !o.planVersion ||
        SNAPSHOT_FIELDS.some(function (key) { return !Object.prototype.hasOwnProperty.call(o, key); }))) {
      setLocalLoadFailure('invalid', '本地 v3 业务快照字段不完整');
      return false;
    }
    if (!validateOverlayShape(o)) {
      setLocalLoadFailure('invalid', '本地业务数据结构损坏');
      return false;
    }
    try { applyBusinessOverlay(o); }
    catch (e) {
      setLocalLoadFailure('invalid', '本地业务数据无法安全应用');
      return false;
    }
    clearLocalLoadFailure();
    setOverlaySaveStatus(false);
    overlayRevision = v >= 2 ? o.revision : (Number.isInteger(o.revision) && o.revision >= 0 ? o.revision : 0);
    overlayUpdatedAt = typeof o.updatedAt === 'number' ? o.updatedAt : 0;
    state.overlayRevision = overlayRevision;
    state.overlayUpdatedAt = overlayUpdatedAt;
    lastOverlayRaw = raw;
    lastPersistedBusiness = businessJson(snapshotFromState());
    unreadableOverlayRaw = null;
    overlayConflict = false;
    state.overlayConflict = false;
    bootOverlayLoaded = true;
    return true;
  }

  /* 仅限已通过备份结构校验的显式导入；写入失败时恢复原加载熔断状态。 */
  function commitSnapshot(snapshot) {
    var previousError = localLoadError;
    var previousBlocked = localLoadBlocked;
    var replaceUnreadable = localLoadBlocked && unreadableOverlayRaw !== null;
    var previousSnapshot = exportSnapshot();
    applyBusinessOverlay(snapshot);
    expireDeferredTasks();
    ensurePlacementWindow();
    state.syncPlacementProjection();
    clearLocalLoadFailure();
    var saved = saveOverlay(replaceUnreadable, unreadableOverlayRaw);
    if (!saved) {
      applyBusinessOverlay(previousSnapshot);
      localLoadError = previousError;
      localLoadBlocked = previousBlocked;
      state.localLoadFailed = previousBlocked;
      state.localLoadError = previousError;
      setOverlaySaveStatus(true);
    } else {
      bootOverlayLoaded = true;
    }
    return saved;
  }

  function restorePlanVersion(value) {
    if (typeof value === 'string' && /^plan-[0-9a-f]{32}$/.test(value)) {
      versionId = value;
      versionInput = planInput();
    }
  }

  /* 启动恢复：种子之上叠加本地 overlay（新目标 / 记录 / 跳过 / 补录跨刷新存活） */
  bootOverlayLoaded = applyOverlay();

  if (typeof window.addEventListener === 'function') {
    window.addEventListener('storage', function (event) {
      if (event.key !== OVERLAY_KEY || event.newValue === lastOverlayRaw) return;
      var currentBusiness = businessJson(snapshotFromState());
      if (currentBusiness !== lastPersistedBusiness || event.newValue === null) {
        setOverlayConflict();
        return;
      }
      try {
        var stored = JSON.parse(event.newValue);
        if (!isObject(stored) || businessJson(stored) !== lastPersistedBusiness ||
            typeof stored.revision !== 'number' || !Number.isInteger(stored.revision) || stored.revision < 0) {
          setOverlayConflict();
          return;
        }
        acceptOverlayMetadata(event.newValue, stored);
      } catch (e) {
        setOverlayConflict();
      }
    });
  }

  /* ---------- 派生计算 ----------
     计划 / 已投入 / 剩余 / 达成率的统一口径在 flows/exec.metrics（过滤 skipped）；
     这里只保留与视图无关的 workedMin（挽救流程的缺口推演用）。 */
  state.workedMin = function () {
    return state.tasks.reduce(function (a, t) {
      return a + U.num(t.actual !== undefined ? t.actual : (t.done ? t.est : 0), 0);
    }, 0);
  };
  /* 计时四元组复位（记录完成 / 目标生效 / 删除数据等收尾共用） */
  state.resetTimer = function () {
    state.running = null;
    state.timerStart = null;
    state.pausedAt = null;
    state.pausedTotal = 0;
  };
  /* 新暂缓只对 deferredAt 的本地日期有效；跨日时自动恢复待办。
     缺少 deferredAt 的旧记录保留兼容语义，仍由用户显式恢复。
     只清元数据，不修改计划落点、日期或其他退役保护。 */
  function expireDeferredTasks() {
    var today = U.todayKey();
    var changed = false;
    state.tasks.forEach(function (task) {
      if (!task || task.deferred !== true || task.deferredAt === undefined || task.deferredAt === null) return;
      var deferredDay = U.dayKey(task.deferredAt);
      if (deferredDay && deferredDay === today) return;
      delete task.deferred;
      delete task.deferredTo;
      delete task.deferredAt;
      delete task.deferredReason;
      changed = true;
    });
    return changed;
  }
  /* 固定窗口滚动到今天：同一天不重排、不改 ID；未来窗口不回退到过去。 */
  function ensurePlacementWindow() {
    var P = placementModel();
    if (!state.placementModel || !P) return false;
    var today = U.todayKey();
    if (state.placementModel.startDate === today || today < state.placementModel.startDate) return false;
    state.placementModel = P.rollWindow(state.placementModel, today, 'pm_roll_' + Date.now().toString(36) + '_');
    if (typeof state.syncPlacementProjection === 'function') state.syncPlacementProjection();
    return true;
  }
  state.placementAvailabilityMatches = function () {
    var P = placementModel();
    if (!state.placementModel || !P) return true;
    var goal = ZX.flows && ZX.flows.goal;
    if (!goal || typeof goal.buildSlots !== 'function') return null;
    var dates = state.placementModel.days.map(function (day) { return day.date; });
    return P.matchesSlots(state.placementModel, goal.buildSlots(dates[dates.length - 1], dates[0]));
  };
  state.feasInput = function () {
    return {
      weeklyH: state.feas.weeklyH,
      weeks: state.feas.weeks,
      discount: state.feas.discount,
      demand: state.feas.demand
    };
  };
  /* 无目标不是 R=0，也没有可行性结论；调用方须先处理 null。
     有目标但参数非法时仍由引擎报错，不把损坏数据伪装成空态。 */
  state.hasGoal = function () {
    return !!(state.goal && state.goal.source !== 'removed' &&
      typeof state.goal.name === 'string' && state.goal.name.trim());
  };
  /* 渲染路径：同步本地确定性纯函数（与后端同语义，不产生 UI 抖动） */
  state.feasibility = function () {
    return state.hasGoal() ? ZX.engine.feasibilityNow(state.feasInput()) : null;
  };
  state.weekInput = function () {
    ensurePlacementWindow();
    var P = placementModel();
    if (state.placementModel && P) return P.replanWeek(state.placementModel, state.tasks, state.locks || {});
    return state.week.map(function (d) {
      return {
        date: d.d,
        minutes: U.num(d.total, 0),
        buffer: U.num(d.buf, 0),
        capacity: U.num(d.capacityMin, U.num(d.capacity, 300)),
        bufferUsed: U.num(d.bufferUsed, U.num(d.bufferUsedMin, 0)),
        releasedMinutes: U.num(d.releasedMinutes, 0),
        releasedBufferMinutes: U.num(d.releasedBufferMinutes, 0)
      };
    });
  };
  state.placementSummary = function () {
    var P = placementModel();
    return state.placementModel && P ? P.summary(state.placementModel) : null;
  };
  var segmentMapModel = null;
  var segmentMap = null;
  state.taskSegmentsMap = function () {
    var P = placementModel();
    if (!state.placementModel || !P) return Object.create(null);
    if (segmentMapModel !== state.placementModel) {
      segmentMap = P.taskSegmentsMap(state.placementModel);
      segmentMapModel = state.placementModel;
    }
    return segmentMap;
  };
  state.taskSegments = function (taskId, date) {
    var segments = state.taskSegmentsMap()[String(taskId)] || [];
    if (!date) return segments.map(function (segment) { return Object.assign({}, segment); });
    return segments.filter(function (segment) { return segment.date === date; })
      .map(function (segment) { return Object.assign({}, segment); });
  };
  state.tasksOnDate = function (date) {
    expireDeferredTasks();
    ensurePlacementWindow();
    if (!state.placementModel) return state.tasks.slice();
    var segmentsById = state.taskSegmentsMap();
    return state.tasks.filter(function (task) {
      return (segmentsById[String(task.id)] || []).some(function (segment) { return segment.date === date; }) ||
        (task.done === true && U.dayKey(task.completedAt) === date) ||
        (task.skipped === true && U.dayKey(task.skippedAt) === date) ||
        (task.abandoned === true && U.dayKey(task.abandonedAt) === date) ||
        (task.substituted === true && U.dayKey(task.substitutedAt) === date);
    });
  };
  function syncPlacementProjection() {
    var P = placementModel();
    if (!state.placementModel || !P) return false;
    state.week = P.projectWeek(state.placementModel, state.tasks);
    state.weekShift = U.clone(state.week);
    var dayAssign = {};
    var segmentsById = typeof state.taskSegmentsMap === 'function' ? state.taskSegmentsMap() : P.taskSegmentsMap(state.placementModel);
    var pad = U.pad2;
    state.tasks.forEach(function (task) {
      var segments = segmentsById[String(task.id)] || [];
      if (segments.length) dayAssign[task.id] = ['日', '一', '二', '三', '四', '五', '六'][new Date(segments[0].date + 'T00:00:00Z').getUTCDay()];
      var first = segments[0];
      var last = segments[segments.length - 1];
      var from = first ? pad(Math.floor(first.startMin / 60)) + ':' + pad(first.startMin % 60) : '';
      var to = last ? pad(Math.floor((last.startMin + last.durMin) / 60)) + ':' + pad((last.startMin + last.durMin) % 60) : '';
      task.time = segments.length
        ? (first.date === last.date
          ? from + '–' + to
          : first.date.slice(5) + ' ' + from + '–' + last.date.slice(5) + ' ' + to)
        : '';
      task.date = segments.length ? segments[0].date : null;
      var unplaced = state.placementModel.unplanned.find(function (item) { return item.taskId === task.id; });
      if (unplaced) { task.unplanned = true; task.unplannedReason = unplaced.reason; }
      else { delete task.unplanned; delete task.unplannedReason; }
    });
    state.dayAssign = dayAssign;
    var today = U.todayKey();
    var day = state.placementModel.days.find(function (item) { return item.date === today; });
    var summary = P.summary(state.placementModel);
    var todaySummary = summary.days.find(function (item) { return item.date === today; });
    var windows = day ? day.windows.filter(function (item) { return item.isBuffer; }) : [];
    var pad = U.pad2;
    state.buffer = Object.assign({}, state.buffer || {}, {
      time: windows.length ? pad(Math.floor(windows[0].startMin / 60)) + ':' + pad(windows[0].startMin % 60) + '–' +
        pad(Math.floor(windows[windows.length - 1].endMin / 60)) + ':' + pad(windows[windows.length - 1].endMin % 60) : '',
      free: !todaySummary || todaySummary.bufferUsedMin === 0
    });
    return true;
  }
  state.syncPlacementProjection = syncPlacementProjection;
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
    expireDeferredTasks();
    ensurePlacementWindow();
    return {
      /* 原样带上 domain / freq / substituted / abandoned 等语义字段，避免重排丢上下文 */
      tasks: state.tasks.map(function (t) { return U.clone(t); }),
      week: state.weekInput(),
      allowBuffer: !!state.placementModel,
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

  /* boot overlay 已应用；此时派生函数和同步投影均已就绪。 */
  expireDeferredTasks();
  ensurePlacementWindow();
  state.syncPlacementProjection();

  ZX.SUBJ = SUBJ;
  ZX.state = state;
  ZX.state.saveOverlay = saveOverlay;
  ZX.state.dropOverlay = dropOverlay;
  ZX.state.canDropOverlay = canDropOverlay;
  ZX.state.overlayWriteEvidence = function () {
    return { attempt: overlayWriteAttempt, verified: overlayVerifiedRaw };
  };
  ZX.state.applyOverlay = applyOverlay;
  ZX.state.exportSnapshot = exportSnapshot;
  ZX.state.transact = state.transact;
  ZX.state.applySnapshot = applyBusinessOverlay;
  ZX.state.getInstallId = getInstallId;
  ZX.state.commitSnapshot = commitSnapshot;
  ZX.state.restorePlanVersion = restorePlanVersion;
  ZX.state.ensurePlacementWindow = ensurePlacementWindow;
  ZX.state.expireDeferredTasks = expireDeferredTasks;
  ZX.state.bootOverlayLoaded = function () { return bootOverlayLoaded; };
  ZX.state.normTask = normTask;

})(window.ZX);
