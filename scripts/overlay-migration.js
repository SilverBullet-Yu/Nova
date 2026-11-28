#!/usr/bin/env node
'use strict';

/* Controlled, offline migration of legacy Nova snapshots/overlays.
 * This command never infers task blocks from week totals, buffer values, or today's date.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const P = require('../shared/placement-model.js');
const { schedule } = require('../shared/engine/schedule.js');

const BACKUP_FORMAT = 'nova-backup';
const BACKUP_VERSION = 1;
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UNSAFE_TEXT = /[\u0000-\u001F\u007F]/;
const DOW = ['日', '一', '二', '三', '四', '五', '六'];
const RANGES = [[480, 720], [720, 1080], [1080, 1320]];
const TERMINAL = ['done', 'skipped', 'abandoned', 'substituted'];
const REQUIRED_SNAPSHOT_FIELDS = [
  'tasks', 'sessions', 'goal', 'feas', 'week', 'weekShift', 'dayAssign', 'locks',
  'avail', 'availSource', 'notif', 'attrCounts', 'replanHistory', 'replanSnapshot'
];
const SNAPSHOT_FIELDS = [
  'tasks', 'sessions', 'goal', 'feas', 'week', 'weekShift', 'placementModel',
  'dayAssign', 'locks', 'avail', 'availSource', 'notif', 'attrCounts',
  'consecutiveZeroDays', 'interrupted', 'rescueRecord', 'replanHistory', 'replanSnapshot'
];

const USAGE = [
  '用法：node scripts/overlay-migration.js <input.json> --out <new-backup.json>',
  '      node scripts/overlay-migration.js <input.json> --out <new-backup.json> --rebuild --start-date YYYY-MM-DD --timezone IANA',
  '',
  'A：合法 placementModel 逻辑迁移；B：无任务区块证据，默认拒绝，仅 --rebuild 可重建；',
  'C：结构冲突/损坏，始终拒绝。--out 必须不存在；输出为独占硬链接、fsync，POSIX 权限 0600。',
  '不会从 week.total/buf、旧 time 或当前日期猜测任务区块。stdout 只含统计、路径和哈希。'
].join('\n');

class MigrationError extends Error {
  constructor(code, message, classification) {
    super(message);
    this.name = 'MigrationError';
    this.code = code;
    this.classification = classification || null;
  }
}

function fail(code, message, classification) {
  throw new MigrationError(code, message, classification);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function snapshotWhitelist(snapshot) {
  const out = {};
  if (hasOwn(snapshot, 'planVersion')) out.planVersion = clone(snapshot.planVersion);
  SNAPSHOT_FIELDS.forEach(key => {
    if (hasOwn(snapshot, key)) out[key] = clone(snapshot[key]);
  });
  return out;
}

function parseIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

function requireIsoDate(value, label) {
  if (!parseIsoDate(value)) fail('invalidDate', label + ' 必须是有效的 YYYY-MM-DD');
  return value;
}

function isoFromUtc(date) {
  return String(date.getUTCFullYear()).padStart(4, '0') + '-' +
    String(date.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(date.getUTCDate()).padStart(2, '0');
}

function addDays(value, amount) {
  const date = parseIsoDate(value);
  if (!date) fail('invalidDate', 'startDate 必须是有效的 YYYY-MM-DD');
  date.setUTCDate(date.getUTCDate() + amount);
  return isoFromUtc(date);
}

function localToday() {
  const now = new Date();
  return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
}

function validateTimezone(value) {
  if (typeof value !== 'string' || !value.trim()) fail('invalidTimezone', '必须显式提供 IANA --timezone');
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
    if (!resolved) throw new Error('unresolved timezone');
  } catch (error) {
    fail('invalidTimezone', '--timezone 不是有效的 IANA 时区');
  }
  return value;
}

function validateAvail(avail) {
  if (!Array.isArray(avail) || avail.length !== 7 || avail.some(row =>
    !Array.isArray(row) || row.length !== 4 || row.some(cell => typeof cell !== 'boolean'))) {
    fail('invalidAvail', 'snapshot.avail 必须是 7 × 4 布尔数组');
  }
  if (avail.some(row => row[3])) fail('invalidAvail', '22–24 静默时段不可用，avail 第四列必须为 false');
  return avail;
}

/* Same slot policy as assets/js/flows/goal.js: 30-minute cells, final two cells are buffer. */
function buildSlots(avail, startDate) {
  requireIsoDate(startDate, 'startDate');
  validateAvail(avail);
  const slots = [];
  for (let offset = 0; offset < 7; offset++) {
    const date = addDays(startDate, offset);
    const gridIndex = (parseIsoDate(date).getUTCDay() + 6) % 7;
    const starts = [];
    RANGES.forEach((range, index) => {
      if (avail[gridIndex][index] !== true) return;
      for (let minute = range[0]; minute < range[1]; minute += 30) starts.push(minute);
    });
    starts.forEach((startMin, index) => slots.push({
      date, startMin, durMin: 30, available: true,
      isBuffer: index >= starts.length - 2
    }));
  }
  return slots;
}

