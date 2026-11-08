'use strict';
/* 诺瓦 Nova · 引擎单测
 * 契约：docs/HANDOFF.md §8（确定性快照断言 / 重排回退与撤销等价 / 弹性位不被清空 / 归因顺序不变量）
 * 运行：npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { feasibility } = require('../shared/engine/feasibility.js');
const { schedule } = require('../shared/engine/schedule.js');
const { replan, undoReplan } = require('../shared/engine/replan.js');
const { attribute } = require('../shared/engine/attribute.js');
const { seed } = require('../shared/data/seed.js');

/* ── 通用夹具 ─────────────────────────────────────────────────────────── */

const REPLAN_PARAMS = {
  loadGrowthCap: 0.20,
  compressFloor: 0.60,
  compressedShareCap: 0.30,
  consecutiveNoImproveCap: 3,
  bufferRatio: 0.15
};

function weekOf(days) {
  return days.map((d) => ({ date: d.date, minutes: d.minutes, buffer: d.buffer === undefined ? 60 : d.buffer }));
}

function baseWeek(minutesEach, count) {
  const out = [];
  for (let i = 0; i < (count || 7); i++) {
    out.push({ date: 'D' + (i + 1), minutes: minutesEach, buffer: 60 });
  }
  return out;
}

/* ── 可行性 ───────────────────────────────────────────────────────────── */

test('feasibility：数值与现有 demo 一致（R 1.08 / T 986 / 缓冲 73）', () => {
  const r = feasibility(seed.feas);
  assert.equal(r.T, 986);
  assert.equal(r.D, 913);
  assert.equal(r.R, 1.08);
  assert.equal(r.margin, 73);
  assert.equal(r.verdict, '合理');
  assert.deepEqual(r.threshold, { ample: 1.2, reasonable: 0.9, tight: 0.7 });
});

test('feasibility：确定性（同输入两次全等）', () => {
  assert.deepEqual(feasibility(seed.feas), feasibility(seed.feas));
});

test('feasibility：四档阈值边界 1.2 / 0.9 / 0.7 / 0.69', () => {
  const mk = (t, d) => feasibility({ weeklyH: t, weeks: 1, discount: 1, demand: d });
  assert.equal(mk(120, 100).R, 1.2);
  assert.equal(mk(120, 100).verdict, '充裕');
  assert.equal(mk(119, 100).R, 1.19);
  assert.equal(mk(119, 100).verdict, '合理');
  assert.equal(mk(90, 100).R, 0.9);
  assert.equal(mk(90, 100).verdict, '合理');
  assert.equal(mk(89, 100).R, 0.89);
  assert.equal(mk(89, 100).verdict, '偏紧');
  assert.equal(mk(70, 100).R, 0.7);
  assert.equal(mk(70, 100).verdict, '偏紧');
  assert.equal(mk(69, 100).R, 0.69);
  assert.equal(mk(69, 100).verdict, '阻断');
});

test('feasibility：非法输入抛错（映射 E1001）', () => {
  assert.throws(() => feasibility({ weeklyH: 20, weeks: 58, discount: 0.85 }), TypeError);
  assert.throws(() => feasibility({ weeklyH: 20, weeks: 58, discount: 0.85, demand: 0 }), TypeError);
});

/* ── 排程 ─────────────────────────────────────────────────────────────── */

test('schedule：确定性（同输入两次全等）', () => {
  const input = {
    tasks: [
      { id: 'a', subject: '数学', estMin: 90, weight: 0.92 },
      { id: 'b', subject: '英语', estMin: 60, weight: 0.78 },
      { id: 'c', subject: '408', estMin: 45, weight: 0.86 }
    ],
    slots: [
      { date: '一', startMin: 540, durMin: 30, available: true, isBuffer: false },
      { date: '一', startMin: 570, durMin: 30, available: true, isBuffer: false },
      { date: '一', startMin: 600, durMin: 30, available: true, isBuffer: false },
      { date: '一', startMin: 630, durMin: 30, available: true, isBuffer: false },
      { date: '一', startMin: 1230, durMin: 60, available: true, isBuffer: true }
    ],
    params: { slotMinutes: 30, bufferRatio: 0.15, maxContiguousMin: 150, deadlineMs: 200 }
  };
  assert.deepEqual(schedule(input), schedule(input));
});

