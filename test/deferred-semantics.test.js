'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const H = require('./helpers');
const engine = require('../shared/engine/replan.js');
const { feasibility } = require('../shared/engine/feasibility.js');
const plain = value => JSON.parse(JSON.stringify(value));

function boot(storage = new Map(), options = {}) {
  const messages = [], ops = [], toasts = [], listeners = [];
  const now = typeof options.now === 'number' ? options.now : Date.now();
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  let renders = 0;
  const ZX = {
    api: { queueOp: op => ops.push(op), pendingCount: () => 0 },
    setTab() {},
    ui: {
      toast: (message, type) => toasts.push({ message, type }),
      fold: (id, options) => options.body,
      sheet() { throw new Error('暂缓任务不应打开执行弹层'); }
    },
    engine: {
      replan: input => engine.replan(input),
      undo: snapshot => engine.undoReplan(snapshot),
      feasibilityNow: input => feasibility(input)
    }
  };
  const sandbox = {
    window: {
      ZX,
      localStorage: H.storage(storage).localStorage,
      Rhythm: { seed: require('../shared/data/seed.js'), workflow: require('../shared/workflow.js') }
    },
    crypto: globalThis.crypto,
    Date: FixedDate,
    document: {
      addEventListener: (type, fn) => { if (type === 'click') listeners.push(fn); },
      createElement: () => ({})
    }
  };
  const ctx = vm.createContext(sandbox);
  for (const path of [
    'util.js', 'state.js', 'views/today.js', 'views/plan.js',
    'assistant.js', 'flows/exec.js', 'flows/planedit.js', 'flows/rescue.js'
  ]) {
    vm.runInContext(fs.readFileSync(require.resolve('../assets/js/' + path), 'utf8'), ctx);
  }
  ZX.util.$ = () => ({ children: [], appendChild: element => messages.push(element.innerHTML) });
  ZX.util.prefs = () => ({});
  ZX.render = () => { renders++; ZX.state.saveOverlay(); };
  return { ZX, messages, ops, toasts, listeners, storage, renders: () => renders, ctx };
}

function fixture(ZX) {
  const S = ZX.state;
  S.tasks = [
    { id: 'open', subject: '数学', title: '普通任务甲', est: 30, time: '09:00–09:30', weight: 0.8 },
    { id: 'keep', subject: '政治', title: '普通任务乙', est: 40, time: '09:30–10:10', weight: 0.9 },
    { id: 'deferred', subject: '英语', title: '今日暂缓任务', est: 50, time: '10:10–11:00', weight: 0.05,
      deferred: true, deferredTo: '六', deferredAt: Date.now(), deferredReason: '状态不佳' },
    { id: 'skipped', subject: '数学', title: '已跳过任务', est: 30, time: '11:00–11:30', weight: 0.7, skipped: true },
    { id: 'abandoned', subject: '英语', title: '已放弃任务', est: 30, time: '11:30–12:00', weight: 0.6, abandoned: true },
    { id: 'substituted', subject: '数学', title: '已替代任务', est: 30, time: '12:00–12:30', weight: 0.5,
      substituted: true, substitutedBy: 'keep' }
  ].map(task => S.normTask(task));
  S.dayAssign = { open: '一', keep: '二', deferred: '三', skipped: '四', abandoned: '五', substituted: '六' };
  S.locks = {};
  S.week = Array.from('一二三四五六日', day => ({ d: day, total: 100, buf: 60, segs: [['数学', 60], ['英语', 40]] }));
  return plain(S.tasks);
}

function ids(list) {
  return list.map(task => task.id).sort();
}

