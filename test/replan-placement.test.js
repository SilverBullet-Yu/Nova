'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { replan, undoReplan } = require('../shared/engine/replan.js');

const PARAMS = {
  loadGrowthCap: 0.20,
  compressFloor: 0.60,
  compressedShareCap: 0.30,
  consecutiveNoImproveCap: 3,
  bufferRatio: 0.15
};

function run(tasks, week, extra) {
  return replan({ tasks, week, params: PARAMS, history: { consecutiveNoImprove: 0 }, ...extra });
}

function day(values) {
  return { date: 'D1', minutes: 0, buffer: 0, ...values };
}

test('replan M1：已有任务先释放再装载，普通与弹性负载均不重复增加', () => {
  const input = {
    tasks: [
      { id: 'existing', subject: '数学', est: 60, weight: 0.9 },
      { id: 'new', subject: '英语', est: 20, weight: 0.5 }
    ],
    week: [day({
      minutes: 100, capacity: 120, bufferUsed: 30, buffer: 30,
      releasedMinutes: 60, releasedBufferMinutes: 30
    })]
  };
  const before = structuredClone(input);
  const res = run(input.tasks, input.week);
  assert.equal(res.accepted, true);
  assert.equal(res.strategies[0].applied, true);
  assert.equal(res.nextWeek[0].minutes, 120);
  assert.equal(res.nextWeek[0].bufferUsed, 0);
  assert.equal(res.loadDelta, -0.0769);
  assert.equal(res.snapshot.week[0].releasedMinutes, 60);
  assert.equal(res.snapshot.week[0].releasedBufferMinutes, 30);
  assert.deepEqual(input, before);
});

test('replan M1：弹性容量未使用时仍先装普通容量', () => {
  const res = run(
    [{ id: 'p', subject: '数学', est: 30, weight: 0.9 }],
    [day({ minutes: 0, capacity: 100, buffer: 60 })],
    { allowBuffer: true }
  );
  assert.equal(res.accepted, true);
  assert.equal(res.nextWeek[0].minutes, 30);  assert.equal(res.nextWeek[0].bufferUsed, 0);
  assert.deepEqual(res.nextPlacements[0].segs, [{ date: 'D1', minutes: 30, isBuffer: false }]);
});

test('replan M1：普通容量用尽后可使用部分弹性容量', () => {
  const res = run(
    [{ id: 'p', subject: '数学', est: 30, weight: 0.9 }],
    [day({ minutes: 100, capacity: 100, bufferUsed: 20, buffer: 60 })],
    { allowBuffer: true, params: { ...PARAMS, loadGrowthCap: 1 } }
  );
  assert.equal(res.accepted, true);
  assert.equal(res.nextWeek[0].minutes, 100);
  assert.equal(res.nextWeek[0].bufferUsed, 50);
  assert.deepEqual(res.nextPlacements[0].segs, [{ date: 'D1', minutes: 30, isBuffer: true }]);
  assert.equal(res.guards.bufferPreserved, true);
});

test('replan M1：弹性容量全用后可释放重装至全用，不溢出弹性池', () => {
  const res = run(
    [{ id: 'p', subject: '数学', est: 60, weight: 0.9 }],
    [day({ minutes: 0, capacity: 0, bufferUsed: 60, buffer: 60, releasedBufferMinutes: 60 })],
    { allowBuffer: true }
  );
  assert.equal(res.accepted, true);
  assert.equal(res.strategies[0].applied, true);
  assert.equal(res.nextTasks[0].est, 60);
  assert.equal(res.nextWeek[0].bufferUsed, 60);
  assert.ok(res.nextWeek[0].bufferUsed <= res.nextWeek[0].buffer);
});

test('replan M1：allowBuffer 未显式开启时不侵占弹性池', () => {
  for (const allowBuffer of [undefined, false]) {
    const res = run(
      [{ id: 'p', subject: '数学', est: 30, weight: 0.9 }],
      [day({ minutes: 100, capacity: 100, bufferUsed: 20, buffer: 60 })],
      { allowBuffer }
    );
    assert.equal(res.strategies[0].applied, false);
    assert.equal(res.diff.some(d => d.op === 'defer'), false);
    assert.equal(res.accepted, false);
    assert.equal(res.nextWeek[0].bufferUsed, 20);
  }
});

test('replan M1：锁定项保留且 placements 分段为空，不进入 diff', () => {
  const res = run(
    [
      { id: 'locked', subject: '数学', est: 60, weight: 0.9 },
      { id: 'p', subject: '英语', est: 60, weight: 0.5 }
    ],
    [day({ minutes: 100, capacity: 100, bufferUsed: 20, buffer: 20, releasedMinutes: 60 })],
    { locks: { locked: true } }
  );
  assert.equal(res.accepted, true);
  const locked = res.nextPlacements.find(p => p.task.id === 'locked');
  assert.equal(locked.locked, true);
  assert.deepEqual(locked.segs, []);
  assert.equal(locked.minutes, 0);
  assert.equal(res.diff.some(d => d.taskId === 'locked'), false);
  assert.equal(res.nextWeek[0].minutes, 100);
  assert.equal(res.nextWeek[0].bufferUsed, 20);
});

