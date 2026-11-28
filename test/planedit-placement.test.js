'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const P = require('../shared/placement-model.js');

const DATES = [
  '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19',
  '2026-11-20', '2026-11-21', '2026-11-22'
];
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
const plain = value => JSON.parse(JSON.stringify(value));

function boot(disk = new Map(), withSettings = false) {
  const ops = [], toasts = [], listeners = [];
  let renders = 0;
  const ZX = {
    api: { queueOp: op => ops.push(op), pendingCount: () => 0 },
    ui: { toast: (message, type) => toasts.push({ message, type }) }
  };
  const sandbox = {
    window: {
      ZX,
      localStorage: {
        getItem: key => disk.has(key) ? disk.get(key) : null,
        setItem: (key, value) => disk.set(key, String(value)),
        removeItem: key => disk.delete(key)
      },
      Rhythm: { seed: require('../shared/data/seed.js'), placementModel: P }
    },
    crypto: globalThis.crypto,
    document: {
      addEventListener: (type, fn) => listeners.push({ type, fn }),
      createElement: () => ({})
    }
  };
  const ctx = vm.createContext(sandbox);
  const scripts = ['util.js', 'state.js', 'flows/planedit.js'];
  if (withSettings) scripts.push('flows/settings.js');
  for (const path of scripts) {
    vm.runInContext(fs.readFileSync(require.resolve('../assets/js/' + path), 'utf8'), ctx);
  }
  ZX.util.todayKey = () => DATES[1];
  ZX.render = () => { renders++; };
  return { ZX, disk, ops, toasts, listeners, renders: () => renders };
}

function task(id, est, extra = {}) {
  return { id, subject: '数学', s: '数学', title: '任务-' + id, est, time: '08:00–09:00', ...extra };
}

function block(id, taskId, date, startMin, durMin, isBuffer = false) {
  return { id, taskId, date, startMin, durMin, isBuffer };
}

function makeModel(tasks, blocks, capacities = DATES.map(() => [120, 60]), unplanned = []) {
  const slots = [];
  DATES.forEach((date, index) => {
    const [normal, buffer] = capacities[index];
    if (normal > 0) slots.push({ date, startMin: 480, durMin: normal, isBuffer: false });
    if (buffer > 0) slots.push({ date, startMin: 480 + normal, durMin: buffer, isBuffer: true });
  });
  return P.createModel({
    startDate: DATES[0], timezone: 'UTC', slots,
    tasks: tasks.map(item => ({ id: item.id, subject: item.subject || item.s, estMin: item.est })),
    blocks, unplanned
  });
}

function install(ZX, tasks, model) {
  const S = ZX.state;
  S.tasks = tasks.map(item => S.normTask(item));
  S.placementModel = model;
  S.dayAssign = { stale: '五' };
  S.locks = {};
  S.buffer = { time: '旧时段', free: true, keep: '保留字段' };
  S.syncPlacementProjection();
  return S;
}

function column(html, date) {
  const start = html.indexOf('data-pe-day="' + date + '"');
  assert.ok(start >= 0, 'missing column ' + date);
  const next = html.indexOf('data-pe-day=', start + 1);
  return html.slice(start, next < 0 ? html.length : next);
}

function placements(model, taskId) {
  return model.placements.find(item => item.taskId === taskId);
}