test('schedule：不可用时段不得排入', () => {
  const res = schedule({
    tasks: [{ id: 'a', subject: '数学', estMin: 60, weight: 0.9 }],
    slots: [
      { date: '一', startMin: 540, durMin: 60, available: false, isBuffer: false },
      { date: '一', startMin: 600, durMin: 60, available: true, isBuffer: false }
    ],
    params: { dailyCapMin: 300, bufferRatio: 0.15, maxContiguousMin: 150 }
  });
  assert.equal(res.blocks.length, 1);
  assert.equal(res.blocks[0].startMin, 600);
  assert.ok(res.blocks.every((b) => !(b.startMin === 540 && b.date === '一')));
  assert.equal(res.unplanned.length, 0);
});

test('schedule：单科目连续不超过 maxContiguousMin', () => {
  const slots = [];
  for (let i = 0; i < 10; i++) {
    slots.push({ date: '一', startMin: 540 + i * 30, durMin: 30, available: true, isBuffer: false });
  }
  const res = schedule({
    tasks: [{ id: 'x', subject: '数学', estMin: 300, weight: 0.9 }],
    slots: slots,
    params: { dailyCapMin: 300, bufferRatio: 0, maxContiguousMin: 150 }
  });
  /* 按同科目连续段检查 */
  const bySubject = {};
  res.blocks.forEach((b) => {
    (bySubject[b.subject] = bySubject[b.subject] || []).push([b.startMin, b.startMin + b.durMin]);
  });
  Object.keys(bySubject).forEach((subj) => {
    const ivs = bySubject[subj].sort((a, b) => a[0] - b[0]);
    let run = 0;
    let prevEnd = null;
    ivs.forEach((iv) => {
      run = prevEnd === iv[0] ? run + (iv[1] - iv[0]) : (iv[1] - iv[0]);
      assert.ok(run <= 150, '连续段 ' + run + ' min 超过上限');
      prevEnd = iv[1];
    });
  });
  assert.equal(res.truncated, true);
  assert.equal(res.unplanned.length, 1);
});

test('schedule：弹性位优先给非弹性（指定时段的刚性）任务', () => {
  const res = schedule({
    tasks: [
      { id: 'rigid', subject: '数学', estMin: 60, weight: 0.9, date: '一', startMin: 1230 },
      { id: 'flex', subject: '英语', estMin: 60, weight: 0.5 }
    ],
    slots: [
      { date: '一', startMin: 600, durMin: 60, available: true, isBuffer: false },
      { date: '一', startMin: 1230, durMin: 60, available: true, isBuffer: true }
    ],
    params: { dailyCapMin: 300, bufferRatio: 0.15, maxContiguousMin: 150 }
  });
  const rigid = res.blocks.filter((b) => b.taskId === 'rigid');
  const flex = res.blocks.filter((b) => b.taskId === 'flex');
  assert.equal(rigid.length, 1);
  assert.equal(rigid[0].isBuffer, true);
  assert.equal(rigid[0].locked, true);
  assert.equal(flex.length, 1);
  assert.equal(flex[0].isBuffer, false);
  assert.equal(flex[0].startMin, 600);
  assert.equal(res.bufferUsedRatio, 1);
});

test('schedule：弹性 Slot 优先级最低，仅在无其他选择时使用', () => {
  const res = schedule({
    tasks: [{ id: 'a', subject: '数学', estMin: 60, weight: 0.9 }],
    slots: [
      { date: '一', startMin: 600, durMin: 60, available: true, isBuffer: false },
      { date: '一', startMin: 1230, durMin: 60, available: true, isBuffer: true }
    ],
    params: { dailyCapMin: 300, bufferRatio: 0.15, maxContiguousMin: 150 }
  });
  assert.equal(res.blocks.length, 1);
  assert.equal(res.blocks[0].isBuffer, false);
  assert.equal(res.blocks[0].startMin, 600);
  assert.equal(res.bufferUsedRatio, 0);
});

test('schedule：单日总时长不超日上限', () => {
  const slots = [];
  for (let i = 0; i < 20; i++) {
    slots.push({ date: '一', startMin: 480 + i * 30, durMin: 30, available: true, isBuffer: false });
  }
  const res = schedule({
    tasks: [
      { id: 'a', subject: '数学', estMin: 180, weight: 0.9 },
      { id: 'b', subject: '英语', estMin: 180, weight: 0.8 },
      { id: 'c', subject: '408', estMin: 180, weight: 0.7 }
    ],
    slots: slots,
    params: { dailyCapMin: 300, bufferRatio: 0, maxContiguousMin: 150 }
  });
  const dayTotal = res.blocks.reduce((a, b) => a + b.durMin, 0);
  assert.ok(dayTotal <= 300, '单日总时长 ' + dayTotal + ' 超过上限');
  assert.equal(res.loadByDay['一'], dayTotal);
  assert.ok(res.unplanned.length >= 1);
  assert.equal(res.truncated, true);
});