function assertJsonValue(value, label, ancestors = new Set()) {
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (typeof value === 'string') {
    if (UNSAFE_TEXT.test(value)) fail('invalidStructure', label + ' 含不安全控制字符');
    return;
  }
  if (typeof value !== 'object') fail('invalidStructure', label + ' 不是原始 JSON 值');
  if (ancestors.has(value)) fail('invalidStructure', label + ' 含循环引用');
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, label + '[' + index + ']', ancestors));
  } else {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) fail('invalidStructure', label + ' 不是普通 JSON 对象');
    Object.keys(value).forEach(key => {
      if (UNSAFE_TEXT.test(key)) fail('invalidStructure', label + ' 的键含不安全控制字符');
      assertJsonValue(value[key], label + '.' + key, ancestors);
    });
  }
  ancestors.delete(value);
}

function decodeInput(input) {
  if (typeof input !== 'string') return input;
  if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) fail('inputTooLarge', '输入超过 32 MiB 限制');
  try {
    return JSON.parse(input.replace(/^\uFEFF/, ''));
  } catch (error) {
    return { __migrationParseError: true };
  }
}

function envelopeOf(input) {
  if (!isObject(input)) fail('invalidStructure', '输入必须是 JSON 对象');
  if (input.__migrationParseError) fail('invalidStructure', '输入不是有效 JSON');
  if (input.format === 'nova-backup') {
    if (input.version !== 1) fail('invalidStructure', 'nova-backup 版本不受支持');
    if (!isObject(input.snapshot)) fail('invalidStructure', 'backup.snapshot 必须是对象');
    if (typeof input.createdAt !== 'string' || !Number.isFinite(Date.parse(input.createdAt))) {
      fail('invalidStructure', 'backup.createdAt 无效');
    }
    if (typeof input.installId !== 'string' || !SAFE_ID.test(input.installId)) fail('invalidStructure', 'backup.installId 必须是安全字符串 ID');
    return { snapshot: input.snapshot, sourceFormat: 'nova-backup/v1', installId: input.installId, overlayVersion: null };
  }
  if (input.format === 'nova-overlay') {
    if (![1, 2, 3].includes(input.version)) fail('invalidStructure', '仅支持 nova-overlay v1/v2/v3');
    if (hasOwn(input, 'snapshot')) fail('invalidStructure', 'overlay 必须使用扁平业务快照，不能嵌套 snapshot');
    let installId = input.installId;
    if (installId !== undefined && (typeof installId !== 'string' || !SAFE_ID.test(installId))) {
      fail('invalidStructure', 'overlay.installId 必须是安全字符串 ID');
    }
    if (input.version >= 2) {
      if (typeof installId !== 'string' || !SAFE_ID.test(installId)) fail('invalidStructure', 'overlay v2/v3 缺少有效 installId');
      if (typeof input.syncMode !== 'string' || input.syncMode !== 'local-only') fail('invalidStructure', 'overlay v2/v3 必须使用 syncMode=local-only');
      if (!Number.isSafeInteger(input.revision) || input.revision < 0) fail('invalidStructure', 'overlay revision 无效');
      if (!Number.isFinite(input.updatedAt)) fail('invalidStructure', 'overlay updatedAt 无效');
    }
    return { snapshot: input, sourceFormat: 'nova-overlay/v' + input.version, installId, overlayVersion: input.version };
  }
  fail('invalidStructure', '仅支持 nova-backup v1 或 nova-overlay v1/v2/v3 原始 JSON');
}