test('v3 日程板按 ISO 日期排序、逐段渲染跨日任务，并分列普通/弹性容量', () => {
  const { ZX } = boot();
  const tasks = [
    task('cross', 50, { title: '跨日任务' }),
    task('local', 30, { title: '当日任务' }),
    task('unplanned', 20, { title: '未排入任务' })
  ];
  const model = makeModel(tasks, [
    block('cross-a', 'cross', DATES[0], 480, 20),
    block('cross-b', 'cross', DATES[1], 600, 30, true),
    block('local-a', 'local', DATES[2], 480, 30)
  ], DATES.map(() => [120, 60]), [{ taskId: 'unplanned', reason: '测试未排入' }]);
  const S = install(ZX, tasks, model);
  S.week = [{ d: '日', total: 9999, buf: 9999 }];

  const loads = ZX.flows.planedit.loads();
  assert.strictEqual(loads[DATES[0]], loads['一']);
  assert.deepEqual(plain(loads[DATES[0]]), {
    base: 0, normalUsed: 20, bufferUsed: 0, total: 20,
    capacity: 120, bufferCapacity: 60, inMin: 0, outMin: 0
  });
  assert.deepEqual(plain(loads['二']), {
    base: 0, normalUsed: 0, bufferUsed: 30, total: 30,
    capacity: 120, bufferCapacity: 60, inMin: 0, outMin: 0
  });

  const html = ZX.flows.planedit.board();
  const days = Array.from(html.matchAll(/data-pe-day="([^"]+)"/g), match => match[1]);
  assert.deepEqual(days, DATES);
  assert.match(column(html, DATES[0]), /周一 11\.16/);
  assert.match(column(html, DATES[6]), /周日 11\.22/);
  assert.match(column(html, DATES[0]), /已用 20\/180<br>弹性 0\/60/);
  assert.match(column(html, DATES[1]), /已用 30\/180<br>弹性 30\/60/);
  assert.equal((html.match(/data-pe-task="cross"/g) || []).length, 2);
  assert.match(column(html, DATES[0]), /data-pe-block="cross-a" data-pe-date="2026-11-16" data-pe-dur="20" data-pe-buffer="false"/);
  assert.match(column(html, DATES[1]), /data-pe-block="cross-b" data-pe-date="2026-11-17" data-pe-dur="30" data-pe-buffer="true"/);
  assert.match(column(html, DATES[1]), /30m · 弹性 · 跨日/);
  assert.ok(!html.includes('data-pe-task="unplanned"'));
  assert.ok(!html.includes('未排入任务'));
  assert.equal(ZX.flows.planedit.assignOf('cross'), DATES[0]);
  assert.equal(ZX.flows.planedit.assignOf('unplanned'), null);
  assert.equal(ZX.flows.planedit.movedCount(), 0);
  assert.deepEqual(plain(ZX.flows.planedit.weekDeltas()), {
    '2026-11-16': 0, '2026-11-17': 0, '2026-11-18': 0, '2026-11-19': 0,
    '2026-11-20': 0, '2026-11-21': 0, '2026-11-22': 0,
    '一': 0, '二': 0, '三': 0, '四': 0, '五': 0, '六': 0, '日': 0
  });
});

test('v3 普通与弹性总容量不足时拒绝移动，探测和提交均不写状态', () => {
  const { ZX, ops, toasts, renders } = boot();
  const tasks = [task('move', 40), task('full', 60)];
  const model = makeModel(tasks, [
    block('move-old', 'move', DATES[0], 480, 40),
    block('full-old', 'full', DATES[1], 480, 60)
  ], DATES.map(() => [60, 0]));
  const S = install(ZX, tasks, model);
  const originalModel = S.placementModel;
  const before = plain(S.placementModel);

  const preview = ZX.flows.planedit.probe('move', DATES[1]);
  assert.equal(preview.ok, false);
  assert.match(preview.reason, /不足|冲突/);
  assert.strictEqual(S.placementModel, originalModel);
  assert.deepEqual(plain(S.placementModel), before);
  assert.equal(renders(), 0);
  assert.equal(ops.length, 0);

  assert.equal(ZX.flows.planedit.moveTask('move', DATES[1]), false);
  assert.strictEqual(S.placementModel, originalModel);
  assert.deepEqual(plain(S.placementModel), before);
  assert.equal(renders(), 0);
  assert.equal(ops.length, 0);
  assert.match(toasts.at(-1).message, /不足|冲突/);
  assert.equal(toasts.at(-1).type, 'warn');
});

