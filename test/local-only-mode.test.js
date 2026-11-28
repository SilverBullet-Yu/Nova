'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const H = require('./helpers');

const read = file => fs.readFileSync(require.resolve(file), 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));
const forbidden = [
  '/api/state', '/api/sync/ops', '/api/plan/review',
  '/api/replan/confirm', '/api/replan/undo'
];
const response = data => ({ ok: true, status: 200, json: async () => data });
function assertNoForbidden(calls) {
  assert.deepEqual(calls.map(call => new URL(call).pathname).filter(path => forbidden.includes(path)), []);
}
function localStorage(disk) {
  return {
    getItem: key => disk.has(key) ? disk.get(key) : null,
    setItem: (key, value) => disk.set(key, String(value)),
    removeItem: key => disk.delete(key)
  };
}
function installApi(ZX, disk, fetch) {
  const window = {
    ZX,
    location: { protocol: 'http:', origin: 'http://synthetic.invalid' },
    localStorage: localStorage(disk)
  };
  const calls = [];
  vm.runInNewContext(read('../assets/js/api.js'), {
    window, crypto, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      calls.push(String(url));
      return fetch(String(url), options);
    }
  });
  return { window, api: window.ZX.api, calls };
}
function installFlow(file, ZX, disk, setup) {
  const window = { ZX, Rhythm: { placementModel: require('../shared/placement-model.js') }, localStorage: localStorage(disk) };
  if (setup) setup(window);
  const sandbox = {
    window,
    document: { addEventListener() {} }
  };
  H.installUtil(sandbox);
  vm.runInNewContext(read(file), sandbox);
  return ZX;
}

test('旧队列字节不变：queueOp 不写入、flush 不联网、支持界面计数为零', async () => {
  const disk = new Map([
    ['zx.auth_token', JSON.stringify({ token: 'synthetic-token' })],
    ['zx.op_queue', '[{"opId":"old-a","pending":true,"value":{"note":"synthetic"}}, {"pending":false}, null, {"opId":"old-b","pending":true}]']
  ]);
  const original = disk.get('zx.op_queue');
  const requests = [];
  let reachable = false;
  const { api, calls } = installApi({ state: { serverSeq: 7 } }, disk, url => {
    requests.push(new URL(url).pathname);
    if (!reachable) throw new Error('synthetic offline');
    return response({});
  });
  assert.equal(api.pendingCount(), 0);
  assert.equal(api.legacyPendingCount(), 2);
  await assert.rejects(api.health(), /synthetic offline/);
  assert.equal(api.queueOp({ opId: 'must-not-append', value: 'synthetic' }), null);
  reachable = true;
  await api.health();
  assert.equal(api.queueOp({ opId: 'online-must-not-append' }), null);
  const isolated = await api.flushQueue();
  assert.deepEqual(JSON.parse(JSON.stringify(isolated)), {
    status: 'isolated', sent: 0, accepted: [], pending: 2, serverSeq: 7
  });
  for (const name of ['getState', 'stagePlan', 'reviewPlan', 'confirmReplan', 'undo', 'syncOps']) {
    assert.equal(typeof api[name], 'undefined', name + ' 已移除');
  }
  await turn();
  assert.deepEqual(requests, ['/api/health', '/api/health']);
  assertNoForbidden(calls);
  assert.equal(disk.get('zx.op_queue'), original);
  assert.equal(api.legacyPendingCount(), 2);
});

function element() {
  return {
    innerHTML: '', textContent: '', value: '', hidden: false, className: '', dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, querySelector: () => element(), querySelectorAll: () => [],
    appendChild() {}, focus() {}, remove() {}, closest: () => null,
    scrollTop: 0, offsetWidth: 0
  };
}

