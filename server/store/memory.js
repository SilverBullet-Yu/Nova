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
const fs = require('node:fs');
const path = require('node:path');

/** 演示基线 seq（与现有 demo 顶栏「seq 88123」一致） */
const BASE_SEQ = 88123;

/** 单批上行上限（契约：≤ 200） */
const MAX_SYNC_BATCH = 200;
const STORE_FILE = process.env.NOVA_STORE_FILE || path.join(__dirname, '..', 'data', 'nova-store.json');

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
let persistCounter = 0;

function createPartition(userId) {
  return {
    userId: userId,
    seq: BASE_SEQ,
    state: Object.assign(clone(seed), { sessionTombstones: {}, sessionsClearedAt: 0, dataClearedAt: 0 }),
    entities: {},       // entity → entityId → field → { value, tombstone, clientTs, seq }
    opIndex: new Map(), // opId → serverSeq（分区内 op_id 唯一，幂等兜底）
    dayAssignWrites: new Map(), // taskId → 改期字段合并桶，避免不同任务互相覆盖
    replanRecords: [],
    replanSeq: 0,
    planBaseline: null
  };
}

/** 取用户分区；首次访问时以 seed 初始化。缺少身份属于调用方缺陷，直接拒绝。 */
function persist() {
  const payload = {};
  for (const [userId, p] of partitions) {
    payload[userId] = {
      userId: p.userId, seq: p.seq, state: p.state, entities: p.entities,
      opIndex: Array.from(p.opIndex.entries()),
      dayAssignWrites: Array.from(p.dayAssignWrites.entries()),
      replanRecords: p.replanRecords, replanSeq: p.replanSeq,
      planBaseline: p.planBaseline
    };
  }
  const dir = path.dirname(STORE_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = STORE_FILE + '.' + process.pid + '.' + (++persistCounter) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
  let renamed = false;
  let lastError = null;
  for (let attempt = 0; attempt < 5 && !renamed; attempt++) {
    try {
      fs.renameSync(tmp, STORE_FILE);
      renamed = true;
    } catch (e) {
      lastError = e;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(e && e.code)) throw e;
      const wait = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(wait, 0, 0, 10);
    }
  }
  if (!renamed) {
    try { fs.rmSync(tmp, { force: true }); } catch (e) { /* 保留原始错误 */ }
    throw lastError;
  }
}

function restore() {
  if (!fs.existsSync(STORE_FILE)) return;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); }
  catch (e) { throw new Error('Nova 持久化文件损坏：' + STORE_FILE); }
  if (!raw || typeof raw !== 'object') return;
  for (const [userId, saved] of Object.entries(raw)) {
    const p = createPartition(userId);
    p.seq = num(saved.seq, BASE_SEQ);
    p.state = saved.state && typeof saved.state === 'object' ? saved.state : p.state;
    p.entities = saved.entities && typeof saved.entities === 'object' ? saved.entities : {};
    p.opIndex = new Map(Array.isArray(saved.opIndex) ? saved.opIndex : []);
    p.dayAssignWrites = new Map(Array.isArray(saved.dayAssignWrites) ? saved.dayAssignWrites : []);
    p.replanRecords = Array.isArray(saved.replanRecords) ? saved.replanRecords : [];
    p.replanSeq = num(saved.replanSeq, p.replanRecords.length);
    p.planBaseline = saved.planBaseline || null;
    partitions.set(String(userId), p);
  }
}

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

restore();

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
      const id = isPlainObject(value) && value.id !== undefined && value.id !== null ? String(value.id) : '';
      if (id && s.sessions.some((x) => x && x.id !== undefined && x.id !== null && String(x.id) === id)) return false;
      s.sessions.push(isPlainObject(value) ? clone(value) : { entityId: entityId, field: field, value: value });
      return true;
    }
    case 'plan': {
      /* 回放形态：手工改期 / 锁定 / 逐条否决，GET /api/state 的 seed.dayAssign /
         seed.locks 与 replan.vetoed 直接可读——闭合「op 只写不读」的多端一致缺口 */
      if (field === 'moved' && isPlainObject(value) && value.taskId !== undefined) {
        s.dayAssign = s.dayAssign || {};
        const day = String(value.day === undefined ? '' : value.day);
        if (day && day !== '日') s.dayAssign[String(value.taskId)] = day;
        else delete s.dayAssign[String(value.taskId)];   // 回到基线日「日」= 撤销改期
      } else if (field === 'locked') {
        s.locks = s.locks || {};
        if (value === true) s.locks[String(entityId)] = true;
        else delete s.locks[String(entityId)];
      } else if (field === 'vetoed' && p.replanRecords.length) {
        const rec = p.replanRecords[p.replanRecords.length - 1];
        rec.vetoed = rec.vetoed || [];
        rec.vetoed.push({
          taskId: String(value && value.taskId !== undefined ? value.taskId : entityId),
          op: (value && value.op) || null,
          at: num(value && value.at, 0)
        });
      } else {
        applyExtra(s, entity, entityId, field, value);
      }
      break;
    }
    case 'notif': {
      /* 通知开关回放：getNotifications 由 state.notif 派生，开关状态多端可见 */
      if (s.notif && Object.prototype.hasOwnProperty.call(s.notif, field)) s.notif[field] = value;
      else applyExtra(s, entity, entityId, field, value);
      break;
    }
    case 'buffer': {
      /* 弹性位占用回放：value=true 占用（free=false） */
      if (field === 'occupied') {
        s.buffer = Object.assign({}, s.buffer || {}, { free: value !== true });
      } else {
        applyExtra(s, entity, entityId, field, value);
      }
      break;
    }
    default: {
      applyExtra(s, entity, entityId, field, value);
    }
  }
}