test('schedule：返回结构完整且版本固定', () => {
  const res = schedule({
    tasks: [{ id: 'a', subject: '数学', estMin: 60, weight: 0.9 }],
    slots: [{ date: '一', startMin: 600, durMin: 60, available: true, isBuffer: false }],
    params: { dailyCapMin: 300, bufferRatio: 0.15, maxContiguousMin: 150 }
  });
  assert.equal(res.version, 'planner-1.0.0');
  assert.deepEqual(Object.keys(res).sort(), [
    'blocks', 'bufferUsedRatio', 'loadByDay', 'softScore', 'truncated', 'unplanned', 'version'
  ]);
  assert.equal(typeof res.softScore, 'number');
  assert.ok(res.blocks[0].reason.length > 0);
});

/* ── 重排 ─────────────────────────────────────────────────────────────── */

test('replan：确定性（同输入两次全等）', () => {
  const input = {
    tasks: seed.tasks,
    week: weekOf(seed.week.map((d) => ({ date: d.d, minutes: d.total, buffer: d.buf }))),
    params: REPLAN_PARAMS,
    history: { consecutiveNoImprove: 0 },
    timestamp: '2026-11-08T11:04:00+08:00'
  };
  assert.deepEqual(replan(input), replan(input));
});

test('replan：种子数据上 L1 顺延 +23% 超限 → 回退到 L2 压缩生效', () => {
  const res = replan({
    tasks: seed.tasks,
    week: weekOf(seed.week.map((d) => ({ date: d.d, minutes: d.total, buffer: d.buf }))),
    params: REPLAN_PARAMS,
    history: { consecutiveNoImprove: 0 },
    timestamp: '2026-11-08T11:04:00+08:00'
  });
  assert.equal(res.strategies.length, 4);
  assert.equal(res.strategies[0].level, 1);
  assert.equal(res.strategies[0].name, '顺延');
  assert.equal(res.strategies[0].applied, false);
  assert.match(res.strategies[0].reason, /超过单次上限/);
  assert.equal(res.strategies[1].level, 2);
  assert.equal(res.strategies[1].name, '压缩');
  assert.equal(res.strategies[1].applied, true);
  assert.equal(res.strategies[2].applied, false);
  assert.equal(res.strategies[3].applied, false);
  assert.match(res.strategies[3].reason, /无需进入/);
  assert.equal(res.accepted, true);
  assert.equal(res.verdict, 'ok');
  assert.ok(res.loadDelta <= REPLAN_PARAMS.loadGrowthCap + 1e-9);
  assert.ok(res.diff.some((d) => d.op === 'compress'));
  assert.ok(res.diff.some((d) => d.op === 'defer'));
  /* 压缩后的任务被标记 degraded */
  const compressedTask = res.nextTasks.find((t) => t.id === 't4');
  assert.equal(compressedTask.degraded, true);
  assert.ok(compressedTask.est < 45);
  assert.ok(compressedTask.est >= Math.floor(45 * REPLAN_PARAMS.compressFloor));
});

test('replan：负载增幅 > 20% 的输入触发 L1 → L2 回退', () => {
  const res = replan({
    tasks: [
      { id: 'done1', subject: '数学', estMin: 300, weight: 0.9, done: true },
      { id: 'p1', subject: '数学', estMin: 100, weight: 0.7 },
      { id: 'p2', subject: '英语', estMin: 100, weight: 0.5 }
    ],
    week: baseWeek(100),
    params: REPLAN_PARAMS,
    history: { consecutiveNoImprove: 0 },
    timestamp: 1000
  });
  assert.equal(res.strategies[0].applied, false);
  assert.match(res.strategies[0].reason, /超过单次上限/);
  assert.equal(res.strategies[1].applied, true);
  assert.equal(res.accepted, true);
  assert.equal(res.guards.loadGrowthOk, true);
  assert.ok(res.loadDelta <= 0.2 + 1e-9);
});