test('真实 main 启动与 online 恢复只探测健康接口，不采纳远端主数据或旧队列', async () => {
  const disk = new Map([
    ['zx.auth_token', JSON.stringify({ token: 'synthetic-token' })],
    ['zx.op_queue', '[ {"opId":"legacy","pending":true} ]'],
    ['zx.pending_plan', JSON.stringify({ id: 'legacy-plan', input: {}, result: {} })]
  ]);
  const original = disk.get('zx.op_queue');
  const legacyPlan = disk.get('zx.pending_plan');
  const tasks = [{ id: 't', s: '数学', title: 'synthetic', est: 60, time: '08:00–09:00', weight: 0.9, done: false }];
  const state = {
    tab: 'chat', tasks, user: { name: '合成测试' }, folds: {}, running: false,
    feasibility: () => null, saveOverlay() {}, bootOverlayLoaded: () => false,
    adoptServerState() { throw new Error('must not adopt remote state'); }
  };
  const ZX = {
    state,
    ui: { loadFolds: () => ({}) },
    flows: { exec: { activeTasks: () => tasks, metrics: () => ({ remain: 60 }) } },
    assistant: { say() {}, tickTimer() {} },
    views: { chat: () => '' }
  };
  const { calls } = installApi(ZX, disk, url => {
    assert.equal(new URL(url).pathname, '/api/health');
    return response({ ok: true });
  });
  const nodes = new Map();
  const document = {
    readyState: 'loading', documentElement: { dataset: {} }, activeElement: null,
    addEventListener(type, fn) { if (type === 'DOMContentLoaded') this.boot = fn; },
    querySelector: selector => {
      if (!nodes.has(selector)) nodes.set(selector, element());
      return nodes.get(selector);
    },
    querySelectorAll: () => []
  };
  const window = { ZX, addEventListener(type, fn) { if (type === 'online') this.online = fn; } };
  H.installUtil({ window });
  ZX.util.$ = selector => document.querySelector(selector);
  ZX.util.applyPrefs = () => {};
  const timers = [];
  vm.runInNewContext(read('../assets/js/main.js'), {
    window, document,
    setTimeout: fn => { timers.push(fn); return timers.length; },
    clearTimeout() {}, setInterval() {}
  });
  document.boot();
  await turn();
  await turn();
  assert.equal(calls.length, 1);
  assert.equal(ZX.api.pendingCount(), 0);
  assert.equal(ZX.api.legacyPendingCount(), 1);
  window.online();
  await turn();
  await turn();
  for (const timer of timers.splice(0)) timer();
  await turn();
  assert.ok(calls.length >= 2);
  assert.ok(calls.every(url => new URL(url).pathname === '/api/health'));
  assertNoForbidden(calls);
  assert.equal(disk.get('zx.op_queue'), original);
  assert.equal(disk.get('zx.pending_plan'), legacyPlan);
  assert.equal(ZX.reviewPendingPlan, undefined);
});

test('引擎桥接拒绝 HTTP 200 畸形结果并回退同一本地产物', async () => {
  const ZX = { api: {
    feasibility: async () => ({ R: 1, T: 1, verdict: '合理' }),
    replan: async () => ({ strategies: [], diff: [] }),
    schedule: async () => ({ blocks: [] })
  } };
  const window = { ZX };
  const sandbox = { window, self: window };
  vm.runInNewContext(read('../assets/js/rhythm.build.js'), sandbox);
  vm.runInNewContext(read('../assets/js/engine.js'), sandbox);
  const feas = await ZX.engine.feasibility({ weeklyH: 20, weeks: 58, discount: 0.85, demand: 913 });
  assert.equal(feas.D, 913);
  assert.equal(ZX.engine.source, 'local');
  const schedule = await ZX.engine.schedule({ tasks: [], slots: [] });
  assert.deepEqual(Object.keys(schedule).sort(), ['blocks', 'unplanned', 'version']);
  const replan = await ZX.engine.replan({ tasks: [], week: [{ date: 'D1', minutes: 0 }] });
  assert.equal(replan.strategies.length, 4);
  assert.equal(ZX.engine.source, 'local');
});

test('engine.confirmReplan 使用本地 Rhythm 结果，计算接口仍保留', async () => {
  const ZX = { api: {
    feasibility() {}, schedule() {}, replan() {}, llmClarify() {}, llmAnalyze() {}
  } };
  const window = { ZX };
  const sandbox = { window, self: window };
  vm.runInNewContext(read('../assets/js/rhythm.build.js'), sandbox);
  vm.runInNewContext(read('../assets/js/engine.js'), sandbox);
  const draft = {
    accepted: false, needsConfirmation: true, verdict: 'needsConfirmation',
    strategies: [1, 2, 3, 4].map(level => ({ level, name: ['顺延', '压缩', '替代', '放弃'][level - 1], applied: level === 4, growth: 0, reason: '' })),
    diff: [{ op: 'abandon', taskId: 't', from: '50', to: '0', detail: '' }],
    snapshot: { tasks: [{ id: 't', est: 50 }], week: [] },
    guards: { loadGrowthOk: true, bufferPreserved: true, consecutiveOk: true, compressedShareOk: true },
    nextTasks: [{ id: 't', est: 50, abandoned: true }],
    nextPlacements: []
  };
  const confirmed = await ZX.engine.confirmReplan(draft);
  assert.equal(confirmed.accepted, true);
  assert.equal(confirmed.needsConfirmation, false);
  assert.equal(draft.accepted, false);
  assert.equal(ZX.engine.source, 'local');
  for (const name of ['getState', 'stagePlan', 'reviewPlan', 'confirmReplan', 'undo', 'syncOps']) {
    assert.equal(typeof ZX.api[name], 'undefined', name + ' 已移除');
  }
  for (const name of ['feasibility', 'schedule', 'replan']) assert.equal(typeof ZX.api[name], 'function');
  for (const name of ['llmClarify', 'llmAnalyze']) assert.equal(typeof ZX.api[name], 'function');
  assert.equal(typeof ZX.engine.attributeNow, 'function');
});

