'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const H = require('./helpers');
const P = require('../shared/placement-model.js');
const seed = require('../shared/data/seed.js');

const NOW = new Date(2026, 10, 23, 12, 0, 0).getTime();
const DATES = Array.from({ length: 7 }, (_, i) => '2026-11-' + String(23 + i).padStart(2, '0'));
const plain = value => JSON.parse(JSON.stringify(value));

class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return NOW; }
}

function daysAgo(days) {
  const date = new FixedDate(NOW);
  date.setDate(date.getDate() - days);
  return date.getTime();
}

function task(id, est, weight, extra = {}) {
  return {
    id, subject: '数学', s: '数学', title: '任务-' + id, est, weight,
    time: extra.time || '23:00–23:30', date: extra.date || '1999-01-01', ...extra
  };
}

function block(id, taskId, date, startMin, durMin, isBuffer = false) {
  return { id, taskId, date, startMin, durMin, isBuffer };
}

function makeModel(tasks, blocks, unplanned = []) {
  const slots = [];
  DATES.forEach(date => {
    slots.push({ date, startMin: 480, durMin: 300, isBuffer: false });
    slots.push({ date, startMin: 780, durMin: 60, isBuffer: true });
  });
  return P.createModel({
    startDate: DATES[0], timezone: 'UTC', idPrefix: 'fixture_', slots,
    tasks: tasks.map(item => ({ id: item.id, subject: item.subject || item.s, estMin: item.est })),
    blocks, unplanned
  });
}

function boot(options = {}) {
  const ops = [], toasts = [], messages = [], sheets = [];
  let renders = 0;
  const ZX = {
    api: { queueOp: op => ops.push(op), pendingCount: () => 0 },
    ui: {
      toast: (message, type) => toasts.push({ message, type }),
      footNav: options => '<button data-sb="' + options.act + '">' + options.label + '</button>',
      flowSheet(config) {
        let click;
        const entry = { config, step: 1 };
        const controller = {
          root: {
            addEventListener: (type, handler) => { if (type === 'click') click = handler; },
            querySelectorAll: () => []
          },
          close: reason => { if (reason) config.onClose(); }
        };
        const flow = {
          step: () => entry.step,
          go: step => { entry.step = step; },
          render() {},
          open() { config.bind(controller); return controller; }
        };
        entry.act = (action, value) => click({ target: { closest: () => ({ dataset: { sb: action, v: value } }) } });
        entry.body = () => config.steps[entry.step](entry.step).body;
        sheets.push(entry);
        return flow;
      }
    }
  };
  const localStorage = H.storage().localStorage;
  const sandbox = {
    window: { ZX, localStorage, Rhythm: { seed, placementModel: options.placementApi || P } },
    localStorage,
    Date: FixedDate,
    crypto: globalThis.crypto,
    document: { addEventListener() {}, createElement: () => ({}) }
  };
  const ctx = vm.createContext(sandbox);
  H.installUtil(sandbox);
  for (const path of ['state.js', 'assistant.js']) {
    vm.runInContext(fs.readFileSync(require.resolve('../assets/js/' + path), 'utf8'), ctx);
  }

  const S = ZX.state;
  const tasks = options.tasks || [];
  S.tasks = tasks.map(item => S.normTask(item));
  S.placementModel = options.v3 === false ? null : options.model;
  S.locks = options.locks || {};
  S.goal = { name: '合成目标', source: 'user', target: '100 分', deadline: '2027-12-25', weeks: 5 };
  S.feas = { weeklyH: 10, weeks: 5, demand: 500 };
  S.sessions = options.sessions || [{ endAt: daysAgo(4) }];
  S.consecutiveZeroDays = 0;
  S.interrupted = null;
  S.rescueRecord = null;
  S.tab = 'today';
  S.week = options.week || [{ d: '旧', total: 9999, buf: 60, segs: [] }];
  S.weekShift = plain(S.week);
  S.dayAssign = { stale: '五' };
  S.buffer = { time: '旧时段', free: false, keep: '保留字段' };
  const chat = { children: [], appendChild: element => messages.push(element.innerHTML), scrollTop: 0 };
  ZX.util.$ = selector => selector === '#chat' ? chat : null;
  ZX.assistant.say = html => messages.push(html);
  ZX.render = () => { renders++; };
  ZX.setTab = tab => { S.tab = tab; };
  vm.runInContext(fs.readFileSync(require.resolve('../assets/js/flows/rescue.js'), 'utf8'), ctx);
  return { ZX, S, ctx, ops, toasts, messages, sheets, renders: () => renders };
}