function validateTask(task, label) {
  if (!isObject(task)) fail('invalidStructure', label + ' 必须是对象');
  if (typeof task.id !== 'string' || !SAFE_ID.test(task.id)) fail('invalidStructure', label + '.id 必须是安全字符串 ID');
  for (const key of ['substitutedBy', 'replaces']) {
    if (task[key] !== undefined && task[key] !== null && (typeof task[key] !== 'string' || !SAFE_ID.test(task[key]))) {
      fail('invalidStructure', label + '.' + key + ' 必须是安全字符串 ID');
    }
  }
  for (const [key, max] of [['title', 200], ['s', 80], ['subject', 80], ['domain', 80], ['time', 64],
    ['skipReason', 300], ['deferredReason', 300], ['localNote', 1000]]) {
    if (task[key] !== undefined && task[key] !== null && (typeof task[key] !== 'string' || task[key].length > max)) {
      fail('invalidStructure', label + '.' + key + ' 文本无效或超长');
    }
  }
  if (task.subject !== undefined && typeof task.subject !== 'string') {
    fail('invalidStructure', label + '.subject 必须是字符串');
  }
  const estimates = ['est', 'estMin', 'actual', 'plannedEst', 'originalEst'];
  for (const key of estimates) {
    const nullable = key !== 'est' && key !== 'estMin';
    if (task[key] !== undefined && (!nullable || task[key] !== null) &&
      (typeof task[key] !== 'number' || !Number.isSafeInteger(task[key]) || task[key] < 0)) {
      fail('invalidStructure', label + '.' + key + ' 必须是非负安全整数');
    }
  }
  if (hasOwn(task, 'est') && hasOwn(task, 'estMin') && task.est !== task.estMin) {
    fail('invalidStructure', label + ' 的 est 与 estMin 冲突');
  }
  if (task.weight !== undefined && (typeof task.weight !== 'number' || !Number.isFinite(task.weight) || task.weight < 0)) {
    fail('invalidStructure', label + '.weight 必须是非负有限数值');
  }
  validateFinite(task.completion, label + '.completion', 0, 100);
  validateFinite(task.partial, label + '.partial', 0, 100);
  for (const key of TERMINAL.concat('deferred')) {
    if (task[key] !== undefined && typeof task[key] !== 'boolean') fail('invalidStructure', label + '.' + key + ' 必须是布尔值');
  }
}

function validateFinite(value, label, min, max) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || (max !== undefined && value > max)) {
    fail('invalidStructure', label + ' 必须是' + (max === undefined ? '不小于 ' + min : ' ' + min + '–' + max) + ' 的有限数值');
  }
}

function validateWeek(week, label) {
  if (!Array.isArray(week) || week.length !== 7 || week.some(day => !isObject(day))) {
    fail('invalidStructure', label + ' 必须是 7 个对象');
  }
  week.forEach((day, index) => {
    if (!Array.isArray(day.segs) || day.segs.some(seg =>
      !((Array.isArray(seg) && seg.length >= 2) || (typeof seg === 'number' && Number.isFinite(seg))))) {
      fail('invalidStructure', label + '[' + index + '].segs 结构无效');
    }
  });
}

