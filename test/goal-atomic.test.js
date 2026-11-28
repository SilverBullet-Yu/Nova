'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const H = require('./helpers');
const P = require('../shared/placement-model.js');
const seed = require('../shared/data/seed.js');
const src = fs.readFileSync(require.resolve('../assets/js/flows/goal.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const NOW = new Date(2026, 10, 18, 12).getTime();
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return NOW; }
}
/* 沙箱公共装配：真实 util.js（trace 随机 id / 日期口径与生产同源）+ 固定星期三 */
function goalSandbox(ZX, disk) {
  const sandbox = { window: { ZX, Rhythm: { placementModel: P }, localStorage: { getItem: k => disk.get(k), setItem: (k, v) => disk.set(k, v) } }, document: { addEventListener() {} } };
  H.installUtil(sandbox);
  ZX.util.todayDow = () => '三';
  return sandbox;
}

function historyApp(disk = new Map()) {
  const toasts = [];
  const ZX = {
    api: { queueOp() {} },
    ui: { toast: message => toasts.push(message), fold: (_, options) => options.body },
    render() {}, setTab() {}, assistant: { say() {} },
    engine: {
      feasibilityNow: require('../shared/engine/feasibility.js').feasibility,
      schedule: require('../shared/engine/schedule.js').schedule
    }
  };
  const localStorage = H.storage(disk).localStorage;
  const ctx = vm.createContext({
    window: { ZX, Rhythm: { seed, placementModel: P }, localStorage },
    document: { addEventListener() {}, createElement: () => ({}) },
    Date: FixedDate, crypto: globalThis.crypto
  });
  for (const file of ['assets/js/util.js', 'assets/js/state.js', 'assets/js/flows/settings.js',
    'assets/js/flows/exec.js', 'assets/js/flows/goal.js', 'assets/js/views/data.js']) {
    vm.runInContext(fs.readFileSync(require.resolve('../' + file), 'utf8'), ctx, { filename: file });
  }
  ZX.util.$ = () => null;
  return { ZX, ctx, disk, toasts };
}
test('排程失败时保留旧目标和待提交草案', async () => {
  const draft = { name: 'new', deadline: '2027-12-25', weeks: 5, weeklyH: 10, demand: 10 };
  const state = { goalDraft: draft, planDraft: [{id:'a', est:30}], goal: {name:'old'}, feas:{}, resetTimer() {} };
  const ZX = { state, render() {}, setTab() {}, ui:{toast(){}}, assistant:{say(){}}, engine:{feasibilityNow:()=>({R:1}),schedule:async()=>{throw new Error('offline');}} };
  const disk = new Map();
  state.currentPlanVersion = () => 'baseline';
  vm.runInNewContext(src, goalSandbox(ZX, disk));
  await ZX.flows.goal.apply();
  assert.equal(disk.has('zx.overlay'), false);
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
  const state = { goalDraft: {name:'synthetic', deadline:'2027-12-25', weeks:5, weeklyH:10, demand:10},
    planDraft: [{id:'a', s:'数学', title:'synthetic task', est:30, weight:1}],
    goal:oldGoal, currentPlanVersion:()=> 'baseline' };
  const ZX = {state, render(){renders++;}, ui:{toast(){}},
    engine:{feasibilityNow:()=>({R:1}), schedule:input=>new Promise(resolve=>{
      release = () => resolve(schedule(input));
    })} };
  vm.runInNewContext(src, goalSandbox(ZX, disk));
  const submission = ZX.flows.goal.apply();
  assert.equal(disk.size, 0);
  state.planDraft[0].title = 'edited synthetic task';
  release();
  await submission;
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
  const state = { goalDraft: { name: 'first', deadline: '2027-12-25', weeks: 5, weeklyH: 10, demand: 10 }, planDraft: [{id:'a', s:'数学', title:'第一份', est:30, weight:1}], goal:{name:'old'}, feas:{}, resetTimer(){}, normTask:t=>t };
  const ZX = { state, render(){renders++;}, setTab(){}, ui:{toast(){}}, assistant:{say(html){resultHtml = html;}}, engine:{feasibilityNow:()=>({R:1}), schedule: input => new Promise(resolve => pending.push(() => resolve(schedule(input))))} };
  const disk = new Map();
  state.currentPlanVersion = () => state.goal.name === 'old' ? 'baseline' : 'applied-version';
  vm.runInNewContext(src, goalSandbox(ZX, disk));
  const firstSubmission = ZX.flows.goal.apply();
  state.goalDraft.name = 'second';
  state.planDraft[0].title = '第二份';
  const secondSubmission = ZX.flows.goal.apply();
  assert.equal(state.goal.name, 'old');
  assert.equal(renders, 0);
  vm.runInNewContext(fs.readFileSync(require.resolve('../assets/js/flows/settings.js'), 'utf8'), { window: { ZX } });
  assert.doesNotMatch(ZX.settings.csv(), /阶段目标/);
  assert.equal(pending.length, 2);
  pending[1]();
  await secondSubmission;
  assert.equal(state.goal.name, 'second');
  assert.equal(state.tasks[0].title, '第二份');
  assert.equal(state.goalDraft, null);
  assert.equal(renders, 1);
  pending[0]();
  await firstSubmission;
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

test('新建目标保留历史会话及其任务引用，刷新后仍可通过 overlay 与备份校验并统计', async () => {
  const { ZX, toasts, disk } = historyApp();
  const S = ZX.state;
  const oldTask = S.tasks[0];
  oldTask.id = 'd_1';
  oldTask.title = '历史目标的任务';
  oldTask.s = oldTask.subject = '数学';
  const oldSession = {
    id: 's-history', taskId: oldTask.id, planVersion: S.currentPlanVersion(),
    startAt: NOW - 30 * 60000, endAt: NOW, minutes: 37,
    completion: 100, status: 'done', feel: null, isBackfill: false
  };
  S.sessions = [oldSession];
  S.dayAssign = {};
  S.locks = {};
  assert.equal(S.saveOverlay(), true);

  S.goalDraft = { name: '新目标', deadline: '2027-12-25', weeks: 5, weeklyH: 10, demand: 10 };
  S.planDraft = [{ id: 'd_1', s: '数学', title: '新目标的任务', est: 30, weight: 1 }];
  S.avail = Array.from({ length: 7 }, () => [false, false, false, false]);
  S.avail[2][0] = true;
  S.availSource = 'user';

  assert.equal(await ZX.flows.goal.apply(), true, toasts.join('；'));
  assert.deepEqual(plain(S.sessions), [oldSession]);
  const archived = S.tasks.find(task => task.id === oldSession.taskId);
  assert.ok(archived, '历史会话引用的旧任务必须保留');
  assert.equal(archived.title, oldTask.title);
  assert.equal(archived.abandoned, true, '旧任务只作为历史记录退役，不进入新计划');
  const current = S.tasks.find(task => task.id !== oldSession.taskId);
  assert.ok(current, '新计划任务必须存在');
  assert.notEqual(current.id, oldSession.taskId, '新任务不得与历史任务 ID 冲突');
  assert.equal(current.title, '新目标的任务');
  assert.ok(!P.taskSegments(S.placementModel, archived.id).length);
  assert.ok(!S.placementModel.unplanned.some(item => item.taskId === archived.id));
  assert.doesNotThrow(() => ZX.settings.exportBackup());

  const { ZX: reloaded } = historyApp(disk);
  assert.equal(reloaded.state.localLoadFailed, false, JSON.stringify(reloaded.state.localLoadError));
  assert.deepEqual(plain(reloaded.state.sessions), [oldSession]);
  assert.equal(reloaded.state.tasks.find(task => task.id === oldSession.taskId).title, oldTask.title);
  assert.doesNotThrow(() => reloaded.settings.exportBackup());
  const report = reloaded.views.data();
  assert.match(report, /有效学习[\s\S]*?0.6/);
  assert.match(report, /<span class="n">数学<\/span><span class="t">/, '历史会话仍按原任务科目统计');
});

test('目标提交预检发现悬空会话时整笔回滚，不覆盖旧 overlay 或计时状态', async () => {
  const { ZX, toasts, disk } = historyApp();
  const S = ZX.state;
  const brokenSession = { id: 's-broken', taskId: 'missing-task', minutes: 10, status: 'done' };
  S.sessions = [brokenSession];
  S.goal = { name: '旧目标', deadline: '2027-01-01', weeks: 10, source: 'user' };
  S.running = S.tasks[0].id;
  S.timerStart = NOW - 1000;
  S.pausedAt = NOW - 500;
  S.pausedTotal = 100;
  assert.equal(S.saveOverlay(), true);
  const beforeRaw = disk.get('zx.overlay');
  const beforeTasks = plain(S.tasks);
  const beforeGoal = plain(S.goal);
  const draft = { name: '新目标', deadline: '2027-12-25', weeks: 5, weeklyH: 10, demand: 10 };
  S.goalDraft = draft;
  S.planDraft = [{ id: 'd_new', s: '数学', title: '新任务', est: 30, weight: 1 }];
  S.avail = Array.from({ length: 7 }, () => [false, false, false, false]);
  S.avail[2][0] = true;
  S.availSource = 'user';

  assert.equal(await ZX.flows.goal.apply(), false);
  assert.equal(disk.get('zx.overlay'), beforeRaw);
  assert.deepEqual(plain(S.tasks), beforeTasks);
  assert.deepEqual(plain(S.goal), beforeGoal);
  assert.deepEqual(plain(S.sessions), [brokenSession]);
  assert.deepEqual(plain(S.goalDraft), draft);
  assert.equal(S.running, beforeTasks[0].id);
  assert.equal(S.timerStart, NOW - 1000);
  assert.equal(S.pausedAt, NOW - 500);
  assert.equal(S.pausedTotal, 100);
  assert.ok(toasts.some(message => /未通过校验/.test(message)));
});