function businessSnapshot(S) {
  return plain({
    tasks: S.tasks, placementModel: S.placementModel, goal: S.goal, feas: S.feas,
    week: S.week, weekShift: S.weekShift, dayAssign: S.dayAssign, buffer: S.buffer,
    locks: S.locks, sessions: S.sessions, consecutiveZeroDays: S.consecutiveZeroDays,
    interrupted: S.interrupted, rescueRecord: S.rescueRecord, tab: S.tab
  });
}

function confirm(fixture, strategy) {
  const rescue = fixture.ZX.flows.rescue;
  rescue.open();
  const sheet = fixture.sheets[0];
  sheet.act('pick', strategy);
  sheet.act('next');
  return sheet;
}

function segmentMinutes(model, taskId) {
  return P.taskSegments(model, taskId).reduce((sum, segment) => sum + segment.durMin, 0);
}

test('v3 挽救缺口不再从剩余模型工时重复扣除历史已投入', () => {
  const tasks = [task('done', 60, 1, { done: true, actual: 60 }), task('rest', 60, 0.5)];
  const model = makeModel(tasks, [block('rest-old', 'rest', DATES[0], 480, 60)]);
  const { ZX, S } = boot({ tasks, model });
  S.feas.weeklyH = 0;
  const metrics = ZX.flows.rescue.metrics();
  assert.equal(metrics.planned, 60);
  assert.equal(metrics.worked, 60);
  assert.equal(metrics.avail, 0);
  assert.equal(metrics.gap, 60);
});

test('v3 挽救把未排入 backlog 纳入缺口，压缩未排入任务不要求旧落点', () => {
  const tasks = [task('drop', 60, 0.1), task('backlog', 60, 0.9)];
  const model = makeModel(tasks, [], [
    { taskId: 'drop', reason: '未排入' },
    { taskId: 'backlog', reason: '未排入' }
  ]);
  const f = boot({ tasks, model });
  f.S.feas.weeklyH = 0;
  const metrics = f.ZX.flows.rescue.metrics();
  assert.equal(metrics.planned, 0);
  assert.equal(metrics.workload, 120);
  assert.equal(metrics.gap, 120);
  const sheet = confirm(f, 'compress');
  sheet.act('apply');
  assert.equal(f.S.tasks.find(item => item.id === 'drop').abandoned, true);
  assert.equal(f.S.tasks.find(item => item.id === 'backlog').est, 36);
  assert.equal(f.S.tasks.find(item => item.id === 'backlog').unplanned, true);
  assert.ok(f.S.placementModel.unplanned.some(item => item.taskId === 'backlog'));
});

test('v3 压缩和降级只使用剩余计划，legacy 仍保留 worked 原口径', () => {
  const tasks = [
    task('done', 60, 1, { done: true, actual: 60 }),
    task('low', 60, 0.1),
    task('keep', 60, 0.9)
  ];
  const model = makeModel(tasks, [
    block('low-old', 'low', DATES[0], 480, 60),
    block('keep-old', 'keep', DATES[0], 540, 60)
  ]);
  const v3 = boot({ tasks, model, week: [{ total: 180 }] });
  v3.S.feas.weeklyH = 0;
  assert.equal(v3.ZX.flows.rescue.optionOf('compress').planMin, 36);
  assert.equal(v3.ZX.flows.rescue.optionOf('compress').gap, 36);
  assert.equal(v3.ZX.flows.rescue.optionOf('downgrade').planMin, 60);
  assert.equal(v3.ZX.flows.rescue.optionOf('downgrade').gap, 60);

  const legacy = boot({ v3: false, tasks, week: [{ total: 180 }] });
  legacy.S.feas.weeklyH = 0;
  assert.equal(legacy.ZX.flows.rescue.optionOf('compress').planMin, 96);
  assert.equal(legacy.ZX.flows.rescue.optionOf('compress').gap, 36);
  assert.equal(legacy.ZX.flows.rescue.optionOf('downgrade').planMin, 120);
  assert.equal(legacy.ZX.flows.rescue.optionOf('downgrade').gap, 60);
});