function validateSnapshot(snapshot) {
  if (!isObject(snapshot)) fail('invalidStructure', 'snapshot 必须是对象');
  assertJsonValue(snapshot, 'snapshot');
  const missing = REQUIRED_SNAPSHOT_FIELDS.filter(key => !hasOwn(snapshot, key));
  if (missing.length) fail('invalidStructure', 'snapshot 缺少字段：' + missing.join(', '));
  for (const key of ['token', 'opQueue', 'op_queue', 'queue']) {
    if (hasOwn(snapshot, key)) fail('invalidStructure', 'snapshot 不得包含凭据或操作队列');
  }
  for (const key of ['tasks', 'sessions', 'replanHistory']) {
    if (!Array.isArray(snapshot[key]) || snapshot[key].some(item => !isObject(item))) {
      fail('invalidStructure', key + ' 必须是对象数组');
    }
  }
  for (const key of ['goal', 'feas', 'dayAssign', 'locks', 'attrCounts']) {
    if (!isObject(snapshot[key])) fail('invalidStructure', key + ' 必须是对象');
  }
  Object.keys(snapshot.attrCounts).forEach(key => validateFinite(snapshot.attrCounts[key], 'attrCounts.' + key, 0));
  validateFinite(snapshot.goal.weeks, 'goal.weeks', 0);
  validateFinite(snapshot.feas.weeklyH, 'feas.weeklyH', 0);
  validateFinite(snapshot.feas.weeks, 'feas.weeks', 0);
  validateFinite(snapshot.feas.discount, 'feas.discount', 0, 1);
  validateFinite(snapshot.feas.demand, 'feas.demand', 0);
  validateWeek(snapshot.week, 'week');
  validateWeek(snapshot.weekShift, 'weekShift');
  if (snapshot.avail !== null) validateAvail(snapshot.avail);
  if (snapshot.availSource !== null && !['default', 'user', 'legacy'].includes(snapshot.availSource)) {
    fail('invalidStructure', 'availSource 无效');
  }
  if (snapshot.notif !== null && !isObject(snapshot.notif)) fail('invalidStructure', 'notif 必须是对象或 null');
  if (snapshot.consecutiveZeroDays !== undefined &&
    (typeof snapshot.consecutiveZeroDays !== 'number' || !Number.isFinite(snapshot.consecutiveZeroDays))) {
    fail('invalidStructure', 'consecutiveZeroDays 无效');
  }
  if (snapshot.interrupted !== undefined && snapshot.interrupted !== null && typeof snapshot.interrupted !== 'boolean') {
    fail('invalidStructure', 'interrupted 无效');
  }
  if (snapshot.rescueRecord !== undefined && snapshot.rescueRecord !== null && !isObject(snapshot.rescueRecord)) {
    fail('invalidStructure', 'rescueRecord 无效');
  }
  if (snapshot.planVersion !== undefined && !/^plan-[0-9a-f]{32}$/.test(snapshot.planVersion)) {
    fail('invalidStructure', 'planVersion 无效');
  }
  if (snapshot.replanSnapshot !== null && (!isObject(snapshot.replanSnapshot) ||
    !Array.isArray(snapshot.replanSnapshot.tasks) || snapshot.replanSnapshot.tasks.some(task => !isObject(task)))) {
    fail('invalidStructure', 'replanSnapshot 结构无效');
  }
  const ids = new Set();
  snapshot.tasks.forEach((task, index) => {
    validateTask(task, 'tasks[' + index + ']');
    if (ids.has(task.id)) fail('invalidStructure', 'tasks 存在重复 ID');
    ids.add(task.id);
  });
  const sessionIds = new Set();
  snapshot.sessions.forEach((session, index) => {
    for (const key of ['id', 'taskId']) {
      if (typeof session[key] !== 'string' || !SAFE_ID.test(session[key])) fail('invalidStructure', 'sessions[' + index + '].' + key + ' 无效');
    }
    if (sessionIds.has(session.id)) fail('invalidStructure', 'sessions 存在重复 ID');
    sessionIds.add(session.id);
    if (!ids.has(session.taskId)) fail('invalidStructure', 'sessions[' + index + '] 引用了不存在的任务');
    for (const [key, max] of [['status', 64], ['note', 1000], ['feel', 300]]) {
      if (session[key] !== undefined && session[key] !== null &&
        (typeof session[key] !== 'string' || session[key].length > max)) {
        fail('invalidStructure', 'sessions[' + index + '].' + key + ' 无效');
      }
    }
    validateFinite(session.minutes, 'sessions[' + index + '].minutes', 0);
    validateFinite(session.startAt, 'sessions[' + index + '].startAt', 0);
    validateFinite(session.endAt, 'sessions[' + index + '].endAt', 0);
    validateFinite(session.completion, 'sessions[' + index + '].completion', 0, 100);
    if (typeof session.startAt === 'number' && typeof session.endAt === 'number' && session.endAt < session.startAt) {
      fail('invalidStructure', 'sessions[' + index + '].endAt 不得早于 startAt');
    }
  });
  for (const key of ['dayAssign', 'locks']) {
    Object.keys(snapshot[key]).forEach(id => {
      if (!SAFE_ID.test(id)) fail('invalidStructure', key + ' 的键必须是安全字符串 ID');
      if (!ids.has(id)) fail('invalidStructure', key + ' 引用了不存在的任务：' + id);
    });
  }
  if (snapshot.replanSnapshot) {
    const snapshotIds = new Set();
    snapshot.replanSnapshot.tasks.forEach((task, index) => {
      validateTask(task, 'replanSnapshot.tasks[' + index + ']');
      if (snapshotIds.has(task.id)) fail('invalidStructure', 'replanSnapshot.tasks 存在重复 ID');
      snapshotIds.add(task.id);
    });
  }
  for (const [key, max] of [['name', 200], ['deadline', 64], ['source', 64]]) {
    if (snapshot.goal[key] !== undefined && snapshot.goal[key] !== null &&
      (typeof snapshot.goal[key] !== 'string' || snapshot.goal[key].length > max)) {
      fail('invalidStructure', 'goal.' + key + ' 无效');
    }
  }
}

