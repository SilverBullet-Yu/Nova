/* =========================================================
   诺瓦 Nova · 后端通信 + 降级 + op 队列
   契约：docs/HANDOFF.md 第 5 / 6 节
   - 超时 3000ms，超时或网络失败 → 抛错（由 engine.js 降级兜底）
   - 写操作先入 localStorage op 队列（键 zx.op_queue）
   ========================================================= */
window.ZX = window.ZX || {};

(function (ZX) {
  'use strict';

  var TIMEOUT = 3000;
  var DEFAULT_BASE = 'http://127.0.0.1:8787';
  var QUEUE_KEY = 'zx.op_queue';
  var MAX_QUEUE = 200;

  var opCounter = 0;

  function resolveBase() {
    var override = window.__ZX_API_BASE__;
    if (override) return String(override).replace(/\/+$/, '');
    try {
      var loc = window.location;
      /* http/https 一律优先用同源 origin：
         - 本地：后端 8787 静态托管前端，同源
         - 云端：反代域名下前后端同源，端口与域名均可能变化
         仅 file:// 才需要绝对地址。 */
      if (loc.protocol === 'http:' || loc.protocol === 'https:') {
        return loc.origin;
      }
    } catch (e) { /* file:// 场景 */ }
    /* file:// 打开时走绝对地址；若后端未加 CORS 头，前端自动降级，不阻断 UI */
    return DEFAULT_BASE;
  }

  var BASE = resolveBase();
  var status = { online: false, base: BASE, checked: false, lastError: null };
  var listeners = [];

  function emit() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](status); } catch (e) { /* 监听器异常不影响主链路 */ }
    }
  }

  function request(method, path, body) {
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (ctrl) { try { ctrl.abort(); } catch (e) {} }
    }, TIMEOUT);

    var opts = {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      mode: 'cors'
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    if (ctrl) opts.signal = ctrl.signal;

    return fetch(BASE + path, opts).then(function (res) {
      clearTimeout(timer);
      if (!res.ok) {
        var err = new Error('HTTP ' + res.status);
        err.status = res.status;
        throw err;
      }
      return res.json();
    }, function (e) {
      clearTimeout(timer);
      throw e;
    });
  }

  /* 统一出口：成功 → 标记在线；失败 → 标记离线并把错误抛给调用方（调用方负责降级） */
  function call(method, path, body) {
    return request(method, path, body).then(function (r) {
      status.online = true;
      status.checked = true;
      status.lastError = null;
      emit();
      return r;
    }, function (e) {
      status.online = false;
      status.checked = true;
      status.lastError = (e && e.message) ? e.message : String(e);
      emit();
      throw e;
    });
  }

  /* ---------- op 队列（C1 / C4 写路径） ---------- */
  function loadQueue() {
    try {
      var raw = window.localStorage.getItem(QUEUE_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function saveQueue(arr) {
    try { window.localStorage.setItem(QUEUE_KEY, JSON.stringify(arr.slice(-MAX_QUEUE))); }
    catch (e) { /* 隐私模式 / 配额不足：不影响主链路 */ }
  }

  function nextOpId() {
    opCounter += 1;
    return 'op_' + Date.now().toString(36) + '_' + opCounter;
  }

  /* clientTs 由前端生成（前端行为，允许用时钟） */
  function queueOp(op) {
    var o = op || {};
    var rec = {
      opId: o.opId || nextOpId(),
      entity: o.entity || 'task',
      entityId: o.entityId || '',
      field: o.field || '',
      value: (o.value === undefined) ? null : o.value,
      clientTs: Date.now(),
      baseSeq: (ZX.state && typeof ZX.state.serverSeq === 'number') ? ZX.state.serverSeq : 0,
      pending: true
    };
    var q = loadQueue();
    q.push(rec);
    saveQueue(q);
    emit();
    if (status.online) { try { flushQueue().catch(function () {}); } catch (e) {} }
    return rec;
  }

  function pendingCount() {
    var q = loadQueue(), n = 0;
    for (var i = 0; i < q.length; i++) if (q[i].pending) n++;
    return n;
  }

  function flushQueue() {
    var q = loadQueue();
    var pending = [];
    for (var i = 0; i < q.length; i++) if (q[i].pending) pending.push(q[i]);
    if (!pending.length) {
      return Promise.resolve({ accepted: [], serverSeq: (ZX.state ? ZX.state.serverSeq : 0) });
    }
    var payload = pending.map(function (o) {
      return {
        opId: o.opId, entity: o.entity, entityId: o.entityId,
        field: o.field, value: o.value, clientTs: o.clientTs, baseSeq: o.baseSeq
      };
    });
    return syncOps(payload).then(function (res) {
      var accepted = (res && res.accepted) || [];
      var cur = loadQueue();
      for (var j = 0; j < cur.length; j++) {
        if (accepted.indexOf(cur[j].opId) >= 0) cur[j].pending = false;
      }
      saveQueue(cur);
      if (res && typeof res.serverSeq === 'number' && ZX.state) ZX.state.serverSeq = res.serverSeq;
      emit();
      return res;
    });
  }

  /* ---------- 对外接口（HANDOFF 第 6 节） ---------- */
  function getState() { return call('GET', '/api/state'); }
  function feasibility(p) { return call('POST', '/api/feasibility', p || {}); }
  function schedule(p) { return call('POST', '/api/schedule', p || {}); }
  function replan(p) { return call('POST', '/api/replan', p || {}); }
  function undo(snapshot) { return call('POST', '/api/replan/undo', { snapshot: snapshot }); }
  function attribute(p) { return call('POST', '/api/attribute', p || {}); }
  function postSession(p) { return call('POST', '/api/sessions', p || {}); }
  function syncOps(ops) { return call('POST', '/api/sync/ops', { ops: ops || [] }); }
  function health() { return call('GET', '/api/health'); }
  function syncSince(n) { return call('GET', '/api/sync?since=' + (n || 0)); }
  function reportsWeekly() { return call('GET', '/api/reports/weekly'); }

  ZX.api = {
    TIMEOUT: TIMEOUT,
    QUEUE_KEY: QUEUE_KEY,
    base: BASE,

    /* 后端通信 */
    getState: getState,
    feasibility: feasibility,
    schedule: schedule,
    replan: replan,
    undo: undo,
    attribute: attribute,
    postSession: postSession,
    syncOps: syncOps,
    health: health,
    syncSince: syncSince,
    reportsWeekly: reportsWeekly,

    /* op 队列 */
    queueOp: queueOp,
    flushQueue: flushQueue,
    pendingCount: pendingCount,
    loadQueue: loadQueue,

    /* 连接状态 */
    isOnline: function () { return status.online; },
    status: function () { return status; },
    onStatus: function (fn) { if (typeof fn === 'function') listeners.push(fn); }
  };

})(window.ZX);
