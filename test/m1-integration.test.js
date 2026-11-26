'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const H = require('./helpers');
const P = require('../shared/placement-model.js');
const workflow = require('../shared/workflow.js');
const { replan } = require('../shared/engine/replan.js');
const seed = require('../shared/data/seed.js');

const today = new Date();
today.setHours(0, 0, 0, 0);
const START = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
const DATES = Array.from({ length: 7 }, (_, i) => {
  const date = new Date(today.getTime());
  date.setDate(date.getDate() + i);
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
});
const plain = value => JSON.parse(JSON.stringify(value));
const turn = () => new Promise(resolve => setImmediate(resolve));
function shiftDate(date, days) {
  const value = new Date(date + 'T00:00:00Z');
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function boot(disk = new Map()) {
  const messages = [];
  const ZX = {
    api: { queueOp() {}, pendingCount: () => 0 },
    ui: { toast() {}, fold: (id, options) => options.body, confirm: () => Promise.resolve(true) },
    setTab() {}
  };
  const localStorage = H.storage(disk).localStorage;
  const listeners = {};
  const document = { addEventListener(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); }, querySelector: () => null, getElementById: () => null };
  const sandbox = {
    window: { ZX, localStorage, Rhythm: { seed, placementModel: P, workflow } },
    localStorage, document, crypto: globalThis.crypto
  };
  H.installUtil(sandbox);
  for (const file of ['state.js', 'assistant.js', 'flows/exec.js', 'flows/planedit.js', 'flows/replan.js', 'flows/rescue.js', 'flows/settings.js']) {
    vm.runInNewContext(fs.readFileSync(require.resolve('../assets/js/' + file), 'utf8'), sandbox);
  }
  ZX.assistant.say = html => messages.push(html);
  ZX.render = () => ZX.state.saveOverlay();
  ZX.engine = { replan: async input => replan(input), attributeNow: () => null };
  return { ZX, disk, messages, listeners, document };
}

function fixture(ZX, { crossDay = false } = {}) {
  const tasks = crossDay
    ? [{ id: 'x', subject: '数学', title: '跨日任务', est: 60, weight: 1 }]
    : [
      { id: 'a', subject: '数学', title: '高权重', est: 60, weight: 0.9 },
      { id: 'b', subject: '英语', title: '低权重', est: 60, weight: 0.1 }
    ];
  const slots = [];
  DATES.forEach((date, i) => {
    const normal = crossDay ? 30 : 60;
    for (let min = 480; min < 480 + normal; min += 30) {
      slots.push({ date, startMin: min, durMin: 30, isBuffer: false });
    }
    if (!crossDay && i > 0) {
      for (let min = 480 + normal; min < 540 + normal; min += 30) {
        slots.push({ date, startMin: min, durMin: 30, isBuffer: true });
      }
    }
  });
  const blocks = crossDay ? [] : [
    { id: 'seed-a', taskId: 'a', date: DATES[1], startMin: 480, durMin: 60 },
    { id: 'seed-b', taskId: 'b', date: DATES[0], startMin: 480, durMin: 60 }
  ];
  const model = P.createModel({ startDate: START, timezone: 'UTC', slots, tasks, blocks, unplanned: [], idPrefix: 'fixture_' });
  ZX.state.tasks = tasks.map(task => ZX.state.normTask({ ...task, s: task.subject, time: '' }));
  ZX.state.placementModel = model;
  ZX.state.locks = {};
  ZX.state.dayAssign = {};
  ZX.state.syncPlacementProjection();
  return { tasks: plain(ZX.state.tasks), model: plain(model) };
}

test('对话开始只启动今日任务，未来任务不会形成隐藏计时器', () => {
  const { ZX, document } = boot();
  document.createElement = () => ({ innerHTML: '', className: '', setAttribute() {}, remove() {} });
  ZX.util.$ = () => ({ children: [], appendChild() {}, removeChild() {}, scrollTop: 0, scrollHeight: 0 });
  fixture(ZX);
  assert.deepEqual(ZX.state.tasks.map(task => task.id), ['a', 'b']);
  assert.deepEqual(ZX.flows.exec.activeTasks().map(task => task.id), ['b']);
  ZX.assistant.startFlow();
  assert.equal(ZX.state.running, 'b');
  assert.equal(ZX.assistant.startTask('a'), undefined);
  assert.equal(ZX.state.running, 'b');
});

