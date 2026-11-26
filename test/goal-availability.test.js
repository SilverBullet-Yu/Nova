'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const H = require('./helpers');
const P = require('../shared/placement-model.js');
const src = fs.readFileSync(require.resolve('../assets/js/flows/goal.js'), 'utf8');
const TODAY = '2026-11-18';

function sandbox(ZX, disk = new Map()) {
  const storage = disk;
  const ctx = { window: { ZX, Rhythm: { placementModel: P }, localStorage: {
    getItem: k => storage.has(k) ? storage.get(k) : null,
    setItem: (k, v) => storage.set(k, v),
    removeItem: k => storage.delete(k)
  } }, document: { addEventListener() {} } };
  H.installUtil(ctx);
  ZX.util.today0 = () => new Date(2026, 10, 18);
  ZX.util.todayKey = () => TODAY;
  return ctx;
}

function slots(avail, deadline) {
  const ZX = { state: { avail } };
  const ctx = sandbox(ZX);
  vm.runInNewContext(src.replace('open: open, apply: apply', 'open: open, apply: apply, slots: buildSlots, dates: futureDates'), ctx);
  return { slots: ZX.flows.goal.slots(deadline), dates: ZX.flows.goal.dates() };
}

test('仅在用户启用的时间带构建具体日期槽位，不进入静默时段', () => {
  const grid = Array.from({ length: 7 }, () => [false, false, false, false]);
  assert.equal(slots(grid).slots.length, 0);
  grid[2] = [true, false, false, true];
  const result = slots(grid);
  assert.deepEqual(Array.from(result.dates), ['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24']);
  assert.ok(result.slots.length > 0);
  assert.ok(result.slots.every(s => s.date === TODAY && s.startMin >= 480 && s.startMin + s.durMin <= 720));
  assert.ok(result.slots.some(s => s.isBuffer));
});

test('缩小范围后的需求在返回表单再前进时不被重置', () => {
  const ZX = { api: { $: () => null }, state: { goalDraft: { type: '考研', base: '一轮', demand: 100 } } };
  const ctx = sandbox(ZX);
  vm.runInNewContext(src.replace('var api = null;', 'var api = {$:()=>null};').replace('open: open, apply: apply', 'open: open, apply: apply, capture: captureForm, feasClick: onClickFeas').replaceAll('flow.render();', ''), ctx);
  ZX.flows.goal.feasClick('fix-demand');
  assert.equal(ZX.state.goalDraft.demand, 85);
  ZX.flows.goal.capture();
  assert.equal(ZX.state.goalDraft.demand, 85);
});

test('排程槽位不晚于目标截止日期，过去截止日在调用引擎前拒绝', async () => {
  const grid = Array.from({ length: 7 }, () => [true, true, true, true]);
  const limited = slots(grid, '2026-11-19').slots;
  assert.ok(limited.length > 0);
  assert.ok(limited.every(slot => slot.date <= '2026-11-19'));
  assert.ok(limited.some(slot => slot.date === '2026-11-19'));

  let calls = 0;
  const draft = { name: '过去目标', deadline: '2026-11-17', weeks: 5, weeklyH: 10, demand: 10 };
  const state = { goalDraft: draft, planDraft: [{ id: 'a', s: '数学', title: '任务', est: 30, weight: 1 }], goal: { name: 'old' }, feas: {}, avail: grid };
  const ZX = { state, render() {}, setTab() {}, ui: { toast() {} }, assistant: { say() {} }, engine: { feasibilityNow: () => ({ R: 1 }), schedule: async () => { calls++; } } };
  vm.runInNewContext(src, sandbox(ZX));
  ZX.flows.goal.apply();
  await Promise.resolve();
  assert.equal(calls, 0);
  assert.equal(state.goal.name, 'old');
});

test('跨日任务时间由具体日期与首末区块派生', () => {
  const ZX = {};
  const ctx = sandbox(ZX);
  vm.runInNewContext(src.replace('open: open, apply: apply', 'open: open, apply: apply, taskTime: taskTime'), ctx);
  const model = P.createModel({
    startDate: TODAY, timezone: 'UTC', idPrefix: 'test_',
    tasks: [{ id: 'a', subject: '数学', estMin: 120 }],
    slots: [
      { date: TODAY, startMin: 480, durMin: 60, isBuffer: false },
      { date: '2026-11-19', startMin: 480, durMin: 60, isBuffer: false }
    ],
    blocks: [
      { id: 'b1', taskId: 'a', date: TODAY, startMin: 480, durMin: 60 },
      { id: 'b2', taskId: 'a', date: '2026-11-19', startMin: 480, durMin: 60 }
    ],
    unplanned: []
  });
  assert.equal(ZX.flows.goal.taskTime(model, 'a'), '11-18 08:00–11-19 09:00');
});

test('排程应用保存全部任务与 v3 落点，弹性容量不计入任务工时', () => {
  const toasts = [];
  const ZX = { state: { goal: {}, normTask: task => ({ ...task, s: task.subject }), resetTimer() {} }, render() {}, setTab() {}, ui: { toast: message => toasts.push(message) }, assistant: { say() {} } };
  const ctx = sandbox(ZX);
  vm.runInNewContext(src.replace('open: open, apply: apply', 'open: open, apply: apply, project: applyScheduled'), ctx);
  const input = [{ id: 'd1', subject: '数学', title: '练习', estMin: 15, weight: 1 }];
  const grid = Array.from({ length: 7 }, () => [false, false, false, false]);
  grid[2][0] = true;
  const built = slots(grid).slots;
  ZX.flows.goal.project({ blocks: [{ id: 'b1', taskId: 'd1', subject: '数学', date: TODAY, startMin: 480, durMin: 15 }], unplanned: [] }, input, 'test',
    { name: '目标', deadline: '2027-01-01', weeks: 4, weeklyH: 10, demand: 20 }, built);
  assert.deepEqual(toasts, []);
  assert.equal(ZX.state.placementModel.schemaVersion, 1);
  assert.equal(ZX.state.tasks[0].id, 'd1');
  assert.equal(ZX.state.dayAssign.d1, '三');
  assert.equal(ZX.state.buffer.time, '11:00–12:00');
  const day = ZX.state.week.find(item => item.date === TODAY);
  assert.equal(day.buf, 60);
  assert.equal(day.total, 15);
  assert.equal(day.bufferUsed, 0);
  assert.ok(ZX.state.week.filter(item => item.date !== TODAY).every(item => item.buf === 0 && item.total === 0));
});

test('可行性卡片区分目标草案与确定性引擎使用的校准需求', () => {
  const { feasibility } = require('../shared/engine/feasibility.js');
  const ZX = { state: { goalDraft: { weeklyH: 20, weeks: 10, demand: 42 } },
    engine: { feasibilityNow: feasibility } };
  const ctx = sandbox(ZX);
  vm.runInNewContext(src.replace('open: open, apply: apply', 'open: open, apply: apply, feasHtml: feasHtml'), ctx);
  const html = ZX.flows.goal.feasHtml();
  assert.match(html, /目标草案：20 h\/周 × 10 周/);
  assert.match(html, /确定性引擎/);
  assert.match(html, /当前需求 D = 42 h/);
});
