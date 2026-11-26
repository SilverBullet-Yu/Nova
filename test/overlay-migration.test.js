'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const P = require('../shared/placement-model.js');
const { migrateInput, classifyInput, buildSlots } = require('../scripts/overlay-migration.js');

const SCRIPT = path.resolve(__dirname, '../scripts/overlay-migration.js');
const SETTINGS = path.resolve(__dirname, '../assets/js/flows/settings.js');
const TODAY = '2026-11-24';
const START = '2026-11-25';
const TIMEZONE = 'Asia/Shanghai';
const PLAN_VERSION = 'plan-0123456789abcdef0123456789abcdef';
const DOW = ['一', '二', '三', '四', '五', '六', '日'];
const clone = value => JSON.parse(JSON.stringify(value));

function availAll() {
  return Array.from({ length: 7 }, () => [true, true, true, false]);
}

function baseSnapshot() {
  const tasks = [
    {
      id: 'task-stable', subject: '数学', s: '数学', title: '稳定任务标题', est: 90,
      estMin: 90, weight: 0.92, actual: 15, plannedEst: 120, originalEst: 120,
      date: '1999-01-01', time: 'legacy-invalid-time', why: '保留正文', done: false
    },
    { id: 'done-task', subject: '英语', title: '已完成', est: 60, weight: 0.8, actual: 60, done: true },
    { id: 'skipped-task', subject: '英语', title: '已跳过', est: 30, skipped: true },
    { id: 'abandoned-task', subject: '政治', title: '已放弃', est: 45, abandoned: true },
    { id: 'substituted-task', subject: '408', title: '已替代', est: 75, substituted: true, substitutedBy: 'task-stable' }
  ];
  const week = DOW.map(d => ({ d, segs: [123], total: 999, buf: 60 }));
  return {
    planVersion: PLAN_VERSION,
    tasks,
    sessions: [{ id: 'session-1', taskId: 'task-stable', minutes: 15, status: 'done', startAt: 123 }],
    goal: { name: '保留目标', deadline: '2027-12-01', source: 'user', weeks: 12 },
    feas: { weeklyH: 20, weeks: 12, discount: 0.85, demand: 400 },
    week,
    weekShift: clone(week),
    dayAssign: { 'task-stable': '三' },
    locks: {},
    avail: availAll(),
    availSource: 'user',
    notif: { daily: true, weekly: false, rescue: true },
    attrCounts: { '效率不足': 2 },
    consecutiveZeroDays: 3,
    interrupted: false,
    rescueRecord: { reason: '保留' },
    replanHistory: [{ at: 123, loadDelta: 0.1, undone: false }],
    replanSnapshot: { tasks: clone(tasks), week: clone(week), timestamp: 123 },
    buffer: { time: 'old-buffer', free: false, marker: 'preserve-extra' }
  };
}

function overlay(snapshot, version = 2) {
  const out = { format: 'nova-overlay', version, ...clone(snapshot) };
  if (version === 1) return out;
  return {
    ...out,
    installId: 'install-0123456789abcdef0123456789abcdef',
    syncMode: 'local-only', revision: 7, updatedAt: 123
  };
}

function backup(snapshot) {
  return {
    format: 'nova-backup', version: 1, createdAt: '2026-01-01T00:00:00.000Z',
    installId: 'install-backup', snapshot: clone(snapshot)
  };
}

function aSnapshot() {
  const snapshot = baseSnapshot();
  snapshot.tasks = [{ id: 'a-task', subject: '数学', title: 'A 类任务', est: 60, weight: 0.9, done: false }];
  snapshot.sessions = [];
  snapshot.dayAssign = { 'a-task': '一' };
  snapshot.replanSnapshot = { tasks: clone(snapshot.tasks), timestamp: 123 };
  const slots = buildSlots(availAll(), TODAY);
  snapshot.placementModel = P.createModel({
    startDate: TODAY, timezone: TIMEZONE, idPrefix: 'a_', slots,
    tasks: snapshot.tasks,
    blocks: [{ id: 'a-block', taskId: 'a-task', date: TODAY, startMin: 480, durMin: 60, reason: 'existing-evidence' }]
  });
  snapshot.week = P.projectWeek(snapshot.placementModel, snapshot.tasks);
  snapshot.weekShift = clone(snapshot.week);
  return snapshot;
}

