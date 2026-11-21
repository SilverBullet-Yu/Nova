'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const seed = require('../shared/data/seed.js');
function boot(storage) {
  const ops = [];
  const ZX = { api: { queueOp: op => ops.push(op) } };
  const ls = { getItem: k => storage.get(k), removeItem: k => storage.delete(k), setItem: (k, v) => storage.set(k, v) };
  const win = { ZX, Rhythm: { seed }, localStorage: ls };
  const ctx = vm.createContext({ window: win, crypto: globalThis.crypto, document: { addEventListener() {} }, localStorage: ls });
  /* util.js 真实装载：randHex / appendTrace / today0 与生产同源 */
  for (const path of ['../assets/js/util.js', '../assets/js/state.js', '../assets/js/flows/exec.js']) vm.runInContext(readFileSync(require.resolve(path), 'utf8'), ctx);
  return { ZX, ops };
}
test('执行记录关联计划版本，刷新保留版本，改期后记录使用新版本', () => {
  const storage = new Map();
  const { ZX, ops } = boot(storage);
  const taskId = ZX.state.tasks[0].id;
  const first = ZX.exec.record({ taskId, minutes: 25 });
  assert.match(first.planVersion || '', /^plan-/);
  assert.equal(ops[0].value.planVersion, first.planVersion);
  ZX.state.saveOverlay();
  const next = boot(storage).ZX;
  assert.equal(next.exec.record({ taskId }).planVersion, first.planVersion);
  next.state.dayAssign[taskId] = '三';
  assert.notEqual(next.exec.record({ taskId }).planVersion, first.planVersion);
  assert.equal(next.state.sessions[0].planVersion, first.planVersion);
  assert.equal(next.exec.record({ taskId, isBackfill: true }).planVersion, null);
});

test('本地重排快照跨刷新恢复，清除后不再恢复', () => {
  const storage = new Map();
  const { ZX } = boot(storage);
  const snapshot = { tasks: structuredClone(ZX.state.tasks), week: structuredClone(ZX.state.week), timestamp: 123, moved: [] };
  ZX.state.snapshot = snapshot;
  ZX.state.replanned = true;
  ZX.state.saveOverlay();
  const next = boot(storage).ZX.state;
  assert.equal(next.replanned, true);
  assert.deepEqual(JSON.parse(JSON.stringify(next.snapshot)), snapshot);
  const { ZX: restored } = boot(storage);
  const taskId = snapshot.tasks[0].id;
  restored.state.snapshot.moved = [{ taskId, from: '日', to: '三' }];
  restored.state.dayAssign[taskId] = '三';
  restored.state.replanHistory = [{ undone: false, planVersionAfter: restored.state.currentPlanVersion() }];
  restored.state.saveOverlay();
  const page = boot(storage);
  Object.assign(page.ZX.util, { clone: structuredClone, tsHM: () => '', nowStr: () => '', $: () => ({ children: [], appendChild() {} }) });
  Object.assign(page.ZX, { setTab() {}, render: () => page.ZX.state.saveOverlay(), engine: { undo: async () => null } });
  vm.runInNewContext(readFileSync(require.resolve('../assets/js/assistant.js'), 'utf8'), {
    window: { ZX: page.ZX, Rhythm: { workflow: require('../shared/workflow.js') } },
    document: { createElement: () => ({}) }
  });
  page.ZX.assistant.undoReplan();
  assert.equal(page.ops[0].value.day, '日');
  assert.equal(boot(storage).ZX.state.dayAssign[taskId], undefined);
  assert.equal(boot(storage).ZX.state.replanHistory[0].undone, true);
  assert.equal(boot(storage).ZX.state.snapshot, null);
  assert.equal(boot(storage).ZX.state.replanned, false);
});