test('v3 普通容量不足时使用弹性，保留原始终段并同步用量、投影和今日缓冲', () => {
  const { ZX, ops, toasts, renders } = boot();
  const tasks = [task('move', 30), task('full', 60)];
  const model = makeModel(tasks, [
    block('move-old', 'move', DATES[0], 480, 30),
    block('full-old', 'full', DATES[1], 480, 60)
  ], DATES.map(() => [60, 60]));
  const S = install(ZX, tasks, model);
  const originalModel = S.placementModel;
  const originalSegments = plain(placements(originalModel, 'move').originalSegments);
  const before = plain(originalModel);

  const nativeMove = P.moveTask;
  let probeInput = null;
  P.moveTask = function (input) {
    probeInput = input;
    return nativeMove.apply(P, arguments);
  };
  let preview;
  try {
    preview = ZX.flows.planedit.probe('move', DATES[1]);
  } finally {
    P.moveTask = nativeMove;
  }
  assert.equal(preview.ok, true);
  assert.notStrictEqual(probeInput, originalModel);
  assert.strictEqual(S.placementModel, originalModel);
  assert.deepEqual(plain(S.placementModel), before);
  assert.deepEqual(P.taskSegments(preview.model, 'move').map(seg => [seg.date, seg.durMin, seg.isBuffer]), [[DATES[1], 30, true]]);

  assert.equal(ZX.flows.planedit.moveTask('move', DATES[1]), true);
  assert.notStrictEqual(S.placementModel, originalModel);
  assert.deepEqual(plain(placements(originalModel, 'move').originalSegments), originalSegments);
  assert.deepEqual(plain(placements(S.placementModel, 'move').originalSegments), originalSegments);
  assert.deepEqual(P.taskSegments(S.placementModel, 'move').map(seg => [seg.date, seg.durMin, seg.isBuffer]), [[DATES[1], 30, true]]);
  assert.deepEqual(plain(S.week), plain(P.projectWeek(S.placementModel, S.tasks)));
  assert.deepEqual(plain(S.weekShift), plain(S.week));
  assert.deepEqual(plain(S.dayAssign), { move: '二', full: '二' });
  assert.deepEqual(plain(S.buffer), { time: '09:00–10:00', free: false, keep: '保留字段' });

  const loads = ZX.flows.planedit.loads();
  assert.deepEqual(plain(loads[DATES[1]]), {
    base: 0, normalUsed: 60, bufferUsed: 30, total: 90,
    capacity: 60, bufferCapacity: 60, inMin: 0, outMin: 0
  });
  assert.strictEqual(loads[DATES[1]], loads['二']);
  assert.equal(ZX.flows.planedit.assignOf('move'), DATES[1]);
  assert.equal(ZX.flows.planedit.movedCount(), 1);
  const deltas = ZX.flows.planedit.weekDeltas();
  assert.equal(deltas[DATES[0]], -30);
  assert.equal(deltas['一'], -30);
  assert.equal(deltas[DATES[1]], 30);
  assert.equal(deltas['二'], 30);
  assert.equal(Object.values(deltas).reduce((sum, value) => sum + value, 0), 0);
  assert.equal(renders(), 1);
  assert.equal(ops.length, 1);
  assert.deepEqual(plain(ops[0]), {
    entity: 'plan', entityId: 'dayAssign', field: 'moved',
    value: { taskId: 'move', date: DATES[1], day: '二' }
  });
  const toast = toasts.at(-1);
  assert.equal(toast.type, 'ok');
  assert.match(toast.message, /普通已用 60\/60 分钟/);
  assert.match(toast.message, /弹性已用 30\/60 分钟/);
  assert.match(toast.message, /总容量 120 分钟/);
  assert.match(toast.message, /代价是抗中断余量减少/);
  assert.match(toast.message, /压缩或顺延/);

  const committed = S.placementModel;
  assert.equal(ZX.flows.planedit.moveTask('move', DATES[1]), true);
  assert.strictEqual(S.placementModel, committed);
  assert.equal(renders(), 1);
  assert.equal(ops.length, 1);
});