test('暂缓项退出今日待办、时间带、普通计划板、挽救候选，并在两页独立可见可恢复', () => {
  const { ZX, messages } = boot();
  fixture(ZX);

  assert.deepEqual(ids(ZX.exec.activeTasks()), ['keep', 'open']);
  ZX.assistant.todayFlow();
  assert.match(messages.at(-1), /今天还剩 <b>2<\/b> 项/);
  assert.doesNotMatch(messages.at(-1), /今日暂缓任务|已跳过任务|已放弃任务|已替代任务/);

  const today = ZX.views.today();
  const band = today.slice(today.indexOf('class="tl"'), today.indexOf('class="tl-scale"'));
  assert.match(band, /普通任务甲/);
  assert.doesNotMatch(band, /今日暂缓任务|已跳过任务/);
  assert.match(today, /今日暂缓（未改期）/);
  assert.ok(today.includes('data-task="open"'));
  assert.ok(!today.includes('data-task="deferred"'));
  assert.ok(!today.includes('data-act="start" data-id="deferred"'));
  assert.match(today, /旧版标记（非改期）：六/);
  assert.ok(today.includes('data-act="restore-deferred" data-id="deferred"'));

  const board = ZX.flows.planedit.board();
  assert.ok(board.includes('data-pe-task="open"'));
  assert.ok(board.includes('data-pe-task="keep"'));
  for (const id of ['deferred', 'skipped', 'abandoned', 'substituted']) {
    assert.ok(!board.includes('data-pe-task="' + id + '"'));
    assert.equal(ZX.flows.planedit.probe(id, '三'), null);
    assert.equal(ZX.flows.planedit.moveTask(id, '三'), false);
  }

  const plan = ZX.views.plan();
  assert.match(plan, /今日暂缓（未改期）/);
  assert.match(plan, /不计入计划板 · 计划日期未变/);
  assert.match(plan, /旧版标记（非改期）：六/);
  assert.ok(plan.includes('data-act="restore-deferred" data-id="deferred"'));
  assert.ok(!plan.includes('data-pe-task="deferred"'));

  for (const strategy of ['compress', 'defer', 'downgrade']) {
    const option = ZX.flows.rescue.optionOf(strategy);
    const candidates = (option.items || []).concat(option.dropped || []);
    assert.ok(candidates.every(task => ['open', 'keep'].includes(task.id)), strategy);
  }
});

test('暂缓仅 deferredAt 的本地当日有效，跨分钟但跨日后自动清理并持久化', () => {
  const storage = new Map();
  const dayOne = new Date(2026, 10, 23, 23, 59).getTime();
  const dayTwo = new Date(2026, 10, 24, 0, 1).getTime();
  const first = boot(storage, { now: dayOne });
  first.ZX.state.tasks = [{
    id: 'tired', subject: '数学', title: '跨日暂缓', est: 30,
    deferred: true, deferredAt: dayOne, deferredReason: '状态不佳'
  }].map(task => first.ZX.state.normTask(task));
  const dayAssign = plain(first.ZX.state.dayAssign);
  assert.equal(first.ZX.state.saveOverlay(), true);

  const second = boot(storage, { now: dayTwo });
  const tired = second.ZX.state.tasks.find(task => task.id === 'tired');
  for (const field of ['deferred', 'deferredAt', 'deferredReason']) {
    assert.equal(Object.hasOwn(tired, field), false, field);
  }
  assert.deepEqual(plain(second.ZX.state.dayAssign), dayAssign);
  assert.ok(second.ZX.exec.activeTasks().some(task => task.id === 'tired'));

  second.ZX.state.tasks.push(second.ZX.state.normTask({
    id: 'late', subject: '英语', title: '读取时过期', est: 20,
    deferred: true, deferredAt: dayOne, deferredReason: '旧暂缓'
  }));
  assert.ok(second.ZX.state.tasksOnDate(second.ZX.util.todayKey()).some(task => task.id === 'late'));
  const late = second.ZX.state.tasks.find(task => task.id === 'late');
  for (const field of ['deferred', 'deferredAt', 'deferredReason']) {
    assert.equal(Object.hasOwn(late, field), false, field);
  }
  second.ZX.render();

  const reloaded = boot(storage, { now: dayTwo }).ZX;
  assert.ok(reloaded.exec.activeTasks().some(task => task.id === 'tired'));
  assert.ok(reloaded.exec.activeTasks().some(task => task.id === 'late'));
});

