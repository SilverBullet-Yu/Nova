'use strict';
/* 诺瓦 Nova · 内存存储（按用户分区，无数据库）
 *
 * 契约：docs/HANDOFF.md §5（同步协议 / 幂等 / 字段级合并）
 * 职责：每个用户一份 seed 副本 + opId 幂等索引 + replan_record 快照
 *
 * 身份：userId 只由 server/auth.js 从凭证解析后传入；本模块不读取请求体里的 userId。
 * 分区：所有读写都落在 partitions.get(userId) 上，用户之间不共享 state / ops / seq。
 * 纯度约束：服务端不读时钟做业务判断。时间一律用单调计数器（serverSeq）。
 */

const { seed } = require('../../shared/data/seed.js');

/** 演示基线 seq（与现有 demo 顶栏「seq 88123」一致） */
const BASE_SEQ = 88123;

/** 单批上行上限（契约：≤ 200） */
const MAX_SYNC_BATCH = 200;

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

/* ── 用户分区 ─────────────────────────────────────────────────────────── */
/** userId → 分区；分区之间完全隔离 */
const partitions = new Map();

function createPartition(userId) {
  return {
    userId: userId,
    seq: BASE_SEQ,
    state: clone(seed),
    entities: {},       // entity → entityId → field → { value, tombstone, clientTs, seq }
    opIndex: new Map(), // opId → serverSeq（分区内 op_id 唯一，幂等兜底）
    replanRecords: [],
    replanSeq: 0
  };
}

/** 取用户分区；首次访问时以 seed 初始化。缺少身份属于调用方缺陷，直接拒绝。 */
function partitionOf(userId) {
  const id = String(userId === undefined || userId === null ? '' : userId);
  if (!id) throw new Error('缺少用户身份，无法定位分区');
  let p = partitions.get(id);
  if (!p) {
    p = createPartition(id);
    partitions.set(id, p);
  }
  return p;
}

function ensureBucket(p, entity, entityId) {
  if (!p.entities[entity]) p.entities[entity] = {};
  const byId = p.entities[entity];
  if (!byId[entityId]) byId[entityId] = {};
  return byId[entityId];
}