test('v3 拖动跨日任务的任一段都会移动整任务，并按日期/星期返回原始终段差值', () => {
  const { ZX } = boot();
  const tasks = [task('cross', 50)];
  const model = makeModel(tasks, [
    block('cross-a', 'cross', DATES[0], 480, 20),
    block('cross-b', 'cross', DATES[1], 480, 30)
  ]);
  const S = install(ZX, tasks, model);
  const original = plain(placements(S.placementModel, 'cross').originalSegments);

  const preview = ZX.flows.planedit.probe('cross', DATES[2]);
  assert.equal(preview.ok, true);
  assert.strictEqual(S.placementModel, model);
  assert.equal(ZX.flows.planedit.moveTask('cross', DATES[2]), true);
  assert.deepEqual(P.taskSegments(S.placementModel, 'cross').map(seg => [seg.date, seg.durMin]), [[DATES[2], 50]]);
  assert.deepEqual(plain(placements(S.placementModel, 'cross').originalSegments), original);
  assert.equal(ZX.flows.planedit.assignOf('cross'), DATES[2]);
  assert.equal(ZX.flows.planedit.movedCount(), 1);

  const deltas = ZX.flows.planedit.weekDeltas();
  assert.equal(deltas[DATES[0]], -20);
  assert.equal(deltas['一'], -20);
  assert.equal(deltas[DATES[1]], -30);
  assert.equal(deltas['二'], -30);
  assert.equal(deltas[DATES[2]], 50);
  assert.equal(deltas['三'], 50);
  const html = ZX.flows.planedit.board();
  assert.ok(!column(html, DATES[0]).includes('data-pe-task="cross"'));
  assert.ok(!column(html, DATES[1]).includes('data-pe-task="cross"'));
  assert.match(column(html, DATES[2]), /data-pe-task="cross"/);
  assert.match(column(html, DATES[2]), /data-pe-dur="50"/);
});

test('v3 计划板过滤暂缓/完成/跳过/退役任务，锁定段可见但不可移动', () => {
  const { ZX, ops, renders } = boot();
  const tasks = [
    task('open', 20),
    task('locked', 20, { title: '锁定任务' }),
    task('done', 20, { title: '已完成任务', done: true }),
    task('skipped', 20, { title: '已跳过任务', skipped: true }),
    task('deferred', 20, { title: '暂缓任务', deferred: true }),
    task('abandoned', 20, { title: '已放弃任务', abandoned: true }),
    task('substituted', 20, { title: '已替代任务', substituted: true })
  ];
  const model = makeModel(tasks, tasks.map((item, index) =>
    block('block-' + item.id, item.id, DATES[0], 480 + index * 30, 20)),
  [[300, 60], ...DATES.slice(1).map(() => [120, 60])]);
  const S = install(ZX, tasks, model);
  S.locks = { locked: true };
  const before = plain(S.placementModel);

  const html = ZX.flows.planedit.board();
  assert.ok(html.includes('data-pe-task="open"'));
  assert.match(html, /data-pe-task="locked"[^>]*draggable="false"/);
  assert.match(html, /已锁定/);
  for (const id of ['done', 'skipped', 'deferred', 'abandoned', 'substituted']) {
    assert.ok(!html.includes('data-pe-task="' + id + '"'), id);
    assert.equal(ZX.flows.planedit.probe(id, DATES[1]), null, id);
    assert.equal(ZX.flows.planedit.moveTask(id, DATES[1]), false, id);
  }
  assert.equal(ZX.flows.planedit.probe('locked', DATES[1]), null);
  assert.equal(ZX.flows.planedit.moveTask('locked', DATES[1]), false);
  assert.deepEqual(plain(S.placementModel), before);
  assert.equal(renders(), 0);
  assert.equal(ops.length, 0);
});