function hasLegacyBlockEvidence(snapshot) {
  if (snapshot.week.concat(snapshot.weekShift).some(day => day.segs.some(seg => Array.isArray(seg)))) return true;
  return snapshot.tasks.some(task => ['segments', 'blocks', 'currentSegments', 'originalSegments', 'blockId'].some(key => hasOwn(task, key)));
}

function normalizeExistingModel(snapshot) {
  try {
    const model = P.normalizeModel(snapshot.placementModel);
    const ids = new Set(snapshot.tasks.map(task => task.id));
    if (model.placements.some(item => !ids.has(item.taskId)) || model.unplanned.some(item => !ids.has(item.taskId))) {
      fail('modelConflict', 'placementModel 引用了 snapshot.tasks 中不存在的任务');
    }
    const unplannedIds = new Set(model.unplanned.map(item => item.taskId));
    for (const task of snapshot.tasks) {
      if (isPending(task) && !unplannedIds.has(task.id) && P.taskSegments(model, task.id).length === 0) {
        fail('modelConflict', '非终态任务既无当前落点也无 unplanned 证据');
      }
    }
    return model;
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    fail('modelConflict', 'placementModel 结构冲突或损坏');
  }
}

function classifyInput(input) {
  try {
    const decoded = decodeInput(input);
    const envelope = envelopeOf(decoded);
    validateSnapshot(envelope.snapshot);
    const snapshot = envelope.snapshot;
    if (snapshot.placementModel !== undefined && snapshot.placementModel !== null) {
      normalizeExistingModel(snapshot);
      return { classification: 'A', sourceFormat: envelope.sourceFormat, warnings: ['week/weekShift 将从合法 placementModel 重建投影'] };
    }
    if (hasLegacyBlockEvidence(snapshot)) {
      return { classification: 'C', sourceFormat: envelope.sourceFormat, warnings: [], reason: 'legacyBlockEvidence' };
    }
    return { classification: 'B', sourceFormat: envelope.sourceFormat, warnings: ['旧 total/buf 与 time 未被用作任务区块证据'] };
  } catch (error) {
    return {
      classification: 'C', sourceFormat: null, warnings: [],
      reason: error.code || 'invalidStructure', message: error.message || '输入结构损坏'
    };
  }
}

function taskMinutes(task) {
  return hasOwn(task, 'est') ? task.est : (hasOwn(task, 'estMin') ? task.estMin : 0);
}

function isPending(task) {
  return !TERMINAL.some(key => task[key] === true);
}

function fmtMinute(value) {
  return String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0');
}

function weekdayOf(date) {
  return DOW[parseIsoDate(date).getUTCDay()];
}

function taskTime(segments) {
  if (!segments.length) return '';
  const first = segments[0];
  const last = segments[segments.length - 1];
  const from = fmtMinute(first.startMin);
  const to = fmtMinute(last.startMin + last.durMin);
  return first.date === last.date ? from + '–' + to :
    first.date.slice(5) + ' ' + from + '–' + last.date.slice(5) + ' ' + to;
}