test('重排确认与撤销始终本机执行，忽略服务端 draftId 且不调用 engine 确认/撤销', async () => {
  const disk = new Map();
  const state = {
    tasks: [{ id: 't', subject: '数学', title: 'synthetic', est: 50, weight: 0.8 }],
    week: [], locks: {}, dayAssign: { t: '二' }, goal: {}, avail: [], replanHistory: [],
    replanInput: () => ({}), normTask: task => task, currentPlanVersion: () => 'synthetic-v1'
  };
  const ops = [];
  let remoteCalls = 0;
  const ZX = {
    state, render() {}, setTab() {}, assistant: { say() {} },
    api: { queueOp: op => { ops.push(op); return null; } },
    engine: {
      replan: async () => ({
        draftId: 'legacy-server-draft', accepted: true, loadDelta: 0.1,
        strategies: [{ level: 1, applied: true, growth: 0.1 }],
        diff: [{ taskId: 't', op: 'defer', from: '二', to: '三' }], guards: { bufferPreserved: true }
      }),
      confirmReplan() { remoteCalls++; throw new Error('remote confirm'); },
      undo() { remoteCalls++; throw new Error('remote undo'); }
    }
  };
  installFlow('../assets/js/flows/replan.js', ZX, disk, window => {
    window.Rhythm = { workflow: require('../shared/workflow.js') };
  });
  ZX.flows.replan.replanFlow();
  await turn();
  assert.equal(state.dayAssign.t, '二');
  ZX.flows.replan.confirmReplan();
  assert.equal(state.dayAssign.t, '三');
  assert.equal(state.tasks[0].est, 50);
  ZX.flows.replan.undoReplan();
  assert.equal(state.dayAssign.t, '二');
  assert.equal(state.replanned, false);
  assert.equal(remoteCalls, 0);
  assert.ok(ops.some(op => op.field === 'moved' && op.value.day === '三'));
  assert.ok(ops.some(op => op.field === 'moved' && op.value.day === '二'));
});

test('目标计划只在本机生效，不调用已移除的上行或复核 API', async () => {
  const disk = new Map();
  disk.set('zx.pending_plan', JSON.stringify({ id: 'legacy-plan' }));
  const state = {
    goalDraft: { name: 'synthetic goal', deadline: '2027-12-25', weeks: 5, weeklyH: 10, demand: 10 },
    planDraft: [{ id: 'a', s: '数学', title: 'synthetic task', est: 30, weight: 1 }],
    goal: { name: 'old' }, feas: {}, resetTimer() {}, normTask: task => task,
    currentPlanVersion: () => 'synthetic-v1'
  };
  const ZX = {
    state, render() {}, setTab() {}, ui: { toast() {} }, assistant: { say() {} },
    api: { queueOp: () => null },
    engine: {
      feasibilityNow: () => ({ R: 1 }),
      schedule: async () => ({
        version: 'synthetic', unplanned: [],
        blocks: [{ id: 'b1', taskId: 'a', date: ZX.util.todayKey(), startMin: 1080, durMin: 30, subject: '数学', isBuffer: false }]
      })
    }
  };
  installFlow('../assets/js/flows/goal.js', ZX, disk);
  ZX.util.todayDow = () => '三';
  ZX.flows.goal.apply();
  await turn();
  assert.equal(state.goal.name, 'synthetic goal');
  assert.equal(state.tasks[0].title, 'synthetic task');
  assert.equal(state.goalDraft, null);
  assert.equal(typeof ZX.api.stagePlan, 'undefined');
  assert.equal(typeof ZX.api.reviewPlan, 'undefined');
  assert.equal(ZX.reviewPendingPlan, undefined);
  assert.deepEqual(JSON.parse(disk.get('zx.pending_plan')), { id: 'legacy-plan' });
});
