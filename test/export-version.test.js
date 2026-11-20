'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
test('导出执行记录自身的版本，未知版本留空', () => {
  const ZX = { util: { pad2: v => String(v).padStart(2, '0'), num: (v,d) => v ?? d }, state: { tasks: [{id:'a'}], sessions: [{taskId:'a', planVersion:'plan-old'}, {taskId:'a', planVersion:null}, {taskId:'a'}] } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../assets/js/flows/settings.js'), 'utf8'), {window:{ZX}});
  const rows = ZX.settings.csv().trimEnd().split(String.fromCharCode(10)).map(row => row.split(','));
  assert.equal(rows[0].at(-1), '计划版本');
  assert.ok(rows.every(row => row.length === 10));
  assert.deepEqual(rows.slice(1).map(row => row.at(-1)), ['', 'plan-old', '', '']);
});

test('CSV 仅导出已确认的用户目标，不把演示目标标为用户输入', () => {
  const ZX = { util: { pad2: v => String(v).padStart(2, '0') }, state: { goal: { name: 'Demo', deadline: '2026-12-01' } } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../assets/js/flows/settings.js'), 'utf8'), { window: { ZX } });
  assert.doesNotMatch(ZX.settings.csv(), /Demo/);
  ZX.state.goal = { name: 'Review, chapter 1', deadline: '2026-12-01', source: 'user' };
  assert.match(ZX.settings.csv(), /阶段目标,,,"Review, chapter 1",,,,用户设置,2026-12-01,/);
});

test('CSV 导出已保存的时段和来源，且不把静默列算作可用项', () => {
  const avail = Array.from({length:7}, () => [false,false,false,true]);
  avail[0][0] = true;
  const ZX = { util: { pad2:v=>String(v).padStart(2,'0') }, state:{avail, availSource:'user'} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../assets/js/flows/settings.js'), 'utf8'), {window:{ZX}});
  const rows = ZX.settings.csv().trimEnd().split(String.fromCharCode(10)).slice(1).map(r=>r.split(','));
  assert.equal(rows.length, 21);
  assert.ok(rows.every(r=>r.length===10 && r[0]==='可用时段'));
  assert.equal(rows[0][3], '周一 08–12（用户设置）');
  assert.equal(rows[0][7], '可排程');
  assert.equal(rows[1][7], '不可排程');
});