test('v3 周计划读取模型用量，压缩同步 segment 分钟、任务时间日期与全部投影', () => {
  const tasks = [
    task('drop', 100, 0.1), task('keep', 100, 0.8, { time: '10:00–11:40' }), task('locked', 40, 0.9)
  ];
  const model = makeModel(tasks, [
    block('drop-old', 'drop', DATES[0], 480, 100),
    block('keep-old', 'keep', DATES[0], 580, 100),
    block('locked-old', 'locked', DATES[0], 680, 40)
  ]);
  const f = boot({ tasks, model, locks: { locked: true } });
  const oldModel = f.S.placementModel;
  const beforeModel = plain(oldModel);
  const originals = plain(oldModel.placements.map(item => item.originalSegments));

  assert.equal(f.ZX.flows.rescue.metrics().planned, 240);
  assert.equal(f.S.week[0].total, 9999);
  const sheet = confirm(f, 'compress');
  assert.match(sheet.body(), /100 → 60/);
  sheet.act('apply');

  assert.equal(segmentMinutes(f.S.placementModel, 'keep'), 60);
  assert.deepEqual(plain(P.taskSegments(f.S.placementModel, 'keep').map(item => [item.date, item.startMin, item.durMin])), [[DATES[0], 480, 60]]);
  assert.equal(P.summary(f.S.placementModel).totals.usedMin, 100);
  assert.equal(f.S.tasks.length, 3);
  assert.deepEqual(plain(f.S.tasks.map(item => [item.id, item.est, item.abandoned, item.degraded])), [
    ['drop', 100, true, null], ['keep', 60, null, true], ['locked', 40, null, null]
  ]);
  assert.deepEqual(plain(P.taskSegments(f.S.placementModel, 'drop')), []);
  assert.equal(f.S.tasks[0].time, '');
  assert.equal(f.S.tasks[0].date, null);
  assert.equal(f.S.tasks[0].unplanned, true);
  assert.equal(f.S.tasks[1].time, '08:00–09:00');
  assert.equal(f.S.tasks[1].date, DATES[0]);
  assert.equal(f.S.tasks[2].time, '11:20–12:00');
  assert.equal(f.S.tasks[2].date, DATES[0]);
  assert.ok(f.S.placementModel.placements.every(item => f.S.tasks.some(task => task.id === item.taskId)));
  assert.deepEqual(plain(f.S.placementModel.placements.map(item => item.originalSegments)), originals);
  assert.deepEqual(plain(oldModel), beforeModel);
  assert.notDeepEqual(plain(f.S.placementModel), beforeModel);
  assert.deepEqual(plain(f.S.week), plain(P.projectWeek(f.S.placementModel, f.S.tasks)));
  assert.deepEqual(plain(f.S.weekShift), plain(f.S.week));
  assert.equal(f.S.week.reduce((sum, day) => sum + day.total, 0), 100);
  assert.deepEqual(plain(f.S.dayAssign), { keep: '一', locked: '一' });
  assert.deepEqual(plain(f.S.buffer), { time: '13:00–14:00', free: true, keep: '保留字段' });
  assert.deepEqual(plain(f.S.rescueRecord.dropped.map(item => item.id)), ['drop']);
  assert.equal(f.ops.length, 1);
  assert.deepEqual(plain(f.ops[0].value.dropped.map(item => item.id)), ['drop']);
  assert.equal(f.S.consecutiveZeroDays, 0);
  assert.equal(f.S.interrupted, false);
});