test('v3 overlay 与完整备份保留模型，重载后周图从有效区块重算', async () => {
  const source = boot();
  fixture(source.ZX);
  assert.equal(source.ZX.state.saveOverlay(), true);
  const overlay = JSON.parse(source.disk.get('zx.overlay'));
  assert.equal(overlay.version, 3);
  assert.deepEqual(overlay.placementModel, source.ZX.state.placementModel);

  const reloaded = boot(source.disk).ZX;
  assert.deepEqual(plain(reloaded.state.placementModel), plain(source.ZX.state.placementModel), JSON.stringify(reloaded.state.localLoadError));
  assert.deepEqual(plain(reloaded.state.week), plain(source.ZX.state.week));
  assert.equal(reloaded.state.week.reduce((sum, day) => sum + day.total, 0), 120);

  const backup = source.ZX.settings.exportBackup();
  const target = boot();
  fixture(target.ZX, { crossDay: true });
  assert.equal(await target.ZX.settings.importBackup(JSON.stringify(backup)), true);
  assert.deepEqual(plain(target.ZX.state.placementModel), plain(source.ZX.state.placementModel));
  assert.equal(JSON.parse(target.disk.get('zx.overlay')).version, 3);
});

test('boot overlay 跨周滚动到今日，锁定任务平移且已完成历史不复活', () => {
  const disk = new Map();
  const source = boot(disk).ZX;
  const oldStart = shiftDate(START, -8);
  const oldDates = Array.from({ length: 7 }, (_, i) => shiftDate(oldStart, i));
  const tasks = [
    { id: 'open', subject: '数学', title: '待办', est: 30, weight: 0.9 },
    { id: 'locked', subject: '英语', title: '锁定', est: 30, weight: 0.8 },
    { id: 'completed', subject: '408', title: '完成历史', est: 30, weight: 0.7, done: true, actual: 30, completedAt: Date.now() },
    { id: 'skipped', subject: '政治', title: '已跳过', est: 30, weight: 0.6, skipped: true, skippedAt: Date.now() },
    { id: 'abandoned', subject: '政治', title: '已放弃', est: 30, weight: 0.5, abandoned: true, abandonedAt: Date.now() },
    { id: 'substituted', subject: '政治', title: '已替代', est: 30, weight: 0.4, substituted: true, substitutedAt: Date.now() },
    { id: 'unplanned', subject: '数学', title: '未排入', est: 0, weight: 0.1 }
  ];
  const blocks = [
    { id: 'open-old', taskId: 'open', date: oldDates[0], startMin: 480, durMin: 30 },
    { id: 'locked-old', taskId: 'locked', date: oldDates[6], startMin: 480, durMin: 30 },
    { id: 'completed-old', taskId: 'completed', date: oldDates[1], startMin: 480, durMin: 30 },
    { id: 'skipped-old', taskId: 'skipped', date: oldDates[2], startMin: 480, durMin: 30 },
    { id: 'abandoned-old', taskId: 'abandoned', date: oldDates[3], startMin: 480, durMin: 30 },
    { id: 'substituted-old', taskId: 'substituted', date: oldDates[4], startMin: 480, durMin: 30 }
  ];
  let model = P.createModel({
    startDate: oldStart, timezone: 'UTC', idPrefix: 'old_',
    slots: oldDates.map(date => ({ date, startMin: 480, durMin: 60, isBuffer: false })),
    tasks, blocks, unplanned: []
  });
  ['completed', 'skipped', 'abandoned', 'substituted'].forEach(id => {
    model = P.releaseTask(model, id, '已释放').model;
  });
  source.state.tasks = tasks.map(task => source.state.normTask({ ...task, s: task.subject, time: '' }));
  source.state.placementModel = model;
  source.state.locks = { locked: true };
  source.state.syncPlacementProjection();
  const originals = plain(model.placements.map(item => item.originalSegments));
  const unplanned = plain(model.unplanned);
  assert.equal(source.state.saveOverlay(), true);

  const loaded = boot(disk).ZX;
  assert.equal(loaded.state.localLoadFailed, false, JSON.stringify(loaded.state.localLoadError));
  assert.equal(loaded.state.placementModel.startDate, START);
  assert.deepEqual(loaded.state.placementModel.days.map(day => day.date), DATES);
  assert.deepEqual(plain(P.taskSegments(loaded.state.placementModel, 'open').map(seg => seg.date)), [DATES[0]]);
  assert.deepEqual(plain(P.taskSegments(loaded.state.placementModel, 'locked').map(seg => seg.date)), [DATES[6]]);
  for (const id of ['completed', 'skipped', 'abandoned', 'substituted']) {
    assert.deepEqual(plain(P.taskSegments(loaded.state.placementModel, id)), []);
  }
  assert.deepEqual(plain(loaded.state.placementModel.placements.map(item => item.originalSegments)), originals);
  assert.deepEqual(plain(loaded.state.placementModel.unplanned), unplanned);
  assert.ok(loaded.state.tasksOnDate(START).some(task => task.id === 'completed'));
  assert.equal(loaded.state.ensurePlacementWindow(), false, '同日不得重复滚动');
});

