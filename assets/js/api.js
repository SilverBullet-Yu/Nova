/* =========================================================
   诺瓦 Nova · 后端通信 + 降级 + op 队列
   契约：docs/HANDOFF.md 第 5 / 6 节
   - 超时 3000ms，超时或网络失败 → 抛错（由 engine.js 降级兜底）
   - 写操作先入 localStorage op 队列（键 zx.op_queue）
   - 鉴权：服务端签发 Bearer 凭证，业务请求统一携带
   ========================================================= */
window.ZX = window.ZX || {};

(function (ZX) {
  'use strict';

  var TIMEOUT = 3000;
  var DEFAULT_BASE = 'http://127.0.0.1:8787';
  var QUEUE_KEY = 'zx.op_queue';
  var MAX_QUEUE = 200;

  /* ---------- 身份凭证 ----------
     · 来源：POST /api/auth/session，服务端随机生成 userId 并签发 HMAC 凭证
     · 存储：localStorage['zx.auth_token'] = { token, userId, expiresAt }
     · 过期：服务端 7 天有效；本地先按 expiresAt 预判，服务端返回 401 时清空并重新签发一次
     · 不含任何可自造身份的字段：userId 只读自服务端响应，不回传服务端做身份判定 */
  var TOKEN_KEY = 'zx.auth_token';
  var AUTH_PATH = '/api/auth/session';

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

  function request(method, path, body, token) {
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (ctrl) { try { ctrl.abort(); } catch (e) {} }
    }, TIMEOUT);

    var headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;

    var opts = {
      method: method,
      headers: headers,
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

  /* ---------- 凭证读写 ---------- */
  function loadToken() {
    try {
      var raw = window.localStorage.getItem(TOKEN_KEY);
      if (!raw) return null;
      var rec = JSON.parse(raw);
      if (!rec || typeof rec.token !== 'string' || !rec.token) return null;
      /* 本地先按 expiresAt 预判，避免明知过期还发一次必然 401 的请求 */
      if (typeof rec.expiresAt === 'number' && rec.expiresAt <= Date.now()) {
        window.localStorage.removeItem(TOKEN_KEY);
        return null;
      }
      return rec;
    } catch (e) { return null; }
  }

  function saveToken(rec) {
    try { window.localStorage.setItem(TOKEN_KEY, JSON.stringify(rec)); }
    catch (e) { /* 隐私模式 / 配额不足：本次会话仍可使用内存中的凭证 */ }
  }

  function clearToken() {
    try { window.localStorage.removeItem(TOKEN_KEY); } catch (e) { /* 忽略 */ }
  }

  var authPromise = null;

  /* 确保存在可用凭证：没有就去服务端签发。并发调用共享同一个签发请求。 */
  function ensureAuth() {
    var rec = loadToken();
    if (rec) return Promise.resolve(rec.token);
    if (authPromise) return authPromise;

    var pending = fetch(BASE + AUTH_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      cache: 'no-store',
      mode: 'cors'
    }).then(function (res) {
      if (!res.ok) {
        var err = new Error('HTTP ' + res.status);
        err.status = res.status;
        throw err;
      }
      return res.json();
    }).then(function (r) {
      if (!r || typeof r.token !== 'string' || !r.token) throw new Error('凭证签发失败');
      saveToken({ token: r.token, userId: r.userId, expiresAt: r.expiresAt });
      return r.token;
    });

    /* 无论成功失败都释放锁，失败时下次调用可重新签发 */
    authPromise = pending.then(function (t) { authPromise = null; return t; },
      function (e) { authPromise = null; throw e; });
    return authPromise;
  }

  /* 公开路由不携带凭证；其余一律先确保凭证 */
  var PUBLIC_PATHS = { '/api/health': true, '/api/auth/session': true };

  function signedRequest(method, path, body) {
    var pub = PUBLIC_PATHS[path] === true;
    return (pub ? Promise.resolve(null) : ensureAuth()).then(function (token) {
      return request(method, path, body, token).catch(function (e) {
        /* 凭证过期或服务端密钥轮换：清空后重新签发一次再重试，不做循环重试 */
        if (pub || !e || e.status !== 401) throw e;
        clearToken();
        return ensureAuth().then(function (fresh) {
          return request(method, path, body, fresh);
        });
      });
    });
  }

  /* 统一出口：收到 HTTP 响应即视为在线；只有网络失败/超时才标记离线 */
  function call(method, path, body) {
    return signedRequest(method, path, body).then(function (r) {
      var recovered = status.checked && !status.online;
      status.online = true;
      status.checked = true;
      status.lastError = null;
      emit();
      /* 首次启动由 probeBackend 在采纳状态后补传；同步请求本身不递归触发。 */
      if (recovered && path !== '/api/sync/ops') flushQueue().catch(function () {});
      return r;
    }, function (e) {
      var reached = !!(e && typeof e.status === 'number');
      status.online = reached;
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

  function traceSync(status, payload, acceptedIds, planVersion) {
    try {
      var store = window.localStorage, key = 'zx.syncTrace';
      var events = JSON.parse(store.getItem(key) || '[]');
      var bytes = crypto.getRandomValues(new Uint8Array(16));
      var id = 'sync-' + Array.from(bytes, function (v) { return v.toString(16).padStart(2, '0'); }).join('');
      var event = {
        id: id, tool: 'sync', at: Date.now(), planVersion: planVersion,
        rulesVersion: 'nova-sync-p0-1', status: status, sent: payload.length,
        accepted: payload.filter(function (op) { return acceptedIds.indexOf(op.opId) >= 0; }).length
      };
      var sessions = payload.filter(function (op) {
        return op.entity === 'session' && op.field === 'recorded' && op.value &&
          typeof op.value.id === 'string' && /^s_[0-9a-z]{1,16}_[0-9]{1,16}$/.test(op.value.id);
      }).map(function (op) {
        return { id: op.value.id, confirmed: acceptedIds.indexOf(op.opId) >= 0 };
      });
      if (sessions.length) event.sessions = sessions;
      store.setItem(key, JSON.stringify((Array.isArray(events) ? events : []).slice(-99).concat([event])));
    } catch (e) { /* 留痕失败不影响队列 */ }
  }

  var syncGeneration = 0;
  function invalidatePendingSync() { syncGeneration++; }

  function flushQueue() {
    var generation = syncGeneration;
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
    var planVersion = ZX.state && ZX.state.currentPlanVersion ? ZX.state.currentPlanVersion() : null;
    return syncOps(payload).then(function (res) {
      if (generation !== syncGeneration) return res;
      var accepted = (res && res.accepted) || [];
      var cur = loadQueue();
      for (var j = 0; j < cur.length; j++) {
        if (accepted.indexOf(cur[j].opId) >= 0) cur[j].pending = false;
      }
      saveQueue(cur);
      if (res && typeof res.serverSeq === 'number' && ZX.state) ZX.state.serverSeq = res.serverSeq;
      var count = payload.filter(function (op) { return accepted.indexOf(op.opId) >= 0; }).length;
      traceSync(count === payload.length ? 'accepted' : count ? 'partial' : 'unconfirmed', payload, accepted, planVersion);
      emit();
      return res;
    }, function (err) {
      if (generation === syncGeneration) traceSync('failed', payload, [], planVersion);
      throw err;
    });
  }

  /* ---------- 对外接口（HANDOFF 第 6 节） ---------- */
  var PLAN_KEY = 'zx.pending_plan';
  var PLAN_BASE = 'zx.server_plan_version';
  var planInFlight = null;
  function readPlanKey(key) {
    try { return JSON.parse(window.localStorage.getItem(key) || 'null'); } catch (e) { return null; }
  }
  function writePlanKey(key, value) {
    window.localStorage.setItem(key, JSON.stringify(value));
  }
  function pendingPlan() { return readPlanKey(PLAN_KEY); }
  function clearPendingPlan() { window.localStorage.removeItem(PLAN_KEY); }
  function stagePlan(input, result) {
    var base = readPlanKey(PLAN_BASE);
    var p = { id: crypto.randomUUID(), input: input, result: result };
    if (base) p.base = base.version;
    if (ZX.state && ZX.state.currentPlanVersion) p.localVersion = ZX.state.currentPlanVersion();
    writePlanKey(PLAN_KEY, p);
    return p;
  }
  function reviewPlan(ticket) {
    var p = pendingPlan();
    if (!p) return Promise.resolve(null);
    if (planInFlight) return planInFlight;
    var body = ticket ? Object.assign({}, p, { ticket: ticket }) : p;
    planInFlight = call('POST', '/api/plan/review', body).then(function (r) {
      var current = pendingPlan();
      if (r && r.status === 'committed' && current && current.id === p.id) {
        writePlanKey(PLAN_BASE, { version: r.version });
        clearPendingPlan();
      }
      return r;
    }).finally(function () { planInFlight = null; });
    return planInFlight;
  }
  function getState() {
    return call('GET', '/api/state').then(function (r) {
      if (!pendingPlan()) {
        try { writePlanKey(PLAN_BASE, { version: r.planBaseline ? r.planBaseline.version : null }); } catch (e) { /* 本地存储不可用 */ }
      }
      return r;
    });
  }
  function feasibility(p) { return call('POST', '/api/feasibility', p || {}); }
  function schedule(p) { return call('POST', '/api/schedule', p || {}); }
  function replan(p) { return call('POST', '/api/replan', p || {}); }
  function confirmReplan(draftId) { return call('POST', '/api/replan/confirm', { draftId: draftId }); }
  function undo(snapshot) { return call('POST', '/api/replan/undo', { snapshot: snapshot }); }
  function syncOps(ops) { return call('POST', '/api/sync/ops', { ops: ops || [] }); }
  function health() { return call('GET', '/api/health'); }

  ZX.api = {
    TIMEOUT: TIMEOUT,
    QUEUE_KEY: QUEUE_KEY,
    base: BASE,

    /* 后端通信 */
    getState: getState,
    stagePlan: stagePlan,
    pendingPlan: pendingPlan,
    clearPendingPlan: clearPendingPlan,
    reviewPlan: reviewPlan,
    feasibility: feasibility,
    schedule: schedule,
    replan: replan,
    confirmReplan: confirmReplan,
    undo: undo,
    syncOps: syncOps,
    health: health,

    /* op 队列 */
    queueOp: queueOp,
    flushQueue: flushQueue,
    invalidatePendingSync: invalidatePendingSync,
    pendingCount: pendingCount,
    loadQueue: loadQueue,

    /* 连接状态 */
    isOnline: function () { return status.online; },
    status: function () { return status; },
    onStatus: function (fn) { if (typeof fn === 'function') listeners.push(fn); }
  };

})(window.ZX);