test('无目标计划页同样显示暂缓列表，不把任务记录隐藏或删除', () => {
  const { ZX } = boot();
  fixture(ZX);
  ZX.state.goal = { source: 'removed', name: '', deadline: '', target: '', weeks: 0 };
  const before = plain(ZX.state.tasks);
  const html = ZX.views.plan();
  assert.match(html, /未设定阶段目标/);
  assert.match(html, /今日暂缓（未改期）/);
  assert.ok(html.includes('data-act="restore-deferred" data-id="deferred"'));
  assert.deepEqual(plain(ZX.state.tasks), before);
});

test('统一恢复只清暂缓元数据，保留任务、计划落点和其他保护并提示', () => {
  const { ZX, messages, toasts, renders } = boot();
  fixture(ZX);
  ZX.state.tasks.push(ZX.state.normTask({
    id: 'guarded', subject: '数学', title: '受保护暂缓项', est: 20,
    deferred: true, deferredTo: '六', deferredAt: Date.now(), deferredReason: '旧原因',
    skipped: true, abandoned: true, substituted: true
  }));
  const dayAssign = plain(ZX.state.dayAssign);
  const count = ZX.state.tasks.length;

  assert.equal(ZX.flows.exec.restoreDeferred('missing'), false);
  assert.equal(ZX.flows.exec.restoreDeferred('open'), false);
  assert.equal(renders(), 0);
  assert.equal(ZX.flows.exec.restoreDeferred('deferred'), true);
  assert.equal(renders(), 1);
  const restored = ZX.state.tasks.find(task => task.id === 'deferred');
  assert.equal(Object.hasOwn(restored, 'deferred'), false);
  assert.equal(Object.hasOwn(restored, 'deferredTo'), false);
  assert.equal(Object.hasOwn(restored, 'deferredAt'), false);
  assert.equal(Object.hasOwn(restored, 'deferredReason'), false);
  assert.equal(restored.title, '今日暂缓任务');
  assert.equal(restored.time, '10:10–11:00');
  assert.equal(ZX.state.tasks.length, count);
  assert.deepEqual(plain(ZX.state.dayAssign), dayAssign);
  assert.ok(ZX.exec.activeTasks().some(task => task.id === 'deferred'));
  assert.ok(ZX.flows.planedit.board().includes('data-pe-task="deferred"'));
  assert.doesNotMatch(ZX.views.today(), /data-id="deferred">恢复/);
  assert.doesNotMatch(ZX.views.plan(), /data-id="deferred">恢复/);
  assert.ok(toasts.some(item => item.type === 'ok' && /计划日期未变/.test(item.message)));
  assert.match(messages.at(-1), /今日暂缓任务/);
  assert.match(messages.at(-1), /未修改计划日期/);

  assert.equal(ZX.flows.exec.restoreDeferred('guarded'), true);
  const guarded = ZX.state.tasks.find(task => task.id === 'guarded');
  assert.equal(guarded.skipped, true);
  assert.equal(guarded.abandoned, true);
  assert.equal(guarded.substituted, true);
  assert.ok(!ZX.exec.activeTasks().some(task => task.id === 'guarded'));
  assert.ok(!ZX.flows.planedit.board().includes('data-pe-task="guarded"'));
  for (const strategy of ['compress', 'defer', 'downgrade']) {
    const option = ZX.flows.rescue.optionOf(strategy);
    assert.ok(!(option.items || []).concat(option.dropped || []).some(task => task.id === 'guarded'));
  }
});

test('旧卡片不能启动、完成、记录或重新跳过今日暂缓任务', () => {
  const { ZX, listeners } = boot();
  fixture(ZX);
  const deferred = ZX.state.tasks.find(task => task.id === 'deferred');
  const before = plain(deferred);
  ZX.state.running = null;
  ZX.assistant.startTask('deferred');
  ZX.assistant.finishTask('deferred', true);
  ZX.exec.commitRecord('deferred', 10, 100, '', 1, 2);
  listeners.forEach(fn => fn({
    target: { closest: selector => selector === '[data-sc]'
      ? { dataset: { sc: 'skip', id: 'deferred' }, closest: () => null }
      : null }
  }));
  assert.equal(ZX.state.running, null);
  assert.equal(ZX.state.sessions.length, 0);
  assert.deepEqual(plain(deferred), before);
});

