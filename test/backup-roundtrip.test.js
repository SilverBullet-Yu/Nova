'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const H = require('./helpers');
const P = require('../shared/placement-model.js');
const seed = require('../shared/data/seed.js');

const plain = value => JSON.parse(JSON.stringify(value));
const read = (disk, key) => disk.has(key) ? disk.get(key) : null;

// 全部状态都在 Map 中；不加载 main.js、服务端或真实浏览器存储。
function boot(disk = new Map()) {
  const stored = H.storage(disk);
  const faults = { trash: 0, overlay: 0, discardOverlay: 0, corruptOverlay: 0, overlayRemoveRead: 0 };
  const localStorage = {
    getItem(key) { return stored.localStorage.getItem(key); },
    setItem(key, value) {
      if (key === 'zx.trash' && faults.trash > 0) { faults.trash--; throw new Error('quota'); }
      if (key === 'zx.overlay' && faults.overlay > 0) { faults.overlay--; throw new Error('quota'); }
      if (key === 'zx.overlay' && faults.discardOverlay > 0) { faults.discardOverlay--; return; }
      if (key === 'zx.overlay' && faults.corruptOverlay > 0) { faults.corruptOverlay--; disk.set(key, '{broken'); return; }
      stored.localStorage.setItem(key, value);
    },
    removeItem(key) {
      stored.localStorage.removeItem(key);
      if (key === 'zx.overlay' && faults.overlayRemoveRead > 0) {
        faults.overlayRemoveRead--;
        throw new Error('overlay remove readback failed');
      }
    }
  };
  const notices = [];
  const warnings = [];
  const confirmCalls = [];
  let confirmResult = true;
  const listeners = { click: [], change: [], storage: [] };
  const input = {
    files: [], value: '', clicks: 0, listeners: {},
    click() { this.clicks++; },
    addEventListener(name, fn) { this.listeners[name] = fn; }
  };
  const elements = {
    '#backupFileInput': input,
    '#saveWarning': { hidden: true, textContent: '' }
  };
  const document = {
    readyState: 'loading',
    addEventListener(name, fn) { (listeners[name] ||= []).push(fn); },
    querySelector(selector) { return elements[selector] || null; },
    querySelectorAll() { return []; },
    getElementById(id) { return elements['#' + id] || null; }
  };
  const ZX = {
    api: { queueOp() {}, invalidatePendingSync() {}, clearPendingPlan() { stored.localStorage.removeItem('zx.pending_plan'); }, pendingCount: () => 0 },
    ui: {
      confirm: async options => { confirmCalls.push(options); return confirmResult; },
      toast: (message, kind) => notices.push([message, kind || ''])
    },
    render: options => { if (!(options && options.skipOverlaySave)) ZX.state.saveOverlay(); }
  };
  const window = {
    ZX, Rhythm: { seed, placementModel: P }, localStorage, document,
    location: { reload() {} },
    addEventListener(name, fn) { (listeners[name] ||= []).push(fn); },
    console: { warn: message => warnings.push(message) }
  };
  const sandbox = { window, document, localStorage, crypto: globalThis.crypto, setTimeout: fn => fn() };
  H.installUtil(sandbox);
  const context = vm.createContext(sandbox);
  for (const file of ['assets/js/state.js', 'assets/js/flows/settings.js']) {
    vm.runInContext(fs.readFileSync(require.resolve('../' + file), 'utf8'), context, { filename: file });
  }
  return {
    ZX, disk, faults, input, notices, warnings, confirmCalls, listeners,
    setConfirm: value => { confirmResult = value; }
  };
}

function populate(app, title = '完整备份任务') {
  const S = app.ZX.state;
  S.tasks[0].title = title;
  S.sessions = [{ id: 's-backup', taskId: S.tasks[0].id, minutes: 37, status: 'done', completion: 100, startAt: 123 }];
  S.goal = { name: '备份目标', deadline: '2027-01-01', weeks: 12, source: 'user' };
  S.feas = { weeklyH: 21, weeks: 12, discount: 0.9, demand: 456 };
  S.week[0].total = 111;
  S.weekShift[1].total = 122;
  S.dayAssign = { [S.tasks[0].id]: '三' };
  S.locks = { [S.tasks[0].id]: true };
  S.avail = Array.from({ length: 7 }, () => [false, false, false, false]);
  S.avail[2][1] = true;
  S.availSource = 'user';
  S.notif = { daily: false, weekly: true, alert: false, rescue: true, extra: true };
  S.attrCounts = { '效率不足': 2 };
  S.replanHistory = [{ at: 123, loadDelta: 0.1, undone: false }];
  S.snapshot = { tasks: plain(S.tasks), week: plain(S.week), timestamp: 123 };
  S.replanned = true;
  assert.equal(S.saveOverlay(), true);
  return plain(S.exportSnapshot());
}

function validBackup(app) {
  return app.ZX.settings.exportBackup();
}