test('weekInput / tasksOnDate / replanInput 都会先确保落点窗口位于今天', () => {
  for (const getter of ['weekInput', 'tasksOnDate', 'replanInput']) {
    const ZX = boot().ZX;
    fixture(ZX);
    const current = plain(ZX.state.placementModel);
    const oldStart = shiftDate(START, -8);
    const oldDates = Array.from({ length: 7 }, (_, i) => shiftDate(oldStart, i));
    const tasks = ZX.state.tasks.map(task => ({ id: task.id, subject: task.subject, estMin: task.est }));
    const oldModel = P.createModel({
      startDate: oldStart, timezone: 'UTC', idPrefix: 'getter_',
      slots: oldDates.map(date => ({ date, startMin: 480, durMin: 60, isBuffer: false })),
      tasks,
      blocks: [{ id: 'getter-old', taskId: 'a', date: oldDates[0], startMin: 480, durMin: 60 }],
      unplanned: []
    });
    ZX.state.placementModel = oldModel;
    if (getter === 'tasksOnDate') ZX.state.tasksOnDate(START);
    else ZX.state[getter]();
    assert.equal(ZX.state.placementModel.startDate, START, getter);
    assert.deepEqual(P.taskSegments(ZX.state.placementModel, 'a').map(seg => seg.date), [DATES[0]], getter);
    assert.notDeepEqual(plain(ZX.state.placementModel), current);
  }
});

test('v3 重排先释放旧落点再按权重移动，锁冲突整笔拒绝撤销', async () => {
  const { ZX, messages } = boot();
  const before = fixture(ZX);
  const beforeVersion = ZX.state.currentPlanVersion();
  assert.doesNotThrow(() => replan(ZX.state.replanInput()));
  ZX.flows.replan.replanFlow();
  await turn();
  assert.ok(messages.at(-1).includes('confirm-replan'), messages.at(-1));
  assert.deepEqual(plain(ZX.state.placementModel), before.model);
  ZX.flows.replan.confirmReplan();
  const after = plain(ZX.state.placementModel);
  assert.notDeepEqual(after, before.model);
  assert.notEqual(ZX.state.currentPlanVersion(), beforeVersion);
  assert.equal(P.taskSegments(after, 'a')[0].date, DATES[0]);
  assert.equal(P.taskSegments(after, 'b')[0].date, DATES[1]);
  assert.deepEqual(plain(ZX.state.snapshot.beforePlacementModel), before.model);
  assert.deepEqual(plain(ZX.state.snapshot.afterPlacementModel), after);

  ZX.flows.planedit.toggleLock('a');
  const locked = plain(ZX.state.placementModel);
  const history = plain(ZX.state.replanHistory);
  ZX.flows.replan.undoReplan();
  assert.match(messages.at(-1), /撤销冲突/);
  assert.deepEqual(plain(ZX.state.placementModel), locked);
  assert.deepEqual(plain(ZX.state.replanHistory), history);

  ZX.state.locks = plain(ZX.state.snapshot.afterLocks);
  ZX.flows.replan.undoReplan();
  assert.match(messages.at(-1), /已撤销/);
  assert.deepEqual(plain(ZX.state.placementModel), before.model);
  assert.deepEqual(plain(ZX.state.tasks), before.tasks);
});

test('v3 零基线重排可确认完整跨日拆分，增幅显示不适用', async () => {
  const { ZX, messages } = boot();
  fixture(ZX, { crossDay: true });
  assert.equal(P.summary(ZX.state.placementModel).totals.usedMin, 0);
  assert.doesNotThrow(() => replan(ZX.state.replanInput()));
  ZX.flows.replan.replanFlow();
  await turn();
  assert.ok(messages.at(-1).includes('增幅不适用（零基线）'), messages.at(-1));
  ZX.flows.replan.confirmReplan();
  const segments = P.taskSegments(ZX.state.placementModel, 'x');
  assert.deepEqual(segments.map(segment => segment.date), DATES.slice(0, 2));
  assert.equal(segments.reduce((sum, segment) => sum + segment.durMin, 0), 60);
  assert.equal(ZX.state.replanRecord.loadDelta, null);
  assert.deepEqual(ZX.state.week.map(day => day.total), [30, 30, 0, 0, 0, 0, 0]);
});