test('v3 veto 只恢复目标任务的落点，compress 同时恢复 est/time且不覆盖其他结果', () => {
  const { ZX, ops } = boot();
  const tasks = [
    task('a', 100, { title: '压缩任务', time: '08:00–09:50' }),
    task('b', 80, { title: '其他重排任务', time: '08:00–09:20' }),
    task('c', 60, { title: '顺延任务', time: '08:00–09:00' })
  ];
  const beforeModel = makeModel(tasks, [
    block('a-normal', 'a', DATES[0], 480, 50),
    block('a-buffer', 'a', DATES[0], 600, 50, true),
    block('b-old', 'b', DATES[1], 480, 80),
    block('c-old', 'c', DATES[2], 480, 60)
  ]);
  const S = install(ZX, tasks, beforeModel);
  const beforeTasks = plain(S.tasks);
  let afterModel = P.moveTask(beforeModel, 'a', DATES[3]).model;
  afterModel = P.moveTask(afterModel, 'b', DATES[4]).model;
  afterModel = P.moveTask(afterModel, 'c', DATES[5]).model;
  S.placementModel = afterModel;
  S.tasks.find(item => item.id === 'a').est = 60;
  S.tasks.find(item => item.id === 'a').time = '18:00–19:00';
  S.tasks.find(item => item.id === 'a').compressed = true;
  S.tasks.find(item => item.id === 'a').degraded = 'degraded';
  S.tasks.find(item => item.id === 'b').est = 70;
  S.tasks.find(item => item.id === 'b').time = '10:00–11:10';
  S.tasks.find(item => item.id === 'b').note = '其他结果必须保留';
  S.tasks.find(item => item.id === 'c').time = '12:00–13:00';
  S.snapshot = { tasks: beforeTasks, beforePlacementModel: beforeModel };
  S.replanRecord = { diff: [
    { taskId: 'a', op: 'compress' }, { taskId: 'b', op: 'defer' }, { taskId: 'c', op: 'defer' }
  ] };
  const bAfter = plain(P.taskSegments(afterModel, 'b'));
  const cAfter = plain(P.taskSegments(afterModel, 'c'));
  const originals = plain(afterModel.placements.map(item => item.originalSegments));

  const bTask = plain(S.tasks.find(item => item.id === 'b'));
  const snapshotBefore = plain(S.snapshot);

  assert.notEqual(ZX.flows.planedit.veto('a', 'compress'), false);
  assert.deepEqual(plain(P.taskSegments(S.placementModel, 'a')), plain(P.taskSegments(beforeModel, 'a')));
  assert.deepEqual(plain(P.taskSegments(S.placementModel, 'b')), bAfter);
  assert.deepEqual(plain(P.taskSegments(S.placementModel, 'c')), cAfter);
  assert.deepEqual(plain(S.placementModel.placements.map(item => item.originalSegments)), originals);
  const aTask = S.tasks.find(item => item.id === 'a');
  assert.equal(aTask.est, 100);
  assert.equal(aTask.time, beforeTasks.find(item => item.id === 'a').time, 'compress 否决必须恢复快照 time');
  assert.equal(aTask.compressed, undefined);
  assert.equal(aTask.degraded, undefined);
  assert.equal(S.tasks.find(item => item.id === 'b').est, bTask.est);
  assert.equal(S.tasks.find(item => item.id === 'b').note, bTask.note);

  assert.notEqual(ZX.flows.planedit.veto('c', 'defer'), false);
  assert.deepEqual(plain(P.taskSegments(S.placementModel, 'c')), plain(P.taskSegments(beforeModel, 'c')));
  assert.deepEqual(plain(P.taskSegments(S.placementModel, 'b')), bAfter);
  assert.equal(S.tasks.find(item => item.id === 'c').time, '08:00–09:00');
  assert.equal(S.tasks.find(item => item.id === 'b').est, bTask.est);
  assert.equal(S.tasks.find(item => item.id === 'b').note, bTask.note);
  assert.deepEqual(plain(S.placementModel.placements.map(item => item.originalSegments)), originals);
  assert.deepEqual(plain(S.week), plain(P.projectWeek(S.placementModel, S.tasks)));
  assert.deepEqual(plain(S.weekShift), plain(S.week));
  assert.deepEqual(plain(S.snapshot), snapshotBefore);
  assert.deepEqual(plain(S.replanRecord.vetoed.map(item => [item.taskId, item.op])), [['a', 'compress'], ['c', 'defer']]);
  assert.equal(ZX.flows.planedit.movedCount(), 1);
  assert.equal(ops.filter(op => op.field === 'vetoed').length, 2);
});