test('legacy 弹性占用与降载防重纳入可选 overlay/备份字段且可恢复', async () => {
  const source = boot();
  const S = source.ZX.state;
  S.placementModel = null;
  S.buffer = Object.assign({}, S.buffer, { free: false, time: '20:30–21:30' });
  S.tiredAdopted = true;
  assert.equal(S.saveOverlay(), true);
  const raw = JSON.parse(source.disk.get('zx.overlay'));
  assert.equal(raw.buffer.free, false);
  assert.equal(raw.tiredAdopted, true);

  const reloaded = boot(source.disk).ZX.state;
  assert.equal(reloaded.buffer.free, false);
  assert.equal(reloaded.tiredAdopted, true);
  const backup = source.ZX.settings.exportBackup();
  assert.equal(backup.snapshot.buffer.free, false);
  assert.equal(backup.snapshot.tiredAdopted, true);

  const target = boot();
  assert.equal(await target.ZX.settings.importBackup(JSON.stringify(backup)), true);
  assert.equal(target.ZX.state.buffer.free, false);
  assert.equal(target.ZX.state.tiredAdopted, true);
});

test('v3 模型不持久化 legacy 弹性布尔与降载防重，避免双重真值', () => {
  const app = boot();
  const S = app.ZX.state;
  const taskId = S.tasks[0].id;
  const dates = Array.from({ length: 7 }, (_, i) => '2026-11-' + String(23 + i).padStart(2, '0'));
  S.placementModel = P.createModel({
    startDate: dates[0], timezone: 'UTC', idPrefix: 'optional-v3_',
    tasks: [{ id: taskId, subject: '数学', estMin: 30 }],
    slots: dates.map(date => ({ date, startMin: 480, durMin: 60, isBuffer: false })),
    blocks: [{ id: 'optional-v3-block', taskId, date: dates[0], startMin: 480, durMin: 30 }],
    unplanned: []
  });
  S.buffer.free = false;
  S.tiredAdopted = true;
  assert.equal(S.saveOverlay(), true);
  const raw = JSON.parse(app.disk.get('zx.overlay'));
  assert.equal(Object.hasOwn(raw, 'buffer'), false);
  assert.equal(Object.hasOwn(raw, 'tiredAdopted'), false);
});

test('双标签页旧版本保存被拒绝，不覆盖另一页的新业务数据', () => {
  const disk = new Map();
  const first = boot(disk);
  populate(first, '标签页 A 基线');
  const stale = boot(disk);
  stale.ZX.state.tasks[0].title = '标签页 B 未保存修改';

  first.ZX.state.tasks[0].title = '标签页 A 新修改';
  assert.equal(first.ZX.state.saveOverlay(), true);
  const before = disk.get('zx.overlay');

  assert.equal(stale.ZX.state.saveOverlay(), false);
  assert.equal(disk.get('zx.overlay'), before);
  assert.equal(JSON.parse(before).tasks[0].title, '标签页 A 新修改');
  assert.equal(stale.ZX.state.tasks[0].title, '标签页 B 未保存修改');
  assert.equal(stale.ZX.state.overlayConflict, true);
  assert.equal(stale.ZX.state.overlaySaveFailed, true);
});

test('双标签页删除冲突会拒绝 dropOverlay，干净页可接受仅元数据变化', () => {
  const disk = new Map();
  const first = boot(disk);
  populate(first, '标签页 A 基线');
  const stale = boot(disk);
  const clean = boot(disk);
  const baseline = disk.get('zx.overlay');

  first.ZX.state.tasks[0].title = '另一页更新';
  assert.equal(first.ZX.state.saveOverlay(), true);
  assert.equal(stale.ZX.state.dropOverlay(), false);
  assert.equal(JSON.parse(disk.get('zx.overlay')).tasks[0].title, '另一页更新');

  const metadataOnly = JSON.parse(baseline);
  metadataOnly.revision += 1;
  metadataOnly.updatedAt += 1;
  disk.set('zx.overlay', JSON.stringify(metadataOnly));
  assert.equal(clean.ZX.state.saveOverlay(), true);
  assert.equal(JSON.parse(disk.get('zx.overlay')).tasks[0].title, '标签页 A 基线');
  assert.equal(clean.ZX.state.overlayConflict, false);
});

test('storage 事件发现本地未保存修改时锁定冲突，显式重载才解除', () => {
  const disk = new Map();
  const first = boot(disk);
  populate(first, '事件基线');
  const second = boot(disk);
  second.ZX.state.tasks[0].title = '事件页未保存修改';
  first.ZX.state.tasks[0].title = '外部新值';
  assert.equal(first.ZX.state.saveOverlay(), true);

  for (const listener of second.listeners.storage) {
    listener({ key: 'zx.overlay', newValue: disk.get('zx.overlay'), storageArea: second.ZX });
  }
  assert.equal(second.ZX.state.overlayConflict, true);
  assert.equal(second.ZX.state.saveOverlay(), false);
  assert.equal(JSON.parse(disk.get('zx.overlay')).tasks[0].title, '外部新值');
  assert.equal(second.ZX.state.applyOverlay(), true);
  assert.equal(second.ZX.state.overlayConflict, false);
  assert.equal(second.ZX.state.tasks[0].title, '外部新值');
});

