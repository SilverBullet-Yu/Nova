/* =========================================================
   诺瓦 Nova · 服务端计算接口 + 本地主数据隔离
   契约：docs/HANDOFF.md 第 5 / 6 节
   - 服务端仅保留 feasibility / schedule / replan / attribute / llm 计算能力
   - 本地主数据与业务确认均在本机完成；旧 zx.op_queue 只读隔离，不再上行
   - 鉴权：计算请求统一携带服务端签发的 Bearer 凭证
   ========================================================= */
window.ZX = window.ZX || {};

(function (ZX) {
  'use strict';

  var TIMEOUT = 3000;
  /* LLM 请求独立预算（2026-11-28 裁决）：与服务端 LLM_TIMEOUT_MS 缺省对齐；
     客户端固定 30s，不随服务端配置变化，服务端调高超过 30s 时客户端仍先中断降级 */
  var LLM_TIMEOUT = 30000;
  var DEFAULT_BASE = 'http://127.0.0.1:8787';
  var QUEUE_KEY = 'zx.op_queue';

  /* ---------- 身份凭证 ----------
     · 来源：POST /api/auth/session，服务端随机生成 userId 并签发 HMAC 凭证
     · 存储：localStorage['zx.auth_token'] = { token, userId, expiresAt }
     · 过期：服务端 7 天有效；本地先按 expiresAt 预判，服务端返回 401 时清空并重新签发一次
     · 不含任何可自造身份的字段：userId 只读自服务端响应，不回传服务端做身份判定 */
  var TOKEN_KEY = 'zx.auth_token';
  var AUTH_PATH = '/api/auth/session';

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

  function request(method, path, body, token, options) {
    options = options || {};
    var signal = options.signal;
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var stopped = null, httpStatus;
    var rejectStop;
    var interruption = new Promise(function (_, reject) { rejectStop = reject; });
    function stop(timeout) {
      if (stopped) return;
      stopped = new Error(timeout ? '请求超时，请稍后重试。' : '已取消请求');
      stopped.name = 'AbortError';
      if (timeout) {
        stopped.code = 'ETIMEDOUT';
        if (httpStatus) stopped.status = httpStatus;
      }
      rejectStop(stopped);
      if (ctrl) ctrl.abort();
    }
    function cancel() { stop(false); }
    if (signal) {
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    }
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

    var timer = setTimeout(function () { stop(true); }, options.timeout || TIMEOUT);
    var network = Promise.resolve().then(function () {
      if (stopped) throw stopped;
      return fetch(BASE + path, opts);
    }).then(function (res) {
      if (stopped) throw stopped;
      httpStatus = res.status;
      if (res.ok) return res.json();
      var err = new Error('HTTP ' + res.status);
      err.status = res.status;
      return Promise.resolve().then(function () { return res.json(); }).then(function (data) {
        if (data && data.error) {
          err.code = data.error.code;
          if (data.error.message) err.message = data.error.message;
        }
        throw err;
      }, function () {
        /* 空正文 / 非 JSON 错误页也保留 HTTP 状态，供 401 重签与在线判断使用。 */
        throw err;
      });
    }).finally(function () {
      /* 截止时间覆盖响应正文读取，而非仅等待响应头。 */
      clearTimeout(timer);
    });
    var pending = Promise.race([interruption, network]);
    return pending;
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

    var pending = request('POST', AUTH_PATH, {}).then(function (r) {
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

  function signedRequest(method, path, body, options) {
    var pub = PUBLIC_PATHS[path] === true;
    return (pub ? Promise.resolve(null) : ensureAuth()).then(function (token) {
      return request(method, path, body, token, options).catch(function (e) {
        /* 凭证过期或服务端密钥轮换：清空后重新签发一次再重试，不做循环重试 */
        if (pub || !e || e.status !== 401) throw e;
        clearToken();
        return ensureAuth().then(function (fresh) {
          return request(method, path, body, fresh, options);
        });
      });
    });
  }

  /* 统一出口：收到 HTTP 响应即视为在线；只有网络失败/超时才标记离线 */
  function call(method, path, body, options) {
    return signedRequest(method, path, body, options).then(function (r) {
      status.online = true;
      status.checked = true;
      status.lastError = null;
      emit();
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

  /* ---------- 旧 op 队列：只读隔离，禁止改写或上行 ---------- */
  function loadQueue() {
    try {
      var raw = window.localStorage.getItem(QUEUE_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  /* 本地主数据模式：保留调用兼容，但不再生成远端操作。 */
  function queueOp() { return null; }

  /* 支持界面只展示本地状态，不把隔离队列计为待同步。 */
  function pendingCount() { return 0; }

  function legacyPendingCount() {
    var q = loadQueue(), n = 0;
    for (var i = 0; i < q.length; i++) if (q[i] && q[i].pending) n++;
    return n;
  }

  function invalidatePendingSync() { /* 本地模式没有在途同步 */ }

  function flushQueue() {
    return Promise.resolve({
      status: 'isolated', sent: 0, accepted: [], pending: legacyPendingCount(),
      serverSeq: (ZX.state && typeof ZX.state.serverSeq === 'number') ? ZX.state.serverSeq : 0
    });
  }

  /* ---------- 对外接口：只暴露计算与健康检查 ---------- */
  var PLAN_KEY = 'zx.pending_plan';
  function pendingPlan() {
    try { return JSON.parse(window.localStorage.getItem(PLAN_KEY) || 'null'); } catch (e) { return null; }
  }
  function feasibility(p) { return call('POST', '/api/feasibility', p || {}); }
  function schedule(p) { return call('POST', '/api/schedule', p || {}); }
  function replan(p) { return call('POST', '/api/replan', p || {}); }
  function health() { return call('GET', '/api/health'); }
  /* LLM 理解与分析层：失败/未配置由服务端以 E5010/5011/5012 报出，调用方按码降级；
     使用独立 30s 预算（LLM_TIMEOUT），普通计算仍走 TIMEOUT 3s */
  function llmClarify(p) { return call('POST', '/api/llm/clarify', p || {}, { timeout: LLM_TIMEOUT }); }
  function llmAnalyze(p) { return call('POST', '/api/llm/analyze', p || {}, { timeout: LLM_TIMEOUT }); }

  ZX.api = {
    /* op 队列键名的单一事实源（settings.js 的 wipe 也按此键清队列） */
    QUEUE_KEY: QUEUE_KEY,

    /* 服务端计算与健康检查 */
    pendingPlan: pendingPlan,
    feasibility: feasibility,
    schedule: schedule,
    replan: replan,
    health: health,
    llmClarify: llmClarify,
    llmAnalyze: llmAnalyze,

    /* op 队列 */
    queueOp: queueOp,
    flushQueue: flushQueue,
    invalidatePendingSync: invalidatePendingSync,
    pendingCount: pendingCount,
    legacyPendingCount: legacyPendingCount,
    /* 测试锚点：只读检查隔离队列，不提供改写能力 */
    loadQueue: loadQueue,

    /* 连接状态 */
    isOnline: function () { return status.online; },
    onStatus: function (fn) { if (typeof fn === 'function') listeners.push(fn); }
  };

})(window.ZX);