test('replan：L1 通过时不再进入后续级别（不追求排满）', () => {
  const res = replan({
    tasks: [{ id: 'p1', subject: '数学', estMin: 100, weight: 0.7 }],
    week: baseWeek(100),
    params: REPLAN_PARAMS,
    history: { consecutiveNoImprove: 0 },
    timestamp: 1000
  });
  assert.equal(res.strategies[0].applied, true);
  assert.equal(res.strategies[1].applied, false);
  assert.equal(res.strategies[2].applied, false);
  assert.equal(res.strategies[3].applied, false);
  assert.equal(res.accepted, true);
  assert.ok(res.loadDelta < 0.2);
});

test('replan：快照可逆（撤销后逐条还原，不重算）', () => {
  const tasks = [
    { id: 'done1', subject: '数学', estMin: 300, weight: 0.9, done: true },
    { id: 'p1', subject: '数学', estMin: 100, weight: 0.7 },
    { id: 'p2', subject: '英语', estMin: 100, weight: 0.5 }
  ];
  const week = baseWeek(100);
  const res = replan({
    tasks: tasks,
    week: week,
    params: REPLAN_PARAMS,
    history: { consecutiveNoImprove: 0 },
    timestamp: '2026-11-08T11:04:00+08:00'
  });
  const undone = undoReplan(res.snapshot);
  assert.deepEqual(undone.tasks, tasks);
  assert.deepEqual(undone.week, week);
  assert.equal(res.snapshot.timestamp, '2026-11-08T11:04:00+08:00');
});

test('replan：snapshot 时间戳由调用方注入（引擎不读时钟）', () => {
  const res = replan({
    tasks: seed.tasks,
    week: weekOf(seed.week.map((d) => ({ date: d.d, minutes: d.total, buffer: d.buf }))),
    params: REPLAN_PARAMS,
    history: { consecutiveNoImprove: 0 }
  });
  assert.equal(res.snapshot.timestamp, null);
});

test('replan：弹性位永不清空', () => {
  const res = replan({
    tasks: [{ id: 'p1', subject: '数学', estMin: 100, weight: 0.7 }],
    week: baseWeek(100),
    params: REPLAN_PARAMS,
    history: { consecutiveNoImprove: 0 },
    timestamp: 1000
  });
  assert.equal(res.guards.bufferPreserved, true);
  res.nextWeek.forEach((d) => {
    assert.ok(d.minutes <= d.capacity, '弹性位被侵占：' + d.date + ' ' + d.minutes + '/' + d.capacity);
  });
});

test('replan：会侵占弹性位的计划一律被阻断', () => {
  const res = replan({
    tasks: [{ id: 'p1', subject: '数学', estMin: 100, weight: 0.7 }],
    week: [{ date: 'D1', minutes: 400, buffer: 60 }],
    params: REPLAN_PARAMS,
    history: { consecutiveNoImprove: 0 },
    timestamp: 1000
  });
  assert.equal(res.accepted, false);
  assert.equal(res.verdict, 'blocked');
  assert.equal(res.guards.bufferPreserved, false);
  assert.ok(res.strategies.every((s) => s.applied === false));
});

test('replan：连续 3 次未改善即停转校准', () => {
  const res = replan({
    tasks: seed.tasks,
    week: weekOf(seed.week.map((d) => ({ date: d.d, minutes: d.total, buffer: d.buf }))),
    params: REPLAN_PARAMS,
    history: { consecutiveNoImprove: 3 },
    timestamp: 1000
  });
  assert.equal(res.accepted, false);
  assert.equal(res.verdict, 'blocked');
  assert.equal(res.guards.consecutiveOk, false);
  assert.equal(res.diff.length, 0);
  assert.ok(res.strategies.every((s) => s.applied === false));
  assert.match(res.strategies[0].reason, /转目标校准/);
});

test('replan：L3 替代只在同知识域内做高频高权重替换', () => {
  const res = replan({
    tasks: [
      { id: 'a', subject: '数学', estMin: 100, weight: 0.3, domain: '高数', freq: 0.2 },
      { id: 'b', subject: '数学', estMin: 40, weight: 0.9, domain: '高数', freq: 0.8 },
      { id: 'c', subject: '线代', estMin: 90, weight: 0.5, domain: '线代', freq: 0.5 }
    ],
    week: baseWeek(100),
    params: Object.assign({}, REPLAN_PARAMS, { compressedShareCap: 0.05 }),
    history: { consecutiveNoImprove: 0 },
    timestamp: 1000
  });
  assert.equal(res.strategies[0].applied, false);
  assert.equal(res.strategies[1].applied, false);
  assert.equal(res.strategies[2].applied, true);
  assert.equal(res.strategies[2].name, '替代');
  assert.equal(res.accepted, true);
  const sub = res.diff.find((d) => d.op === 'substitute');
  assert.ok(sub);
  assert.equal(sub.taskId, 'a');
  assert.match(sub.to, /^b/);
  const a = res.nextTasks.find((t) => t.id === 'a');
  assert.equal(a.substituted, true);
  assert.equal(a.substitutedBy, 'b');
});