test('v1 overlay 可读并在启动保存时升级为 v3，installId 稳定且 revision 递增', () => {
  const disk = new Map();
  const first = boot(disk);
  const expected = populate(first);
  const v1 = JSON.parse(disk.get('zx.overlay'));
  for (const key of ['format', 'version', 'installId', 'syncMode', 'revision', 'updatedAt']) delete v1[key];
  disk.set('zx.overlay', JSON.stringify(v1));

  const upgraded = boot(disk);
  assert.equal(upgraded.ZX.state.localLoadFailed, false);
  assert.deepEqual(plain(upgraded.ZX.state.exportSnapshot()), expected);
  assert.equal(upgraded.ZX.state.saveOverlay(), true);
  const overlay = JSON.parse(disk.get('zx.overlay'));
  assert.equal(overlay.format, 'nova-overlay');
  assert.equal(overlay.version, 3);
  assert.equal(overlay.syncMode, 'local-only');
  assert.equal(overlay.revision, 1);
  assert.equal(typeof overlay.updatedAt, 'number');
  assert.match(overlay.installId, /^install-[0-9a-f]{32}$/);
  assert.equal(disk.get('zx.install_id'), overlay.installId);
  assert.equal(upgraded.ZX.state.saveOverlay(), true);
  assert.equal(JSON.parse(disk.get('zx.overlay')).revision, 2);
  assert.equal(boot(disk).ZX.state.getInstallId(), overlay.installId);
});

test('完整备份往返保留全部业务字段，覆盖前快照可经 7 天 trash 恢复', async () => {
  const source = boot();
  const expected = populate(source);
  const backup = validBackup(source);
  assert.equal(backup.format, 'nova-backup');
  assert.equal(backup.version, 1);
  assert.ok(Number.isFinite(Date.parse(backup.createdAt)));
  assert.deepEqual(plain(backup.snapshot), expected);

  const target = boot();
  const previous = populate(target, '覆盖前任务');
  const previousInstall = target.ZX.state.getInstallId();
  assert.notEqual(previousInstall, backup.installId);
  assert.equal(await target.ZX.settings.importBackup(JSON.stringify(backup)), true);
  assert.equal(target.confirmCalls.length, 1);
  assert.deepEqual(plain(target.ZX.state.exportSnapshot()), expected);
  assert.deepEqual(plain(boot(target.disk).ZX.state.exportSnapshot()), expected);
  const overlay = JSON.parse(target.disk.get('zx.overlay'));
  assert.equal(overlay.installId, previousInstall, '导入源 installId 不得替换本机标识');
  assert.equal(overlay.syncMode, 'local-only');
  const trash = JSON.parse(target.disk.get('zx.trash'));
  assert.equal(typeof trash.at, 'number');
  assert.deepEqual(plain(trash.snapshot), previous);

  assert.equal(await target.ZX.settings.restore(), true);
  assert.deepEqual(plain(target.ZX.state.exportSnapshot()), previous);
  assert.equal(target.disk.has('zx.trash'), false);
});

test('备份拒绝 placementModel.unplanned 的悬空任务引用', async () => {
  const source = boot();
  populate(source);
  const backup = validBackup(source);
  const taskId = backup.snapshot.tasks[0].id;
  const dates = Array.from({ length: 7 }, (_, i) => '2026-11-' + String(23 + i).padStart(2, '0'));
  const model = P.createModel({
    startDate: dates[0], timezone: 'UTC', idPrefix: 'backup_',
    slots: dates.map(date => ({ date, startMin: 480, durMin: 60, isBuffer: false })),
    tasks: [{ id: taskId, subject: '数学', estMin: 30 }],
    blocks: [{ id: 'backup-block', taskId, date: dates[0], startMin: 480, durMin: 30 }],
    unplanned: []
  });
  model.unplanned.push({ taskId: 'missing-task', reason: '悬空引用' });
  backup.snapshot.placementModel = model;

  const target = boot();
  populate(target, '保留原任务');
  const before = target.disk.get('zx.overlay');
  assert.equal(await target.ZX.settings.importBackup(JSON.stringify(backup)), false);
  assert.equal(target.confirmCalls.length, 0);
  assert.equal(target.disk.get('zx.overlay'), before);
  assert.equal(target.disk.has('zx.trash'), false);
});

test('导入 commitSnapshot 后的重载校验失败会整笔回滚', async () => {
  const source = boot();
  populate(source, '导入任务');
  const target = boot();
  const previous = populate(target, '原任务');
  const before = target.disk.get('zx.overlay');
  const nativeReload = target.ZX.state.applyOverlay;
  let reloadCalls = 0;
  target.ZX.state.applyOverlay = function () {
    reloadCalls++;
    if (reloadCalls === 1) return false;
    return nativeReload();
  };
  assert.equal(await target.ZX.settings.importBackup(JSON.stringify(validBackup(source))), false);
  assert.equal(reloadCalls, 2, '回滚也应通过真实 overlay 重载路径');
  assert.equal(target.disk.get('zx.overlay'), before);
  assert.deepEqual(plain(target.ZX.state.exportSnapshot()), previous);
  assert.ok(target.notices.some(([message, kind]) => kind === 'warn' && /重载校验失败/.test(message)));
});

