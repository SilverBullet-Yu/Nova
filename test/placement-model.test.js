'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const pm = require('../shared/placement-model.js');

const START = '2026-11-23';
const DATES = Array.from({ length: 7 }, (_, i) => `2026-11-${String(23 + i).padStart(2, '0')}`);
const API = [
  'createModel', 'normalizeModel', 'rollWindow', 'matchesSlots', 'summary', 'projectWeek', 'taskSegments', 'taskSegmentsMap',
  'replanWeek', 'applyReplan', 'moveTask', 'resizeTask', 'releaseTask', 'restoreTask'
];

function slotsFor(dates, normal = 60, buffer = 60, start = 480) {
  const slots = [];
  dates.forEach((date) => {
    if (normal > 0) slots.push({ date, startMin: start, durMin: normal, available: true, isBuffer: false });
    if (buffer > 0) slots.push({ date, startMin: start + normal, durMin: buffer, available: true, isBuffer: true });
  });
  return slots;
}

function block(id, taskId, date, startMin, durMin, isBuffer = false, reason = 'schedule') {
  return { id, taskId, date, startMin, durMin, isBuffer, reason };
}

function makeModel(options = {}) {
  const dates = options.dates || DATES;
  return pm.createModel({
    startDate: options.startDate || START,
    timezone: options.timezone || 'Asia/Shanghai',
    idPrefix: options.idPrefix || 't_',
    slots: options.slots || slotsFor(dates, options.normal === undefined ? 60 : options.normal, options.buffer === undefined ? 60 : options.buffer),
    tasks: options.tasks || [],
    blocks: options.blocks || [],
    unplanned: options.unplanned || []
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.keys(value).forEach((key) => deepFreeze(value[key]));
  }
  return value;
}

function throwsTypeError(fn) {
  assert.throws(fn, TypeError);
}

function minutesByDate(model, taskId) {
  const out = {};
  pm.taskSegments(model, taskId).forEach((seg) => {
    out[seg.date] = (out[seg.date] || 0) + seg.durMin;
  });
  return out;
}

test('UMD 双模导出固定 API，且相同输入得到相同模型', () => {
  assert.deepEqual(Object.keys(pm).sort(), API.slice().sort());
  const source = fs.readFileSync(path.join(__dirname, '../shared/placement-model.js'), 'utf8');
  const context = { self: {}, Intl, Date };
  vm.runInNewContext(source, context, { filename: 'placement-model.js' });
  assert.equal(typeof context.self.Rhythm.placementModel.createModel, 'function');
  assert.deepEqual(Object.keys(context.self.Rhythm.placementModel).sort(), API.slice().sort());

  const input = {
    startDate: START,
    timezone: 'Asia/Shanghai',
    slots: slotsFor([DATES[0]]),
    tasks: [{ id: 'a', subject: '数学', estMin: 30 }],
    blocks: [block('b1', 'a', DATES[0], 480, 30)],
    unplanned: [],
    idPrefix: 't_'
  };
  const before = clone(input);
  const first = pm.createModel(input);
  const second = pm.createModel(input);
  assert.deepEqual(first, second);
  assert.deepEqual(input, before);
});

test('createModel 聚合连续 slots、保留原始终点证据并记录零工时', () => {
  const slots = [
    { date: DATES[0], startMin: 480, durMin: 30, available: true, isBuffer: false },
    { date: DATES[0], startMin: 510, durMin: 30, available: true, isBuffer: false },
    { date: DATES[0], startMin: 540, durMin: 30, available: true, isBuffer: true },
    { date: DATES[0], startMin: 570, durMin: 30, available: true, isBuffer: true },
    { date: DATES[0], startMin: 600, durMin: 30, available: false, isBuffer: false }
  ];
  const model = makeModel({
    slots,
    tasks: [{ id: 'a', subject: '数学', estMin: 60 }, { id: 'z', subject: '英语', estMin: 0 }],
    blocks: [block('b1', 'a', DATES[0], 480, 60, false, '按权重排入')]
  });
  assert.deepEqual(model.days[0], {
    date: DATES[0],
    capacityMin: 60,
    bufferCapacityMin: 60,
    windows: [
      { startMin: 480, endMin: 540, isBuffer: false },
      { startMin: 540, endMin: 600, isBuffer: true }
    ]
  });
  assert.equal(model.placements.length, 1);
  assert.equal(model.placements[0].source, '按权重排入');
  assert.deepEqual(model.placements[0].originalSegments, model.placements[0].currentSegments);
  assert.notEqual(model.placements[0].originalSegments, model.placements[0].currentSegments);
  assert.notEqual(model.placements[0].originalSegments[0], model.placements[0].currentSegments[0]);
  assert.deepEqual(model.unplanned, [{ taskId: 'z', reason: '标准工时为 0，无可排内容' }]);
  assert.equal(model.startDate, START);
  assert.equal(model.timezone, 'Asia/Shanghai');
});

test('createModel 保留部分排入任务的 unplanned 证据', () => {
  const model = makeModel({
    tasks: [{ id: 'a', subject: '数学', estMin: 90 }],
    blocks: [block('b1', 'a', DATES[0], 480, 30)],
    unplanned: [{ taskId: 'a', reason: '剩余 60 分钟无可用时段' }]
  });
  assert.equal(pm.taskSegments(model, 'a').length, 1);
  assert.deepEqual(model.unplanned, [{ taskId: 'a', reason: '剩余 60 分钟无可用时段' }]);
  assert.deepEqual(minutesByDate(model, 'a'), { [DATES[0]]: 30 });
});

test('summary 分列普通容量、弹性容量和未用量', () => {
  const model = makeModel({ tasks: [], blocks: [] });
  const result = pm.summary(model);
  assert.equal(result.days.length, 7);
  assert.deepEqual(result.days[0], {
    date: DATES[0], d: '一', capacityMin: 60, bufferCapacityMin: 60,
    normalUsedMin: 0, bufferUsedMin: 0, usedMin: 0,
    remainingNormalMin: 60, remainingBufferMin: 60
  });
  assert.deepEqual(result.totals, {
    capacityMin: 420, bufferCapacityMin: 420,
    normalUsedMin: 0, bufferUsedMin: 0, usedMin: 0,
    remainingNormalMin: 420, remainingBufferMin: 420
  });
});

test('summary 正确统计普通、弹性未用/部分/全用和总量', () => {
  const dates = DATES.slice(0, 3);
  const model = makeModel({
    dates,
    tasks: [
      { id: 'a', subject: '数学', estMin: 30 },
      { id: 'b', subject: '英语', estMin: 30 },
      { id: 'c', subject: '408', estMin: 120 }
    ],
    blocks: [
      block('a1', 'a', DATES[0], 480, 30),
      block('b1', 'b', DATES[1], 540, 30, true),
      block('c1', 'c', DATES[2], 480, 60),
      block('c2', 'c', DATES[2], 540, 60, true)
    ]
  });
  const days = pm.summary(model).days;
  assert.deepEqual(days.slice(0, 3).map((d) => [d.normalUsedMin, d.bufferUsedMin, d.usedMin, d.remainingNormalMin, d.remainingBufferMin]), [
    [30, 0, 30, 30, 60],
    [0, 30, 30, 60, 30],
    [60, 60, 120, 0, 0]
  ]);
  assert.deepEqual(pm.summary(model).totals, {
    capacityMin: 180, bufferCapacityMin: 180,
    normalUsedMin: 90, bufferUsedMin: 90, usedMin: 180,
    remainingNormalMin: 90, remainingBufferMin: 90
  });
});

test('projectWeek 的 total 只含实际任务分钟，segs 排除弹性占用', () => {
  const model = makeModel({
    tasks: [{ id: 'a', subject: '数学', estMin: 30 }, { id: 'b', subject: '英语', estMin: 30 }],
    blocks: [block('a1', 'a', DATES[0], 480, 30), block('b1', 'b', DATES[0], 540, 30, true)]
  });
  const row = pm.projectWeek(model, [{ id: 'a', subject: '数学' }, { id: 'b', subject: '英语' }])[0];
  assert.deepEqual(row, {
    d: '一', date: DATES[0], segs: [['数学', 30]], buf: 60, total: 60,
    normalUsed: 30, bufferUsed: 30, capacityMin: 60, bufferCapacityMin: 60
  });
  const empty = pm.projectWeek(makeModel(), [])[0];
  assert.equal(empty.total, 0);
  assert.equal(empty.buf, 60);
});

test('projectWeek 支持完整跨日任务且只累计每日实际落点', () => {
  const model = makeModel({
    tasks: [{ id: 'a', subject: '数学', estMin: 60 }],
    blocks: [block('a1', 'a', DATES[0], 480, 30), block('a2', 'a', DATES[1], 540, 30, true)]
  });
  const rows = pm.projectWeek(model, [{ id: 'a', subject: '数学', estMin: 60 }]);
  assert.deepEqual(rows.slice(0, 2).map((r) => [r.date, r.total, r.normalUsed, r.bufferUsed, r.segs]), [
    [DATES[0], 30, 30, 0, [['数学', 30]]],
    [DATES[1], 30, 0, 30, []]
  ]);
  assert.deepEqual(pm.taskSegments(model, 'a').map((s) => [s.date, s.durMin, s.isBuffer]), [
    [DATES[0], 30, false], [DATES[1], 30, true]
  ]);
  assert.deepEqual(pm.taskSegments(model, 'missing'), []);
});

test('replanWeek 只释放未完成且未锁定的 currentSegments，并分列普通/弹性', () => {
  const model = makeModel({
    normal: 240,
    buffer: 60,
    tasks: [
      { id: 'a', subject: '数学', est: 30 },
      { id: 'b', subject: '英语', est: 30 },
      { id: 'c', subject: '408', est: 30, done: true },
      { id: 'h', subject: '政治', est: 30 }
    ],
    blocks: [
      block('a1', 'a', DATES[0], 480, 30),
      block('b1', 'b', DATES[0], 720, 30, true),
      block('c1', 'c', DATES[0], 750, 30, true),
      block('h1', 'h', DATES[0], 510, 30)
    ]
  });
  const tasks = [
    { id: 'a', subject: '数学', est: 30 },
    { id: 'b', subject: '英语', est: 30 },
    { id: 'c', subject: '408', est: 30, done: true },
    { id: 'd', subject: '政治', est: 30, skipped: true },
    { id: 'e', subject: '政治', est: 30, deferred: true },
    { id: 'f', subject: '政治', est: 30, abandoned: true },
    { id: 'g', subject: '政治', est: 30, substituted: true },
    { id: 'h', subject: '政治', est: 30 }
  ];
  const row = pm.replanWeek(model, tasks, { h: true })[0];
  assert.deepEqual(row, {
    date: DATES[0], minutes: 60, bufferUsed: 60, buffer: 60,
    capacity: 240, releasedMinutes: 30, releasedBufferMinutes: 30
  });
});

test('applyReplan 兼容 replan 原生 task/segs 形状', () => {
  const tasks = [{ id: 'p', subject: '数学', est: 60, weight: 1 }];
  const model = makeModel({
    tasks: [{ id: 'p', subject: '数学', estMin: 60 }],
    blocks: [block('p1', 'p', DATES[0], 480, 60)]
  });
  const week = pm.replanWeek(model, tasks, {});
  assert.equal(week[0].releasedMinutes, 60);
  const result = {
    nextTasks: clone(tasks),
    nextPlacements: [{
      task: clone(tasks[0]),
      segs: [{ date: DATES[0], minutes: 60, isBuffer: false }],
      minutes: 60
    }]
  };
  const out = pm.applyReplan(model, result, 't_');
  assert.equal(pm.summary(out).totals.usedMin, 60);
  assert.deepEqual(pm.taskSegments(out, 'p').map((s) => [s.date, s.durMin, s.isBuffer]), [[DATES[0], 60, false]]);
});

test('零基线只返回零用量，不虚构百分比或旧 total-buf', () => {
  const model = makeModel({ tasks: [{ id: 'z', subject: '数学', est: 0 }], blocks: [] });
  const summary = pm.summary(model);
  const week = pm.projectWeek(model, [{ id: 'z', subject: '数学', est: 0 }]);
  const replan = pm.replanWeek(model, [{ id: 'z', subject: '数学', est: 0 }], {});
  assert.equal(summary.totals.usedMin, 0);
  assert.equal(week.reduce((sum, row) => sum + row.total, 0), 0);
  assert.equal(replan.reduce((sum, row) => sum + row.releasedMinutes + row.releasedBufferMinutes, 0), 0);
  [summary.totals, week[0], replan[0]].forEach((row) => {
    assert.equal(Object.keys(row).some((key) => /percent|rate|ratio|pct/i.test(key)), false);
  });
});

test('applyReplan 保留锁定及非待办旧落点，并释放待办旧落点', () => {
  const model = makeModel({
    normal: 240,
    buffer: 0,
    tasks: [
      { id: 'l', subject: '数学', est: 30 },
      { id: 'd', subject: '英语', est: 30, done: true },
      { id: 'p', subject: '408', est: 30 },
      { id: 'a', subject: '政治', est: 30 },
      { id: 's', subject: '政治', est: 30 }
    ],
    blocks: [
      block('l1', 'l', DATES[0], 480, 30),
      block('d1', 'd', DATES[0], 510, 30),
      block('p1', 'p', DATES[0], 540, 30),
      block('a1', 'a', DATES[0], 570, 30),
      block('s1', 's', DATES[0], 600, 30)
    ]
  });
  const before = clone(model);
  const result = {
    nextTasks: [
      { id: 'l', subject: '数学', est: 30 },
      { id: 'd', subject: '英语', est: 30, done: true },
      { id: 'p', subject: '408', est: 30 },
      { id: 'a', subject: '政治', est: 30, abandoned: true },
      { id: 's', subject: '政治', est: 30, substituted: true }
    ],
    nextPlacements: [
      { taskId: 'l', segments: [], minutes: 0, locked: true },
      { taskId: 'd', segments: [{ date: DATES[1], minutes: 30, isBuffer: false }], minutes: 30, locked: false },
      { taskId: 'p', segments: [{ date: DATES[1], minutes: 30, isBuffer: false }], minutes: 30, locked: false }
    ]
  };
  const out = pm.applyReplan(model, result, 't_');
  assert.deepEqual(pm.taskSegments(out, 'l'), pm.taskSegments(model, 'l'));
  assert.deepEqual(pm.taskSegments(out, 'd'), pm.taskSegments(model, 'd'));
  assert.deepEqual(pm.taskSegments(out, 'p').map((s) => [s.date, s.startMin, s.durMin]), [[DATES[1], 480, 30]]);
  assert.deepEqual(pm.taskSegments(out, 'a'), []);
  assert.deepEqual(pm.taskSegments(out, 's'), []);
  out.placements.forEach((placement) => {
    const old = model.placements.find((p) => p.taskId === placement.taskId);
    assert.deepEqual(placement.originalSegments, old.originalSegments);
  });
  assert.deepEqual(model, before);
});

test('applyReplan 物化跨日与弹性落点，blockId 幂等稳定', () => {
  const model = makeModel({
    tasks: [{ id: 'p', subject: '数学', est: 60 }],
    blocks: [block('p-old', 'p', DATES[0], 480, 60)]
  });
  const result = {
    nextTasks: [{ id: 'p', subject: '数学', est: 60 }],
    nextPlacements: [{
      taskId: 'p', locked: false, minutes: 60,
      segments: [
        { date: DATES[0], minutes: 30, isBuffer: false },
        { date: DATES[1], minutes: 20, isBuffer: true },
        { date: DATES[2], minutes: 10, isBuffer: false }
      ]
    }]
  };
  const first = pm.applyReplan(model, result, 't_');
  const segments = pm.taskSegments(first, 'p');
  assert.deepEqual(segments.map((s) => [s.date, s.startMin, s.durMin, s.isBuffer]), [
    [DATES[0], 480, 30, false],
    [DATES[1], 540, 20, true],
    [DATES[2], 480, 10, false]
  ]);
  assert.equal(new Set(segments.map((s) => s.blockId)).size, 3);
  assert.deepEqual(first.placements[0].originalSegments, model.placements[0].originalSegments);
  const second = pm.applyReplan(first, result, 't_');
  assert.deepEqual(second, first);
});

test('applyReplan 装入失败时抛 TypeError，且不修改输入模型', () => {
  const model = makeModel({
    tasks: [{ id: 'l', subject: '数学', est: 60 }, { id: 'p', subject: '英语', est: 60 }],
    blocks: [block('l1', 'l', DATES[0], 480, 60)]
  });
  const before = clone(model);
  const result = {
    nextTasks: [{ id: 'l', subject: '数学', est: 60 }, { id: 'p', subject: '英语', est: 60 }],
    nextPlacements: [
      { taskId: 'l', segments: [], minutes: 0, locked: true },
      { taskId: 'p', segments: [{ date: DATES[0], minutes: 60, isBuffer: false }], minutes: 60, locked: false }
    ]
  };
  throwsTypeError(() => pm.applyReplan(model, result, 't_'));
  assert.deepEqual(model, before);
});

test('applyReplan 拒绝损坏的 nextPlacements 契约', () => {
  const model = makeModel();
  const nextTasks = [{ id: 'p', subject: '数学', est: 30 }];
  throwsTypeError(() => pm.applyReplan(model, { nextTasks }, 't_'));
  throwsTypeError(() => pm.applyReplan(model, {
    nextTasks,
    nextPlacements: [{ taskId: 'p', segments: [{ date: DATES[0], minutes: 30, isBuffer: false }], minutes: 29, locked: false }]
  }, 't_'));
  throwsTypeError(() => pm.applyReplan(model, {
    nextTasks,
    nextPlacements: [{ taskId: 'p', segments: [{ date: DATES[0], minutes: 0, isBuffer: false }], minutes: 0, locked: false }]
  }, 't_'));
  throwsTypeError(() => pm.applyReplan(model, {
    nextTasks,
    nextPlacements: [
      { taskId: 'p', segments: [], minutes: 0, locked: false },
      { taskId: 'p', segments: [], minutes: 0, locked: false }
    ]
  }, 't_'));
});

test('moveTask 优先普通窗口，保留原始终段并返回当日用量', () => {
  const model = makeModel({
    tasks: [{ id: 'o', subject: '英语', estMin: 30 }, { id: 'p', subject: '数学', estMin: 30 }],
    blocks: [block('o1', 'o', DATES[1], 480, 30), block('p1', 'p', DATES[0], 540, 30, true)]
  });
  const original = clone(model.placements.find((p) => p.taskId === 'p').originalSegments);
  const result = pm.moveTask(model, 'p', DATES[1], 't_');
  assert.equal(result.ok, true);
  assert.equal(result.date, DATES[1]);
  assert.deepEqual(pm.taskSegments(result.model, 'p').map((s) => [s.date, s.startMin, s.durMin, s.isBuffer]), [[DATES[1], 510, 30, false]]);
  assert.deepEqual(result.model.placements.find((p) => p.taskId === 'p').originalSegments, original);
  assert.deepEqual([result.normalUsedMin, result.bufferUsedMin, result.usedMin, result.remainingNormalMin, result.remainingBufferMin], [60, 0, 60, 0, 60]);
});

test('moveTask 普通不足时使用弹性窗口并记录实际弹性用量', () => {
  const model = makeModel({
    tasks: [{ id: 'o', subject: '英语', estMin: 60 }, { id: 'p', subject: '数学', estMin: 30 }],
    blocks: [block('o1', 'o', DATES[1], 480, 60), block('p1', 'p', DATES[0], 480, 30)]
  });
  const result = pm.moveTask(model, 'p', DATES[1], 't_');
  assert.equal(result.ok, true);
  assert.deepEqual(pm.taskSegments(result.model, 'p').map((s) => [s.startMin, s.durMin, s.isBuffer]), [[540, 30, true]]);
  assert.deepEqual([result.normalUsedMin, result.bufferUsedMin, result.usedMin, result.remainingNormalMin, result.remainingBufferMin], [60, 30, 90, 0, 30]);
});

test('moveTask 容量或重叠不足时失败且不返回半成品', () => {
  const model = makeModel({
    tasks: [{ id: 'o', subject: '英语', estMin: 120 }, { id: 'p', subject: '数学', estMin: 30 }],
    blocks: [block('o1', 'o', DATES[1], 480, 60), block('o2', 'o', DATES[1], 540, 60, true), block('p1', 'p', DATES[0], 480, 30)]
  });
  const before = clone(model);
  const result = pm.moveTask(model, 'p', DATES[1], 't_');
  assert.equal(result.ok, false);
  assert.equal(typeof result.reason, 'string');
  assert.equal('model' in result, false);
  assert.deepEqual(model, before);
  assert.equal(pm.moveTask(model, 'p', '2026-11-99', 't_').ok, false);
});

test('moveTask 重复移动到同一天时 blockId 与模型保持稳定', () => {
  const model = makeModel({
    tasks: [{ id: 'p', subject: '数学', estMin: 60 }],
    blocks: [block('p-old', 'p', DATES[0], 480, 60)]
  });
  const first = pm.moveTask(model, 'p', DATES[1], 't_');
  const ids = pm.taskSegments(first.model, 'p').map((s) => s.blockId);
  const second = pm.moveTask(first.model, 'p', DATES[1], 't_');
  assert.equal(second.ok, true);
  assert.deepEqual(pm.taskSegments(second.model, 'p').map((s) => s.blockId), ids);
  assert.deepEqual(second.model, first.model);
});

test('resizeTask 跨日缩小时按原日期顺序保留前段分配', () => {
  const model = makeModel({
    dates: DATES.slice(0, 2), normal: 120, buffer: 0,
    tasks: [{ id: 'p', subject: '数学', estMin: 120 }],
    blocks: [block('p1', 'p', DATES[0], 480, 60), block('p2', 'p', DATES[1], 480, 60)]
  });
  const original = clone(model.placements[0].originalSegments);
  const result = pm.resizeTask(model, 'p', 90, 't_');
  assert.equal(result.ok, true);
  assert.deepEqual(minutesByDate(result.model, 'p'), { [DATES[0]]: 60, [DATES[1]]: 30 });
  assert.deepEqual(result.model.placements[0].originalSegments, original);
  assert.deepEqual(pm.summary(result.model).totals.usedMin, 90);
});

test('resizeTask 跨日增长时先保留原分配，再按日期顺序使用空余', () => {
  const model = makeModel({
    dates: DATES.slice(0, 2), normal: 120, buffer: 0,
    tasks: [{ id: 'p', subject: '数学', estMin: 60 }],
    blocks: [block('p1', 'p', DATES[0], 480, 30), block('p2', 'p', DATES[1], 480, 30)]
  });
  const result = pm.resizeTask(model, 'p', 150, 't_');
  assert.equal(result.ok, true);
  assert.deepEqual(minutesByDate(result.model, 'p'), { [DATES[0]]: 120, [DATES[1]]: 30 });
  assert.deepEqual(result.model.placements[0].originalSegments, model.placements[0].originalSegments);
});

test('resizeTask 原日期容量不足时失败，零工时清空 current 但保留原始证据', () => {
  const model = makeModel({
    dates: [DATES[0]], normal: 60, buffer: 0,
    tasks: [{ id: 'p', subject: '数学', estMin: 60 }],
    blocks: [block('p1', 'p', DATES[0], 480, 60)]
  });
  const before = clone(model);
  const failed = pm.resizeTask(model, 'p', 90, 't_');
  assert.equal(failed.ok, false);
  assert.equal('model' in failed, false);
  assert.deepEqual(model, before);
  const zero = pm.resizeTask(model, 'p', 0, 't_');
  assert.equal(zero.ok, true);
  assert.deepEqual(pm.taskSegments(zero.model, 'p'), []);
  assert.deepEqual(zero.model.placements[0].originalSegments, model.placements[0].originalSegments);
  assert.deepEqual(zero.model.unplanned, [{ taskId: 'p', reason: '工时为 0，未排入' }]);
  assert.equal(pm.summary(zero.model).totals.usedMin, 0);
});

test('releaseTask 清空当前落点并保留原始证据，restoreTask 可恢复且不改原始终段', () => {
  const model = makeModel({
    tasks: [{ id: 'p', subject: '数学', estMin: 60 }],
    blocks: [block('p-old', 'p', DATES[0], 480, 60)]
  });
  const released = pm.releaseTask(model, 'p', '已跳过', 't_');
  assert.equal(released.ok, true);
  assert.deepEqual(pm.taskSegments(released.model, 'p'), []);
  assert.deepEqual(released.model.placements[0].originalSegments, model.placements[0].originalSegments);
  assert.deepEqual(released.model.unplanned, [{ taskId: 'p', reason: '已跳过' }]);
  const restored = pm.restoreTask(released.model, 'p', 't_');
  assert.equal(restored.ok, true);
  assert.deepEqual(minutesByDate(restored.model, 'p'), { [DATES[0]]: 60 });
  assert.deepEqual(restored.model.unplanned, []);
  assert.deepEqual(restored.model.placements[0].originalSegments, model.placements[0].originalSegments);
});

test('restoreTask 遇到后续占用时失败且不修改输入', () => {
  const model = makeModel({
    normal: 60, buffer: 0,
    tasks: [{ id: 'p', subject: '数学', estMin: 60 }, { id: 'q', subject: '英语', estMin: 60 }],
    blocks: [block('p-old', 'p', DATES[0], 480, 60), block('q-old', 'q', DATES[1], 480, 60)]
  });
  const released = pm.releaseTask(model, 'p', '已跳过', 't_');
  const occupied = pm.moveTask(released.model, 'q', DATES[0], 't_');
  assert.equal(occupied.ok, true);
  const before = clone(occupied.model);
  const failed = pm.restoreTask(occupied.model, 'p', 't_');
  assert.equal(failed.ok, false);
  assert.equal('model' in failed, false);
  assert.deepEqual(occupied.model, before);
});

test('restoreTask 按剩余工时恢复，不把部分完成放大回原计划', () => {
  const model = makeModel({
    tasks: [{ id: 'p', subject: '数学', estMin: 60 }],
    blocks: [block('p-old', 'p', DATES[0], 480, 60)]
  });
  const released = pm.releaseTask(model, 'p', '已跳过', 't_');
  const restored = pm.restoreTask(released.model, 'p', 't_', 30);
  assert.equal(restored.ok, true);
  assert.equal(pm.summary(restored.model).totals.usedMin, 30);
  assert.deepEqual(restored.model.placements[0].originalSegments, model.placements[0].originalSegments);
});

test('applyReplan 拒绝待排工时与落点分钟不一致的半成品', () => {
  const model = makeModel({
    tasks: [{ id: 'p', subject: '数学', estMin: 60 }],
    blocks: [block('p-old', 'p', DATES[0], 480, 60)]
  });
  const before = clone(model);
  assert.throws(() => pm.applyReplan(model, {
    nextTasks: [{ id: 'p', subject: '数学', est: 60 }],
    nextPlacements: [{ taskId: 'p', minutes: 30, locked: false, segments: [{ date: DATES[0], minutes: 30, isBuffer: false }] }]
  }, 't_'), /工时与落点分钟不一致/);
  assert.deepEqual(model, before);
});

test('normalizeModel 可往返规范化并返回独立深拷贝', () => {
  const model = makeModel({
    tasks: [{ id: 'p', subject: '数学', estMin: 30 }],
    blocks: [block('p1', 'p', DATES[0], 480, 30)]
  });
  const raw = clone(model);
  const normalized = pm.normalizeModel(raw);
  assert.deepEqual(normalized, raw);
  assert.notEqual(normalized, raw);
  assert.notEqual(normalized.days[0].windows, raw.days[0].windows);
  normalized.placements[0].currentSegments[0].durMin = 15;
  assert.equal(raw.placements[0].currentSegments[0].durMin, 30);
});

test('normalizeModel 严格拒绝日期、连续七天、时区和 schema 损坏', () => {
  const model = makeModel();
  throwsTypeError(() => pm.normalizeModel({ ...clone(model), startDate: '2026-02-30' }));
  throwsTypeError(() => pm.normalizeModel({ ...clone(model), timezone: 'Mars/Olympus' }));
  throwsTypeError(() => pm.normalizeModel({ ...clone(model), schemaVersion: 2 }));
  const gap = clone(model);
  gap.days[2].date = '2026-11-26';
  throwsTypeError(() => pm.normalizeModel(gap));
  throwsTypeError(() => pm.normalizeModel({ ...clone(model), days: model.days.slice(0, 6) }));
});

test('normalizeModel 严格拒绝窗口和容量损坏', () => {
  const model = makeModel();
  const badWindow = clone(model);
  badWindow.days[0].windows[0].endMin = 480;
  throwsTypeError(() => pm.normalizeModel(badWindow));
  const overlap = clone(model);
  overlap.days[0].windows[1].startMin = 530;
  overlap.days[0].bufferCapacityMin = 70;
  throwsTypeError(() => pm.normalizeModel(overlap));
  const capacity = clone(model);
  capacity.days[0].capacityMin = 59;
  throwsTypeError(() => pm.normalizeModel(capacity));
  const beyondDay = clone(model);
  beyondDay.days[0].windows[0].endMin = 1441;
  throwsTypeError(() => pm.normalizeModel(beyondDay));
});

test('normalizeModel 严格拒绝 placement、block 和 unplanned ID 重复', () => {
  const model = makeModel({
    tasks: [{ id: 'a', subject: '数学', estMin: 30 }, { id: 'b', subject: '英语', estMin: 30 }],
    blocks: [block('same', 'a', DATES[0], 480, 30), block('b1', 'b', DATES[0], 510, 30)],
    unplanned: [{ taskId: 'a', reason: '测试' }]
  });
  const placementId = clone(model);
  placementId.placements[1].placementId = placementId.placements[0].placementId;
  throwsTypeError(() => pm.normalizeModel(placementId));
  const taskId = clone(model);
  taskId.placements[1].taskId = 'a';
  throwsTypeError(() => pm.normalizeModel(taskId));
  const blockId = clone(model);
  blockId.placements[1].originalSegments[0].blockId = 'same';
  blockId.placements[1].currentSegments[0].blockId = 'same';
  throwsTypeError(() => pm.normalizeModel(blockId));
  const unplanned = clone(model);
  unplanned.unplanned.push({ taskId: 'a', reason: '重复' });
  throwsTypeError(() => pm.normalizeModel(unplanned));
});

test('normalizeModel 严格拒绝 segment 归属、日期、时长、类型和窗口越界', () => {
  const model = makeModel({
    tasks: [{ id: 'a', subject: '数学', estMin: 30 }],
    blocks: [block('a1', 'a', DATES[0], 480, 30)]
  });
  const wrongOwner = clone(model);
  wrongOwner.placements[0].currentSegments[0].taskId = 'other';
  throwsTypeError(() => pm.normalizeModel(wrongOwner));
  const wrongDate = clone(model);
  wrongDate.placements[0].currentSegments[0].date = '2026-12-01';
  throwsTypeError(() => pm.normalizeModel(wrongDate));
  const zeroDuration = clone(model);
  zeroDuration.placements[0].currentSegments[0].durMin = 0;
  throwsTypeError(() => pm.normalizeModel(zeroDuration));
  const wrongType = clone(model);
  wrongType.placements[0].currentSegments[0].isBuffer = 'false';
  throwsTypeError(() => pm.normalizeModel(wrongType));
  const outside = clone(model);
  outside.placements[0].currentSegments[0].startMin = 600;
  throwsTypeError(() => pm.normalizeModel(outside));
});

test('normalizeModel 允许 originalSegments 保留窗口外历史，但 currentSegments 必须严格在当前窗口', () => {
  const model = makeModel({
    tasks: [{ id: 'a', subject: '数学', estMin: 30 }],
    blocks: [block('a1', 'a', DATES[0], 480, 30)]
  });
  const historical = clone(model);
  historical.placements[0].originalSegments[0].date = '2020-01-01';
  historical.placements[0].originalSegments[0].startMin = 0;
  const normalized = pm.normalizeModel(historical);
  assert.equal(normalized.placements[0].originalSegments[0].date, '2020-01-01');
  assert.equal(normalized.placements[0].currentSegments[0].date, DATES[0]);

  const pastCurrent = clone(historical);
  pastCurrent.placements[0].currentSegments[0].date = '2020-01-01';
  throwsTypeError(() => pm.normalizeModel(pastCurrent));
  const invalidHistorical = clone(historical);
  invalidHistorical.placements[0].originalSegments[0].date = '2020-02-30';
  throwsTypeError(() => pm.normalizeModel(invalidHistorical));
});

test('rollWindow 跨周按原索引平移窗口与当前落点，保留历史、未排入和已释放状态', () => {
  const model = makeModel({
    tasks: [
      { id: 'a', subject: '数学', estMin: 30 },
      { id: 'b', subject: '英语', estMin: 30 },
      { id: 'released', subject: '408', estMin: 30 },
      { id: 'u', subject: '政治', estMin: 0 }
    ],
    blocks: [
      block('a-old', 'a', DATES[0], 480, 30),
      block('b-old', 'b', DATES[6], 540, 30, true),
      block('released-old', 'released', DATES[2], 480, 30)
    ],
    unplanned: [{ taskId: 'u', reason: '未排入' }]
  });
  const released = pm.releaseTask(model, 'released', '已跳过').model;
  const before = clone(released);
  const originals = clone(released.placements.map(item => item.originalSegments));
  const newStart = '2026-12-02';
  const newDates = Array.from({ length: 7 }, (_, i) => `2026-12-${String(2 + i).padStart(2, '0')}`);

  const rolled = pm.rollWindow(released, newStart, 'roll_');
  assert.equal(rolled.startDate, newStart);
  assert.deepEqual(rolled.days.map(day => day.date), newDates);
  assert.deepEqual(rolled.days.map(day => day.windows), before.days.map(day => day.windows));
  assert.deepEqual(rolled.days.map(day => [day.capacityMin, day.bufferCapacityMin]),
    before.days.map(day => [day.capacityMin, day.bufferCapacityMin]));
  assert.deepEqual(pm.taskSegments(rolled, 'a').map(seg => [seg.date, seg.startMin, seg.durMin]), [[newDates[0], 480, 30]]);
  assert.deepEqual(pm.taskSegments(rolled, 'b').map(seg => [seg.date, seg.startMin, seg.durMin, seg.isBuffer]), [[newDates[6], 540, 30, true]]);
  assert.deepEqual(pm.taskSegments(rolled, 'released'), []);
  assert.deepEqual(rolled.placements.map(item => item.originalSegments), originals);
  assert.deepEqual(rolled.unplanned, before.unplanned);
  assert.ok(rolled.placements.every(item => item.currentSegments.every(seg => seg.blockId.startsWith('roll_'))));
  assert.deepEqual(pm.normalizeModel(rolled), rolled);
  assert.deepEqual(released, before, '纯函数不得修改输入');

  const unchanged = pm.rollWindow(rolled, newStart, 'other_');
  assert.deepEqual(unchanged, rolled, '同一天滚动不得改 ID 或重复平移');
  throwsTypeError(() => pm.rollWindow(rolled, '2026-11-01', 'roll_'));
});

test('taskSegmentsMap 一次归一化得到与逐任务查询相同的独立分段索引', () => {
  const model = makeModel({
    tasks: [{ id: 'a', subject: '数学', estMin: 60 }, { id: 'b', subject: '英语', estMin: 30 }],
    blocks: [
      block('map-a2', 'a', DATES[1], 480, 30),
      block('map-a1', 'a', DATES[0], 480, 30),
      block('map-b1', 'b', DATES[2], 540, 30, true)
    ]
  });
  const map = pm.taskSegmentsMap(model);
  assert.deepEqual(map.a, pm.taskSegments(model, 'a'));
  assert.deepEqual(map.b, pm.taskSegments(model, 'b'));
  assert.deepEqual(map.missing, undefined);
  map.a[0].durMin = 999;
  assert.notEqual(pm.taskSegments(model, 'a')[0].durMin, 999);
});

test('matchesSlots 区分当前可用窗口与陈旧窗口且不修改模型', () => {
  const model = makeModel({ normal: 60, buffer: 60 });
  const before = clone(model);
  assert.equal(pm.matchesSlots(model, slotsFor(DATES, 60, 60)), true);
  assert.equal(pm.matchesSlots(model, slotsFor(DATES, 30, 60)), false);
  assert.equal(pm.matchesSlots(model, slotsFor(DATES, 60, 60, 540)), false);
  assert.deepEqual(model, before);
});

test('normalizeModel 拒绝 original/current 内部及跨任务重叠', () => {
  const model = makeModel({
    normal: 120, buffer: 0,
    tasks: [{ id: 'a', subject: '数学', estMin: 60 }, { id: 'b', subject: '英语', estMin: 30 }],
    blocks: [block('a1', 'a', DATES[0], 480, 30), block('a2', 'a', DATES[0], 510, 30), block('b1', 'b', DATES[0], 540, 30)]
  });
  const originalOverlap = clone(model);
  originalOverlap.placements[0].originalSegments[1].startMin = 500;
  throwsTypeError(() => pm.normalizeModel(originalOverlap));
  const currentOverlap = clone(model);
  currentOverlap.placements[0].currentSegments[1].startMin = 500;
  throwsTypeError(() => pm.normalizeModel(currentOverlap));
  const crossTask = clone(model);
  crossTask.placements[1].currentSegments[0].startMin = 500;
  throwsTypeError(() => pm.normalizeModel(crossTask));
});

test('createModel 拒绝可用 slots 重叠和 blocks 重叠', () => {
  throwsTypeError(() => makeModel({
    slots: [
      { date: DATES[0], startMin: 480, durMin: 60, isBuffer: false },
      { date: DATES[0], startMin: 510, durMin: 30, isBuffer: true }
    ]
  }));
  throwsTypeError(() => makeModel({
    normal: 120, buffer: 0,
    tasks: [{ id: 'a', subject: '数学', estMin: 60 }, { id: 'b', subject: '英语', estMin: 30 }],
    blocks: [block('a1', 'a', DATES[0], 480, 60), block('b1', 'b', DATES[0], 510, 30)]
  }));
});

test('旧 week.total/buf 无容量证据时不能反推为模型', () => {
  const legacy = {
    schemaVersion: 1,
    startDate: START,
    timezone: 'Asia/Shanghai',
    days: [{ date: START, total: 60, buf: 60, windows: [] }],
    placements: [],
    unplanned: []
  };
  throwsTypeError(() => pm.normalizeModel(legacy));
});

test('具体日期跨夏令时仍按民用日连续保存七天', () => {
  const startDate = '2026-03-07';
  const dates = Array.from({ length: 7 }, (_, i) => `2026-03-${String(7 + i).padStart(2, '0')}`);
  const model = makeModel({ startDate, timezone: 'America/New_York', dates, tasks: [], blocks: [] });
  assert.deepEqual(model.days.map((d) => d.date), dates);
  assert.equal(model.timezone, 'America/New_York');
  assert.equal(pm.summary(model).days.length, 7);
});

test('纯函数写入不修改冻结输入', () => {
  const model = deepFreeze(makeModel({
    tasks: [{ id: 'p', subject: '数学', estMin: 30 }],
    blocks: [block('p1', 'p', DATES[0], 480, 30)]
  }));
  const before = clone(model);
  const moved = pm.moveTask(model, 'p', DATES[1], 't_');
  assert.equal(moved.ok, true);
  const resized = pm.resizeTask(model, 'p', 15, 't_');
  assert.equal(resized.ok, true);
  assert.deepEqual(model, before);
});

test('applyReplan 拒绝未确认结果并接受显式已确认结果', () => {
  const model = makeModel({
    tasks: [{ id: 'p', subject: '数学', estMin: 60 }],
    blocks: [block('p1', 'p', DATES[0], 480, 60)]
  });
  const nextTasks = [{ id: 'p', subject: '数学', est: 60 }];
  const nextPlacements = [{ taskId: 'p', minutes: 60, locked: false, segments: [{ date: DATES[0], minutes: 60, isBuffer: false }] }];
  assert.throws(() => pm.applyReplan(model, { accepted: false, needsConfirmation: true, nextTasks, nextPlacements }, 't_'), /尚未确认/);
  const out = pm.applyReplan(model, { accepted: true, needsConfirmation: false, nextTasks, nextPlacements }, 't_');
  assert.equal(pm.summary(out).totals.usedMin, 60);
});