test('replan：L4 放弃标记 abandoned 并要求用户确认', () => {
  const res = replan({
    tasks: [
      { id: 'p1', subject: '政治', estMin: 100, weight: 0.2 },
      { id: 'p2', subject: '英语', estMin: 100, weight: 0.4 },
      { id: 'p3', subject: '数学', estMin: 100, weight: 0.9 }
    ],
    week: baseWeek(100),
    params: REPLAN_PARAMS,
    history: { consecutiveNoImprove: 0 },
    timestamp: 1000
  });
  assert.equal(res.strategies[3].applied, true);
  assert.equal(res.accepted, true);
  const ab = res.diff.filter((d) => d.op === 'abandon');
  assert.ok(ab.length >= 1);
  assert.match(ab[0].detail, /需用户确认/);
  const abandoned = res.nextTasks.filter((t) => t.abandoned === true);
  assert.equal(abandoned.length, ab.length);
  assert.equal(abandoned[0].needsConfirmation, true);
});

test('replan：结构完整（strategies / diff / guards / snapshot）', () => {
  const res = replan({
    tasks: seed.tasks,
    week: weekOf(seed.week.map((d) => ({ date: d.d, minutes: d.total, buffer: d.buf }))),
    params: REPLAN_PARAMS,
    history: { consecutiveNoImprove: 0 },
    timestamp: 1000
  });
  assert.deepEqual(Object.keys(res.guards).sort(), [
    'bufferPreserved', 'compressedShareOk', 'consecutiveOk', 'loadGrowthOk'
  ]);
  assert.deepEqual(Object.keys(res.snapshot).sort(), ['tasks', 'timestamp', 'week']);
  res.diff.forEach((d) => {
    assert.ok(['defer', 'compress', 'substitute', 'abandon'].indexOf(d.op) >= 0);
    assert.equal(typeof d.taskId, 'string');
    assert.equal(typeof d.from, 'string');
    assert.equal(typeof d.to, 'string');
    assert.equal(typeof d.detail, 'string');
  });
});

/* ── 归因 ─────────────────────────────────────────────────────────────── */

test('attribute：四种偏差各得对应 type', () => {
  const over = attribute({ planLoadRatio: 1.2, consecutiveZeroDays: 0, consecutiveTimeoutCount: 0, efficiencyRatio: 1, completion: 0, externalRatio: 0 });
  assert.equal(over.type, '计划过载');

  const interrupt = attribute({ planLoadRatio: 1, consecutiveZeroDays: 2, consecutiveTimeoutCount: 0, efficiencyRatio: 1, completion: 0, externalRatio: 0 });
  assert.equal(interrupt.type, '执行中断');

  const ineff = attribute({ planLoadRatio: 1, consecutiveZeroDays: 0, consecutiveTimeoutCount: 0, efficiencyRatio: 1.5, completion: 0.7, externalRatio: 0 });
  assert.equal(ineff.type, '效率不足');

  const external = attribute({ planLoadRatio: 1, consecutiveZeroDays: 0, consecutiveTimeoutCount: 0, efficiencyRatio: 1, completion: 0, externalRatio: 0.4 });
  assert.equal(external.type, '外部干扰');

  const none = attribute({ planLoadRatio: 1, consecutiveZeroDays: 0, consecutiveTimeoutCount: 0, efficiencyRatio: 1, completion: 0.5, externalRatio: 0.1 });
  assert.equal(none.type, '无偏差');
});

test('attribute：顺序不变量（多条件同时命中时返回靠前的那个）', () => {
  const all = {
    planLoadRatio: 1.5,
    consecutiveZeroDays: 3,
    consecutiveTimeoutCount: 4,
    efficiencyRatio: 2,
    completion: 0.9,
    externalRatio: 0.6
  };
  assert.equal(attribute(all).type, '计划过载');

  const noOverload = Object.assign({}, all, { planLoadRatio: 1.0, consecutiveTimeoutCount: 0 });
  assert.equal(attribute(noOverload).type, '执行中断');

  const noInterrupt = Object.assign({}, noOverload, { consecutiveZeroDays: 0 });
  assert.equal(attribute(noInterrupt).type, '效率不足');

  const noIneff = Object.assign({}, noInterrupt, { efficiencyRatio: 1.2 });
  assert.equal(attribute(noIneff).type, '外部干扰');

  const noExternal = Object.assign({}, noIneff, { externalRatio: 0.1 });
  assert.equal(attribute(noExternal).type, '无偏差');
});