test('v3 顺延否决从恢复模型重投影 date/time，CSV 与完整备份持久化后保持一致', () => {
  const disk = new Map();
  const { ZX } = boot(disk, true);
  const moved = task('moved', 60, { date: DATES[2], time: '11-18 08:00–11-19 09:30' });
  const other = task('other', 30, { date: DATES[1], time: '10:00–10:30' });
  const beforeModel = makeModel([moved, other], [
    block('moved-a', 'moved', DATES[2], 480, 30),
    block('moved-b', 'moved', DATES[3], 540, 30),
    block('other-a', 'other', DATES[1], 600, 30, true)
  ]);
  const S = install(ZX, [moved, other], beforeModel);
  S.placementModel = P.moveTask(beforeModel, 'moved', DATES[5]).model;
  S.tasks.find(item => item.id === 'moved').date = DATES[5];
  S.tasks.find(item => item.id === 'moved').time = '18:00–19:00';
  S.snapshot = { tasks: [plain(moved), plain(other)], beforePlacementModel: beforeModel };
  S.replanRecord = {};
  const otherBefore = plain(S.tasks.find(item => item.id === 'other'));

  assert.equal(ZX.flows.planedit.veto('moved', 'defer'), true);
  const restored = S.tasks.find(item => item.id === 'moved');
  assert.equal(restored.date, DATES[2]);
  assert.equal(restored.time, '11-18 08:00–11-19 09:30');
  assert.deepEqual(plain(S.tasks.find(item => item.id === 'other')), otherBefore, '不得改动其他任务的落点或业务字段');
  assert.match(ZX.settings.csv(), /任务,moved,数学,任务-moved,60,,0,未开始,2026-11-18,/);
  assert.equal(ZX.settings.exportBackup().snapshot.tasks.find(item => item.id === 'moved').date, DATES[2]);

  const persisted = JSON.parse(disk.get('zx.overlay')).tasks.find(item => item.id === 'moved');
  assert.equal(persisted.date, DATES[2]);
  assert.equal(persisted.time, '11-18 08:00–11-19 09:30');
  const refreshed = boot(new Map(), true).ZX;
  refreshed.state.applySnapshot(JSON.parse(disk.get('zx.overlay')));
  assert.equal(refreshed.state.localLoadFailed, false);
  assert.equal(refreshed.state.tasks.find(item => item.id === 'moved').date, DATES[2]);
  assert.equal(refreshed.state.tasks.find(item => item.id === 'moved').time, '11-18 08:00–11-19 09:30');
  assert.match(refreshed.settings.csv(), /任务,moved,数学,任务-moved,60,,0,未开始,2026-11-18,/);
  assert.equal(refreshed.settings.exportBackup().snapshot.tasks.find(item => item.id === 'moved').date, DATES[2]);
});

