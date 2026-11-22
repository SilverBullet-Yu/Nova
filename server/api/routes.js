'use strict';
/* 诺瓦 Nova · REST 路由
 *
 * 契约：docs/HANDOFF.md §5（路径 / 请求 / 响应）+ 附录 B 错误码
 * 错误统一形状：{ error: { code, message } }
 */

const { randomUUID } = require('node:crypto');
const { feasibility } = require('../../shared/engine/feasibility.js');
const { schedule } = require('../../shared/engine/schedule.js');
const { replan, confirmReplan, undoReplan } = require('../../shared/engine/replan.js');
const { attribute } = require('../../shared/engine/attribute.js');
const llm = require('../llm.js');

/* 错误码表与 ApiError 在 server/api/errors.js（llm.js 与本模块相互引用，
   集中于此会成 require 环）；此处再导出保持既有引用面不变 */
const { ApiError } = require('./errors.js');

const VERSION = require('../../package.json').version;

const ERRORS = require('./errors.js').ERRORS;

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
  const drafts = new Map();
  const planReviews = new Map();
  const planReceipts = new Map();
  const draftTtlMs = 5 * 60 * 1000;
  const maxDrafts = 128;
  const receiptTtlMs = 24 * 60 * 60 * 1000;
  const maxReceipts = 512;

  function revision(userId) {
    return [store.getSeq(userId), store.getLatestReplan(userId)?.seq || 0, store.getPlanBaseline(userId)?.version || ''].join(':');
  }
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

  function reviewPlan(body, userId) {
    const b = needObject(body);
    if (typeof b.id !== 'string' || !/^[0-9a-f-]{36}$/.test(b.id)) throw new ApiError('E1001', '计划请求 ID 无效');
    const key = userId + ':' + b.id;
    const signature = JSON.stringify([b.base, b.input, b.result]);
    const previous = planReceipts.get(key);
    if (previous) {
      if (previous.expiresAt <= Date.now()) {
        planReceipts.delete(key); /* 过期收据视为不存在，允许重新复核 */
      } else if (previous.signature !== signature) {
        throw new ApiError('E3001', '请求 ID 已用于其他计划');
      } else {
        return previous.response;
      }
    }
    const result = scheduleRoute(b.input);
    if (!result.blocks.length) throw new ApiError('E1001', '没有可提交的排程结果');
    const baseline = store.getPlanBaseline(userId);
    const version = baseline ? baseline.version : null;
    const current = revision(userId);
    if (JSON.stringify(result) !== JSON.stringify(b.result)) {
      return { status: 'conflict', reason: 'result-changed', version };
    }
    const draft = planReviews.get(key);
    const valid = draft && draft.ticket === b.ticket && draft.signature === signature &&
      draft.revision === current && draft.expiresAt > Date.now();
    if (!valid && (b.ticket || b.base !== version || (baseline && baseline.stale))) {
      const ticket = draft && draft.signature === signature && draft.revision === current && draft.expiresAt > Date.now()
        ? draft.ticket : randomUUID();
      for (const [k, d] of planReviews) if (d.expiresAt <= Date.now()) planReviews.delete(k);
      if (planReviews.size >= maxDrafts && !planReviews.has(key)) planReviews.delete(planReviews.keys().next().value);
      planReviews.set(key, { ticket, signature, revision: current, expiresAt: Date.now() + draftTtlMs });
      return { status: 'conflict', reason: baseline ? 'baseline-changed' : 'baseline-missing', version, ticket };
    }
    const response = { status: 'committed', version: randomUUID() };
    store.recordSchedule(userId, response.version, result);
    planReviews.delete(key);
    /* 收据限界：过期清扫 + 容量上限（FIFO 淘汰），防长驻进程无界增长（与 drafts 同构） */
    for (const [k, r] of planReceipts) if (r.expiresAt <= Date.now()) planReceipts.delete(k);
    if (planReceipts.size >= maxReceipts && !planReceipts.has(key)) {
      planReceipts.delete(planReceipts.keys().next().value);
    }
    planReceipts.set(key, { signature, response, expiresAt: Date.now() + receiptTtlMs });
    return response;
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
    if (result.accepted !== true && result.needsConfirmation !== true) return result;
    const now = Date.now();
    for (const [id, draft] of drafts) if (draft.expiresAt <= now) drafts.delete(id);
    if (drafts.size >= maxDrafts) drafts.delete(drafts.keys().next().value);
    const draftId = randomUUID();
    drafts.set(draftId, { userId, revision: revision(userId), expiresAt: now + draftTtlMs, result, locks: b.locks, params: b.params });
    return { ...result, draftId };
  }

  /* ── POST /api/replan/confirm ──
     用途：仅对该身份先前生成的草案写入业务记录。 */
  function replanConfirmRoute(body, userId) {
    const b = needObject(body);
    if (typeof b.draftId !== 'string' || Object.keys(b).length !== 1) throw new ApiError('E1001', '仅接受 draftId');
    const draft = drafts.get(b.draftId);
    if (!draft || draft.userId !== userId) throw new ApiError('E2001', '找不到重排草案');
    if (draft.expiresAt <= Date.now()) {
      drafts.delete(b.draftId);
      throw new ApiError('E2001', '找不到重排草案');
    }
    if (draft.confirmed) return draft.confirmed;
    if (draft.revision !== revision(userId)) throw new ApiError('E3001', '计划状态已变化，请重新预览');
    const confirmed = draft.result.needsConfirmation ? confirmReplan(draft.result) : draft.result;
    store.recordReplan(userId, confirmed, { version: randomUUID(), locks: draft.locks, params: draft.params });
    draft.confirmed = confirmed;
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
      if (typeof op.entityId !== 'string' && !Number.isSafeInteger(op.entityId)) {
        throw new ApiError('E1001', 'ops[' + i + '].entityId 必须是字符串或安全整数');
      }
      const reservedKey = (key) => Object.prototype.hasOwnProperty.call(Object.prototype, key) || key === 'prototype';
      const keys = [op.entity, String(op.entityId), op.field];
      if (op.entity === 'plan' && op.field === 'moved' && isPlainObject(op.value) && op.value.taskId !== undefined) {
        const taskId = op.value.taskId;
        if (typeof taskId !== 'string' && !Number.isSafeInteger(taskId)) {
          throw new ApiError('E1001', 'ops[' + i + '].value.taskId 必须是字符串或安全整数');
        }
        keys.push(String(taskId));
      }
      if (keys.some(reservedKey)) throw new ApiError('E1001', 'ops[' + i + '] 包含保留键');
      if (op.clientTs !== undefined && op.clientTs !== null) needNumber(op.clientTs, 'ops[' + i + '].clientTs');
      /* 身份只来自凭证：请求体携带的 userId 若与凭证不一致，直接拒绝，避免越权写入他人分区 */
      if (op.userId !== undefined && op.userId !== null && String(op.userId) !== userId) {
        throw new ApiError('E4030', 'ops[' + i + '].userId 与凭证身份不一致');
      }
    });
    return store.applyOps(userId, ops);
  }

  /* ── POST /api/llm/clarify ──
     LLM 多轮澄清一轮：入参为对话消息与当前画像，出参 { reply, profile, done, missing }。
     handler 返回 Promise（handle 统一等待）；LLM 未配置 / 失败 / 输出非法分别
     映射 E5010 / E5011 / E5012，前端据此降级到表单流程。 */
  function llmClarifyRoute(body) {
    const b = needObject(body);
    const messages = needArray(b.messages, 'messages');
    if (messages.length > 40) throw new ApiError('E1001', 'messages 不得超过 40 条');
    messages.forEach((m, i) => {
      if (!isPlainObject(m)) throw new ApiError('E1001', 'messages[' + i + '] 必须是对象');
      if (m.role !== 'user' && m.role !== 'assistant') {
        throw new ApiError('E1001', 'messages[' + i + '].role 必须是 user 或 assistant');
      }
      needString(m.content, 'messages[' + i + '].content');
    });
    if (b.profile !== undefined && b.profile !== null && !isPlainObject(b.profile)) {
      throw new ApiError('E1001', 'profile 必须是对象');
    }
    return llm.clarifyTurn(messages, b.profile || null);
  }

  /* ── POST /api/llm/analyze ──
     LLM 分析建议：画像（必填，槽位不齐直接 E1001）+ 可选执行历史 → 拆解建议。
     建议只含「学什么 / 多少时间 / 风险」，不含排程块；排程仍由引擎执行。 */
  function llmAnalyzeRoute(body) {
    const b = needObject(body);
    if (!isPlainObject(b.profile)) throw new ApiError('E1001', '缺少字段 profile');
    return llm.analyzeProfile(b.profile, isPlainObject(b.history) ? b.history : null);
  }

  /* ── 路由注册表（单一事实源）───────────────────────────────────────────
   * 路径、处理器、是否免鉴权（public）与限流阈值（limit）集中声明，
   * main.js 的鉴权与限流编排只读本表元数据——避免「路由 / 免鉴权名单 / 限流表」
   * 三处分散导致新增端点漏配（曾致 /api/plan/review 短暂成为唯一无限流写端点）。
   * 未声明的路径不注册即不存在（404 E2001），无从绕过。
   * --------------------------------------------------------------------- */
  const L = (limit, windowMs) => ({ limit: limit, windowMs: windowMs });
  const routes = {
    'GET /api/health': { public: true, limit: null, handler: function () { return health(); } },
    'POST /api/auth/session': { public: true, limit: L(60, 60000), handler: function () { return authSessionRoute(); } },
    'GET /api/state': { public: false, limit: null, handler: function (ctx) { return state(ctx.userId); } },
    'POST /api/feasibility': { public: false, limit: L(30, 60000), handler: function (ctx) { return feasibilityRoute(ctx.body); } },
    'POST /api/schedule': { public: false, limit: L(30, 60000), handler: function (ctx) { return scheduleRoute(ctx.body); } },
    'POST /api/plan/review': { public: false, limit: L(30, 60000), handler: function (ctx) { return reviewPlan(ctx.body, ctx.userId); } },
    'POST /api/replan': { public: false, limit: L(12, 60000), handler: function (ctx) { return replanRoute(ctx.body, ctx.userId); } },
    'POST /api/replan/confirm': { public: false, limit: L(12, 60000), handler: function (ctx) { return replanConfirmRoute(ctx.body, ctx.userId); } },
    'POST /api/replan/undo': { public: false, limit: null, handler: function (ctx) { return undoRoute(ctx.body); } },
    'POST /api/attribute': { public: false, limit: L(30, 60000), handler: function (ctx) { return attributeRoute(ctx.body); } },
    'POST /api/sync/ops': { public: false, limit: L(60, 60000), handler: function (ctx) { return syncOpsRoute(ctx.body, ctx.userId); } },
    'POST /api/llm/clarify': { public: false, limit: L(10, 60000), handler: function (ctx) { return llmClarifyRoute(ctx.body); } },
    'POST /api/llm/analyze': { public: false, limit: L(10, 60000), handler: function (ctx) { return llmAnalyzeRoute(ctx.body); } }
  };

  /**
   * 处理一次 API 调用。
   * 同步 handler 与异步 handler（LLM 端点返回 Promise）统一走 Promise 链，
   * 返回 {status, body}；错误经同一映射（ApiError 直传 / TypeError·RangeError
   * 归 E1001 / 其余 E5001），同步抛错与此等价。
   * @returns {Promise<{status:number, body:object}>}
   */
  function handle(ctx) {
    const key = ctx.method + ' ' + ctx.pathname;
    const entry = routes[key];
    if (!entry) {
      /* 路径存在但方法不符 → E1001；路径不存在 → E2001 */
      const otherMethod = Object.keys(routes).some((k) => k.slice(k.indexOf(' ')) === key.slice(key.indexOf(' ')));
      return Promise.reject(new ApiError(otherMethod ? 'E1001' : 'E2001', otherMethod ? '方法不支持：' + key : '接口不存在：' + key));
    }
    return Promise.resolve().then(() => entry.handler(ctx)).then(
      (body) => ({ status: 200, body: body }),
      (err) => {
        if (err instanceof ApiError) throw err;
        /* 引擎入参异常统一映射为 E1001 */
        if (err instanceof TypeError || err instanceof RangeError) {
          throw new ApiError('E1001', err.message);
        }
        throw new ApiError('E5001', err && err.message ? err.message : '服务内部错误');
      }
    );
  }

  return { handle: handle, routes: routes };
}

module.exports = { createRouter: createRouter, ApiError: ApiError };