test('attribute：计划过载的 timeout 分支同样优先', () => {
  const res = attribute({ planLoadRatio: 1, consecutiveZeroDays: 5, consecutiveTimeoutCount: 3, efficiencyRatio: 2, completion: 0.9, externalRatio: 0.9 });
  assert.equal(res.type, '计划过载');
});

test('attribute：确定性 + 结构完整', () => {
  const input = { planLoadRatio: 1.2, consecutiveZeroDays: 0, consecutiveTimeoutCount: 0, efficiencyRatio: 1, completion: 0, externalRatio: 0 };
  assert.deepEqual(attribute(input), attribute(input));
  const res = attribute(input);
  assert.deepEqual(Object.keys(res).sort(), ['actions', 'confidence', 'evidence', 'type']);
  assert.ok(res.confidence >= 0 && res.confidence <= 1);
  assert.ok(Array.isArray(res.actions) && res.actions.length >= 1);
  assert.equal(typeof res.evidence, 'object');
});

/* ── 种子数据 ─────────────────────────────────────────────────────────── */

test('seed：结构与数值与现有 demo 一致', () => {
  assert.equal(seed.user.name, '林清');
  assert.equal(seed.user.dailyCapMin, 300);
  assert.equal(seed.goal.name, '2027 考研 · 计算机');
  assert.equal(seed.goal.target, '380 分');
  assert.equal(seed.goal.deadline, '2027-12-25');
  assert.equal(seed.goal.weeks, 58);
  assert.deepEqual(seed.feas, { weeklyH: 20, weeks: 58, discount: 0.85, demand: 913 });
  assert.equal(seed.tasks.length, 4);
  assert.deepEqual(seed.tasks.map((t) => t.subject), ['英语', '数学', '408', '政治']);
  assert.deepEqual(seed.tasks.map((t) => t.est), [60, 90, 75, 45]);
  assert.deepEqual(seed.tasks.map((t) => t.weight), [0.78, 0.92, 0.86, 0.41]);
  assert.equal(seed.tasks[0].done, true);
  assert.equal(seed.tasks[0].actual, 60);
  assert.equal(seed.buffer.time, '20:30–21:30');
  assert.equal(seed.buffer.free, true);
  assert.equal(seed.week.length, 7);
  assert.deepEqual(seed.week.map((d) => d.d), ['一', '二', '三', '四', '五', '六', '日']);
  assert.deepEqual(seed.week.map((d) => d.total), [105, 90, 150, 45, 105, 150, 270]);
  assert.deepEqual(seed.week.map((d) => d.buf), [60, 60, 60, 60, 60, 60, 60]);
  assert.equal(seed.week[6].today, true);
  assert.equal(seed.weekShift.length, 7);
  assert.deepEqual(seed.weekShift.map((d) => d.total), [105, 120, 150, 90, 90, 195, 225]);
  assert.deepEqual(seed.notif, { daily: true, weekly: true, alert: true, rescue: true });
  assert.deepEqual(seed.weekStats.WEEKS, [52, 61, 58, 66, 71, 74, 72, 68]);
  assert.equal(seed.weekStats.kpis.achievementRate, 68);
  assert.equal(seed.weekStats.kpis.effectiveHours, 11.2);
});

test('seed：不可变（深度冻结）', () => {
  assert.ok(Object.isFrozen(seed));
  assert.ok(Object.isFrozen(seed.tasks));
  assert.ok(Object.isFrozen(seed.week));
  assert.ok(Object.isFrozen(seed.weekStats));
  assert.throws(() => { 'use strict'; seed.tasks[0].est = 999; }, TypeError);
});

test('seed：科目色值沿用现有 CSS 变量名', () => {
  assert.equal(seed.subjectColors['数学'], 'var(--m-math)');
  assert.equal(seed.subjectColors['英语'], 'var(--m-en)');
  assert.equal(seed.subjectColors['408'], 'var(--m-408)');
  assert.equal(seed.subjectColors['政治'], 'var(--m-pol)');
});