test('导入重载校验失败时不得回滚覆盖另一页的新写入', async () => {
  const source = boot();
  populate(source, '导入任务');
  const target = boot();
  populate(target, '原任务');
  const nativeReload = target.ZX.state.applyOverlay;
  let reloadCalls = 0;
  target.ZX.state.applyOverlay = function () {
    reloadCalls++;
    if (reloadCalls === 1) {
      const other = boot(target.disk);
      other.ZX.state.tasks[0].title = '另一页在导入期间写入';
      assert.equal(other.ZX.state.saveOverlay(), true);
      return false;
    }
    return nativeReload();
  };
  assert.equal(await target.ZX.settings.importBackup(JSON.stringify(validBackup(source))), false);
  assert.equal(JSON.parse(target.disk.get('zx.overlay')).tasks[0].title, '另一页在导入期间写入');
  assert.equal(target.ZX.state.tasks[0].title, '另一页在导入期间写入');
  assert.equal(target.disk.has('zx.trash'), false);
  assert.ok(target.notices.some(([message, kind]) => kind === 'warn' && /另一标签页/.test(message)));
});

test('导入提交后外部抢先写入时，回滚不得把外部字节误判为本次写入', async () => {
  const source = boot();
  populate(source, '导入任务');
  const target = boot();
  populate(target, '原任务');
  const nativeCommit = target.ZX.state.commitSnapshot;
  target.ZX.state.commitSnapshot = function (snapshot) {
    const committed = nativeCommit(snapshot);
    if (committed) {
      const other = boot(target.disk);
      other.ZX.state.tasks[0].title = '提交后另一页抢先写入';
      assert.equal(other.ZX.state.saveOverlay(), true);
    }
    return committed;
  };
  assert.equal(await target.ZX.settings.importBackup(JSON.stringify(validBackup(source))), false);
  assert.equal(JSON.parse(target.disk.get('zx.overlay')).tasks[0].title, '提交后另一页抢先写入');
  assert.equal(target.ZX.state.tasks[0].title, '提交后另一页抢先写入');
});

test('导入写入前发现外部删除时保留删除，不恢复旧 overlay', async () => {
  const source = boot();
  populate(source, '导入任务');
  const target = boot();
  populate(target, '原任务');
  const nativeCommit = target.ZX.state.commitSnapshot;
  target.ZX.state.commitSnapshot = function (snapshot) {
    target.disk.delete('zx.overlay');
    return nativeCommit(snapshot);
  };
  assert.equal(await target.ZX.settings.importBackup(JSON.stringify(validBackup(source))), false);
  assert.equal(target.disk.has('zx.overlay'), false);
  assert.equal(target.disk.has('zx.trash'), false);
  assert.ok(target.notices.some(([message, kind]) => kind === 'warn' && /另一标签页/.test(message)));
});

test('损坏 overlay 可显式删除，但外部变更时先保留回收站并拒绝删除', async () => {
  const corrupt = new Map([['zx.overlay', '{original-corrupt']]);
  const app = boot(corrupt);
  await app.ZX.settings.confirmWipe();
  assert.equal(corrupt.has('zx.overlay'), false);
  assert.ok(JSON.parse(corrupt.get('zx.trash')).snapshot);

  const disk = new Map();
  const first = boot(disk);
  populate(first, '删除基线');
  const stale = boot(disk);
  const oldTrash = '{ "at": 123, "snapshot": { "legacy": "保留" }, "padding": "  " }\n';
  disk.set('zx.trash', oldTrash);
  first.ZX.state.tasks[0].title = '另一页删除前更新';
  assert.equal(first.ZX.state.saveOverlay(), true);
  await stale.ZX.settings.confirmWipe();
  assert.equal(JSON.parse(disk.get('zx.overlay')).tasks[0].title, '另一页删除前更新');
  assert.equal(disk.get('zx.trash'), oldTrash);
});

test('删除已执行但回读异常时保留 trash 并明确提示', async () => {
  const app = boot();
  populate(app);
  app.faults.overlayRemoveRead = 1;
  await app.ZX.settings.confirmWipe();
  assert.equal(app.disk.has('zx.overlay'), false);
  assert.ok(app.disk.has('zx.trash'));
  assert.ok(app.notices.some(([message, kind]) => kind === 'warn' && /无法确认|回读/.test(message)));
});

test('不可读页面不得强制覆盖另一页已修复的有效 overlay', async () => {
  const disk = new Map();
  const source = boot(disk);
  populate(source, '导入备份');
  const backup = JSON.stringify(validBackup(source));
  source.ZX.state.tasks[0].title = '另一页已修复';
  assert.equal(source.ZX.state.saveOverlay(), true);
  const repaired = disk.get('zx.overlay');
  disk.set('zx.overlay', '{target-corrupt');
  const target = boot(disk);
  assert.equal(target.ZX.state.localLoadFailed, true);
  disk.set('zx.overlay', repaired);
  assert.equal(await target.ZX.settings.importBackup(backup), false);
  assert.equal(disk.get('zx.overlay'), repaired);
  assert.equal(target.ZX.state.tasks[0].title, '另一页已修复');
});