test('replan M1：defer diff 提供跨日结构化 segments，日期以空格斜线连接', () => {
  const week = [
    { date: 'D1', minutes: 50, capacity: 50, buffer: 0, releasedMinutes: 50 },
    { date: 'D2', minutes: 0, capacity: 0, buffer: 70, bufferUsed: 0 }
  ];
  const res = run(
    [{ id: 'p', subject: '数学', est: 70, weight: 0.9 }],
    week,
    { allowBuffer: true, params: { ...PARAMS, loadGrowthCap: 1 } }
  );
  assert.equal(res.accepted, true);
  const diff = res.diff.find(d => d.op === 'defer');
  assert.equal(diff.to, 'D1 / D2');
  assert.deepEqual(diff.segments, [
    { date: 'D1', minutes: 50, isBuffer: false },
    { date: 'D2', minutes: 20, isBuffer: true }
  ]);
  assert.deepEqual(diff.segments, res.nextPlacements[0].segs);
});

test('replan M1：零基线 loadDelta 为 null，容量足够时接受且不显示百分比', () => {
  const res = run(
    [{ id: 'p', subject: '数学', est: 60, weight: 0.9 }],
    [day({ capacity: 60, buffer: 60 })]
  );
  assert.equal(res.accepted, true);
  assert.equal(res.loadDelta, null);
  assert.equal(res.growthApplicable, false);
  assert.equal(res.guards.loadGrowthOk, true);
  assert.match(res.strategies[0].reason, /增幅不适用（零基线）/);
  assert.doesNotMatch(res.strategies[0].reason, /100\.0%/);
  assert.equal(typeof res.strategies[0].growth, 'number');
});

test('replan M1：零基线仍由容量守卫阻断无法装载的任务', () => {
  const res = run(
    [{ id: 'p', subject: '数学', est: 60, weight: 0.9 }],
    [day({ capacity: 50, buffer: 0 })],
    { params: { ...PARAMS, compressFloor: 1 } }
  );
  assert.equal(res.accepted, false);
  assert.equal(res.strategies[0].applied, false);
  assert.equal(res.loadDelta, null);
  assert.equal(res.growthApplicable, false);
  assert.equal(res.diff.some(d => d.op === 'defer'), false);
  assert.match(res.strategies[0].reason, /增幅不适用（零基线）/);
});

test('replan M1：已释放的本周任务重装不误触发 L2 压缩', () => {
  const res = run(
    [{ id: 'p', subject: '数学', est: 100, weight: 0.9 }],
    [day({ minutes: 100, capacity: 100, buffer: 60, releasedMinutes: 100 })]
  );
  assert.equal(res.accepted, true);
  assert.equal(res.strategies[0].applied, true);
  assert.match(res.strategies[1].reason, /前置级别已通过校验/);
  assert.equal(res.diff.some(d => d.op === 'compress'), false);
  assert.equal(res.nextTasks[0].est, 100);
  assert.equal(res.nextWeek[0].minutes, 100);
  assert.equal(res.loadDelta, 0);
});

test('replan M1：L2 总容量在 allowBuffer 时包含弹性池', () => {
  const res = run(
    [{ id: 'p', subject: '数学', est: 130, weight: 0.9 }],
    [day({ minutes: 100, capacity: 100, buffer: 60, releasedMinutes: 100 })],
    { allowBuffer: true, params: { ...PARAMS, loadGrowthCap: 0 } }
  );
  assert.match(res.strategies[1].reason, /容量未溢出/);
  assert.equal(res.diff.some(d => d.op === 'compress'), false);
  assert.equal(res.nextTasks.find(t => t.id === 'p').est, 130);
});

test('replan M1：L2 成功也返回 nextPlacements，分段时间与 tasks 一致', () => {
  const res = run(
    [{ id: 'p', subject: '数学', est: 100, weight: 0.9 }],
    [day({ minutes: 70, capacity: 70, buffer: 20, releasedMinutes: 70 })]
  );
  assert.equal(res.accepted, true);
  assert.equal(res.strategies[1].applied, true);
  assert.equal(res.nextTasks[0].est, 70);
  assert.deepEqual(res.nextPlacements[0].segs, [{ date: 'D1', minutes: 70, isBuffer: false }]);
  assert.equal(res.nextPlacements[0].minutes, 70);
});

test('replan M1：旧无新字段输入保持普通容量行为与快照形状', () => {
  const week = [{ date: 'D1', minutes: 100, buffer: 60 }];
  const res = run([{ id: 'p', subject: '数学', est: 20, weight: 0.7 }], week);
  assert.equal(res.accepted, true);
  assert.equal(res.loadDelta, 0.2);
  assert.equal(res.growthApplicable, true);
  assert.equal(res.nextWeek[0].minutes, 120);
  assert.equal(res.nextWeek[0].bufferUsed, 0);
  assert.deepEqual(Object.keys(res.snapshot).sort(), ['tasks', 'timestamp', 'week']);
  assert.deepEqual(Object.keys(undoReplan(res.snapshot)).sort(), ['tasks', 'week']);
  assert.deepEqual(res.nextPlacements[0].segs, [{ date: 'D1', minutes: 20, isBuffer: false }]);
});

test('replan M1：snapshot 与 undoReplan 原样保留可选 placementModel', () => {
  const placementModel = { version: 3, placements: [{ taskId: 'p', date: 'D1', minutes: 20 }] };
  const res = run(
    [{ id: 'p', subject: '数学', est: 20, weight: 0.7 }],
    [day({ capacity: 100 })],
    { placementModel }
  );
  assert.deepEqual(res.snapshot.placementModel, placementModel);
  const undone = undoReplan(res.snapshot);
  assert.deepEqual(undone.placementModel, placementModel);
  undone.placementModel.placements[0].minutes = 99;
  assert.equal(res.snapshot.placementModel.placements[0].minutes, 20);
  assert.equal(placementModel.placements[0].minutes, 20);
});
