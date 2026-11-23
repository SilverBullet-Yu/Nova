'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const seed = require('../shared/data/seed.js');
const plain = value => JSON.parse(JSON.stringify(value));

function boot(disk, failTrash = false, failOverlay = false, ignoreOverlay = false) {
  const localStorage = {
    getItem: key => disk.has(key) ? disk.get(key) : null,
    setItem: (key, value) => { if ((key === 'zx.trash' && failTrash) || (key === 'zx.overlay' && failOverlay)) throw new Error('quota'); if (key === 'zx.overlay' && ignoreOverlay) return; disk.set(key, String(value)); },
    removeItem: key => disk.delete(key)
  };
  const notices = [];
  let reloads = 0;
  const window = { ZX: { api: { queueOp() {}, invalidatePendingSync() {}, clearPendingPlan() {} },
    ui: { confirm: async () => true, toast: message => notices.push(message) } },
    Rhythm: { seed }, localStorage, location: { reload: () => reloads++ } };
  const ctx = vm.createContext({ window, localStorage, crypto: globalThis.crypto,
    document: { addEventListener() {} }, setTimeout: fn => { fn(); } });
  for (const name of ['util.js', 'state.js', 'flows/settings.js'])
    vm.runInContext(fs.readFileSync(require.resolve('../assets/js/' + name), 'utf8'), ctx);
  window.ZX.render = () => window.ZX.state.saveOverlay();
  return { ZX: window.ZX, notices, reloads: () => reloads };
}

test('删除并恢复后，各本地计划字段在再次刷新后完整保留', async () => {
  const disk = new Map();
  const first = boot(disk).ZX;
  Object.assign(first.state, {
    dayAssign: { t2: '三' }, locks: { t2: true }, notif: { daily: false },
    attrCounts: { '效率不足': 2 }, replanHistory: [{ undone: false, loadDelta: 0.1 }],
    weekShift: [{ d: '一', segs: [17], buf: 20, total: 37 }],
    snapshot: { tasks: [{ id: 'old', est: 20 }], week: [], timestamp: 123 }, replanned: true
  });
  first.settings.ensure();
  first.state.saveOverlay();
  const before = JSON.parse(disk.get('zx.overlay'));
  first.settings.confirmWipe();
  await Promise.resolve();
  assert.ok(disk.has('zx.trash'));
  const second = boot(disk).ZX;
  assert.equal(second.settings.restore(), true);
  const refreshed = boot(disk).ZX;
  const after = JSON.parse(disk.get('zx.overlay'));
  for (const key of ['tasks', 'sessions', 'goal', 'feas', 'week', 'weekShift', 'dayAssign', 'locks', 'avail', 'availSource', 'notif', 'attrCounts', 'replanHistory', 'replanSnapshot'])
    assert.deepEqual(after[key], before[key], key);
  assert.equal(refreshed.state.replanned, true);
  assert.deepEqual(plain(refreshed.state.snapshot), before.replanSnapshot);
});

test('恢复结果无法保存时不得丢弃回收站快照', async () => {
  const disk = new Map();
  const first = boot(disk).ZX;
  first.state.saveOverlay();
  first.settings.confirmWipe();
  await Promise.resolve();
  const savedTrash = disk.get('zx.trash');
  const { ZX, notices } = boot(disk, false, true);
  ZX.state.dayAssign = { t3: '五' };
  ZX.state.sessions = [{ id: 'after-delete', minutes: 7 }];
  const before = plain({ dayAssign: ZX.state.dayAssign, sessions: ZX.state.sessions });
  assert.equal(ZX.settings.restore(), false);
  assert.deepEqual(plain({ dayAssign: ZX.state.dayAssign, sessions: ZX.state.sessions }), before);
  assert.equal(disk.get('zx.trash'), savedTrash);
  assert.ok(notices.some(message => /失败|无法/.test(message)));
});

test('旧 overlay 中任务相同但改期未保存时仍须保留回收站', async () => {
  const disk = new Map();
  const first = boot(disk).ZX;
  first.state.dayAssign = { t2: '三' };
  first.state.saveOverlay();
  first.settings.confirmWipe();
  await Promise.resolve();
  const seedPage = boot(disk).ZX;
  seedPage.state.saveOverlay();
  const stale = JSON.parse(disk.get('zx.overlay'));
  stale.at = Date.now() + 60000;
  disk.set('zx.overlay', JSON.stringify(stale));
  const savedTrash = disk.get('zx.trash');
  const { ZX } = boot(disk, false, false, true);
  assert.equal(ZX.settings.restore(), false);
  assert.equal(disk.get('zx.trash'), savedTrash);
});

test('无法保存回收站快照时不得清空原数据或待同步队列', async () => {
  const disk = new Map([['zx.op_queue', 'keep-queue']]);
  const { ZX, notices, reloads } = boot(disk, true);
  ZX.state.saveOverlay();
  const overlay = disk.get('zx.overlay');
  ZX.settings.confirmWipe();
  await Promise.resolve();
  assert.equal(disk.get('zx.overlay'), overlay);
  assert.equal(disk.get('zx.op_queue'), 'keep-queue');
  assert.equal(reloads(), 0);
  assert.ok(notices.some(message => /失败|无法/.test(message)));
});