/** 未识别的实体 / 字段统一落入 extra 桶（原 default 分支） */
function applyExtra(s, entity, entityId, field, value) {
  s.extra = s.extra || {};
  s.extra[entity] = s.extra[entity] || {};
  s.extra[entity][entityId] = s.extra[entity][entityId] || {};
  s.extra[entity][entityId][field] = value;
}

/** max 首次合并的基线：与 applyToState 的业务字段落点一致；sum 仍按增量从 0 起算。 */
function readStateField(p, entity, entityId, field) {
  const s = p.state;
  let target;
  switch (entity) {
    case 'task': target = (s.tasks || []).find((x) => String(x.id) === entityId); break;
    case 'user': case 'goal': case 'feas': target = s[entity]; break;
    case 'settings':
      target = s.notif && Object.prototype.hasOwnProperty.call(s.notif, field) ? s.notif : s.settings;
      break;
    case 'week': target = s.weekState && s.weekState[entityId]; break;
    case 'notif':
      if (s.notif && Object.prototype.hasOwnProperty.call(s.notif, field)) {
        target = s.notif;
        break;
      }
      // 其他通知字段与 plan / buffer 的 max 字段一样落入 extra。
    default: target = s.extra && s.extra[entity] && s.extra[entity][entityId];
  }
  return target && target[field];
}

/** 字段级合并：返回是否实际改写了状态 */
function mergeField(p, record) {
  const entity = record.entity;
  const entityId = String(record.entityId === undefined ? '' : record.entityId);
  const field = record.field;
  const value = record.value;
  const policy = policyOf(field);
  /* session 记录是追加事件而非任务上的 LWW 字段；有 ID 按记录去重，
     无 ID 保留旧回读形态，由 applyOps 的 opId 索引兜底；旧计数/墓碑策略不变。 */
  if (entity === 'session' && policy === 'lastWrite') return applyToState(p, entity, entityId, field, value);

  let bucket;
  if (entity === 'plan' && entityId === 'dayAssign' && field === 'moved' &&
      isPlainObject(value) && value.taskId !== undefined) {
    const taskId = String(value.taskId);
    if (!p.dayAssignWrites.has(taskId)) p.dayAssignWrites.set(taskId, {});
    bucket = p.dayAssignWrites.get(taskId);
  } else {
    bucket = ensureBucket(p, entity, entityId);
  }
  const prev = bucket[field];
  const clientTs = num(record.clientTs, 0);
  const seq = num(record.serverSeq, p.seq);

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
    const base = prev ? num(prev.value, 0) : num(readStateField(p, entity, entityId, field), 0);
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
  persist();
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

function recordReplan(userId, result, constraints) {
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
  if (rec.accepted && constraints) {
    p.planBaseline = { version: constraints.version, seq: p.seq, record: rec,
      locks: clone(constraints.locks || {}), params: clone(constraints.params || {}) };
  }
  persist();
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
  if (accepted.length) persist();
  return { accepted: accepted, serverSeq: serverSeq };
}

module.exports = {
  reset: reset,
  /** 该用户分区合并后的状态快照（仅测试检查内部结构用；克隆返回，
      避免业务代码经此引用绕过 applyOps 的幂等索引与合并策略直写分区） */
  getModel: function (userId) {
    return clone(partitionOf(userId).state);
  },
  getSeq: function (userId) {
    return partitionOf(userId).seq;
  },
  getState: function (userId) {
    const p = partitionOf(userId);
    const baseline = p.planBaseline;
    return {
      seed: clone(p.state),
      planBaseline: baseline ? { version: baseline.version, stale: baseline.seq !== p.seq } : null,
      replan: getLatestReplan(userId),
      notifications: getNotifications(userId)
    };
  },
  getPlanBaseline: function (userId) {
    const p = partitionOf(userId);
    const b = p.planBaseline;
    return b ? { version: b.version, stale: b.seq !== p.seq } : null;
  },
  getNotifications: getNotifications,
  getLatestReplan: getLatestReplan,
  recordReplan: recordReplan,
  recordSchedule: function (userId, version, result) {
    const p = partitionOf(userId);
    p.planBaseline = { version, seq: p.seq, record: clone(result) };
    persist();
  },
  applyOps: applyOps,
  MAX_SYNC_BATCH: MAX_SYNC_BATCH
};