function rebuildOptions(extra = {}) {
  return { rebuild: true, startDate: START, timezone: TIMEZONE, today: TODAY, createdAt: '2026-11-24T12:00:00.000Z', ...extra };
}

function expectCode(fn, code, classification) {
  assert.throws(fn, error => {
    assert.equal(error.code, code);
    if (classification) assert.equal(error.classification, classification);
    return true;
  });
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-overlay-migration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJson(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
  return file;
}

function cli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 20000 });
}

function futureStart() {
  const date = new Date();
  date.setDate(date.getDate() + 2);
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}

function parseBackup(text) {
  // Expose the real private parser inside this VM only; no production file is changed.
  const source = fs.readFileSync(SETTINGS, 'utf8').replace(
    'ZX.settings = ZX.flows.settings;',
    'ZX.settings = ZX.flows.settings; ZX.settings.__parseBackupForTest = parseBackup;'
  );
  const window = { ZX: { util: {} }, Rhythm: { placementModel: P } };
  const context = vm.createContext({ window, Intl, Date });
  vm.runInContext(source, context, { filename: SETTINGS });
  return window.ZX.settings.__parseBackupForTest(text);
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

test('分类 A：合法 backup/overlay placementModel 原样逻辑迁移并重建投影', () => {
  for (const input of [backup(aSnapshot()), overlay(aSnapshot(), 1), overlay(aSnapshot(), 2), overlay(aSnapshot(), 3)]) {
    const before = clone(input);
    const classification = classifyInput(input);
    assert.equal(classification.classification, 'A');
    const out = migrateInput(input, { today: TODAY, createdAt: '2026-11-24T12:00:00.000Z' });
    assert.equal(out.format, 'nova-backup');
    assert.equal(out.version, 1);
    assert.equal(out.migration.classification, 'A');
    assert.equal(out.migration.mode, 'logical');
    assert.deepEqual(out.snapshot.placementModel, before.snapshot ? before.snapshot.placementModel : before.placementModel);
    assert.deepEqual(out.snapshot.week, P.projectWeek(out.snapshot.placementModel, out.snapshot.tasks));
    assert.deepEqual(out.snapshot.weekShift, out.snapshot.week);
    assert.equal(out.snapshot.dayAssign['a-task'], '二', 'A 类 dayAssign 也从具体落点重建');
    assert.deepEqual(input, before);
    parseBackup(JSON.stringify(out));
  }
});

test('A 类空当前落点可迁移，未覆盖的非终态任务归 C', () => {
  const released = aSnapshot();
  released.placementModel.placements[0].currentSegments = [];
  released.placementModel.unplanned.push({ taskId: 'a-task', reason: '已释放，待重排' });
  const out = migrateInput(backup(released), { today: TODAY, createdAt: '2026-11-24T12:00:00.000Z' });
  assert.equal(out.snapshot.placementModel.unplanned[0].taskId, 'a-task');
  assert.equal(Object.hasOwn(out.snapshot.dayAssign, 'a-task'), false);

  const missing = aSnapshot();
  missing.placementModel.placements[0].currentSegments = [];
  assert.equal(classifyInput(backup(missing)).classification, 'C');
});

test('A 类乱序段落按最早日期投影，输出剥离信封与未知字段并失效旧版本号', () => {
  const snapshot = aSnapshot();
  snapshot.placementModel.placements[0].currentSegments.push({
    blockId: 'a-later', taskId: 'a-task', date: '2026-11-25', startMin: 480, durMin: 30, isBuffer: false
  });
  snapshot.placementModel.placements[0].currentSegments.reverse();
  snapshot.privateNote = '不得进入迁移备份';
  snapshot.buffer = { marker: '旧派生字段' };
  const input = overlay(snapshot, 3);
  input.auth_token = '不得进入迁移备份';
  const out = migrateInput(input, { today: TODAY, createdAt: '2026-11-24T12:00:00.000Z' });
  assert.equal(out.snapshot.dayAssign['a-task'], '二');
  assert.equal(out.snapshot.planVersion, undefined);
  assert.equal(Object.hasOwn(out.snapshot, 'privateNote'), false);
  assert.equal(Object.hasOwn(out.snapshot, 'buffer'), false);
  assert.equal(Object.hasOwn(out.snapshot, 'format'), false);
  assert.equal(Object.hasOwn(out.snapshot, 'revision'), false);
  assert.doesNotMatch(JSON.stringify(out), /不得进入迁移备份|旧派生字段/);
});

test('v2/v3 非 local-only 信封归 C', () => {
  const input = overlay(aSnapshot(), 3);
  input.syncMode = 'cloud-sync';
  assert.equal(classifyInput(input).classification, 'C');
});

test('分类 B：v1/v2/v3 无任务区块证据，total/buf/time 不被当作证据', () => {
  for (const version of [1, 2, 3]) {
    const result = classifyInput(overlay(baseSnapshot(), version));
    assert.equal(result.classification, 'B');
    assert.equal(result.sourceFormat, 'nova-overlay/v' + version);
  }
  const snapshot = baseSnapshot();
  snapshot.week.forEach(day => { day.total = 100000; day.buf = 999; });
  snapshot.tasks[0].time = '09:00–10:00';
  assert.equal(classifyInput(snapshot).classification, 'C', '裸 snapshot 不是受支持的输入信封');
  assert.equal(classifyInput(overlay(snapshot, 1)).classification, 'B');
});

test('分类 C：损坏 JSON、未来版本、缺字段、非法模型、悬空引用和 legacy 区块证据', () => {
  const cases = [
    '{broken',
    { format: 'nova-overlay', version: 4, ...baseSnapshot() },
    { format: 'nova-backup', version: 1, createdAt: 'bad', installId: 'x', snapshot: baseSnapshot() },
    { format: 'nova-backup', version: 1, createdAt: '2026-01-01T00:00:00.000Z', installId: 'unsafe install id', snapshot: baseSnapshot() },
    { format: 'nova-overlay', version: 2, ...baseSnapshot() },
    overlay({ ...baseSnapshot(), tasks: 'not-an-array' }, 3)
  ];
  const invalidModel = aSnapshot();
  invalidModel.placementModel.schemaVersion = 2;
  cases.push(overlay(invalidModel, 3));
  const dangling = aSnapshot();
  dangling.placementModel.unplanned.push({ taskId: 'missing-task', reason: '悬空' });
  cases.push(backup(dangling));
  const evidence = baseSnapshot();
  evidence.week[0].segs = [['数学', 60]];
  cases.push(overlay(evidence, 1));
  const taskEvidence = baseSnapshot();
  taskEvidence.tasks[0].segments = [];
  cases.push(overlay(taskEvidence, 2));
  const nullSubject = baseSnapshot();
  nullSubject.tasks[0].subject = null;
  cases.push(overlay(nullSubject, 2));
  const nullEstimate = baseSnapshot();
  nullEstimate.tasks[0].est = null;
  delete nullEstimate.tasks[0].estMin;
  cases.push(overlay(nullEstimate, 2));
  for (const input of cases) assert.equal(classifyInput(input).classification, 'C');
});

test('B/C 默认拒绝写出并明确 cannotAutoMigrate', () => {
  const dir = tempDir(test);
  for (const [input, classification] of [[overlay(baseSnapshot(), 1), 'B'], [overlay({ ...baseSnapshot(), tasks: [] , week: [] }, 1), 'C']]) {
    const source = writeJson(dir, classification + '.json', input);
    const out = path.join(dir, classification + '-out.json');
    const result = cli([source, '--out', out]);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    const error = JSON.parse(result.stderr);
    assert.equal(error.error, 'cannotAutoMigrate');
    assert.equal(error.classification, classification);
    assert.match(error.message, /cannotAutoMigrate/);
    assert.equal(fs.existsSync(out), false);
  }
});

test('rebuild 缺参数、过去日期、非法日期/时区和 avail 均拒绝', () => {
  const input = overlay(baseSnapshot(), 3);
  expectCode(() => migrateInput(input, rebuildOptions({ startDate: undefined })), 'missingParameter');
  expectCode(() => migrateInput(input, rebuildOptions({ timezone: undefined })), 'missingParameter');
  expectCode(() => migrateInput(input, rebuildOptions({ startDate: '2026-11-23' })), 'pastStartDate');
  expectCode(() => migrateInput(input, rebuildOptions({ startDate: '2026-02-30' })), 'invalidDate');
  expectCode(() => migrateInput(input, rebuildOptions({ timezone: 'Not/A_Zone' })), 'invalidTimezone');
  for (const avail of [null, availAll().slice(0, 6), availAll().map(row => row.map(() => 1)), availAll().map((row, i) => i === 0 ? [true, true, true, true] : row)]) {
    const snapshot = baseSnapshot();
    snapshot.avail = avail;
    expectCode(() => migrateInput(overlay(snapshot, 3), rebuildOptions()), avail === null ? 'invalidAvail' : 'cannotAutoMigrate');
  }
  const empty = baseSnapshot();
  empty.avail = Array.from({ length: 7 }, () => [false, false, false, false]);
  expectCode(() => migrateInput(overlay(empty, 3), rebuildOptions()), 'noAvailableSlots');
});

test('deferred 任务拒绝 rebuild；locked 缺可靠锚点、时间冲突或不可用也拒绝', () => {
  const deferred = baseSnapshot();
  deferred.tasks.push({ id: 'deferred-task', subject: '英语', title: '暂缓', est: 30, deferred: true });
  expectCode(() => migrateInput(overlay(deferred, 3), rebuildOptions()), 'deferredTaskPresent');

  for (const mutate of [
    task => { delete task.time; },
    task => { task.time = 'legacy-invalid-time'; },
    task => { task.time = '09:00–11:00'; }
  ]) {
    const snapshot = baseSnapshot();
    snapshot.locks['task-stable'] = true;
    mutate(snapshot.tasks[0]);
    expectCode(() => migrateInput(overlay(snapshot, 3), rebuildOptions()), 'unreliableLockedTask');
  }
  const missingDay = baseSnapshot();
  missingDay.locks['task-stable'] = true;
  missingDay.dayAssign = {};
  missingDay.tasks[0].time = '09:00–10:30';
  expectCode(() => migrateInput(overlay(missingDay, 3), rebuildOptions()), 'unreliableLockedTask');
  const unavailable = baseSnapshot();
  unavailable.locks['task-stable'] = true;
  unavailable.tasks[0].time = '09:00–10:30';
  unavailable.avail[2][0] = false;
  expectCode(() => migrateInput(overlay(unavailable, 3), rebuildOptions()), 'unreliableLockedTask');
});

test('A 不接受 --rebuild；C 即使显式 rebuild 也拒绝', () => {
  expectCode(() => migrateInput(backup(aSnapshot()), rebuildOptions()), 'rebuildNotAllowed', 'A');
  const evidence = baseSnapshot();
  evidence.week[0].segs = [['数学', 60]];
  expectCode(() => migrateInput(overlay(evidence, 3), rebuildOptions()), 'cannotAutoMigrate', 'C');
});

test('成功 rebuild：未来 7 天、稳定任务字段、终态不复活、投影/撤销快照正确', () => {
  const input = deepFreeze(overlay(baseSnapshot(), 3));
  const before = clone(input);
  const out = migrateInput(input, rebuildOptions());
  const snapshot = out.snapshot;
  const model = snapshot.placementModel;

  assert.equal(out.migration.classification, 'B');
  assert.equal(out.migration.mode, 'rebuild');
  assert.equal(out.migration.startDate, START);
  assert.equal(out.migration.timezone, TIMEZONE);
  assert.equal(out.migration.createdAt, '2026-11-24T12:00:00.000Z');
  assert.equal(out.migration.sourceFormat, 'nova-overlay/v3');
  assert.ok(Array.isArray(out.migration.warnings) && out.migration.warnings.length > 0);
  assert.equal(model.startDate, START);
  assert.equal(model.days.length, 7);
  assert.deepEqual(model.days.map(day => day.date), ['2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29', '2026-11-30', '2026-12-01']);
  assert.deepEqual(model.placements.map(item => item.taskId), ['task-stable']);
  assert.ok(model.placements.every(item => item.source === 'legacy-rebuild'));
  assert.ok(model.placements.every(item => item.originalSegments.length === 0));
  assert.ok(model.unplanned.every(item => item.taskId === 'task-stable'));

  const task = snapshot.tasks.find(item => item.id === 'task-stable');
  assert.equal(task.title, '稳定任务标题');
  assert.equal(task.why, '保留正文');
  assert.equal(task.weight, 0.92);
  assert.equal(task.actual, 15);
  assert.equal(task.plannedEst, 120);
  assert.equal(task.originalEst, 120);
  assert.equal(task.est, 90);
  assert.equal(task.date, START);
  assert.equal(task.time, '08:00–09:30');
  assert.equal(snapshot.dayAssign['task-stable'], '三');
  for (const id of ['done-task', 'skipped-task', 'abandoned-task', 'substituted-task']) {
    const terminal = snapshot.tasks.find(item => item.id === id);
    assert.equal(terminal.date, null);
    assert.equal(terminal.time, '');
    assert.equal(model.placements.some(item => item.taskId === id), false);
  }
  assert.equal(snapshot.replanSnapshot, null);
  assert.equal(snapshot.planVersion, undefined);
  assert.deepEqual(snapshot.week, P.projectWeek(model, snapshot.tasks));
  assert.deepEqual(snapshot.weekShift, snapshot.week);
  assert.equal(snapshot.week[0].total, 90, '未用弹性容量不计入任务工时');
  assert.equal(snapshot.week[0].buf, 60);
  assert.equal(snapshot.week[0].normalUsed, 90);
  assert.equal(snapshot.week[0].bufferUsed, 0);

  for (const key of ['goal', 'feas', 'sessions', 'notif', 'avail', 'locks', 'replanHistory']) {
    assert.deepEqual(snapshot[key], before[key]);
  }
  assert.deepEqual(input, before, '迁移不得修改输入对象');
  parseBackup(JSON.stringify(out));
});

test('locked 待办可由可靠 dayAssign+time 作为刚性任务完整排入', () => {
  const snapshot = baseSnapshot();
  snapshot.locks['task-stable'] = true;
  snapshot.tasks[0].time = '09:00–10:30';
  const out = migrateInput(overlay(snapshot, 3), rebuildOptions());
  const placement = out.snapshot.placementModel.placements.find(item => item.taskId === 'task-stable');
  assert.equal(placement.currentSegments[0].date, START);
  assert.equal(placement.currentSegments[0].startMin, 540);
  assert.equal(out.snapshot.tasks[0].time, '09:00–10:30');
  assert.equal(out.snapshot.placementModel.unplanned.length, 0);
});

test('重复 session、悬空 session 与重复撤销任务均归 C', () => {
  const duplicateSession = baseSnapshot();
  duplicateSession.sessions.push({ ...duplicateSession.sessions[0] });
  assert.throws(() => migrateInput(overlay(duplicateSession, 1), rebuildOptions()), error => error.classification === 'C');
  const danglingSession = baseSnapshot();
  danglingSession.sessions[0].taskId = 'missing-task';
  assert.throws(() => migrateInput(overlay(danglingSession, 1), rebuildOptions()), error => error.classification === 'C');
  const duplicateSnapshotTask = baseSnapshot();
  duplicateSnapshotTask.replanSnapshot = { tasks: [duplicateSnapshotTask.tasks[0], { ...duplicateSnapshotTask.tasks[0] }] };
  assert.throws(() => migrateInput(overlay(duplicateSnapshotTask, 1), rebuildOptions()), error => error.classification === 'C');
});

test('弹性槽任务按实际用量计 total；容量不虚增任务工时', () => {
  const snapshot = baseSnapshot();
  snapshot.tasks = [{ id: 'buffer-task', subject: '数学', title: '弹性任务', est: 180, weight: 1 }];
  snapshot.sessions = [];
  snapshot.avail = Array.from({ length: 7 }, () => [false, false, false, false]);
  snapshot.avail[0][0] = true;
  snapshot.dayAssign = {};
  snapshot.locks = {};
  const out = migrateInput(overlay(snapshot, 1), rebuildOptions({ startDate: TODAY }));
  const model = out.snapshot.placementModel;
  const monday = model.days.find(day => day.date === '2026-11-30');
  const projectedMonday = out.snapshot.week.find(day => day.date === '2026-11-30');
  assert.equal(monday.capacityMin, 180);
  assert.equal(monday.bufferCapacityMin, 60);
  assert.ok(model.placements[0].currentSegments.some(segment => segment.isBuffer));
  assert.ok(model.placements[0].currentSegments.some(segment => !segment.isBuffer));
  assert.equal(projectedMonday.normalUsed, 150);
  assert.equal(projectedMonday.bufferUsed, 30);
  assert.equal(projectedMonday.total, 180);
  assert.equal(projectedMonday.buf, 60);
});

test('容量不足保留 unplanned 证据与告警，不猜测或丢弃待办', () => {
  const snapshot = baseSnapshot();
  snapshot.tasks[0].est = 1000;
  snapshot.tasks[0].estMin = 1000;
  snapshot.avail = Array.from({ length: 7 }, () => [false, false, false, false]);
  snapshot.avail[2][0] = true;
  const out = migrateInput(overlay(snapshot, 3), rebuildOptions());
  assert.ok(out.snapshot.placementModel.unplanned.some(item => item.taskId === 'task-stable'));
  assert.equal(out.snapshot.tasks[0].unplanned, true);
  assert.ok(out.migration.warnings.some(item => /未能排入/.test(item)));
  assert.ok(out.snapshot.placementModel.placements[0].originalSegments.length === 0);
});

test('buildSlots 按真实星期映射 7 天，30 分钟粒度且每日末两槽为弹性', () => {
  const avail = Array.from({ length: 7 }, () => [false, false, false, false]);
  avail[0][0] = true;
  const slots = buildSlots(avail, TODAY);
  assert.equal(slots.length, 8);
  assert.deepEqual(slots.map(slot => slot.startMin), [480, 510, 540, 570, 600, 630, 660, 690]);
  assert.deepEqual(slots.map(slot => slot.isBuffer), [false, false, false, false, false, false, true, true]);
  assert.ok(slots.every(slot => slot.date === '2026-11-30' && slot.durMin === 30 && slot.available), '周二起点应映射到下周一');
  expectCode(() => buildSlots(avail, '2026-02-30'), 'invalidDate');
  expectCode(() => buildSlots([], TODAY), 'invalidAvail');
});

test('CLI 成功：stdout 只有统计/路径/hash，原文件不变，输出独占且 mode600', () => {
  const dir = tempDir(test);
  const input = overlay(baseSnapshot(), 3);
  input.tasks[0].title = '不得出现在 stdout 的敏感正文';
  const source = writeJson(dir, 'source.json', input);
  const original = fs.readFileSync(source);
  const out = path.join(dir, 'migrated.json');
  const startDate = futureStart();
  const result = cli([source, '--out', out, '--rebuild', '--start-date', startDate, '--timezone', 'UTC']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const stats = JSON.parse(result.stdout);
  assert.equal(stats.ok, true);
  assert.equal(stats.classification, 'B');
  assert.equal(stats.mode, 'rebuild');
  assert.equal(stats.out, path.resolve(out));
  assert.match(stats.sha256, /^[0-9a-f]{64}$/);
  assert.equal(stats.tasks, input.tasks.length);
  assert.doesNotMatch(result.stdout, /敏感正文|保留正文/);
  assert.deepEqual(fs.readFileSync(source), original);
  const text = fs.readFileSync(out, 'utf8');
  assert.equal(stats.sha256, require('node:crypto').createHash('sha256').update(text).digest('hex'));
  assert.equal(stats.bytes, Buffer.byteLength(text));
  assert.equal(fs.statSync(out).nlink, 1, '临时硬链接已移除，最终输出只有目标目录项');
  if (process.platform !== 'win32') assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['migrated.json', 'source.json']);
  parseBackup(text);
});

test('CLI 可将 nova-backup v1 的 A 类输入逻辑迁移到新备份', () => {
  const dir = tempDir(test);
  const source = writeJson(dir, 'a-source.json', backup(aSnapshot()));
  const original = fs.readFileSync(source);
  const out = path.join(dir, 'a-out.json');
  const result = cli([source, '--out', out]);
  assert.equal(result.status, 0, result.stderr);
  const stats = JSON.parse(result.stdout);
  assert.equal(stats.classification, 'A');
  assert.equal(stats.mode, 'logical');
  assert.equal(stats.sourceFormat, 'nova-backup/v1');
  assert.deepEqual(fs.readFileSync(source), original);
  const migrated = parseBackup(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(clone(migrated.snapshot.placementModel), aSnapshot().placementModel);
});

test('CLI 输出已存在/指向输入/悬空符号链接均不覆盖', () => {
  const dir = tempDir(test);
  const source = writeJson(dir, 'source.json', backup(aSnapshot()));
  const original = fs.readFileSync(source);
  const existing = path.join(dir, 'existing.json');
  fs.writeFileSync(existing, 'sentinel');
  let result = cli([source, '--out', existing]);
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(result.stderr).error, 'outputExists');
  assert.equal(fs.readFileSync(existing, 'utf8'), 'sentinel');

  result = cli([source, '--out', source]);
  assert.notEqual(result.status, 0);
  assert.deepEqual(fs.readFileSync(source), original);

  const dangling = path.join(dir, 'dangling.json');
  fs.symlinkSync(path.join(dir, 'missing-target.json'), dangling);
  result = cli([source, '--out', dangling]);
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(result.stderr).error, 'outputExists');
  assert.equal(fs.lstatSync(dangling).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(dir, 'missing-target.json')), false);
});