test('恢复成功不得删除另一页新写入的 trash', async () => {
  const app = boot();
  populate(app, '恢复任务');
  const originalTrash = JSON.stringify({ at: Date.now(), snapshot: app.ZX.state.exportSnapshot() });
  app.disk.set('zx.trash', originalTrash);
  const externalTrash = '{ "at": 9999999999999, "snapshot": { "external": "保留" }, "padding": "  " }\n';
  const nativeSave = app.ZX.state.saveOverlay;
  let injected = false;
  app.ZX.state.saveOverlay = function () {
    const saved = nativeSave();
    if (!injected) {
      injected = true;
      app.disk.set('zx.trash', externalTrash);
    }
    return saved;
  };
  assert.equal(await app.ZX.settings.restore(), true);
  assert.equal(app.disk.get('zx.trash'), externalTrash);
});

test('未来版本显式导入保留可读 revision 并递增', async () => {
  const source = boot();
  populate(source, '修复备份');
  const disk = new Map();
  populate(boot(disk));
  const future = JSON.parse(disk.get('zx.overlay'));
  future.version = 999;
  future.revision = 100;
  disk.set('zx.overlay', JSON.stringify(future));
  const app = boot(disk);
  assert.equal(app.ZX.state.localLoadFailed, true);
  assert.equal(await app.ZX.settings.importBackup(JSON.stringify(validBackup(source))), true);
  assert.equal(JSON.parse(disk.get('zx.overlay')).revision, 101);
});

test('完整备份导入校验和计时器复位成功后立即重绘，并保留成功提示', async () => {
  const source = boot();
  populate(source, '导入后重绘任务');
  const target = boot();
  populate(target, '导入前旧任务');
  target.ZX.state.running = target.ZX.state.tasks[0].id;
  target.ZX.state.timerStart = 123;
  const events = [];
  const nativeReset = target.ZX.state.resetTimer;
  target.ZX.state.resetTimer = function () {
    nativeReset();
    events.push('reset');
  };
  target.ZX.render = () => {
    events.push('render');
    assert.equal(target.ZX.state.tasks[0].title, '导入后重绘任务', '重绘必须读取导入后的内存状态');
    assert.equal(target.ZX.state.running, null, '重绘前必须已完成计时器复位');
  };

  assert.equal(await target.ZX.settings.importBackup(JSON.stringify(validBackup(source))), true);
  assert.deepEqual(events, ['reset', 'render']);
  assert.match(target.notices.at(-1)[0], /完整备份导入成功/);
});

test('成功导入和恢复都会复位计时器，失败导入不复位', async () => {
  const source = boot();
  populate(source, '导入任务');
  const backup = JSON.stringify(validBackup(source));
  const target = boot();
  populate(target, '原任务');
  const running = () => {
    target.ZX.state.running = target.ZX.state.tasks[0].id;
    target.ZX.state.timerStart = 123;
    target.ZX.state.pausedAt = 456;
    target.ZX.state.pausedTotal = 30;
  };
  const assertReset = () => {
    assert.equal(target.ZX.state.running, null);
    assert.equal(target.ZX.state.timerStart, null);
    assert.equal(target.ZX.state.pausedAt, null);
    assert.equal(target.ZX.state.pausedTotal, 0);
  };

  running();
  target.faults.overlay = 1;
  assert.equal(await target.ZX.settings.importBackup(backup), false);
  assert.equal(target.ZX.state.running, target.ZX.state.tasks[0].id);

  running();
  assert.equal(await target.ZX.settings.importBackup(backup), true);
  assertReset();
  running();
  assert.equal(await target.ZX.settings.restore(), true);
  assertReset();
});

