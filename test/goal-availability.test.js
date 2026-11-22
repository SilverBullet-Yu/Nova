'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const H = require('./helpers');
const src = fs.readFileSync(require.resolve('../assets/js/flows/goal.js'), 'utf8');
function slots(avail) {
  const ZX = { state: { avail } };
  const sandbox = { window: { ZX }, document: { addEventListener() {} } };
  H.installUtil(sandbox);
  ZX.util.todayDow = () => '三';
  vm.runInNewContext(src.replace('open: open, apply: apply', 'open: open, apply: apply, slots: buildSlots'), sandbox);
  return ZX.flows.goal.slots();
}
test('仅在用户启用的时间带构建排程槽位，不进入静默时段', () => {
  const grid = Array.from({ length: 7 }, () => [false, false, false, false]);
  assert.equal(slots(grid).length, 0);
  grid[2] = [true, false, false, true];
  const result = slots(grid);
  assert.ok(result.length > 0);
  assert.ok(result.every(s => s.date === '三' && s.startMin >= 480 && s.startMin + s.durMin <= 720));
  assert.ok(result.some(s => s.isBuffer));
});

test('今日投影保留15分钟及第五项任务，只计算当天工时', () => {
  const ZX = { state: { normTask: task => task } };
  const sandbox = { window: { ZX }, document: { addEventListener() {} } };
  H.installUtil(sandbox);
  ZX.util.todayDow = () => '三';
  vm.runInNewContext(src.replace('open: open, apply: apply', 'open: open, apply: apply, project: todayTasksFromBlocks'), sandbox);
  const all = Array.from({ length: 5 }, (_, i) => ({ id: 'd' + i, subject: '数学', title: '任务' + i, estMin: 90, weight: 1 }));
  const blocks = all.map((task, i) => ({ taskId: task.id, date: '三', startMin: 480 + i * 30, durMin: 15 }));
  blocks.push({ taskId: 'd0', date: '四', startMin: 480, durMin: 75 });
  const projected = ZX.flows.goal.project(blocks, all, 'test');
  assert.equal(projected.length, 5);
  assert.ok(projected.every(task => task.est === 15));
});

test('排程应用的落点和弹性位取实际周三上午槽，不凭空添加其他天容量', () => {
  const ZX = { state: { goal: {}, normTask: task => ({ ...task, s: task.subject }), resetTimer() {} }, render() {}, setTab() {} };
  const store = H.storage();
  const sandbox = { window: { ZX, localStorage: store.localStorage }, localStorage: store.localStorage,
    document: { addEventListener() {} } };
  H.installUtil(sandbox);
  ZX.util.todayDow = () => '三';
  vm.runInNewContext(src.replace('open: open, apply: apply', 'open: open, apply: apply, project: applyScheduled'), sandbox);
  const input = [{ id: 'd1', subject: '数学', title: '练习', estMin: 15, weight: 1 }];
  const grid = Array.from({ length: 7 }, () => [false, false, false, false]);
  grid[2][0] = true;
  ZX.flows.goal.project({ blocks: [{ taskId: 'd1', subject: '数学', date: '三', startMin: 480, durMin: 15 }], unplanned: [] }, input, 'test',
    { name: '目标', deadline: '2027-01-01', weeks: 4, weeklyH: 10, demand: 20 }, slots(grid));
  assert.equal(ZX.state.dayAssign[ZX.state.tasks[0].id], '三');
  assert.equal(ZX.state.buffer.time, '11:00–12:00');
  assert.equal(ZX.state.week.find(day => day.d === '三').buf, 60);
  assert.ok(ZX.state.week.filter(day => day.d !== '三').every(day => day.buf === 0 && day.total === 0));
});

test('可行性卡片区分目标草案与确定性引擎使用的校准需求', () => {
  const { feasibility } = require('../shared/engine/feasibility.js');
  const ZX = { state: { goalDraft: { weeklyH: 20, weeks: 10, demand: 42 } },
    engine: { feasibilityNow: feasibility } };
  const sandbox = { window: { ZX }, document: { addEventListener() {} } };
  H.installUtil(sandbox);
  vm.runInNewContext(src.replace('open: open, apply: apply', 'open: open, apply: apply, feasHtml: feasHtml'),
    sandbox);
  const html = ZX.flows.goal.feasHtml();
  assert.match(html, /目标草案：20 h\/周 × 10 周/);
  assert.match(html, /确定性引擎/);
  assert.match(html, /当前需求 D = 42 h/);
});