test('v3 veto 恢复落点若与其他任务冲突，归一化失败时不部分写入', () => {
  const { ZX, ops, toasts, renders } = boot();
  const tasks = [task('a', 60), task('b', 60)];
  const base = makeModel(tasks, [
    block('a-original', 'a', DATES[0], 480, 60),
    block('b-original', 'b', DATES[2], 480, 60)
  ]);
  const beforeModel = P.moveTask(base, 'a', DATES[1]).model;
  placements(beforeModel, 'a').currentSegments[0].blockId = 'shared-id';
  const normalizedBefore = P.normalizeModel(beforeModel);
  let afterModel = P.moveTask(normalizedBefore, 'a', DATES[3]).model;
  placements(afterModel, 'a').currentSegments[0].blockId = 'a-after-id';
  afterModel = P.normalizeModel(afterModel);
  afterModel = P.moveTask(afterModel, 'b', DATES[1]).model;
  placements(afterModel, 'b').currentSegments[0].blockId = 'shared-id';
  afterModel = P.normalizeModel(afterModel);
  const S = install(ZX, tasks, afterModel);
  S.tasks[0].est = 30;
  S.tasks[0].time = '18:00–18:30';
  S.tasks[0].compressed = true;
  S.snapshot = { tasks: [task('a', 60)], beforePlacementModel: beforeModel };
  S.replanRecord = {};
  const currentModel = S.placementModel;
  const before = plain({ model: S.placementModel, tasks: S.tasks, week: S.week, dayAssign: S.dayAssign });

  assert.equal(ZX.flows.planedit.veto('a', 'compress'), false);
  assert.deepEqual(plain(S.placementModel), plain(currentModel));
  assert.deepEqual(plain({ model: S.placementModel, tasks: S.tasks, week: S.week, dayAssign: S.dayAssign }), before);
  assert.equal(S.replanRecord.vetoed, undefined);
  assert.match(toasts.at(-1).message, /校验失败/);
  assert.equal(toasts.at(-1).type, 'warn');
  assert.equal(ops.length, 0);
  assert.equal(renders(), 0);
});

test('v3 veto 的 compress/defer 在快照不足时明确拒绝且不部分写入', () => {
  const { ZX, ops, toasts, renders } = boot();
  const tasks = [task('a', 60)];
  const model = makeModel(tasks, [block('a-old', 'a', DATES[0], 480, 60)]);
  const S = install(ZX, tasks, model);
  const before = plain({ model: S.placementModel, tasks: S.tasks, week: S.week, dayAssign: S.dayAssign });

  for (const op of ['compress', 'defer']) {
    S.snapshot = op === 'compress' ? { tasks: plain(S.tasks) } : {};
    S.replanRecord = {};
    assert.equal(ZX.flows.planedit.veto('a', op), false);
    assert.equal(S.replanRecord.vetoed, undefined);
    assert.match(toasts.at(-1).message, /快照.*缺少|缺少.* est\/time/);
    assert.equal(toasts.at(-1).type, 'warn');
    assert.deepEqual(plain({ model: S.placementModel, tasks: S.tasks, week: S.week, dayAssign: S.dayAssign }), before);
  }
  S.snapshot = { beforePlacementModel: model, tasks: [{ id: 'a', est: 60 }] };
  S.replanRecord = {};
  assert.equal(ZX.flows.planedit.veto('a', 'compress'), false);
  assert.match(toasts.at(-1).message, /est\/time/);
  assert.equal(S.replanRecord.vetoed, undefined);
  assert.equal(ops.length, 0);
  assert.equal(renders(), 0);
});

