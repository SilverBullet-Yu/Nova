'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const H = require('./helpers');

/* 本地主数据模式：main 不再提供复核编排，启动/online 仅探测健康。 */
const source = fs.readFileSync(require.resolve('../assets/js/main.js'), 'utf8');

function setup(env = {}) {
  const disk = env.disk || new Map([
    ['zx.pending_plan', JSON.stringify({ id: 'legacy-plan', input: {}, result: {} })]
  ]);
  const healthCalls = [];
  const restored = [];
  const listeners = {};
  let pendingReads = 0;
  const element = () => ({
    innerHTML: '', textContent: '', hidden: false, dataset: {}, style: {}, offsetWidth: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
    setAttribute() {}, removeAttribute() {}
  });
  const ZX = {
    state: {
      tab: 'chat', tasks: [], user: { name: '合成测试' }, goal: {}, buffer: {},
      folds: {}, running: false, feasibility: () => null, saveOverlay() {}
    },
    api: {
      isOnline: () => true,
      legacyPendingCount: () => 1,
      pendingCount: () => 0,
      pendingPlan: () => { pendingReads++; return JSON.parse(disk.get('zx.pending_plan') || 'null'); },
      health: () => { healthCalls.push('/api/health'); return Promise.resolve({ ok: true }); },
      onStatus() {}
    },
    ui: { loadFolds: () => ({}), confirm: async () => true, toast() {}, countTo() {} },
    flows: {
      exec: {
        activeTasks: () => [], metrics: () => ({ remain: 0 }),
        restoreDeferred: id => { restored.push(id); return true; }
      }
    },
    assistant: { say() {}, tickTimer() {} },
    views: { chat: () => '', plan: () => '' }
  };
  const document = {
    readyState: 'loading', documentElement: { dataset: {} }, activeElement: null,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    querySelector: () => element(), querySelectorAll: () => []
  };
  const window = {
    ZX,
    localStorage: {
      getItem: key => disk.has(key) ? disk.get(key) : null,
      setItem: (key, value) => disk.set(key, String(value)),
      removeItem: key => disk.delete(key)
    },
    addEventListener(type, fn) { (listeners['window:' + type] ||= []).push(fn); }
  };
  H.installUtil({ window, document });
  ZX.util.applyPrefs = () => {};
  vm.runInNewContext(source, { window, document, setInterval() {}, setTimeout() {}, clearTimeout() {} });
  listeners.DOMContentLoaded.forEach(fn => fn());
  const dispatch = (type, target) => (listeners[type] || []).forEach(fn => fn({ target }));
  return { ZX, disk, healthCalls, restored, pendingReads: () => pendingReads, dispatch };
}

const turn = () => new Promise(resolve => setImmediate(resolve));

test('main 无复核编排，启动和 online 不读取旧 pending_plan 或发业务请求', async () => {
  const legacy = JSON.stringify({ id: 'legacy-plan', localVersion: 'old', input: {}, result: {} });
  const { ZX, disk, healthCalls, pendingReads, dispatch } = setup({ disk: new Map([['zx.pending_plan', legacy]]) });
  await turn();
  assert.equal(ZX.reviewPendingPlan, undefined);
  assert.deepEqual(healthCalls, ['/api/health']);
  assert.equal(pendingReads(), 0);

  dispatch('window:online');
  await turn();
  assert.deepEqual(healthCalls, ['/api/health', '/api/health']);
  assert.equal(pendingReads(), 0);
  assert.equal(disk.get('zx.pending_plan'), legacy);
  for (const name of ['getState', 'stagePlan', 'reviewPlan', 'confirmReplan', 'undo', 'syncOps']) {
    assert.equal(typeof ZX.api[name], 'undefined', name + ' 已移除');
  }
});

test('main 的 restore-deferred 事件委托可用', () => {
  const { restored, dispatch } = setup();
  const button = {
    dataset: { act: 'restore-deferred', id: 'deferred-task' },
    closest: selector => selector === '[data-act]' ? button : null
  };
  dispatch('click', button);
  assert.deepEqual(restored, ['deferred-task']);
});