function parseLegacyTime(value) {
  if (typeof value !== 'string') return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)[–-]([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  const startMin = Number(match[1]) * 60 + Number(match[2]);
  const endMin = Number(match[3]) * 60 + Number(match[4]);
  return endMin > startMin ? { startMin, durMin: endMin - startMin } : null;
}

function lockedAnchor(task, startDate, slots, dayAssign) {
  const assignment = hasOwn(dayAssign, task.id) ? dayAssign[task.id] : null;
  const time = parseLegacyTime(task.time);
  if (typeof assignment !== 'string' || !/^[一二三四五六日]$/.test(assignment) || !time) {
    fail('unreliableLockedTask', 'locked 待办任务缺少可靠 dayAssign + HH:MM–HH:MM time');
  }
  if (time.durMin !== taskMinutes(task)) fail('unreliableLockedTask', 'locked 任务的 time 时长与剩余工时不一致');
  const dates = Array.from({ length: 7 }, (_, index) => addDays(startDate, index));
  const date = dates.find(item => weekdayOf(item) === assignment);
  if (!date || time.startMin % 30 !== 0 || !slots.some(slot => slot.date === date && slot.startMin === time.startMin)) {
    fail('unreliableLockedTask', 'locked 任务的星期/时间没有对应可用槽');
  }
  return { date, startMin: time.startMin };
}

function rebuildSnapshot(snapshot, options) {
  if (!options.rebuild) fail('cannotAutoMigrate', 'cannotAutoMigrate：B 类无任务区块证据，默认拒绝写出；请显式 --rebuild', 'B');
  if (typeof options.startDate !== 'string' || !options.startDate) fail('missingParameter', '--rebuild 必须显式提供 --start-date YYYY-MM-DD');
  if (typeof options.timezone !== 'string' || !options.timezone) fail('missingParameter', '--rebuild 必须显式提供 --timezone IANA');
  const startDate = requireIsoDate(options.startDate, '--start-date');
  const timezone = validateTimezone(options.timezone);
  const today = options.today === undefined ? localToday() : requireIsoDate(options.today, 'today');
  if (startDate < today) fail('pastStartDate', '--start-date 不得早于本机今天');
  if (snapshot.avail === null) fail('invalidAvail', 'snapshot.avail 为 null，不能重建');
  validateAvail(snapshot.avail);
  if (snapshot.tasks.some(task => task.deferred === true)) {
    fail('deferredTaskPresent', '存在 deferred 任务；请先恢复后再 rebuild');
  }

  const slots = buildSlots(snapshot.avail, startDate);
  const pending = snapshot.tasks.filter(isPending);
  if (pending.some(task => taskMinutes(task) > 0) && !slots.length) fail('noAvailableSlots', '没有可用槽，不能重建待办任务');
  const scheduleTasks = pending.map(task => ({
    id: task.id, subject: task.subject === undefined ? '未分类' : task.subject,
    estMin: taskMinutes(task), weight: task.weight === undefined ? 0 : task.weight,
    title: task.title === undefined ? '' : task.title,
    ...(snapshot.locks[task.id] === true ? lockedAnchor(task, startDate, slots, snapshot.dayAssign) : {})
  }));
  const result = schedule({
    tasks: scheduleTasks, slots,
    params: { bufferRatio: 0.15, maxContiguousMin: 150, dailyCapMin: 300 }
  });
  if (result.unplanned.some(item => snapshot.locks[item.taskId] === true)) {
    fail('lockedTaskNotPlaced', 'locked 任务无法完整排入可靠锚点，拒绝 rebuild');
  }

  let model;
  try {
    model = P.createModel({
      startDate, timezone, idPrefix: 'legacy-rebuild_', slots,
      tasks: snapshot.tasks, blocks: result.blocks,
      unplanned: result.unplanned.map(item => ({ taskId: item.taskId, reason: item.reason }))
    });
    const pendingIds = new Set(pending.map(task => task.id));
    model.unplanned = model.unplanned.filter(item => pendingIds.has(item.taskId));
    model.placements.forEach(placement => {
      placement.originalSegments = [];
      placement.source = 'legacy-rebuild';
    });
    model = P.normalizeModel(model);
  } catch (error) {
    fail('rebuildFailed', '重建落点模型失败：' + error.message);
  }

  const tasks = clone(snapshot.tasks);
  const byId = new Map(tasks.map(task => [task.id, task]));
  tasks.forEach(task => {
    delete task.unplanned;
    delete task.unplannedReason;
    task.date = null;
    task.time = '';
  });
  model.placements.forEach(placement => {
    const task = byId.get(placement.taskId);
    task.date = placement.currentSegments[0].date;
    task.time = taskTime(placement.currentSegments);
  });
  model.unplanned.forEach(item => {
    const task = byId.get(item.taskId);
    task.unplanned = true;
    task.unplannedReason = item.reason;
  });
  const week = P.projectWeek(model, tasks);
  const dayAssign = {};
  model.placements.forEach(placement => { dayAssign[placement.taskId] = weekdayOf(placement.currentSegments[0].date); });
  const out = snapshotWhitelist(snapshot);
  out.tasks = tasks;
  out.placementModel = model;
  out.week = week;
  out.weekShift = clone(week);
  out.dayAssign = dayAssign;
  out.replanSnapshot = null;
  delete out.planVersion;
  return out;
}

function logicalSnapshot(snapshot) {
  const out = snapshotWhitelist(snapshot);
  const model = normalizeExistingModel(snapshot);
  out.placementModel = model;
  out.week = P.projectWeek(model, out.tasks);
  out.weekShift = clone(out.week);
  out.dayAssign = {};
  model.placements.forEach(placement => {
    const segments = P.taskSegments(model, placement.taskId);
    if (segments.length) out.dayAssign[placement.taskId] = weekdayOf(segments[0].date);
  });
  delete out.planVersion;
  return out;
}

function createdAtOf(options) {
  const value = options.createdAt === undefined ? new Date().toISOString() : options.createdAt;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail('invalidCreatedAt', 'createdAt 必须是有效时间戳');
  return value;
}

function installIdOf(envelope, snapshot) {
  if (typeof envelope.installId === 'string' && envelope.installId.trim()) return envelope.installId;
  const digest = crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex').slice(0, 32);
  return 'install-migrated-' + digest;
}

function migrateInput(input, options = {}) {
  if (!isObject(options)) fail('invalidOptions', 'options 必须是对象');
  const decoded = decodeInput(input);
  const classification = classifyInput(decoded);
  if (classification.classification === 'C') {
    fail('cannotAutoMigrate', 'cannotAutoMigrate：C 类结构冲突/损坏（' + (classification.reason || 'invalidStructure') + '）', 'C');
  }
  const envelope = envelopeOf(decoded);
  const createdAt = createdAtOf(options);
  const warnings = classification.warnings.slice();
  let snapshot;
  let mode;
  if (classification.classification === 'A') {
    if (options.rebuild) fail('rebuildNotAllowed', '--rebuild 只允许 B 类输入；A 类保留合法 placementModel', 'A');
    snapshot = logicalSnapshot(envelope.snapshot);
    mode = 'logical';
    if (!envelope.installId) warnings.push('旧 overlay 无 installId，已按源快照指纹生成迁移标识');
  } else {
    snapshot = rebuildSnapshot(envelope.snapshot, options);
    mode = 'rebuild';
    warnings.push('originalSegments 已清空：旧数据没有历史区块证据');
    warnings.push('replanSnapshot 已置空，旧撤销快照不得覆盖新模型');
    if (!envelope.installId) warnings.push('旧 overlay 无 installId，已按源快照指纹生成迁移标识');
    if (snapshot.placementModel.unplanned.length) warnings.push(snapshot.placementModel.unplanned.length + ' 个待办任务未能排入，已保留 unplanned 证据');
  }
  validateSnapshot(snapshot);
  const backup = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt,
    installId: installIdOf(envelope, envelope.snapshot),
    snapshot,
    migration: {
      classification: classification.classification,
      mode,
      ...(mode === 'rebuild' ? { startDate: options.startDate, timezone: options.timezone } : {}),
      createdAt,
      sourceFormat: classification.sourceFormat,
      warnings
    }
  };
  if (options.out !== undefined) writeExclusive(options.out, JSON.stringify(backup, null, 2) + '\n', options.inputPath);
  return backup;
}

