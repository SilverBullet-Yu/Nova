'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const src = fs.readFileSync(require.resolve('../assets/js/flows/goal.js'), 'utf8');
function slots(avail) {
  const ZX = { state: { avail }, util: { todayDow: () => '三' } };
  vm.runInNewContext(src.replace('open: open, apply: apply', 'open: open, apply: apply, slots: buildSlots'), { window: { ZX }, document: { addEventListener() {} } });
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

test('可行性卡片区分目标草案与确定性引擎使用的校准需求', () => {
  const { feasibility } = require('../shared/engine/feasibility.js');
  const ZX = { state: { goalDraft: { weeklyH: 20, weeks: 10, demand: 42 } },
    engine: { feasibilityNow: feasibility }, util: {} };
  vm.runInNewContext(src.replace('open: open, apply: apply', 'open: open, apply: apply, feasHtml: feasHtml'),
    { window: { ZX }, document: { addEventListener() {} } });
  const html = ZX.flows.goal.feasHtml();
  assert.match(html, /目标草案：20 h\/周 × 10 周/);
  assert.match(html, /确定性引擎/);
  assert.match(html, /当前需求 D = 42 h/);
});