test('旧模式保留周标签、增量负载、改期队列和压缩否决回归', () => {
  const { ZX, ops, toasts, renders } = boot();
  const S = ZX.state;
  S.placementModel = null;
  S.tasks = [
    S.normTask(task('a', 30, { title: '旧任务甲' })),
    S.normTask(task('b', 40, { title: '旧任务乙' })),
    S.normTask(task('deferred', 50, { title: '旧暂缓任务', deferred: true }))
  ];
  S.week = WEEKDAYS.map(day => ({ d: day, total: day === '日' ? 100 : 20, buf: 60, segs: [] }));
  S.dayAssign = { a: '一', deferred: '二' };
  S.locks = {};
  S.user.dailyCapMin = 300;

  const loads = ZX.flows.planedit.loads();
  assert.deepEqual(plain(loads['日']), { base: 100, inMin: 0, outMin: 30, total: 70 });
  assert.deepEqual(plain(loads['一']), { base: 20, inMin: 30, outMin: 0, total: 50 });
  assert.equal(ZX.flows.planedit.movedCount(), 1);
  assert.equal(ZX.flows.planedit.weekDeltas()['一'], 30);
  assert.equal(ZX.flows.planedit.weekDeltas()['日'], -30);
  const html = ZX.flows.planedit.board();
  assert.ok(html.includes('data-pe-day="一"'));
  assert.ok(!html.includes('data-pe-day="2026-11-16"'));
  assert.ok(!html.includes('data-pe-task="deferred"'));
  assert.equal(ZX.flows.planedit.probe('deferred', '三'), null);

  const before = plain(S.dayAssign);
  const preview = ZX.flows.planedit.probe('a', '二');
  assert.equal(preview.ok, true);
  assert.equal(preview.load, 50);
  assert.deepEqual(plain(S.dayAssign), before);
  assert.equal(ZX.flows.planedit.moveTask('a', '二'), true);
  assert.deepEqual(plain(S.dayAssign), { a: '二', deferred: '二' });
  assert.equal(ZX.flows.planedit.loads()['二'].total, 50);
  assert.deepEqual(plain(ops[0]), {
    entity: 'plan', entityId: 'dayAssign', field: 'moved', value: { taskId: 'a', day: '二' }
  });
  assert.match(toasts.at(-1).message, /已移到周二 · 当日 50 \/ 300 分钟/);
  assert.equal(renders(), 1);

  S.user.dailyCapMin = 40;
  const dayAssign = plain(S.dayAssign);
  assert.equal(ZX.flows.planedit.moveTask('b', '二'), false);
  assert.deepEqual(plain(S.dayAssign), dayAssign);
  assert.match(toasts.at(-1).message, /将达 90 分钟，超过日上限 40/);

  S.snapshot = { tasks: [{ id: 'a', est: 60, time: 'Snapshot time' }] };
  S.tasks[0].est = 30;
  S.tasks[0].time = '09:00–09:30';
  S.tasks[0].compressed = true;
  S.replanRecord = {};
  ZX.flows.planedit.veto('a', 'compress');
  assert.equal(S.tasks[0].est, 60);
  assert.equal(S.tasks[0].time, '09:00–09:30');
  assert.equal(S.tasks[0].compressed, undefined);
  assert.match(toasts.at(-1).message, /已否决这条压缩 · 工时已恢复/);
  ZX.flows.planedit.veto('deferred', 'defer');
  assert.equal(S.tasks[2].deferred, true);
});

test('生产否决按钮绑定草案与计划版本，旧卡不会修改当前结果', () => {
  const { ZX, toasts } = boot();
  const S = ZX.state;
  S.tasks = [S.normTask(task('a', 35, { compressed: true }))];
  S.snapshot = { tasks: [task('a', 60)] };
  S.replanRecord = { vetoContext: { draftId: 'draft-current', planVersion: 'plan-current' } };
  const before = plain(S.tasks);
  assert.equal(ZX.flows.planedit.veto('a', 'compress', null, 'draft-old', 'plan-old'), false);
  assert.deepEqual(plain(S.tasks), before);
  assert.match(toasts.at(-1).message, /已失效/);
  assert.equal(ZX.flows.planedit.veto('a', 'compress', null, 'draft-current', 'plan-current'), true);
  assert.equal(S.tasks[0].est, 60);
});