function assertOutputDoesNotExist(out) {
  try {
    fs.lstatSync(out);
    fail('outputExists', '--out 已存在，拒绝覆盖');
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    if (error.code !== 'ENOENT') throw error;
  }
}

function writeExclusive(out, text, inputPath) {
  if (typeof out !== 'string' || !out) fail('missingParameter', '必须提供不存在的 --out 路径');
  const target = path.resolve(out);
  assertOutputDoesNotExist(target);
  if (inputPath) {
    const source = path.resolve(inputPath);
    if (process.platform === 'win32' ? source.toLowerCase() === target.toLowerCase() : source === target) {
      fail('inputOutputConflict', '--out 不得指向输入文件');
    }
  }
  const parent = path.dirname(target);
  let parentStat;
  try { parentStat = fs.statSync(parent); } catch (error) { fail('invalidOutput', '--out 父目录不存在或不可访问'); }
  if (!parentStat.isDirectory()) fail('invalidOutput', '--out 父路径不是目录');
  const temporary = target + '.' + process.pid + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  let committed = false;
  let created = false;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    created = true;
    try {
      fs.writeFileSync(fd, text, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(temporary, 0o600);
    /* link is an atomic create-if-absent operation; it cannot replace an input or racing output. */
    fs.linkSync(temporary, target);
    committed = true;
    fs.unlinkSync(temporary);
    if (process.platform !== 'win32') {
      const directoryFd = fs.openSync(parent, 'r');
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    }
  } catch (error) {
    if (created) { try { fs.unlinkSync(temporary); } catch (cleanupError) { /* retain original error */ } }
    if (error instanceof MigrationError) throw error;
    if (error.code === 'EEXIST') fail('outputExists', '--out 已存在，拒绝覆盖');
    if (committed) fail('outputCommitted', '输出已提交但目录 fsync 失败：' + error.message);
    fail('writeFailed', '独占写出失败：' + error.message);
  }
  return target;
}

function parseArgs(args) {
  const options = { rebuild: false };
  let inputPath = null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--rebuild') {
      if (options.rebuild) fail('invalidArguments', '参数重复：--rebuild');
      options.rebuild = true;
      continue;
    }
    if (!['--out', '--start-date', '--timezone'].includes(arg)) {
      if (arg.startsWith('--') || inputPath) fail('invalidArguments', '未知或重复参数：' + arg);
      inputPath = arg;
      continue;
    }
    const key = arg === '--start-date' ? 'startDate' : arg.slice(2);
    if (hasOwn(options, key)) fail('invalidArguments', '参数重复：' + arg);
    const value = args[++index];
    if (!value || value.startsWith('--')) fail('invalidArguments', '参数不完整：' + arg);
    options[key] = value;
  }
  if (!inputPath) fail('missingParameter', '缺少输入文件路径');
  if (!options.out) fail('missingParameter', '缺少 --out');
  if (!options.rebuild && (options.startDate !== undefined || options.timezone !== undefined)) {
    fail('invalidArguments', '--start-date/--timezone 只能与 --rebuild 同用');
  }
  return { inputPath, options };
}