test('清除本地计划时也清除重排留痕，保留无关存储', () => {
  const storage = new Map([['zx.replanTrace', '[]'], ['zx.scheduleTrace', '[]'], ['zx.executionTrace', '[]'], ['zx.syncTrace', '[]'], ['unrelated', 'keep']]);
  const { ZX } = boot(storage);
  ZX.state.saveOverlay();
  assert.equal(storage.has('zx.overlay'), true);
  ZX.state.dropOverlay();
  assert.equal(storage.has('zx.overlay'), false);
  assert.equal(storage.has('zx.replanTrace'), false);
  assert.equal(storage.has('zx.scheduleTrace'), false);
  assert.equal(storage.has('zx.executionTrace'), false);
  assert.equal(storage.has('zx.syncTrace'), false);
  assert.equal(storage.get('unrelated'), 'keep');
});
test('确认删除阶段目标后，刷新保留计划和记录，CSV 不再导出目标', async () => {
  const storage = new Map();
  const settings = readFileSync(require.resolve('../assets/js/flows/settings.js'), 'utf8');
  function init() {
    const { ZX } = boot(storage);
    Object.assign(ZX.util, { pad2: n => String(n).padStart(2, '0') });
    ZX.ui = { confirm: async () => true, toast() {} };
    ZX.render = () => ZX.state.saveOverlay();
    vm.runInNewContext(settings, { window: { ZX, localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) } } });
    return ZX;
  }
  const ZX = init();
  const taskId = ZX.state.tasks[0].id;
  ZX.state.goal = { name: '私人阶段目标', deadline: '2026-12-01', weeks: 4, source: 'user' };
  ZX.exec.record({ taskId, minutes: 25 });
  ZX.state.saveOverlay();
  assert.match(ZX.settings.csv(), /私人阶段目标/);
  storage.set('zx.trash', JSON.stringify({ at: Date.now(), snapshot: { goal: ZX.state.goal, feas: ZX.state.feas, tasks: ZX.state.tasks, sessions: ZX.state.sessions } }));
  await ZX.settings.confirmRemoveGoal();
  const trash = JSON.parse(storage.get('zx.trash')).snapshot;
  assert.equal(trash.goal, undefined);
  assert.equal(trash.feas, undefined);
  assert.equal(trash.tasks[0].id, taskId);
  assert.equal(trash.sessions[0].minutes, 25);
  const next = init();
  const serverSeed = { ...seed, goal: { ...seed.goal, name: '旧服务端目标' } };
  assert.equal(next.state.adoptServerState({ seed: serverSeed }), true);
  assert.equal(next.state.goal.name, '旧服务端目标');
  assert.equal(next.state.bootOverlayLoaded(), true);
  next.state.applyOverlay();
  assert.equal(next.state.goal.source, 'removed');
  assert.equal(next.state.tasks[0].id, taskId);
  assert.equal(next.state.sessions[0].minutes, 25);
  assert.notEqual(next.state.goal.name, '私人阶段目标');
  assert.notEqual(next.state.goal.deadline, '2026-12-01');
  assert.doesNotMatch(next.settings.csv(), /私人阶段目标/);
  storage.set('zx.trash', JSON.stringify({ at: Date.now(), snapshot: {
    ...trash, goal: { name: '私人阶段目标', source: 'user' }, feas: { demand: 99 },
    sessions: [{ ...trash.sessions[0], minutes: 42 }]
  } }));
  assert.equal(next.settings.restore(), true);
  const restored = init();
  assert.equal(restored.state.goal.source, 'removed');
  assert.equal(restored.state.feas.demand, 0);
  assert.equal(restored.state.tasks[0].id, taskId);
  assert.equal(restored.state.sessions[0].minutes, 42);
  assert.doesNotMatch(restored.settings.csv(), /私人阶段目标/);
});

test('刷新恢复显式空任务列表，而旧 overlay 缺字段时仍使用种子', () => {
  const storage = new Map();
  const { ZX } = boot(storage);
  const seeded = ZX.state.tasks.length;
  assert.ok(seeded > 0);
  ZX.state.tasks = [];
  ZX.state.saveOverlay();
  assert.equal(boot(storage).ZX.state.tasks.length, 0);
  storage.set('zx.overlay', JSON.stringify({ sessions: [] }));
  assert.equal(boot(storage).ZX.state.tasks.length, seeded);
});

test('时段来源区分默认、旧版设置与用户编辑，且局部更新可跨刷新恢复', () => {
  const settings = readFileSync(require.resolve('../assets/js/flows/settings.js'), 'utf8');
  function init(storage) {
    const { ZX } = boot(storage);
    Object.assign(ZX.util, { $: () => ({}), $$: () => [], refocus() {} });
    vm.runInNewContext(settings, { window: { ZX } });
    return ZX;
  }
  const storage = new Map();
  const ZX = init(storage);
  assert.match(ZX.settings.summaryHtml(), /默认模板/);
  ZX.settings.toggle(0, 0);
  assert.match(init(storage).settings.summaryHtml(), /用户设置/);
  const overlay = JSON.parse(storage.get('zx.overlay'));
  assert.equal(overlay.avail[0][0], false);
  delete overlay.availSource;
  storage.set('zx.overlay', JSON.stringify(overlay));
  assert.match(init(storage).settings.summaryHtml(), /旧版设置/);
});

test('可用时段编辑可导出，恢复默认并刷新后不再使用旧时段', () => {
  const storage = new Map();
  const settings = readFileSync(require.resolve('../assets/js/flows/settings.js'), 'utf8');
  const goal = readFileSync(require.resolve('../assets/js/flows/goal.js'), 'utf8')
    .replace('open: open, apply: apply', 'open: open, apply: apply, slots: buildSlots');
  function init() {
    const { ZX } = boot(storage);
    Object.assign(ZX.util, { $: () => ({}), $$: () => [], refocus() {}, clone: structuredClone, todayDow: () => '一', pad2: n => String(n).padStart(2, '0') });
    ZX.ui = { toast() {} };
    const ctx = vm.createContext({ window: { ZX }, document: { addEventListener() {} } });
    vm.runInContext(settings, ctx);
    vm.runInContext(goal, ctx);
    return ZX;
  }
  const first = init();
  first.settings.ensure();
  const baseline = JSON.stringify(first.flows.goal.slots());
  first.settings.bulk('clear');
  const edited = init();
  assert.equal(edited.flows.goal.slots().length, 0);
  assert.match(edited.settings.csv(), /用户设置/);
  edited.settings.bulk('reset');
  const restored = init();
  assert.match(restored.settings.summaryHtml(), /默认模板/);
  assert.doesNotMatch(restored.settings.csv(), /用户设置|旧版设置/);
  assert.equal(JSON.stringify(restored.flows.goal.slots()), baseline);
});