function applyToState(p, entity, entityId, field, value) {
  const s = p.state;
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
      /* 回读形态：value 即完整 session 记录（exec.record 产出，含 status/feel），
         GET /api/state 的 seed.sessions 直接可读——闭合「后端无 session 回读接口」缺口；
         非对象 value（旧式包装）保持原样容错 */
      s.sessions = s.sessions || [];
      s.sessions.push(isPlainObject(value) ? clone(value) : { entityId: entityId, field: field, value: value });
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
function mergeField(p, record) {
  const entity = record.entity;
  const entityId = String(record.entityId === undefined ? '' : record.entityId);
  const field = record.field;
  const policy = policyOf(field);
  const bucket = ensureBucket(p, entity, entityId);
  const prev = bucket[field];
  const clientTs = num(record.clientTs, 0);
  const seq = num(record.serverSeq, p.seq);
  const value = record.value;

  if (policy === 'tombstone') {
    if (prev && prev.tombstone) return false;          // 墓碑优先，不可翻转
    if (isDeleteValue(value)) {
      bucket[field] = { value: true, tombstone: true, clientTs: clientTs, seq: seq };
      applyToState(p, entity, entityId, field, true);
      return true;
    }
    if (!prev || clientTs >= prev.clientTs) {
      bucket[field] = { value: value, tombstone: false, clientTs: clientTs, seq: seq };
      applyToState(p, entity, entityId, field, value);
      return true;
    }
    return false;
  }

  if (policy === 'sum') {
    const base = prev ? num(prev.value, 0) : 0;
    const next = base + num(value, 0);
    bucket[field] = { value: next, tombstone: false, clientTs: clientTs, seq: seq };
    applyToState(p, entity, entityId, field, next);
    return true;
  }

  if (policy === 'max') {
    const base = prev ? num(prev.value, 0) : 0;
    const next = Math.max(base, num(value, 0));
    if (next !== base || !prev) {
      bucket[field] = { value: next, tombstone: false, clientTs: clientTs, seq: seq };
      applyToState(p, entity, entityId, field, next);
    }
    return true;
  }

  /* lastWrite：状态类最后写入优先 */
  if (!prev || clientTs > prev.clientTs || (clientTs === prev.clientTs && seq >= prev.seq)) {
    bucket[field] = { value: value, tombstone: false, clientTs: clientTs, seq: seq };
    applyToState(p, entity, entityId, field, value);
    return true;
  }
  return false;
}

/* ── 对外接口 ─────────────────────────────────────────────────────────── */

/** 清空全部用户分区（测试与本地重置用） */
function reset() {
  partitions.clear();
}

/** 静态种子：所有用户共享同一份初始数据，但分区内各自持有副本 */
function getSeed() {
  return clone(seed);
}

function getNotifications(userId) {
  const n = partitionOf(userId).state.notif || {};
  return [
    { id: 'n_daily', kind: 'daily', enabled: n.daily !== false, title: '每日提醒', body: '19:00 · 今日 3 项' },
    { id: 'n_weekly', kind: 'weekly', enabled: n.weekly !== false, title: '周报', body: '周日 20:00 · 最少打扰' },
    { id: 'n_alert', kind: 'alert', enabled: n.alert !== false, title: '进度预警', body: '必须附带补救方案' },
    { id: 'n_rescue', kind: 'rescue', enabled: n.rescue !== false, title: '中断挽救', body: '连续 3 天无记录时触发' }
  ];
}

function getLatestReplan(userId) {
  const p = partitionOf(userId);
  return p.replanRecords.length ? clone(p.replanRecords[p.replanRecords.length - 1]) : null;
}

function getReplanRecords(userId) {
  return clone(partitionOf(userId).replanRecords);
}

function recordReplan(userId, result) {
  const p = partitionOf(userId);
  p.replanSeq += 1;
  const rec = {
    id: 'rr_' + p.replanSeq,
    seq: p.replanSeq,
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
  p.replanRecords.push(rec);
  return clone(rec);
}

/** 批量上行：opId 幂等（分区内 (user_id, op_id) 唯一），身份只取入参 userId */
function applyOps(userId, ops) {
  const p = partitionOf(userId);
  const accepted = [];
  let serverSeq = p.seq;
  ops.forEach((op) => {
    const opId = String(op.opId);

    if (p.opIndex.has(opId)) {
      accepted.push(opId);
      serverSeq = p.opIndex.get(opId);     // 幂等：返回首次 serverSeq
      return;
    }

    p.seq += 1;
    const seq = p.seq;
    p.opIndex.set(opId, seq);
    const record = {
      serverSeq: seq,
      userId: p.userId,
      opId: opId,
      entity: String(op.entity || 'unknown'),
      entityId: String(op.entityId === undefined ? '' : op.entityId),
      field: String(op.field || ''),
      value: op.value,
      clientTs: num(op.clientTs, 0),
      baseSeq: num(op.baseSeq, 0)
    };
    mergeField(p, record);
    accepted.push(opId);
    serverSeq = seq;
  });
  return { accepted: accepted, serverSeq: serverSeq };
}

module.exports = {
  reset: reset,
  getSeed: getSeed,
  /** 该用户分区合并后的状态（契约字段名为 seed，内容是本分区的当前快照） */
  getModel: function (userId) {
    return partitionOf(userId).state;
  },
  getSeq: function (userId) {
    return partitionOf(userId).seq;
  },
  getState: function (userId) {
    return {
      seed: clone(partitionOf(userId).state),
      replan: getLatestReplan(userId),
      notifications: getNotifications(userId)
    };
  },
  getNotifications: getNotifications,
  getLatestReplan: getLatestReplan,
  getReplanRecords: getReplanRecords,
  recordReplan: recordReplan,
  applyOps: applyOps,
  mergeField: mergeField,
  policyOf: policyOf,
  MAX_SYNC_BATCH: MAX_SYNC_BATCH,
  BASE_SEQ: BASE_SEQ
};