test('重排引擎 pending 与 L3 替代候选都排除 deferred/skipped，且不删除原任务', () => {
  const week = Array.from({ length: 7 }, (_, index) => ({ date: 'D' + (index + 1), minutes: 100, capacity: 115, buffer: 60 }));
  const tasks = [
    { id: 'open', est: 30, weight: 0.8, domain: '数学', freq: 0.5 },
    { id: 'keep', est: 40, weight: 0.9, domain: '数学', freq: 0.5 },
    { id: 'deferred', est: 200, weight: 0.1, domain: '数学', freq: 0.8, deferred: true },
    { id: 'skipped', est: 200, weight: 0.1, domain: '数学', freq: 0.8, skipped: true },
    { id: 'abandoned', est: 200, weight: 0.1, abandoned: true },
    { id: 'substituted', est: 200, weight: 0.1, substituted: true, substitutedBy: 'keep' },
    { id: 'done', est: 200, weight: 0.1, done: true }
  ];
  const result = engine.replan({ tasks, locks: {}, week, compressedShareCap: 0.05, timestamp: 1000 });
  assert.equal(result.accepted, true);
  assert.deepEqual(result.diff.map(item => item.taskId).sort(), ['keep', 'open']);
  assert.deepEqual(result.nextTasks.map(task => task.id).sort(), tasks.map(task => task.id).sort());
  assert.equal(result.nextWeek.reduce((sum, day) => sum + day.minutes, 0), 770);
  for (const id of ['deferred', 'skipped', 'abandoned', 'substituted', 'done']) {
    assert.deepEqual(plain(result.nextTasks.find(task => task.id === id)), plain(tasks.find(task => task.id === id)));
  }

  for (const flag of ['deferred', 'skipped']) {
    const candidates = [
      { id: 'a', est: 100, weight: 0.3, domain: '高数', freq: 0.2 },
      { id: 'legacy', est: 40, weight: 0.9, domain: '高数', freq: 0.8, [flag]: true },
      { id: 'c', est: 90, weight: 0.5, domain: '线代', freq: 0.5 }
    ];
    const substituted = engine.replan({ tasks: candidates, locks: {}, week, compressedShareCap: 0.05, timestamp: 1000 });
    assert.ok(!substituted.diff.some(item => item.taskId === 'legacy'));
    assert.ok(!substituted.diff.some(item => item.op === 'substitute' && item.taskId === 'a'));
    assert.deepEqual(plain(substituted.nextTasks.find(task => task.id === 'legacy')), plain(candidates[1]));
  }
});