test('v3 跳过释放落点但保留当日实际投入，恢复时重新装入原始落点', () => {
  const { ZX, listeners } = boot();
  fixture(ZX);
  ZX.state.tasks[1].actual = 20;
  let saveSkip;
  ZX.ui.footNav = () => '';
  ZX.ui.sheet = () => ({ root: { addEventListener(type, fn) { if (type === 'click') saveSkip = fn; }, querySelector: () => null }, $: () => null, close() {} });
  const click = (action, id) => {
    const event = { target: { closest(selector) { return selector === '[data-sc]' ? { dataset: { sc: action, id }, closest: () => null } : null; } } };
    (listeners.click || []).forEach(fn => fn(event));
  };
  click('skip', 'b');
  assert.equal(typeof saveSkip, 'function');
  saveSkip({ target: { closest: selector => selector === '[data-sc]' ? { dataset: { sc: 'save-skip' } } : null } });
  assert.equal(ZX.state.tasks[1].skipped, true);
  assert.deepEqual(P.taskSegments(ZX.state.placementModel, 'b'), []);
  assert.equal(P.summary(ZX.state.placementModel).totals.usedMin, 60);
  assert.ok(ZX.state.tasksOnDate(ZX.util.todayKey()).some(task => task.id === 'b'));
  assert.equal(ZX.state.tasks.find(task => task.id === 'b').actual, 20);
  assert.equal(ZX.exec.metrics().worked, 20);
  assert.equal(ZX.exec.metrics().skipped, 1);

  click('restore', 'b');
  assert.equal(ZX.state.tasks[1].skipped, false);
  assert.equal(P.taskSegments(ZX.state.placementModel, 'b')[0].date, DATES[0]);
  assert.equal(P.summary(ZX.state.placementModel).totals.usedMin, 120);
  assert.equal(ZX.exec.metrics().worked, 20);
  assert.equal(ZX.exec.metrics().skipped, 0);
});

test('overlay 落点引用缺失任务时熔断，不启动崩溃或覆盖原键', () => {
  const disk = new Map();
  const ZX = boot(disk).ZX;
  fixture(ZX);
  ZX.state.saveOverlay();
  const raw = JSON.parse(disk.get('zx.overlay'));
  const placement = raw.placementModel.placements[0];
  placement.taskId = 'missing-task';
  placement.originalSegments.forEach(segment => { segment.taskId = 'missing-task'; });
  placement.currentSegments.forEach(segment => { segment.taskId = 'missing-task'; });
  disk.set('zx.overlay', JSON.stringify(raw));
  const before = disk.get('zx.overlay');
  const loaded = boot(disk).ZX;
  assert.equal(loaded.state.localLoadFailed, true);
  assert.equal(loaded.state.saveOverlay(), false);
  assert.equal(disk.get('zx.overlay'), before);
});

test('当日挽救恢复状态跨刷新保留，不被旧 sessions 再次判为中断', () => {
  const disk = new Map();
  const ZX = boot(disk).ZX;
  const now = Date.now();
  ZX.state.sessions = [{ id: 'old-session', taskId: ZX.state.tasks[0].id, endAt: now - 4 * 86400000 }];
  ZX.state.rescueRecord = { at: now, strategy: 'defer' };
  ZX.state.consecutiveZeroDays = 0;
  ZX.state.interrupted = false;
  ZX.state.saveOverlay();
  const loaded = boot(disk).ZX;
  assert.equal(loaded.state.consecutiveZeroDays, 0);
  assert.equal(loaded.state.interrupted, false);
  assert.deepEqual(plain(loaded.state.rescueRecord), { at: now, strategy: 'defer' });
});

test('部分完成按累计完成度计算剩余，不再次压缩剩余工时', () => {
  const { ZX } = boot();
  fixture(ZX);
  ZX.exec.metrics();
  ZX.exec.commitRecord('b', 50, 50, '', 1, 2);
  assert.equal(ZX.state.tasks[1].est, 30);
  ZX.exec.commitRecord('b', 25, 75, '', 3, 4);
  assert.equal(ZX.state.tasks[1].est, 15);
  assert.equal(P.summary(ZX.state.placementModel).totals.usedMin, 75);
});

test('v3 弹性位不能由旧布尔开关绕过模型记账', () => {
  const { ZX } = boot();
  fixture(ZX);
  ZX.state.buffer.free = false;
  const before = plain(ZX.state.placementModel);
  ZX.assistant.toggleBuffer();
  assert.equal(ZX.state.buffer.free, false);
  assert.deepEqual(plain(ZX.state.placementModel), before);
});

test('旧 v2 快照没有落点证据时保持 legacy，不反推日期或减去 buf', () => {
  const disk = new Map();
  const first = boot(disk).ZX.state;
  first.saveOverlay();
  const raw = JSON.parse(disk.get('zx.overlay'));
  raw.version = 2;
  raw.placementModel = null;
  raw.week[0].total = 105;
  raw.week[0].buf = 60;
  disk.set('zx.overlay', JSON.stringify(raw));
  const state = boot(disk).ZX.state;
  assert.equal(state.placementModel, null);
  assert.equal(state.week[0].total, 105);
  assert.equal(state.week[0].buf, 60);
  assert.equal(state.week[0].date, undefined);
});
