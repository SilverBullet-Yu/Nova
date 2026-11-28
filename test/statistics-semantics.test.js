'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const H = require('./helpers');
const P = require('../shared/placement-model.js');
const root = path.join(__dirname, '..');
const plain = value => JSON.parse(JSON.stringify(value));

function boot() {
  const ZX = {
    api: { queueOp() {} },
    ui: { toast() {}, fold: (id, options) => options.body },
    engine: { attributeNow: () => null },
    render() {}
  };
  const storage = H.storage();
  const sandbox = {
    window: {
      ZX,
      localStorage: storage.localStorage,
      Rhythm: { seed: { seed: { tasks: [] } }, placementModel: P }
    },
    crypto: globalThis.crypto,
    document: { addEventListener() {}, createElement: () => ({}) }
  };
  const ctx = vm.createContext(sandbox);
  for (const file of ['util.js', 'state.js', 'flows/exec.js', 'views/today.js', 'views/data.js', 'home-summary.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'assets/js', file), 'utf8'), ctx);
  }
  const S = ZX.state;
  S.tasks = [];
  S.sessions = [];
  S.locks = {};
  S.dayAssign = {};
  S.buffer = { time: '', free: true };
  ZX.util.$ = () => null;
  return { ZX, S, ctx, storage };
}

function task(overrides) {
  return Object.assign({ id: 'task', title: '合成任务', s: '数学', subject: '数学', est: 60, weight: 0.5, done: false }, overrides);
}

function setTasks(S, items) {
  S.tasks = items.map(item => S.normTask(task(item)));
  return S.tasks;
}

function requiredMetricsKeys() {
  return ['total', 'done', 'taskRate', 'planned', 'plannedBasis', 'completedPlanned', 'plannedRate',
    'worked', 'remain', 'partialCount', 'skipped', 'deferred', 'abandoned', 'substituted', 'locked', 'backfill'];
}

test('统计 API 分列任务与计划工时；全完成时实际超时仍为 100% 计划完成率', () => {
  const { ZX, S } = boot();
  setTasks(S, [
    { id: 'a', est: 60, done: true, actual: 30 },
    { id: 'b', est: 60, done: true, actual: 90 }
  ]);
  const m = ZX.exec.metrics();
  for (const key of requiredMetricsKeys()) assert.ok(Object.hasOwn(m, key), '缺少字段 ' + key);
  assert.equal(m.total, 2);
  assert.equal(m.done, 2);
  assert.equal(m.taskRate, 1);
  assert.equal(m.planned, 120);
  assert.equal(m.plannedBasis, 'known');
  assert.equal(m.completedPlanned, 120);
  assert.equal(m.plannedRate, 1);
  assert.equal(m.rate, m.plannedRate);
  assert.equal(m.worked, 120);
  assert.equal(m.remain, 0);
  assert.equal(m.partialCount, 0);
});

test('部分完成按原计划折算，任务完成率不把部分项算作完成，剩余只取未完成 est', () => {
  const { ZX, S } = boot();
  setTasks(S, [
    { id: 'partial', est: 30, plannedEst: 100, partial: 50, completion: 50, actual: 70 },
    { id: 'open', est: 60, actual: 0 }
  ]);
  let m = ZX.exec.metrics();
  assert.equal(m.total, 2);
  assert.equal(m.done, 0);
  assert.equal(m.taskRate, 0);
  assert.equal(m.planned, 160);
  assert.equal(m.completedPlanned, 50);
  assert.equal(m.plannedRate, 50 / 160);
  assert.equal(m.worked, 70);
  assert.equal(m.remain, 90);
  assert.equal(m.partialCount, 1);

  S.tasks.find(t => t.id === 'open').est = -10;
  m = ZX.exec.metrics();
  assert.equal(m.remain, 30, '负 est 归零，其他未完成项的剩余预估仍保留');
});

test('旧部分任务缺原始计划时分母未知，禁止用剩余 est 与完成度反推', () => {
  const { ZX, S } = boot();
  setTasks(S, [
    { id: 'done', est: 60, done: true, actual: 20 },
    { id: 'legacy-partial', est: 30, partial: 50, completion: 50, actual: 10 }
  ]);
  const legacy = S.tasks.find(t => t.id === 'legacy-partial');
  assert.equal(Object.hasOwn(legacy, 'plannedEst'), false);
  const m = ZX.exec.metrics();
  assert.equal(m.total, 2);
  assert.equal(m.done, 1);
  assert.equal(m.taskRate, 0.5);
  assert.equal(m.planned, 60, '只汇总已知任务的原始计划');
  assert.equal(m.completedPlanned, 60);
  assert.equal(m.plannedBasis, 'unknown');
  assert.equal(m.plannedRate, null);
  assert.equal(m.rate, null);
  assert.equal(m.worked, 30);
  assert.equal(m.remain, 30);
  assert.equal(m.partialCount, 1);
  assert.equal(Object.hasOwn(legacy, 'plannedEst'), false, '旧部分任务不得补写反推分母');
});

test('跳过 / 暂缓 / 放弃 / 替代 / 锁定分列；跳过和暂缓前实际投入仍保留', () => {
  const { ZX, S } = boot();
  setTasks(S, [
    { id: 'done', est: 60, done: true, actual: 40 },
    { id: 'open', est: 30, actual: 0 },
    { id: 'skipped', est: 50, skipped: true, actual: 10 },
    { id: 'deferred', est: 50, deferred: true, actual: 20 },
    { id: 'abandoned', est: 50, abandoned: true },
    { id: 'substituted', est: 50, substituted: true, substitutedBy: 'open' }
  ]);
  S.locks = { open: true };
  const m = ZX.exec.metrics();
  assert.equal(m.total, 2);
  assert.equal(m.done, 1);
  assert.equal(m.planned, 90);
  assert.equal(m.worked, 70);
  assert.equal(m.remain, 30);
  assert.equal(m.skipped, 1);
  assert.equal(m.deferred, 1);
  assert.equal(m.abandoned, 1);
  assert.equal(m.substituted, 1);
  assert.equal(m.locked, 1);
});

test('补录单列且不混入任务 actual、完成率或剩余预估', () => {
  const { ZX, S } = boot();
  setTasks(S, [{ id: 'open', est: 60, actual: 25 }]);
  const now = Date.now();
  ZX.exec.record({ taskId: 'open', startAt: now, endAt: now, minutes: 40, completion: 100, status: 'backfill', isBackfill: true });
  ZX.exec.record({ taskId: 'open', startAt: now, endAt: now, minutes: 999, completion: 100, status: 'done', isBackfill: false });
  const m = ZX.exec.metrics();
  assert.equal(m.backfill, 40);
  assert.equal(m.worked, 25);
  assert.equal(m.done, 0);
  assert.equal(m.taskRate, 0);
  assert.equal(m.plannedRate, 0);
  assert.equal(m.remain, 60);
});

test('首次统计冻结新任务计划基准，后续改 est 不改写原计划分母', () => {
  const { ZX, S } = boot();
  const normalized = S.normTask(task({ id: 'normalized', est: 45 }));
  assert.equal(normalized.plannedEst, 45);
  S.tasks = [task({ id: 'raw', est: 60 })];
  assert.equal(Object.hasOwn(S.tasks[0], 'plannedEst'), false);
  assert.equal(ZX.exec.metrics().planned, 60);
  assert.equal(S.tasks[0].plannedEst, 60);
  S.tasks[0].est = 30;
  const m = ZX.exec.metrics();
  assert.equal(m.planned, 60);
  assert.equal(m.remain, 30);
});

test('已有 originalEst 可作为兼容分母，plannedEst 优先且不修改 state.js 的字段契约', () => {
  const { ZX, S } = boot();
  setTasks(S, [
    { id: 'original', est: 40, originalEst: 80, partial: 50, actual: 20 },
    { id: 'planned', est: 40, originalEst: 80, plannedEst: 70, actual: 0 }
  ]);
  const m = ZX.exec.metrics();
  assert.equal(S.tasks[0].plannedEst, 80);
  assert.equal(S.tasks[1].plannedEst, 70);
  assert.equal(m.planned, 150);
  assert.equal(m.completedPlanned, 40);
  assert.equal(m.plannedBasis, 'known');
});

test('v3 完成项 currentSegments 清空后仍凭 completedAt 进入今日统计', () => {
  const { ZX, S } = boot();
  const today = ZX.util.todayKey();
  const model = P.createModel({
    startDate: today,
    timezone: 'UTC',
    slots: [{ date: today, startMin: 540, durMin: 120 }],
    tasks: [{ id: 'v3', subject: '数学', est: 60 }],
    blocks: [{ id: 'block-v3', taskId: 'v3', date: today, startMin: 540, durMin: 60 }]
  });
  S.tasks = [task({ id: 'v3', est: 60 })];
  S.placementModel = model;
  assert.equal(Object.hasOwn(S.tasks[0], 'plannedEst'), false);
  ZX.exec.commitRecord('v3', 75, 100, '', 1, 2);
  assert.equal(P.taskSegments(S.placementModel, 'v3').length, 0);
  assert.equal(ZX.util.dayKey(S.tasks[0].completedAt), today);
  assert.ok(S.tasksOnDate(today).some(t => t.id === 'v3'));
  const m = ZX.exec.metrics();
  assert.equal(m.total, 1);
  assert.equal(m.done, 1);
  assert.equal(m.taskRate, 1);
  assert.equal(m.planned, 60);
  assert.equal(m.completedPlanned, 60);
  assert.equal(m.plannedRate, 1, '实际 75 分钟不得把计划完成率推成 125%');
  assert.equal(m.worked, 75);
  assert.equal(m.remain, 0);
  for (const html of [ZX.views.today(), ZX.views.data(), ZX.homeSummary.render()]) {
    assert.match(html, /100%/);
    assert.doesNotMatch(html, /125%|null%|NaN/);
  }
});

test('今日页、数据页和首页摘要消费新字段，未知分母显示未知而非 0%', () => {
  const { ZX, S } = boot();
  setTasks(S, [
    { id: 'done', est: 60, done: true, actual: 20 },
    { id: 'legacy-partial', est: 30, partial: 50, actual: 10 },
    { id: 'skipped', est: 40, skipped: true, actual: 5 },
    { id: 'deferred', est: 40, deferred: true, actual: 5 },
    { id: 'locked-open', est: 20 }
  ]);
  S.locks = { 'locked-open': true };
  const today = ZX.views.today();
  const data = ZX.views.data();
  const home = ZX.homeSummary.render();
  for (const html of [today, data, home]) {
    assert.match(html, /任务完成率/);
    assert.match(html, /计划工时完成率|计划工时完成率 ·/);
    assert.match(html, /未知/);
    assert.match(html, /实际投入/);
    assert.match(html, /剩余预估/);
    assert.doesNotMatch(html, /null%|NaN|计划工时完成率<\/span><b[^>]*>0%/);
  }
  assert.match(today, /任务完成率<\/span><b[^>]*>33%/);
  assert.match(today, /计划工时完成率<\/span><b[^>]*>未知/);
  assert.match(today, /实际投入<\/span><b>40m/);
  assert.match(today, /剩余预估<\/span><b>50m/);
  assert.match(today, /部分完成 1 项/);
  assert.match(today, /跳过 1 项、暂缓 1 项/);
  assert.match(today, /锁定 1 项/);
});

test('今日页首屏仅展示核心统计，时间带与次要统计默认收起', () => {
  const { ZX, S } = boot();
  setTasks(S, [{ id: 'a', est: 60, plannedEst: 60 }]);
  const html = ZX.views.today();
  assert.match(html, /<details class="vs-more">/);
  assert.match(html, /<details class="sc-disclosure sc-timeline">/);
  assert.doesNotMatch(html, /<details[^>]+open/);
  assert.match(html, /任务完成率/);
  assert.match(html, /实际投入/);
  assert.match(html, /剩余预估/);
});

test('计划页首屏保留可行性与日程，节律和计算公式默认收起', () => {
  const { ZX, S, ctx } = boot();
  S.goal = { name: '合成目标', target: '100', deadline: '2027-12-25', weeks: 8 };
  S.feas = { weeklyH: 10, weeks: 8, discount: 0.85, demand: 60 };
  ZX.engine.feasibilityNow = require('../shared/engine/feasibility.js').feasibility;
  ZX.flows.planedit = { board: () => '<div class="sc2-board">日程</div>', movedCount: () => 0, lockedCount: () => 0, weekDeltas: () => ({}) };
  vm.runInContext(fs.readFileSync(path.join(root, 'assets/js/views/plan.js'), 'utf8'), ctx);
  const html = ZX.views.plan();
  assert.match(html, /<details class="sc-disclosure sc-feas-details">/);
  assert.match(html, /<details class="sc-disclosure sc-plan-details">/);
  assert.doesNotMatch(html, /<details[^>]+open/);
  assert.ok(html.indexOf('可行性 R') < html.indexOf('学期节律'));
});

test('空今日只有已知零计划时显示横线，不伪造计划完成率', () => {
  const { ZX, S } = boot();
  setTasks(S, []);
  const m = ZX.exec.metrics();
  assert.equal(m.total, 0);
  assert.equal(m.taskRate, 0);
  assert.equal(m.planned, 0);
  assert.equal(m.plannedBasis, 'known');
  assert.equal(m.plannedRate, null);
  assert.equal(m.rate, null);
  assert.match(ZX.views.today(), /计划工时完成率<\/span><b[^>]*>—/);

  const messages = [];
  ZX.assistant = { say: html => messages.push(html) };
  setTasks(S, [{ id: 'zero', est: 0, plannedEst: 0 }]);
  ZX.exec.commitRecord('zero', 0, 100, '', 1, 2);
  assert.equal(ZX.exec.metrics().plannedBasis, 'known');
  assert.match(messages.at(-1), /计划工时完成率 <b class="ac">—<\/b>/);
});