test('v3 降级保留放弃任务、释放模型落点并同步记录与队列', () => {
  const tasks = [task('low', 60, 0.1), task('mid', 60, 0.3), task('keep', 60, 0.9)];
  const model = makeModel(tasks, [
    block('low-old', 'low', DATES[0], 480, 60),
    block('mid-old', 'mid', DATES[0], 540, 60),
    block('keep-old', 'keep', DATES[0], 600, 60)
  ]);
  const f = boot({ tasks, model });
  const originals = plain(f.S.placementModel.placements.map(item => item.originalSegments));
  const sheet = confirm(f, 'downgrade');
  sheet.act('apply');

  assert.equal(f.S.tasks.length, 3);
  assert.deepEqual(plain(f.S.tasks.map(item => [item.id, item.abandoned])), [['low', true], ['mid', true], ['keep', null]]);
  assert.deepEqual(plain(P.taskSegments(f.S.placementModel, 'low')), []);
  assert.deepEqual(plain(P.taskSegments(f.S.placementModel, 'mid')), []);
  assert.equal(segmentMinutes(f.S.placementModel, 'keep'), 60);
  assert.equal(P.summary(f.S.placementModel).totals.usedMin, 60);
  assert.ok(f.S.placementModel.placements.every(item => f.S.tasks.some(task => task.id === item.taskId)));
  assert.deepEqual(plain(f.S.placementModel.placements.map(item => item.originalSegments)), originals);
  assert.equal(f.S.tasks[2].est, 60);
  assert.equal(f.S.tasks[2].time, '10:00–11:00');
  assert.equal(f.S.tasks[2].date, DATES[0]);
  assert.equal(f.S.goal.target, '70 分');
  assert.deepEqual(plain(f.S.week), plain(P.projectWeek(f.S.placementModel, f.S.tasks)));
  assert.deepEqual(plain(f.S.dayAssign), { keep: '一' });
  assert.deepEqual(plain(f.S.rescueRecord.dropped.map(item => item.id)), ['low', 'mid']);
  assert.deepEqual(plain(f.ops[0].value.dropped.map(item => item.id)), ['low', 'mid']);
});

test('v3 顺延只改周期与截止日期，不替换模型或改写任务落点', () => {
  const tasks = [task('keep', 30, 0.9)];
  const model = makeModel(tasks, [block('keep-old', 'keep', DATES[0], 480, 30)]);
  const f = boot({ tasks, model });
  const oldModel = f.S.placementModel;
  const oldTasks = f.S.tasks;
  const oldSegments = plain(P.taskSegments(oldModel, 'keep'));
  const sheet = confirm(f, 'defer');
  sheet.act('apply');

  assert.strictEqual(f.S.placementModel, oldModel);
  assert.strictEqual(f.S.tasks, oldTasks);
  assert.equal(f.S.tasks[0].time, '23:00–23:30');
  assert.equal(f.S.tasks[0].date, '1999-01-01');
  assert.deepEqual(plain(P.taskSegments(f.S.placementModel, 'keep')), oldSegments);
  assert.equal(f.S.goal.deadline, '2028-01-01');
  assert.equal(f.S.goal.weeks, 6);
  assert.equal(f.S.feas.weeks, 6);
  assert.deepEqual(plain(f.S.week), plain(P.projectWeek(f.S.placementModel, f.S.tasks)));
  assert.deepEqual(plain(f.S.dayAssign), { keep: '一' });
  assert.deepEqual(plain(f.S.rescueRecord.dropped), []);
});

test('预览后手工改期仅改变 placementModel 也使旧挽救确认失效', () => {
  const tasks = [task('drop', 60, 0.1), task('keep', 60, 0.9)];
  const model = makeModel(tasks, [
    block('drop-old', 'drop', DATES[0], 480, 60),
    block('keep-old', 'keep', DATES[0], 540, 60)
  ]);
  const f = boot({ tasks, model });
  const sheet = confirm(f, 'compress');
  f.S.placementModel = P.moveTask(f.S.placementModel, 'keep', DATES[1]).model;
  const before = businessSnapshot(f.S);
  sheet.act('apply');

  assert.deepEqual(businessSnapshot(f.S), before);
  assert.equal(f.ops.length, 0);
  assert.equal(sheet.step, 1);
  assert.match(f.toasts.at(-1).message, /计划已变化.*重新预览/);
});

test('v3 压缩落点容量不足时整笔拒绝且可重试，不写模型、任务、投影或队列', () => {
  const resizeCalls = [];
  const failingP = Object.assign({}, P, {
    resizeTask(model, id, minutes, prefix) {
      resizeCalls.push({ id, minutes, prefix });
      return { ok: false, reason: '目标日期普通窗口与弹性窗口均不足，或与现有落点冲突' };
    }
  });
  const tasks = [task('drop', 100, 0.1), task('keep', 100, 0.8), task('locked', 40, 0.9)];
  const model = makeModel(tasks, [
    block('drop-old', 'drop', DATES[0], 480, 100),
    block('keep-old', 'keep', DATES[0], 580, 100),
    block('locked-old', 'locked', DATES[0], 680, 40)
  ]);
  const f = boot({ tasks, model, locks: { locked: true }, placementApi: failingP });
  const sheet = confirm(f, 'compress');
  const before = businessSnapshot(f.S);
  const nativeSync = f.S.syncPlacementProjection;
  let syncCalls = 0;
  f.S.syncPlacementProjection = function () { syncCalls++; return nativeSync.call(this); };
  sheet.act('apply');

  assert.deepEqual(businessSnapshot(f.S), before);
  assert.deepEqual(resizeCalls.map(item => [item.id, item.minutes]), [['keep', 60]]);
  assert.equal(syncCalls, 0);
  assert.equal(f.ops.length, 0);
  assert.match(f.toasts.at(-1).message, /不足/);
  assert.match(f.toasts.at(-1).message, /当前计划未变更/);
  assert.equal(f.toasts.at(-1).type, 'warn');

  f.ctx.window.Rhythm.placementModel = P;
  sheet.act('apply');
  assert.equal(syncCalls, 1);
  assert.equal(f.ops.length, 1);
  assert.equal(segmentMinutes(f.S.placementModel, 'keep'), 60);
});

