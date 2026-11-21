'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const H = require('./helpers');
const src = fs.readFileSync(require.resolve('../assets/js/flows/goal.js'), 'utf8');
/* 沙箱公共装配：真实 util.js（trace 随机 id / 日期口径与生产同源）+ 固定星期三 */
function goalSandbox(ZX, disk) {
  const sandbox = { window: { ZX, localStorage: { getItem: k => disk.get(k), setItem: (k, v) => disk.set(k, v) } }, document: { addEventListener() {} } };
  H.installUtil(sandbox);
  ZX.util.todayDow = () => '三';
  return sandbox;
}
test('排程失败时保留旧目标和待提交草案', async () => {
  const draft = { name: 'new', weeks: 5, weeklyH: 10, demand: 10 };
  const state = { goalDraft: draft, planDraft: [{id:'a', est:30}], goal: {name:'old'}, feas:{}, resetTimer() {} };
  const ZX = { state, render() {}, setTab() {}, ui:{toast(){}}, assistant:{say(){}}, engine:{feasibilityNow:()=>({R:1}),schedule:async()=>{throw new Error('offline');}} };
  const disk = new Map();
  state.currentPlanVersion = () => 'baseline';
  vm.runInNewContext(src, goalSandbox(ZX, disk));
  ZX.flows.goal.apply();
  assert.equal(disk.size, 0);
  await Promise.resolve();
  assert.equal(state.goal.name, 'old');
  assert.equal(state.goalDraft, draft);
  const [event] = JSON.parse(disk.get('zx.scheduleTrace') || '[]');
  assert.deepEqual(event && Object.keys(event).sort(), ['at','id','planVersion','rulesVersion','status','tool']);
  assert.equal(event.status, 'failed');
  assert.equal(event.planVersion, 'baseline');
  assert.match(event.id, /^schedule-/);
});

test('确认后编辑草案，迟到排程只写失效追踪，不应用计划', async () => {
  const { schedule } = require('../shared/engine/schedule.js');
  const disk = new Map();
  let release;
  let renders = 0;
  const oldGoal = {name:'old'};
  const state = { goalDraft: {name:'synthetic', weeks:5, weeklyH:10, demand:10},
    planDraft: [{id:'a', s:'数学', title:'synthetic task', est:30, weight:1}],
    goal:oldGoal, currentPlanVersion:()=> 'baseline' };
  const ZX = {state, render(){renders++;}, ui:{toast(){}},
    engine:{feasibilityNow:()=>({R:1}), schedule:input=>new Promise(resolve=>{
      release = () => resolve(schedule(input));
    })} };
  vm.runInNewContext(src, goalSandbox(ZX, disk));
  ZX.flows.goal.apply();
  assert.equal(disk.size, 0);
  state.planDraft[0].title = 'edited synthetic task';
  release();
  await Promise.resolve();
  assert.equal(state.goal, oldGoal);
  assert.equal(state.planDraft[0].title, 'edited synthetic task');
  assert.equal(renders, 0);
  const raw = disk.get('zx.scheduleTrace');
  assert.deepEqual(JSON.parse(raw).map(e=>[e.status,e.planVersion]), [['stale','baseline']]);
  assert.doesNotMatch(raw, /synthetic/);
});

test('连续确认后，迟到的旧排程结果不能覆盖已提交的新计划', async () => {
  const { schedule } = require('../shared/engine/schedule.js');
  const pending = [];
  let resultHtml;
  let renders = 0;
  const state = { goalDraft: { name: 'first', weeks: 5, weeklyH: 10, demand: 10 }, planDraft: [{id:'a', s:'数学', title:'第一份', est:30, weight:1}], goal:{name:'old'}, feas:{}, resetTimer(){}, normTask:t=>t };
  const ZX = { state, render(){renders++;}, setTab(){}, ui:{toast(){}}, assistant:{say(html){resultHtml = html;}}, engine:{feasibilityNow:()=>({R:1}), schedule: input => new Promise(resolve => pending.push(() => resolve(schedule(input))))} };
  const disk = new Map();
  state.currentPlanVersion = () => state.goal.name === 'old' ? 'baseline' : 'applied-version';
  vm.runInNewContext(src, goalSandbox(ZX, disk));
  ZX.flows.goal.apply();
  state.goalDraft.name = 'second';
  state.planDraft[0].title = '第二份';
  ZX.flows.goal.apply();
  assert.equal(state.goal.name, 'old');
  assert.equal(renders, 0);
  vm.runInNewContext(fs.readFileSync(require.resolve('../assets/js/flows/settings.js'), 'utf8'), { window: { ZX } });
  assert.doesNotMatch(ZX.settings.csv(), /阶段目标/);
  assert.equal(pending.length, 2);
  pending[1]();
  await Promise.resolve();
  assert.equal(state.goal.name, 'second');
  assert.equal(state.tasks[0].title, '第二份');
  assert.equal(state.goalDraft, null);
  assert.equal(renders, 1);
  pending[0]();
  await Promise.resolve();
  assert.equal(state.goal.name, 'second');
  assert.equal(state.tasks[0].title, '第二份');
  assert.equal(renders, 1);
  const events = JSON.parse(disk.get('zx.scheduleTrace'));
  assert.deepEqual(events.map(e => [e.status, e.planVersion]), [['committed', 'applied-version']]);
  assert.doesNotMatch(JSON.stringify(events), /first|second|第二份/);
  assert.equal(state.goal.source, 'user');
  assert.match(resultHtml, /任务草案.*确定性引擎/);
  assert.match(resultHtml, /7 天.*28 小时.*弹性位兜底/);
  assert.match(ZX.settings.csv(), /阶段目标,,,second,,,,用户设置/);
  assert.doesNotMatch(ZX.settings.csv(), /阶段目标,,,first/);
});