function readInput(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { fail('readFailed', '无法读取输入文件'); }
  if (stat.isSymbolicLink() || !stat.isFile()) fail('readFailed', '输入路径必须是普通文件');
  if (stat.size > MAX_INPUT_BYTES) fail('inputTooLarge', '输入超过 32 MiB 限制');
  try { return fs.readFileSync(file, 'utf8'); } catch (error) { fail('readFailed', '无法读取输入文件'); }
}

function statsOf(backup, inputPath, out, text) {
  const model = backup.snapshot.placementModel;
  return {
    ok: true,
    classification: backup.migration.classification,
    mode: backup.migration.mode,
    sourceFormat: backup.migration.sourceFormat,
    input: path.resolve(inputPath),
    out: path.resolve(out),
    sha256: crypto.createHash('sha256').update(text).digest('hex'),
    bytes: Buffer.byteLength(text, 'utf8'),
    tasks: backup.snapshot.tasks.length,
    placements: model ? model.placements.length : 0,
    unplanned: model ? model.unplanned.length : 0,
    warnings: backup.migration.warnings.length
  };
}

function main(args = process.argv.slice(2)) {
  try {
    if (args.length === 1 && args[0] === '--help') {
      process.stdout.write(USAGE + '\n');
      return;
    }
    const { inputPath, options } = parseArgs(args);
    const raw = readInput(inputPath);
    const backup = migrateInput(raw, { ...options, inputPath });
    const text = JSON.stringify(backup, null, 2) + '\n';
    /* migrateInput wrote the same serialization; report only aggregate metadata. */
    process.stdout.write(JSON.stringify(statsOf(backup, inputPath, options.out, text)) + '\n');
  } catch (error) {
    const classification = error.classification || null;
    process.stderr.write(JSON.stringify({
      ok: false,
      error: error.code || 'migrationFailed',
      classification,
      message: error.message || '迁移失败'
    }) + '\n');
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { migrateInput, classifyInput, buildSlots };