test('CLI 缺参数、非法参数与 C 类 rebuild 均非零且不创建输出', () => {
  const dir = tempDir(test);
  const source = writeJson(dir, 'source.json', overlay(baseSnapshot(), 3));
  const out = path.join(dir, 'out.json');
  for (const args of [
    [source],
    [source, '--out', out, '--rebuild'],
    [source, '--out', out, '--rebuild', '--start-date', futureStart()],
    [source, '--out', out, '--start-date', futureStart(), '--timezone', 'UTC'],
    [source, '--out', out, '--unknown', 'x'],
    [source, '--out', out, '--out', out]
  ]) {
    const result = cli(args);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(fs.existsSync(out), false);
  }
  const corrupt = writeJson(dir, 'corrupt.json', overlay({ ...baseSnapshot(), week: [] }, 3));
  const corruptOut = path.join(dir, 'corrupt-out.json');
  const result = cli([corrupt, '--out', corruptOut, '--rebuild', '--start-date', futureStart(), '--timezone', 'UTC']);
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(result.stderr).error, 'cannotAutoMigrate');
  assert.equal(fs.existsSync(corruptOut), false);
});

test('迁移模块可无副作用 require，支持原始 JSON 字符串与 BOM', () => {
  const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(SCRIPT)});`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  const text = '\uFEFF' + JSON.stringify(overlay(baseSnapshot(), 1));
  const out = migrateInput(text, rebuildOptions());
  assert.equal(out.migration.sourceFormat, 'nova-overlay/v1');
  assert.match(out.installId, /^install-migrated-[0-9a-f]{32}$/);
});

test('现有 parseBackup 接受 A 与 B 迁移结果', () => {
  const a = migrateInput(backup(aSnapshot()), { today: TODAY, createdAt: '2026-11-24T12:00:00.000Z' });
  const b = migrateInput(overlay(baseSnapshot(), 3), rebuildOptions());
  assert.equal(parseBackup(JSON.stringify(a)).format, 'nova-backup');
  assert.equal(parseBackup(JSON.stringify(b)).snapshot.placementModel.startDate, START);
});
