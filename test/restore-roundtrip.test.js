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
  const confirmCalls = [];
  let reloads = 0;
  const window = { ZX: { api: { queueOp() {}, invalidatePendingSync() {}, clearPendingPlan() {} },
    ui: { confirm: async options => { confirmCalls.push(options); return true; }, toast: message => notices.push(message) } },
    Rhythm: { seed }, localStorage, location: { reload: () => reloads++ } };
  const ctx = vm.createContext({ window, localStorage, crypto: globalThis.crypto,
    document: { addEventListener() {} }, setTimeout: fn => { fn(); } });
  for (const name of ['util.js', 'state.js', 'flows/settings.js'])
    vm.runInContext(fs.readFileSync(require.resolve('../assets/js/' + name), 'utf8'), ctx);
  window.ZX.render = () => window.ZX.state.saveOverlay();
  return { ZX: window.ZX, notices, confirmCalls, reloads: () => reloads };
}

test('删除并恢复后，各本地计划字段在再次刷新后完整保留', async () => {
  const disk = new Map();
  const first = boot(disk).ZX;
  const sessionTaskId = first.state.tasks[0].id;
  Object.assign(first.state, {
    sessions: [{ id: 'versioned-session', taskId: sessionTaskId, planVersion: first.state.currentPlanVersion(), startAt: 1, endAt: 2, minutes: 30, completion: 100, status: 'done' }],
    dayAssign: { t2: '三' }, locks: { t2: true }, notif: { daily: false },
    attrCounts: { '效率不足': 2 }, replanHistory: [{ undone: false, loadDelta: 0.1 }],
    consecutiveZeroDays: 3, interrupted: true, rescueRecord: { reason: '保留挽救状态' },
    weekShift: [{ d: '一', segs: [17], buf: 20, total: 37 }],
    snapshot: { tasks: [{ id: 'old', est: 20 }], week: [], timestamp: 123 }, replanned: true
  });
  first.settings.ensure();
  first.state.saveOverlay();
  const before = JSON.parse(disk.get('zx.overlay'));
  await first.settings.confirmWipe();
  assert.ok(disk.has('zx.trash'));
  const second = boot(disk).ZX;
  assert.equal(await second.settings.restore(), true);
  const refreshed = boot(disk).ZX;
  const after = JSON.parse(disk.get('zx.overlay'));
  for (const key of ['tasks', 'sessions', 'goal', 'feas', 'week', 'weekShift', 'dayAssign', 'locks', 'avail', 'availSource', 'notif', 'attrCounts', 'consecutiveZeroDays', 'interrupted', 'rescueRecord', 'replanHistory', 'replanSnapshot'])
    assert.deepEqual(after[key], before[key], key);
  assert.equal(refreshed.state.replanned, true);
  assert.deepEqual(plain(refreshed.state.snapshot), before.replanSnapshot);
  assert.equal(after.planVersion, before.planVersion);
  assert.equal(refreshed.state.currentPlanVersion(), before.planVersion);
  assert.equal(after.sessions[0].planVersion, before.sessions[0].planVersion);
});

test('恢复结果无法保存时不得丢弃回收站快照', async () => {
  const disk = new Map();
  const first = boot(disk).ZX;
  first.state.saveOverlay();
  await first.settings.confirmWipe();
  const savedTrash = disk.get('zx.trash');
  const { ZX, notices } = boot(disk, false, true);
  ZX.state.dayAssign = { t3: '五' };
  ZX.state.sessions = [{ id: 'after-delete', minutes: 7 }];
  const before = plain({ dayAssign: ZX.state.dayAssign, sessions: ZX.state.sessions });
  const beforeVersion = ZX.state.currentPlanVersion();
  assert.equal(await ZX.settings.restore(), false);
  assert.deepEqual(plain({ dayAssign: ZX.state.dayAssign, sessions: ZX.state.sessions }), before);
  assert.equal(ZX.state.currentPlanVersion(), beforeVersion, '恢复失败必须还原计划版本');
  assert.equal(disk.get('zx.trash'), savedTrash);
  assert.ok(notices.some(message => /失败|无法/.test(message)));
});

test('旧 overlay 中任务相同但改期未保存时仍须保留回收站', async () => {
  const disk = new Map();
  const first = boot(disk).ZX;
  first.state.dayAssign = { t2: '三' };
  first.state.saveOverlay();
  await first.settings.confirmWipe();
  const seedPage = boot(disk).ZX;
  seedPage.state.saveOverlay();
  const stale = JSON.parse(disk.get('zx.overlay'));
  stale.at = Date.now() + 60000;
  disk.set('zx.overlay', JSON.stringify(stale));
  const savedTrash = disk.get('zx.trash');
  const { ZX } = boot(disk, false, false, true);
  assert.equal(await ZX.settings.restore(), false);
  assert.equal(disk.get('zx.trash'), savedTrash);
});

test('wipe 删除本机业务数据，但旧队列与待复核计划原样隔离', async () => {
  const queue = '[ { "opId": "legacy-queue" } ]\n';
  const pending = '{ "plan": "待复核", "padding": "  " }\n';
  const disk = new Map([['zx.op_queue', queue], ['zx.pending_plan', pending]]);
  const { ZX, confirmCalls } = boot(disk);
  ZX.state.saveOverlay();
  await ZX.settings.confirmWipe();
  assert.match(confirmCalls[0].text, /删除本机业务数据，旧队列与待复核记录保留隔离/);
  assert.equal(disk.has('zx.overlay'), false);
  assert.equal(disk.get('zx.op_queue'), queue);
  assert.equal(disk.get('zx.pending_plan'), pending);
  assert.equal(disk.has('zx.trash'), true);
});

test('无法保存回收站快照时不得清空原数据或旧队列', async () => {
  const disk = new Map([['zx.op_queue', 'keep-queue']]);
  const { ZX, notices, reloads } = boot(disk, true);
  ZX.state.saveOverlay();
  const overlay = disk.get('zx.overlay');
  await ZX.settings.confirmWipe();
  assert.equal(disk.get('zx.overlay'), overlay);
  assert.equal(disk.get('zx.op_queue'), 'keep-queue');
  assert.equal(reloads(), 0);
  assert.ok(notices.some(message => /失败|无法/.test(message)));
});
