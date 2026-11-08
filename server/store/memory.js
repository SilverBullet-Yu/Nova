'use strict';
/* 诺瓦 Nova · 内存存储（单例，无数据库）
 *
 * 契约：docs/HANDOFF.md §5（同步协议 / 幂等 / 字段级合并）
 * 职责：seed 副本 + sync_op 序列表 + replan_record 快照
 *
 * 纯度约束：服务端不读时钟做业务判断。时间一律用单调计数器（serverSeq）。
 */

const { seed } = require('../../shared/data/seed.js');

/** 演示基线 seq（与现有 demo 顶栏「seq 88123」一致） */
const BASE_SEQ = 88123;

/** 单批上行上限（契约：≤ 200） */
const MAX_SYNC_BATCH = 200;

/** 增量拉取单页上限 */
const MAX_SYNC_PAGE = 500;

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function num(v, dflt) {
  return typeof v === 'number' && isFinite(v) ? v : dflt;
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/* ── 字段级合并策略 ────────────────────────────────────────────────────────
 * tombstone：删除类，墓碑优先，一旦置位不可翻转
 * sum      ：计数类（可累加），求和
 * max      ：计数类（不可累加，如单次时长），取最大值
 * lastWrite：状态类，最后写入优先（同 clientTs 时以 serverSeq 大者为准）
 * ----------------------------------------------------------------------- */
const TOMBSTONE_FIELDS = ['deleted', 'isDeleted', 'deletedAt'];
const SUM_FIELDS = ['count', 'sessionCount', 'sessions', 'times'];
const MAX_FIELDS = ['actual', 'durationMin', 'minutes', 'duration'];

function policyOf(field) {
  const f = String(field || '');
  if (TOMBSTONE_FIELDS.indexOf(f) >= 0) return 'tombstone';
  if (SUM_FIELDS.indexOf(f) >= 0) return 'sum';
  if (MAX_FIELDS.indexOf(f) >= 0) return 'max';
  return 'lastWrite';
}

function isDeleteValue(v) {
  return v === true || v === 1 || v === '1' ||
    (typeof v === 'string' && v.toLowerCase() === 'true');
}

/* ── 单例状态 ─────────────────────────────────────────────────────────── */
const store = {
  baseSeq: BASE_SEQ,
  seq: BASE_SEQ,
  seed: clone(seed),
  state: clone(seed),
  entities: {},       // entity → entityId → field → { value, tombstone, clientTs, seq }
  ops: [],            // sync_op 序列表（serverSeq 升序）
  opIndex: new Map(), // `${userId}:${opId}` → serverSeq（(user_id, op_id) 唯一约束）
  sessions: new Map(),// opId → { ok, serverSeq }
  replanRecords: [],
  replanSeq: 0
};

function ensureBucket(entity, entityId) {
  if (!store.entities[entity]) store.entities[entity] = {};
  const byId = store.entities[entity];
  if (!byId[entityId]) byId[entityId] = {};
  return byId[entityId];
}

function applyToState(entity, entityId, field, value) {
  const s = store.state;
  switch (entity) {
    case 'task': {
      const t = (s.tasks || []).find((x) => String(x.id) === entityId);
      if (t) t[field] = value;
      break;
    }
    case 'user': {
      s.user = s.user || {};
      s.user[field] = value;
      break;
    }
    case 'settings': {
      if (s.notif && Object.prototype.hasOwnProperty.call(s.notif, field)) s.notif[field] = value;
      else {
        s.settings = s.settings || {};
        s.settings[field] = value;
      }
      break;
    }
    case 'goal': {
      s.goal = s.goal || {};
      s.goal[field] = value;
      break;
    }
    case 'feas': {
      s.feas = s.feas || {};
      s.feas[field] = value;
      break;
    }
    case 'week': {
      s.weekState = s.weekState || {};
      s.weekState[entityId] = s.weekState[entityId] || {};
      s.weekState[entityId][field] = value;
      break;
    }
    case 'session': {
      s.sessions = s.sessions || [];
      s.sessions.push({ entityId: entityId, field: field, value: value });
      break;
    }
    default: {
      s.extra = s.extra || {};
      s.extra[entity] = s.extra[entity] || {};
      s.extra[entity][entityId] = s.extra[entity][entityId] || {};
      s.extra[entity][entityId][field] = value;
    }
  }
}

/** 字段级合并：返回是否实际改写了状态 */
function mergeField(record) {
  const entity = record.entity;
  const entityId = String(record.entityId === undefined ? '' : record.entityId);
  const field = record.field;
  const policy = policyOf(field);
  const bucket = ensureBucket(entity, entityId);
  const prev = bucket[field];
  const clientTs = num(record.clientTs, 0);
  const seq = num(record.serverSeq, store.seq);
  const value = record.value;

  if (policy === 'tombstone') {
    if (prev && prev.tombstone) return false;          // 墓碑优先，不可翻转
    if (isDeleteValue(value)) {
      bucket[field] = { value: true, tombstone: true, clientTs: clientTs, seq: seq };
      applyToState(entity, entityId, field, true);
      return true;
    }
    if (!prev || clientTs >= prev.clientTs) {
      bucket[field] = { value: value, tombstone: false, clientTs: clientTs, seq: seq };
      applyToState(entity, entityId, field, value);
      return true;
    }
    return false;
  }

  if (policy === 'sum') {
    const base = prev ? num(prev.value, 0) : 0;
    const next = base + num(value, 0);
    bucket[field] = { value: next, tombstone: false, clientTs: clientTs, seq: seq };
    applyToState(entity, entityId, field, next);
    return true;
  }

  if (policy === 'max') {
    const base = prev ? num(prev.value, 0) : 0;
    const next = Math.max(base, num(value, 0));
    if (next !== base || !prev) {
      bucket[field] = { value: next, tombstone: false, clientTs: clientTs, seq: seq };
      applyToState(entity, entityId, field, next);
    }
    return true;
  }

  /* lastWrite：状态类最后写入优先 */
  if (!prev || clientTs > prev.clientTs || (clientTs === prev.clientTs && seq >= prev.seq)) {
    bucket[field] = { value: value, tombstone: false, clientTs: clientTs, seq: seq };
    applyToState(entity, entityId, field, value);
    return true;
  }
  return false;
}

/* ── 对外接口 ─────────────────────────────────────────────────────────── */

function reset() {
  store.seq = BASE_SEQ;
  store.state = clone(seed);
  store.entities = {};
  store.ops = [];
  store.opIndex = new Map();
  store.sessions = new Map();
  store.replanRecords = [];
  store.replanSeq = 0;
  return store;
}

function getSeed() {
  return clone(store.seed);
}

function getNotifications() {
  const n = store.state.notif || {};
  return [
    { id: 'n_daily', kind: 'daily', enabled: n.daily !== false, title: '每日提醒', body: '19:00 · 今日 3 项' },
    { id: 'n_weekly', kind: 'weekly', enabled: n.weekly !== false, title: '周报', body: '周日 20:00 · 最少打扰' },
    { id: 'n_alert', kind: 'alert', enabled: n.alert !== false, title: '进度预警', body: '必须附带补救方案' },
    { id: 'n_rescue', kind: 'rescue', enabled: n.rescue !== false, title: '中断挽救', body: '连续 3 天无记录时触发' }
  ];
}

function getLatestReplan() {
  return store.replanRecords.length ? clone(store.replanRecords[store.replanRecords.length - 1]) : null;
}

function getReplanRecords() {
  return clone(store.replanRecords);
}

function recordReplan(result) {
  store.replanSeq += 1;
  const rec = {
    id: 'rr_' + store.replanSeq,
    seq: store.replanSeq,
    strategies: clone(result.strategies || []),
    diff: clone(result.diff || []),
    loadDelta: num(result.loadDelta, 0),
    accepted: result.accepted === true,
    verdict: result.verdict || 'blocked',
    guards: clone(result.guards || {}),
    snapshot: clone(result.snapshot || null),
    nextTasks: clone(result.nextTasks || []),
    nextWeek: clone(result.nextWeek || [])
  };
  store.replanRecords.push(rec);
  return clone(rec);
}

/** 打卡上报：opId 幂等，重复提交返回首次 serverSeq */
function recordSession(payload) {
  const opId = String(payload.opId);
  if (store.sessions.has(opId)) {
    return { ok: true, serverSeq: store.sessions.get(opId).serverSeq, duplicate: true };
  }
  store.seq += 1;
  const seq = store.seq;
  store.sessions.set(opId, { ok: true, serverSeq: seq });

  const taskId = String(payload.taskId);
  const durationMin = num(payload.durationMin, 0);
  const completion = num(payload.completion, 0);
  const clientTs = num(payload.clientTs, 0);

  store.ops.push({
    serverSeq: seq,
    userId: 'u_demo',
    opId: opId,
    entity: 'session',
    entityId: taskId,
    field: 'durationMin',
    value: durationMin,
    clientTs: clientTs,
    baseSeq: num(payload.baseSeq, 0)
  });

  mergeField({ entity: 'task', entityId: taskId, field: 'actual', value: durationMin, clientTs: clientTs, serverSeq: seq });
  mergeField({ entity: 'task', entityId: taskId, field: 'completion', value: completion, clientTs: clientTs, serverSeq: seq });
  mergeField({ entity: 'task', entityId: taskId, field: 'done', value: completion >= 0.99, clientTs: clientTs, serverSeq: seq });
  mergeField({ entity: 'task', entityId: taskId, field: 'sessionCount', value: 1, clientTs: clientTs, serverSeq: seq });

  return { ok: true, serverSeq: seq };
}

/** 批量上行：opId 幂等（(user_id, op_id) 唯一约束） */
function applyOps(ops) {
  const accepted = [];
  let serverSeq = store.seq;
  ops.forEach((op) => {
    const opId = String(op.opId);
    const userId = String(op.userId || 'u_demo');
    const key = userId + ':' + opId;

    if (store.opIndex.has(key)) {
      accepted.push(opId);
      serverSeq = store.opIndex.get(key);     // 幂等：返回首次 serverSeq
      return;
    }

    store.seq += 1;
    const seq = store.seq;
    store.opIndex.set(key, seq);
    const record = {
      serverSeq: seq,
      userId: userId,
      opId: opId,
      entity: String(op.entity || 'unknown'),
      entityId: String(op.entityId === undefined ? '' : op.entityId),
      field: String(op.field || ''),
      value: op.value,
      clientTs: num(op.clientTs, 0),
      baseSeq: num(op.baseSeq, 0)
    };
    store.ops.push(record);
    mergeField(record);
    accepted.push(opId);
    serverSeq = seq;
  });
  return { accepted: accepted, serverSeq: serverSeq };
}

/** 增量拉取：seq 升序 */
function getOpsSince(since, limit) {
  const from = num(since, 0);
  const max = num(limit, MAX_SYNC_PAGE);
  const out = [];
  for (let i = 0; i < store.ops.length; i++) {
    if (store.ops[i].serverSeq > from) {
      out.push(clone(store.ops[i]));
      if (out.length >= max) break;
    }
  }
  const last = out.length ? out[out.length - 1].serverSeq : from;
  const hasMore = store.ops.some((o) => o.serverSeq > last);
  return { ops: out, serverSeq: last, hasMore: hasMore };
}

module.exports = {
  store: store,
  reset: reset,
  getSeed: getSeed,
  /** 可变状态副本（seed + 已合并的 op 结果） */
  getModel: function () {
    return store.state;
  },
  getSeq: function () {
    return store.seq;
  },
  getState: function () {
    return {
      seed: getSeed(),
      replan: getLatestReplan(),
      notifications: getNotifications()
    };
  },
  getNotifications: getNotifications,
  getLatestReplan: getLatestReplan,
  getReplanRecords: getReplanRecords,
  recordReplan: recordReplan,
  recordSession: recordSession,
  applyOps: applyOps,
  getOpsSince: getOpsSince,
  mergeField: mergeField,
  policyOf: policyOf,
  MAX_SYNC_BATCH: MAX_SYNC_BATCH,
  MAX_SYNC_PAGE: MAX_SYNC_PAGE,
  BASE_SEQ: BASE_SEQ
};