test('legacy 压缩保持物理删除与 retime，周计划仍读取 week.total', () => {
  const tasks = [task('drop', 100, 0.1), task('keep', 100, 0.9, { time: '10:00–11:40' })];
  const f = boot({ v3: false, tasks, week: [{ total: 240 }, { total: 60 }] });
  assert.equal(f.ZX.flows.rescue.metrics().planned, 300);
  const weekBefore = plain(f.S.week);
  const sheet = confirm(f, 'compress');
  sheet.act('apply');

  assert.deepEqual(plain(f.S.tasks.map(item => [item.id, item.est, item.time])), [['keep', 60, '10:00–11:00']]);
  assert.deepEqual(plain(f.S.week), weekBefore);
  assert.equal(f.S.placementModel, null);
  assert.deepEqual(plain(f.S.rescueRecord.dropped.map(item => item.id)), ['drop']);
});

test('legacy 降级保持物理删除与目标下调', () => {
  const tasks = [task('low', 60, 0.1), task('mid', 60, 0.3), task('keep', 60, 0.9)];
  const f = boot({ v3: false, tasks, week: [{ total: 180 }] });
  const sheet = confirm(f, 'downgrade');
  sheet.act('apply');

  assert.deepEqual(plain(f.S.tasks.map(item => item.id)), ['keep']);
  assert.equal(f.S.goal.target, '70 分');
  assert.equal(f.S.placementModel, null);
  assert.deepEqual(plain(f.S.rescueRecord.dropped.map(item => item.id)), ['low', 'mid']);
});

test('真实挽救仍无参 detect，独立演示不调用真实入口且不写 v3 业务状态', () => {
  const tasks = [task('keep', 60, 0.9)];
  const model = makeModel(tasks, [block('keep-old', 'keep', DATES[0], 480, 60)]);
  const real = boot({ tasks, model, sessions: [{ endAt: daysAgo(3) }] });
  const detect = real.ZX.flows.rescue.detect;
  const detectCalls = [];
  real.ZX.flows.rescue.detect = function (...args) { detectCalls.push(args); return detect.apply(this, args); };
  const beforeReal = businessSnapshot(real.S);
  real.ZX.assistant.rescueFlow();
  assert.deepEqual(detectCalls, [[]]);
  assert.equal(real.sheets.length, 1);
  assert.equal(real.S.consecutiveZeroDays, 3);
  assert.match(real.messages.at(-1), /连续 3 天没有记录/);
  assert.doesNotMatch(real.messages.at(-1), /演示数据/);
  assert.deepEqual(businessSnapshot(real.S), beforeReal);

  const demo = boot({ tasks, model, sessions: [{ endAt: daysAgo(1) }] });
  const beforeDemo = businessSnapshot(demo.S);
  const forbiddenCalls = [];
  for (const name of ['detect', 'open', 'apply']) {
    demo.ZX.flows.rescue[name] = () => { forbiddenCalls.push(name); throw new Error('演示不得调用真实 ' + name); };
  }
  const preview = demo.ZX.assistant.demoRescueFlow();
  assert.equal(preview.zeroDays, 4);
  assert.equal(preview.metrics.planned, 60);
  assert.deepEqual(forbiddenCalls, []);
  assert.equal(demo.ops.length, 0);
  assert.equal(demo.sheets.length, 0);
  assert.match(demo.messages.at(-1), /演示数据 · 不会修改真实计划/);
  assert.doesNotMatch(demo.messages.at(-1), /data-sb="apply"/);
  assert.deepEqual(businessSnapshot(demo.S), beforeDemo);
});
