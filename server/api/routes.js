'use strict';
/* 诺瓦 Nova · REST 路由
 *
 * 契约：docs/HANDOFF.md §5（路径 / 请求 / 响应）+ 附录 B 错误码
 * 错误统一形状：{ error: { code, message } }
 */

const { feasibility } = require('../../shared/engine/feasibility.js');
const { schedule } = require('../../shared/engine/schedule.js');
const { replan, confirmReplan, undoReplan } = require('../../shared/engine/replan.js');
const { attribute } = require('../../shared/engine/attribute.js');

const VERSION = '1.0.0';

/* 附录 B 错误码 → HTTP 状态码
 * E1001 参数非法 / 缺失        → 400
 * E2001 资源不存在             → 404
 * E3001 状态冲突               → 409
 * E3002 资源已存在             → 409
 * E4001 幂等键重复（视为成功）  → 200
 * E4002 请求体过大 / 批量超限  → 400
 * E4010 未提供或凭证无效       → 401
 * E4030 越权访问（身份不一致）  → 403
 * E4290 请求过于频繁           → 429
 * E5001 服务内部错误           → 500
 * E9001 未分类异常             → 500
 */
const ERRORS = {
  E1001: { status: 400, message: '请求参数非法或缺失' },
  E2001: { status: 404, message: '资源不存在' },
  E3001: { status: 409, message: '状态冲突' },
  E3002: { status: 409, message: '资源已存在' },
  E4001: { status: 200, message: '幂等键重复，已返回首次结果' },
  E4002: { status: 400, message: '请求体过大或单批操作超过上限 200' },
  E4010: { status: 401, message: '未提供有效凭证' },
  E4030: { status: 403, message: '无权访问该用户数据' },
  E4290: { status: 429, message: '请求过于频繁' },
  E5001: { status: 500, message: '服务内部错误' },
  E9001: { status: 500, message: '未分类异常' }
};