test('完整备份与快照均不包含 token 或 legacy 操作队列', async () => {
  const app = boot();
  app.disk.set('zx.op_queue', JSON.stringify([{ token: 'queue-secret' }]));
  populate(app);
  app.ZX.state.token = 'token-secret';
  const snapshot = app.ZX.state.exportSnapshot();
  const backup = app.ZX.settings.exportBackup();
  for (const value of [snapshot, backup, backup.snapshot]) {
    assert.equal(Object.prototype.hasOwnProperty.call(value, 'token'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(value, 'opQueue'), false);
    assert.doesNotMatch(JSON.stringify(value), /token-secret|queue-secret|zx\.op_queue/);
  }
  assert.equal(app.disk.get('zx.op_queue'), JSON.stringify([{ token: 'queue-secret' }]));
  assert.match(app.ZX.settings.csv(), /完整备份任务/, 'CSV 导出仍兼容');
});

test('dropOverlay 只删除业务 overlay，旧队列与待复核计划字节不变', () => {
  const disk = new Map([
    ['zx.op_queue', '[ { "opId": "legacy-queue" } ]\n'],
    ['zx.pending_plan', '{ "plan": "待复核", "padding": "  " }\n']
  ]);
  const app = boot(disk);
  populate(app);
  const queue = disk.get('zx.op_queue');
  const pending = disk.get('zx.pending_plan');
  app.ZX.state.dropOverlay();
  assert.equal(disk.has('zx.overlay'), false);
  assert.equal(disk.get('zx.op_queue'), queue);
  assert.equal(disk.get('zx.pending_plan'), pending);
});

for (const [name, raw, kind] of [
  ['损坏 JSON', '{broken', 'corrupt'],
  ['未来版本', null, 'future-version'],
  ['非法业务结构', JSON.stringify({ tasks: 'not-an-array' }), 'invalid'],
  ['损坏的计划时段', JSON.stringify({ week: [{ segs: [null] }] }), 'invalid'],
  ['v2 元数据缺失', JSON.stringify({ format: 'nova-overlay', version: 2, tasks: [] }), 'invalid']
]) {
  test(name + ' 不被启动渲染或 saveOverlay 覆盖，并显示本地加载失败', () => {
    const disk = new Map();
    if (raw === null) {
      populate(boot(disk));
      const future = JSON.parse(disk.get('zx.overlay'));
      future.version = 999;
      disk.set('zx.overlay', JSON.stringify(future));
    } else disk.set('zx.overlay', raw);
    const before = disk.get('zx.overlay');
    const app = boot(disk);
    assert.equal(app.ZX.state.bootOverlayLoaded(), false);
    assert.equal(app.ZX.state.localLoadFailed, true);
    assert.equal(app.ZX.state.localLoadError.kind, kind);
    app.ZX.state.tasks = [];
    assert.equal(app.ZX.state.saveOverlay(), false);
    app.ZX.render();
    app.ZX.settings.init();
    assert.equal(disk.get('zx.overlay'), before);
    assert.equal(app.ZX.state.adoptServerState, undefined);
    assert.ok(app.warnings.some(message => /暂停覆盖/.test(message)));
    assert.ok(app.notices.some(([message]) => /本地数据加载失败/.test(message)));
    assert.throws(() => app.ZX.settings.exportBackup(), /加载失败/);
  });
}

for (const [name, fault] of [['trash 写入失败', 'trash'], ['overlay 写入失败', 'overlay'],
  ['overlay 写入被丢弃', 'discardOverlay']]) {
  test('导入' + name + ' 时恢复旧 overlay 与内存，无旧 trash 时不留下新 trash', async () => {
    const source = boot();
    populate(source, '导入任务');
    const backup = JSON.stringify(validBackup(source));
    const target = boot();
    const previous = populate(target, '原任务');
    const before = target.disk.get('zx.overlay');
    target.faults[fault] = 1;
    assert.equal(await target.ZX.settings.importBackup(backup), false);
    assert.equal(target.disk.get('zx.overlay'), before);
    assert.deepEqual(plain(target.ZX.state.exportSnapshot()), previous);
    assert.equal(target.ZX.state.localLoadFailed, false);
    assert.ok(target.notices.some(([message, kind]) => kind === 'warn' && /导入失败/.test(message)));
    assert.equal(target.disk.has('zx.trash'), false);
    assert.deepEqual(plain(boot(target.disk).ZX.state.exportSnapshot()), previous);
  });
}

test('导入回读出现意外内容时保留当前 raw 并进入加载熔断', async () => {
  const source = boot();
  populate(source, '导入任务');
  const target = boot();
  populate(target, '原任务');
  target.faults.corruptOverlay = 1;
  assert.equal(await target.ZX.settings.importBackup(JSON.stringify(validBackup(source))), false);
  assert.equal(target.disk.get('zx.overlay'), '{broken');
  assert.equal(target.ZX.state.localLoadFailed, true);
  assert.equal(target.disk.has('zx.trash'), false);
  assert.ok(target.notices.some(([message, kind]) => kind === 'warn' && /另一标签页|原数据未改变/.test(message)));
});

test('已有 trash 时导入失败保持原 trash 字节，回滚失败明确告警', async () => {
  const source = boot();
  populate(source, '导入任务');
  const backup = JSON.stringify(validBackup(source));
  for (const fault of ['trash', 'overlay']) {
    const target = boot();
    const previous = populate(target, '原任务');
    const before = target.disk.get('zx.overlay');
    const oldTrash = '{ "at": 123, "snapshot": { "legacy": "原样保留" }, "padding": "  " }\n';
    target.disk.set('zx.trash', oldTrash);
    target.faults[fault] = 1;
    assert.equal(await target.ZX.settings.importBackup(backup), false);
    assert.equal(target.disk.get('zx.overlay'), before);
    assert.equal(target.disk.get('zx.trash'), oldTrash);
    assert.deepEqual(plain(target.ZX.state.exportSnapshot()), previous);
  }

  const target = boot();
  target.disk.set('zx.trash', 'old-trash');
  target.faults.trash = 2;
  assert.equal(await target.ZX.settings.importBackup(backup), false);
  assert.ok(target.notices.some(([message, kind]) => kind === 'warn' && /trash 回滚失败/.test(message)));
});

test('损坏 overlay 上导入失败仍保留原键；显式导入成功后可解除熔断', async () => {
  const source = boot();
  populate(source, '救援备份');
  const text = JSON.stringify(validBackup(source));
  const disk = new Map([['zx.overlay', '{original-corrupt']]);
  const app = boot(disk);
  app.faults.overlay = 1;
  assert.equal(await app.ZX.settings.importBackup(text), false);
  assert.equal(disk.get('zx.overlay'), '{original-corrupt');
  assert.equal(app.ZX.state.localLoadError.kind, 'corrupt');
  assert.equal(app.ZX.state.saveOverlay(), false);

  assert.equal(await app.ZX.settings.importBackup(text), true);
  assert.equal(app.ZX.state.localLoadFailed, false);
  assert.equal(JSON.parse(disk.get('zx.overlay')).tasks[0].title, '救援备份');
  assert.equal(JSON.parse(disk.get('zx.trash')).snapshot.tasks[0].title, (seed.seed || seed).tasks[0].title);
});

test('导入前拒绝错误格式、未来版本、缺字段、非法时段和含凭据快照，不弹确认也不写入', async () => {
  const source = boot();
  populate(source);
  const good = validBackup(source);
  const variants = [
    '{',
    { ...good, format: 'other' },
    { ...good, version: 2 },
    { ...good, createdAt: 'invalid' },
    { ...good, snapshot: { ...good.snapshot, sessions: undefined } },
    { ...good, snapshot: { ...good.snapshot, avail: [[true]] } },
    { ...good, snapshot: { ...good.snapshot, week: [{ segs: [null] }] } },
    { ...good, snapshot: { ...good.snapshot, token: 'secret' } },
    { ...good, snapshot: { ...good.snapshot, tasks: good.snapshot.tasks.map((task, index) => index ? task : { ...task, title: '坏\u0000文本' }) } },
    { ...good, snapshot: { ...good.snapshot, sessions: [{ id: 's-safe', taskId: 't1', status: '坏\u0001文本' }] } },
    { ...good, snapshot: { ...good.snapshot, tasks: good.snapshot.tasks.map((task, index) => index ? task : { ...task, id: '"><img src=x onerror=alert(1)>' }) } },
    { ...good, snapshot: { ...good.snapshot, sessions: [{ id: 's-safe', taskId: 'bad"id' }] } },
    { ...good, snapshot: { ...good.snapshot, tasks: good.snapshot.tasks.map((task, index) => index ? task : { ...task, title: '长'.repeat(201) }) } },
    { ...good, snapshot: { ...good.snapshot, goal: { ...good.snapshot.goal, extra: '安全\u0000文本' } } },
    { ...good, snapshot: { ...good.snapshot, attrCounts: { '坏\u0000键': 1 } } }
  ];
  for (const variant of variants) {
    const target = boot();
    populate(target, '不动原任务');
    const before = target.disk.get('zx.overlay');
    const text = typeof variant === 'string' ? variant : JSON.stringify(variant);
    assert.equal(await target.ZX.settings.importBackup(text), false);
    assert.equal(target.confirmCalls.length, 0);
    assert.equal(target.disk.get('zx.overlay'), before);
    assert.equal(target.disk.has('zx.trash'), false);
  }
});

test('备份拒绝重复任务、负工时与悬空会话，非法 overlay 数值保持原字节', async () => {
  const source = boot();
  populate(source);
  const duplicate = validBackup(source);
  duplicate.snapshot.placementModel = null;
  duplicate.snapshot.dayAssign = {};
  duplicate.snapshot.locks = {};
  duplicate.snapshot.sessions = [];
  duplicate.snapshot.tasks.push({ ...duplicate.snapshot.tasks[0] });
  const target = boot();
  assert.equal(await target.ZX.settings.importBackup(JSON.stringify(duplicate)), false);
  assert.equal(target.disk.has('zx.overlay'), false);

  const negative = validBackup(source);
  negative.snapshot.tasks[0].est = -1;
  assert.equal(await target.ZX.settings.importBackup(JSON.stringify(negative)), false);

  const dangling = validBackup(source);
  dangling.snapshot.sessions[0].taskId = 'missing-task';
  assert.equal(await target.ZX.settings.importBackup(JSON.stringify(dangling)), false);

  const raw = JSON.parse(source.disk.get('zx.overlay'));
  raw.tasks[0].est = 'not-a-number';
  const invalidRaw = JSON.stringify(raw);
  source.disk.set('zx.overlay', invalidRaw);
  const loaded = boot(source.disk).ZX;
  assert.equal(loaded.state.localLoadFailed, true);
  assert.equal(loaded.state.saveOverlay(), false);
  assert.equal(source.disk.get('zx.overlay'), invalidRaw);
});

test('备份允许正常中文、空格、标点与尖括号，安全 ID 可正常往返', async () => {
  const source = boot();
  populate(source);
  const backup = validBackup(source);
  backup.snapshot.tasks[0].id = 'task.safe-1:2';
  if (backup.snapshot.placementModel) {
    backup.snapshot.placementModel.placements.forEach(p => { if (p.taskId === source.ZX.state.tasks[0].id) p.taskId = 'task.safe-1:2'; });
    backup.snapshot.placementModel.unplanned = backup.snapshot.placementModel.unplanned.filter(item => item.taskId !== source.ZX.state.tasks[0].id);
  }
  if (backup.snapshot.dayAssign[source.ZX.state.tasks[0].id] !== undefined) {
    backup.snapshot.dayAssign['task.safe-1:2'] = backup.snapshot.dayAssign[source.ZX.state.tasks[0].id];
    delete backup.snapshot.dayAssign[source.ZX.state.tasks[0].id];
  }
  if (backup.snapshot.locks[source.ZX.state.tasks[0].id] !== undefined) {
    backup.snapshot.locks['task.safe-1:2'] = backup.snapshot.locks[source.ZX.state.tasks[0].id];
    delete backup.snapshot.locks[source.ZX.state.tasks[0].id];
  }
  backup.snapshot.tasks[0].title = '<高数> 复习 极限、导数 > 重点';
  backup.snapshot.tasks[0].s = '数学 / 408';
  backup.snapshot.goal.name = '目标 <A+> & B';
  backup.snapshot.sessions[0].taskId = 'task.safe-1:2';
  backup.snapshot.sessions[0].note = '<纯文本备注> 正常保存';
  const target = boot();
  assert.equal(await target.ZX.settings.importBackup(JSON.stringify(backup)), true);
  assert.equal(target.ZX.state.tasks[0].title, backup.snapshot.tasks[0].title);
  assert.equal(target.ZX.state.tasks[0].s, '数学 / 408');
  assert.equal(target.ZX.state.goal.name, backup.snapshot.goal.name);
  assert.equal(target.ZX.state.sessions[0].note, backup.snapshot.sessions[0].note);
  const exportedAgain = target.ZX.settings.exportBackup();
  const secondTarget = boot();
  assert.equal(await secondTarget.ZX.settings.importBackup(JSON.stringify(exportedAgain)), true);
  assert.equal(secondTarget.ZX.state.tasks[0].title, backup.snapshot.tasks[0].title);
});

test('目标名和计划项标题统一限制 200 字，导出前拒绝超长快照', async () => {
  const goalSource = fs.readFileSync(require.resolve('../assets/js/flows/goal.js'), 'utf8');
  assert.match(goalSource, /id="saName"[^>]*maxlength="200"/);
  assert.match(goalSource, /id="saAddT"[^>]*maxlength="200"/);
  assert.match(goalSource, /目标名称最多/);
  assert.match(goalSource, /计划项标题最多/);

  const source = boot();
  populate(source);
  const snapshot = source.ZX.state.exportSnapshot();
  snapshot.tasks[0].title = '题'.repeat(200);
  snapshot.goal.name = '目'.repeat(200);
  source.ZX.state.applySnapshot(snapshot);
  const backup = source.ZX.settings.exportBackup();
  const target = boot();
  assert.equal(await target.ZX.settings.importBackup(JSON.stringify(backup)), true);
  assert.equal(target.ZX.state.tasks[0].title.length, 200);
  assert.equal(target.ZX.state.goal.name.length, 200);

  source.ZX.state.tasks[0].title = '题'.repeat(201);
  assert.throws(() => source.ZX.settings.exportBackup(), /200/);
});

test('用户取消导入时不写 trash 或 overlay', async () => {
  const source = boot();
  populate(source);
  const target = boot();
  populate(target, '保留任务');
  const before = target.disk.get('zx.overlay');
  target.setConfirm(false);
  assert.equal(await target.ZX.settings.importBackup(JSON.stringify(validBackup(source))), false);
  assert.equal(target.disk.get('zx.overlay'), before);
  assert.equal(target.disk.has('zx.trash'), false);
});

test('settings.init 自绑定文件输入与备份按钮，File 入口可完成导入', async () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  assert.match(html, /id="backupFileInput"[^>]*type="file"[^>]*accept="\.json,application\/json"/);
  const meSource = fs.readFileSync(require.resolve('../assets/js/views/me.js'), 'utf8');
  assert.match(meSource, /data-act="export-backup">导出完整备份/);
  assert.match(meSource, /data-act="import-backup">导入完整备份/);

  const source = boot();
  populate(source, '文件导入任务');
  const target = boot();
  target.ZX.settings.init();
  assert.equal(typeof target.input.listeners.change, 'function');
  const importButton = { dataset: { act: 'import-backup' }, closest: () => importButton };
  target.listeners.click[0]({ target: importButton });
  assert.equal(target.input.clicks, 1);
  target.input.files = [{ text: async () => JSON.stringify(validBackup(source)) }];
  target.input.listeners.change();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(target.ZX.state.tasks[0].title, '文件导入任务');
  assert.equal(target.input.value, '');
});