test('采纳降载只写今日暂缓元数据，队列无周六目标且刷新/恢复后语义保持', () => {
  const storage = new Map();
  const first = boot(storage);
  first.ZX.state.tasks = [
    { id: 'keep', subject: '数学', title: '保留任务', est: 30, time: '09:00–09:30', weight: 0.9 },
    { id: 'tired', subject: '英语', title: '暂缓任务', est: 40, time: '09:30–10:10', weight: 0.1 }
  ].map(task => first.ZX.state.normTask(task));
  first.ZX.state.dayAssign = { keep: '一', tired: '二' };
  first.ZX.state.locks = {};
  const dayAssign = plain(first.ZX.state.dayAssign);

  first.ZX.assistant.tiredFlow();
  assert.match(first.messages.at(-1), /仅标记顺延（仅今日暂缓），不会修改计划日期/);
  const versionBeforeDefer = first.ZX.state.currentPlanVersion();
  first.ZX.assistant.adoptTired();
  assert.notEqual(first.ZX.state.currentPlanVersion(), versionBeforeDefer);
  const tired = first.ZX.state.tasks.find(task => task.id === 'tired');
  assert.equal(tired.deferred, true);
  assert.equal(typeof tired.deferredAt, 'number');
  assert.equal(tired.deferredReason, '状态不佳');
  assert.equal(Object.hasOwn(tired, 'deferredTo'), false);
  assert.equal(first.ZX.state.movedOut, null);
  assert.deepEqual(plain(first.ZX.state.dayAssign), dayAssign);
  assert.match(first.messages.at(-1), /仅今日暂缓，未修改计划日期/);
  assert.doesNotMatch(first.messages.join(''), /周六|六/);
  const op = first.ops.find(item => item.field === 'deferred');
  assert.ok(op);
  assert.equal(op.entityId, 'tired');
  assert.deepEqual(Object.keys(op.value).sort(), ['at', 'est', 'reason']);
  assert.equal(op.value.reason, '状态不佳');
  assert.equal(op.value.est, 40);
  assert.equal(op.value.at, tired.deferredAt);

  const refreshed = boot(storage).ZX;
  const stored = refreshed.state.tasks.find(task => task.id === 'tired');
  assert.equal(stored.deferred, true);
  assert.equal(stored.deferredAt, tired.deferredAt);
  assert.equal(stored.deferredReason, '状态不佳');
  assert.deepEqual(plain(refreshed.state.dayAssign), dayAssign);
  assert.ok(!refreshed.exec.activeTasks().some(task => task.id === 'tired'));
  assert.match(refreshed.views.today(), /data-act="restore-deferred" data-id="tired"/);
  assert.match(refreshed.views.plan(), /data-act="restore-deferred" data-id="tired"/);

  const versionBeforeRestore = refreshed.state.currentPlanVersion();
  refreshed.flows.exec.restoreDeferred('tired');
  assert.notEqual(refreshed.state.currentPlanVersion(), versionBeforeRestore);
  const restored = boot(storage).ZX;
  const restoredTask = restored.state.tasks.find(task => task.id === 'tired');
  for (const field of ['deferred', 'deferredTo', 'deferredAt', 'deferredReason']) {
    assert.equal(Object.hasOwn(restoredTask, field), false);
  }
  assert.deepEqual(plain(restored.state.dayAssign), dayAssign);
  assert.ok(restored.exec.activeTasks().some(task => task.id === 'tired'));
});

test('旧 deferredTo 刷新后只作兼容标记，恢复后清除且不改真实 dayAssign', () => {
  const storage = new Map();
  const first = boot(storage);
  fixture(first.ZX);
  const dayAssign = plain(first.ZX.state.dayAssign);
  first.ZX.render();

  const refreshed = boot(storage).ZX;
  const legacy = refreshed.state.tasks.find(task => task.id === 'deferred');
  assert.equal(legacy.deferred, true);
  assert.equal(legacy.deferredTo, '六');
  assert.deepEqual(plain(refreshed.state.dayAssign), dayAssign);
  assert.match(refreshed.views.today(), /旧版标记（非改期）：六/);
  assert.match(refreshed.views.plan(), /旧版标记（非改期）：六/);
  assert.ok(!refreshed.flows.planedit.board().includes('data-pe-task="deferred"'));

  refreshed.flows.exec.restoreDeferred('deferred');
  const restored = boot(storage).ZX;
  const task = restored.state.tasks.find(item => item.id === 'deferred');
  for (const field of ['deferred', 'deferredTo', 'deferredAt', 'deferredReason']) {
    assert.equal(Object.hasOwn(task, field), false);
  }
  assert.deepEqual(plain(restored.state.dayAssign), dayAssign);
  assert.ok(restored.exec.activeTasks().some(item => item.id === 'deferred'));
});

test('否决重排顺延不会把今日暂缓误恢复，也不改计划落点', () => {
  const { ZX, ops } = boot();
  fixture(ZX);
  ZX.state.replanRecord = {};
  const dayAssign = plain(ZX.state.dayAssign);
  ZX.flows.planedit.veto('deferred', 'defer');
  assert.equal(ZX.state.tasks.find(task => task.id === 'deferred').deferred, true);
  assert.deepEqual(plain(ZX.state.dayAssign), dayAssign);
  assert.equal(ops.at(-1).field, 'vetoed');
});