class ApiError extends Error {
  constructor(code, message) {
    super(message || (ERRORS[code] ? ERRORS[code].message : '未知错误'));
    this.name = 'ApiError';
    this.code = code;
    this.status = ERRORS[code] ? ERRORS[code].status : 500;
  }
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function needObject(body) {
  if (!isPlainObject(body)) throw new ApiError('E1001', '请求体必须是 JSON 对象');
  return body;
}

function needArray(v, name) {
  if (!Array.isArray(v)) throw new ApiError('E1001', name + ' 必须是数组');
  return v;
}

function needString(v, name) {
  if (typeof v !== 'string' || !v.length) throw new ApiError('E1001', name + ' 必须是非空字符串');
  return v;
}

function needNumber(v, name, opts) {
  const o = opts || {};
  if (typeof v !== 'number' || !isFinite(v)) throw new ApiError('E1001', name + ' 必须是有限数值');
  if (o.min !== undefined && v < o.min) throw new ApiError('E1001', name + ' 不得小于 ' + o.min);
  if (o.max !== undefined && v > o.max) throw new ApiError('E1001', name + ' 不得大于 ' + o.max);
  return v;
}

/** 引擎入参校验：字段存在则必须是有限数值 */
function checkNumericFields(obj, fields) {
  fields.forEach((f) => {
    if (obj[f] !== undefined && obj[f] !== null) needNumber(obj[f], f);
  });
}

function createRouter(store, auth) {
  /* ── GET /api/health ── */
  function health() {
    return {
      ok: true,
      version: VERSION,
      uptimeMs: Math.floor(process.uptime() * 1000)
    };
  }

  /* ── POST /api/auth/session ── */
  /* 唯一无需凭证的业务入口：服务端生成随机 userId 并签发凭证，不接受任何客户端身份字段 */
  function authSessionRoute() {
    return auth.issueSession();
  }

  /* ── GET /api/state ── */
  function state(userId) {
    return store.getState(userId);
  }

  /* ── POST /api/feasibility ── */
  function feasibilityRoute(body) {
    const b = needObject(body);
    ['weeklyH', 'weeks', 'discount', 'demand'].forEach((f) => {
      if (b[f] === undefined || b[f] === null) throw new ApiError('E1001', '缺少字段 ' + f);
      needNumber(b[f], f);
    });
    return feasibility({
      weeklyH: b.weeklyH,
      weeks: b.weeks,
      discount: b.discount,
      demand: b.demand
    });
  }

  /* ── POST /api/schedule ── */
  function scheduleRoute(body) {
    const b = needObject(body);
    if (b.tasks === undefined) throw new ApiError('E1001', '缺少字段 tasks');
    if (b.slots === undefined) throw new ApiError('E1001', '缺少字段 slots');
    needArray(b.tasks, 'tasks');
    needArray(b.slots, 'slots');
    if (b.params !== undefined && b.params !== null && !isPlainObject(b.params)) {
      throw new ApiError('E1001', 'params 必须是对象');
    }
    return schedule({ tasks: b.tasks, slots: b.slots, params: b.params || {} });
  }

  /* ── POST /api/replan ── */
  function replanRoute(body, userId) {
    const b = needObject(body);
    if (b.tasks === undefined) throw new ApiError('E1001', '缺少字段 tasks');
    if (b.week === undefined) throw new ApiError('E1001', '缺少字段 week');
    needArray(b.tasks, 'tasks');
    needArray(b.week, 'week');
    if (b.params !== undefined && b.params !== null && !isPlainObject(b.params)) {
      throw new ApiError('E1001', 'params 必须是对象');
    }
    if (b.history !== undefined && b.history !== null && !isPlainObject(b.history)) {
      throw new ApiError('E1001', 'history 必须是对象');
    }
    const result = replan({
      tasks: b.tasks,
      week: b.week,
      params: b.params || {},
      history: b.history || {},
      locks: b.locks,
      timestamp: b.timestamp === undefined ? null : b.timestamp
    });
    /* L4 放弃需用户确认：needsConfirmation 的结果不落库 */
    if (result.accepted === true) store.recordReplan(userId, result);
    return result;
  }

  /* ── POST /api/replan/confirm ──
     用途：用户确认 L4 放弃建议后落库。只接受 needsConfirmation=true 的结果。 */
  function replanConfirmRoute(body, userId) {
    const b = needObject(body);
    if (!isPlainObject(b.result)) throw new ApiError('E1001', '缺少字段 result');
    let confirmed;
    try {
      confirmed = confirmReplan(b.result);
    } catch (err) {
      throw new ApiError('E1001', err.message);
    }
    store.recordReplan(userId, confirmed);
    return confirmed;
  }

  /* ── POST /api/replan/undo ── */
  function undoRoute(body) {
    const b = needObject(body);
    if (!isPlainObject(b.snapshot)) throw new ApiError('E1001', '缺少字段 snapshot');
    return undoReplan(b.snapshot);
  }

  /* ── POST /api/attribute ── */
  function attributeRoute(body) {
    const b = needObject(body);
    if (!Object.keys(b).length) throw new ApiError('E1001', '请求体不能为空');
    checkNumericFields(b, [
      'planLoadRatio', 'consecutiveZeroDays', 'consecutiveTimeoutCount',
      'efficiencyRatio', 'completion', 'externalRatio'
    ]);
    return attribute({
      planLoadRatio: b.planLoadRatio,
      consecutiveZeroDays: b.consecutiveZeroDays,
      consecutiveTimeoutCount: b.consecutiveTimeoutCount,
      efficiencyRatio: b.efficiencyRatio,
      completion: b.completion,
      externalRatio: b.externalRatio
    });
  }

  /* ── POST /api/sessions ── */
  function sessionsRoute(body, userId) {
    const b = needObject(body);
    needString(b.opId, 'opId');
    needString(b.taskId, 'taskId');
    needNumber(b.durationMin, 'durationMin', { min: 0 });
    needNumber(b.completion, 'completion', { min: 0, max: 1 });
    return store.recordSession(userId, b);
  }

  /* ── POST /api/sync/ops ── */
  function syncOpsRoute(body, userId) {
    const b = needObject(body);
    if (b.ops === undefined) throw new ApiError('E1001', '缺少字段 ops');
    const ops = needArray(b.ops, 'ops');
    if (ops.length > store.MAX_SYNC_BATCH) {
      throw new ApiError('E4002', '单批上行不得超过 ' + store.MAX_SYNC_BATCH + ' 条，当前 ' + ops.length + ' 条');
    }
    ops.forEach((op, i) => {
      if (!isPlainObject(op)) throw new ApiError('E1001', 'ops[' + i + '] 必须是对象');
      needString(op.opId, 'ops[' + i + '].opId');
      needString(op.entity, 'ops[' + i + '].entity');
      needString(op.field, 'ops[' + i + '].field');
      if (op.entityId === undefined || op.entityId === null) {
        throw new ApiError('E1001', 'ops[' + i + '].entityId 缺失');
      }
      if (op.clientTs !== undefined && op.clientTs !== null) needNumber(op.clientTs, 'ops[' + i + '].clientTs');
      /* 身份只来自凭证：请求体携带的 userId 若与凭证不一致，直接拒绝，避免越权写入他人分区 */
      if (op.userId !== undefined && op.userId !== null && String(op.userId) !== userId) {
        throw new ApiError('E4030', 'ops[' + i + '].userId 与凭证身份不一致');
      }
    });
    return store.applyOps(userId, ops);
  }

  /* ── GET /api/sync?since=N ── */
  function syncRoute(query, userId) {
    const raw = query.get('since');
    let since = 0;
    if (raw !== null && raw !== undefined && raw !== '') {
      if (!/^-?\d+$/.test(String(raw))) throw new ApiError('E1001', 'since 必须是非负整数');
      since = parseInt(String(raw), 10);
      if (since < 0) throw new ApiError('E1001', 'since 必须是非负整数');
    }
    const limitRaw = query.get('limit');
    let limit = store.MAX_SYNC_PAGE;
    if (limitRaw !== null && limitRaw !== undefined && limitRaw !== '') {
      if (!/^\d+$/.test(String(limitRaw))) throw new ApiError('E1001', 'limit 必须是非负整数');
      limit = Math.min(parseInt(String(limitRaw), 10), store.MAX_SYNC_PAGE);
    }
    return store.getOpsSince(userId, since, limit);
  }

  /* ── GET /api/reports/weekly ── */
  function weeklyReport(userId) {
    const s = store.getModel(userId);
    const ws = s.weekStats || {};
    const kpis = ws.kpis || {};
    return {
      week: (s.week || []).map((d) => ({
        d: d.d,
        segs: d.segs,
        buf: d.buf,
        total: d.total,
        today: d.today === true
      })),
      achievement: kpis.achievementRate,
      effectiveHours: kpis.effectiveHours,
      subjectMix: ws.subjectMix || {},
      attribution: ws.attribution || {},
      actions: ws.actions || []
    };
  }

  const routes = {
    'GET /api/health': function () { return health(); },
    'POST /api/auth/session': function () { return authSessionRoute(); },
    'GET /api/state': function (ctx) { return state(ctx.userId); },
    'GET /api/sync': function (ctx) { return syncRoute(ctx.query, ctx.userId); },
    'GET /api/reports/weekly': function (ctx) { return weeklyReport(ctx.userId); },
    'POST /api/feasibility': function (ctx) { return feasibilityRoute(ctx.body); },
    'POST /api/schedule': function (ctx) { return scheduleRoute(ctx.body); },
    'POST /api/replan': function (ctx) { return replanRoute(ctx.body, ctx.userId); },
    'POST /api/replan/confirm': function (ctx) { return replanConfirmRoute(ctx.body, ctx.userId); },
    'POST /api/replan/undo': function (ctx) { return undoRoute(ctx.body); },
    'POST /api/attribute': function (ctx) { return attributeRoute(ctx.body); },
    'POST /api/sessions': function (ctx) { return sessionsRoute(ctx.body, ctx.userId); },
    'POST /api/sync/ops': function (ctx) { return syncOpsRoute(ctx.body, ctx.userId); }
  };

  /**
   * 处理一次 API 调用
   * @returns {{status:number, body:object}}
   */
  function handle(ctx) {
    const key = ctx.method + ' ' + ctx.pathname;
    const handler = routes[key];
    if (!handler) {
      /* 路径存在但方法不符 → E1001；路径不存在 → E2001 */
      const otherMethod = Object.keys(routes).some((k) => k.slice(k.indexOf(' ')) === key.slice(key.indexOf(' ')));
      throw new ApiError(otherMethod ? 'E1001' : 'E2001', otherMethod ? '方法不支持：' + key : '接口不存在：' + key);
    }
    try {
      return { status: 200, body: handler(ctx) };
    } catch (err) {
      if (err instanceof ApiError) throw err;
      /* 引擎入参异常统一映射为 E1001 */
      if (err instanceof TypeError || err instanceof RangeError) {
        throw new ApiError('E1001', err.message);
      }
      throw new ApiError('E5001', err && err.message ? err.message : '服务内部错误');
    }
  }

  return { handle: handle, routes: routes, VERSION: VERSION };
}

module.exports = { createRouter: createRouter, ApiError: ApiError, ERRORS: ERRORS, VERSION: VERSION };
