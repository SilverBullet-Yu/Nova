'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const H = require('./helpers');
const engine = require('../shared/engine/replan.js');
const plain = value => JSON.parse(JSON.stringify(value));

function boot(storage = new Map()) {
  const messages = [], ops = [];
  const ZX = { api: { queueOp: op => ops.push(op), pendingCount: () => 0 }, setTab() {},
    ui: { toast() {}, fold: (id, o) => o.body } };
  const sandbox = { window: { ZX, localStorage: H.storage(storage).localStorage,
    Rhythm: { seed: require('../shared/data/seed.js'), workflow: require('../shared/workflow.js') } },
    crypto: globalThis.crypto,
    document: { addEventListener() {}, createElement: () => ({}) } };
  const ctx = vm.createContext(sandbox);
  for (const path of ['util.js', 'state.js', 'assistant.js', 'flows/exec.js', 'flows/planedit.js', 'flows/rescue.js', 'flows/replan.js', 'views/me.js']) {
    vm.runInContext(fs.readFileSync(require.resolve('../assets/js/' + path), 'utf8'), ctx);
  }
  ZX.util.$ = () => ({ children: [], appendChild: e => messages.push(e.innerHTML) });
  ZX.util.prefs = () => ({});
  ZX.render = () => ZX.state.saveOverlay();
  ZX.engine = { replan: async input => engine.replan(input), undo: async snap => engine.undoReplan(snap) };
  ZX.flows.settings = { grid: () => [], summaryHtml: () => '', restoreInfo: () => null };
  return { ZX, messages, ops };
}

function fixture(ZX, level) {
  const S = ZX.state;
  const tasks = level === 3 ? [
    { id: 'a', est: 100, weight: 0.3, domain: '高数', freq: 0.2 },
    { id: 'b', est: 40, weight: 0.9, domain: '高数', freq: 0.8 },
    { id: 'c', est: 90, weight: 0.5, domain: '线代', freq: 0.5 }
  ] : [
    { id: 'a', est: 100, weight: 0.2 },
    { id: 'b', est: 100, weight: 0.4 },
    { id: 'c', est: 100, weight: 0.9 }
  ];
  S.tasks = tasks.map(t => S.normTask({ ...t, s: '数学', title: '本地标题-' + t.id, time: '09:00–10:40', localNote: '保留' }));
  S.tasks.push(S.normTask({ id: 'done', done: true, est: 25, actual: 20, title: '已完成' }));
  S.tasks.push(S.normTask({ id: 'locked', est: 15, title: '锁定项' }));
  S.locks = { locked: true };
  S.dayAssign = {};
  S.week = Array.from('一二三四五六日', d => ({ d, total: 100, buf: 60, segs: [] }));
  return plain(S.tasks);
}

for (const level of [3, 4]) {
  test('L' + level + ' 确认后退出所有待办、拒绝旧启动/记录按钮，刷新与撤销恢复', async () => {
    const storage = new Map();
    const { ZX, messages } = boot(storage);
    const before = fixture(ZX, level);
    const expected = engine.replan(ZX.state.replanInput());
    assert.equal(expected.strategies.find(s => s.level === level).applied, true);
    const retiredIds = expected.nextTasks.filter(t => t.substituted || t.abandoned).map(t => t.id);
    assert.ok(retiredIds.length);
    ZX.flows.replan.replanFlow();
    await Promise.resolve();
    assert.deepEqual(plain(ZX.state.tasks), before);
    assert.equal(storage.has('zx.overlay'), false);
    ZX.flows.replan.confirmReplan();
    ZX.flows.replan.confirmReplan();
    assert.equal(ZX.state.replanHistory.length, 1);
    for (const id of retiredIds) {
      const t = ZX.state.tasks.find(t => t.id === id);
      assert.equal(level === 3 ? t.substituted : t.abandoned, true);
      assert.equal(t.title, '本地标题-' + id);
      assert.equal(t.time, '09:00–10:40');
      assert.equal(t.localNote, '保留');
      assert.ok(!ZX.exec.activeTasks().some(t => t.id === id));
      assert.ok(!ZX.flows.planedit.board().includes('data-pe-task="' + id + '"'));
      for (const strategy of ['compress', 'downgrade']) {
        const o = ZX.flows.rescue.optionOf(strategy);
        assert.ok(!o.items.concat(o.dropped).some(t => t.id === id));
      }
      ZX.assistant.todayFlow();
      assert.ok(!messages.at(-1).includes(t.title));
      const timer = ['running', 'timerStart', 'pausedAt', 'pausedTotal'];
      Object.assign(ZX.state, { running: 'locked', timerStart: 1000, pausedAt: 2000, pausedTotal: 300 });
      const oldTimer = timer.map(k => ZX.state[k]);
      ZX.assistant.startTask(id);
      ZX.assistant.finishTask(id, true);
      ZX.exec.commitRecord(id, 10, 100, '', 1, 2);
      assert.deepEqual(timer.map(k => ZX.state[k]), oldTimer);
      assert.equal(ZX.state.sessions.length, 0);
    }
    if (level === 3) {
      assert.equal(ZX.state.tasks.find(t => t.id === 'a').substitutedBy, 'b');
      assert.equal(ZX.state.tasks.find(t => t.id === 'b').replaces, 'a');
    }
    assert.equal(ZX.exec.metrics().done, 1);
    assert.equal(ZX.exec.metrics().worked, 20);
    const count = before.filter(t => !t.done && !retiredIds.includes(t.id)).length;
    assert.ok(ZX.views.me().includes('19:00 · 今日 ' + count + ' 项'));
    assert.deepEqual(plain(ZX.state.tasks.filter(t => t.done || t.id === 'locked')), before.filter(t => t.done || t.id === 'locked'));
    ZX.assistant.startFlow();
    assert.ok(!retiredIds.includes(ZX.state.running));
    const refreshed = boot(storage).ZX;
    assert.deepEqual(plain(refreshed.state.tasks), plain(ZX.state.tasks));
    refreshed.flows.replan.undoReplan();
    assert.deepEqual(plain(refreshed.state.tasks), before);
    assert.deepEqual(plain(boot(storage).ZX.state.tasks), before);
    for (const id of retiredIds) {
      assert.ok(refreshed.exec.activeTasks().some(t => t.id === id));
      assert.ok(refreshed.flows.planedit.board().includes('data-pe-task="' + id + '"'));
      refreshed.assistant.startTask(id);
      assert.equal(refreshed.state.running, id);
    }
  });
}

test('nextTasks 只投影替代字段，重复/多操作 diff 不覆盖压缩与放弃，完成和锁定项不变', async () => {
  const { ZX } = boot();
  const before = fixture(ZX, 3);
  const diff = [
    { taskId: 'a', op: 'compress', to: '60' },
    { taskId: 'a', op: 'substitute', to: '不可解析的展示文字' },
    { taskId: 'c', op: 'abandon' },
    { taskId: 'c', op: 'compress', to: '45' }
  ];
  for (const id of ['done', 'locked']) diff.push({ taskId: id, op: 'abandon' }, { taskId: id, op: 'compress', to: '1' });
  const nextTasks = before.map(t => ({ ...t, title: '引擎标题', time: '未知', est: 999,
    ...(t.id === 'b' ? { replaces: 'a' } : { substituted: true, substitutedBy: 'b' }) }));
  ZX.engine.replan = async () => ({ accepted: true, strategies: [{ level: 3, applied: true }], diff: diff.concat(diff), nextTasks });
  ZX.flows.replan.replanFlow();
  await Promise.resolve();
  ZX.flows.replan.confirmReplan();
  const [a, b, c] = ZX.state.tasks;
  assert.equal(a.est, 60);
  assert.equal(a.substituted, true);
  assert.equal(a.substitutedBy, 'b');
  assert.equal(b.replaces, 'a');
  assert.equal(b.est, 40);
  assert.equal(c.abandoned, true);
  assert.equal(c.est, 45);
  for (const t of ZX.state.tasks) {
    const old = before.find(x => x.id === t.id);
    assert.equal(t.title, old.title);
    assert.equal(t.time, old.time);
    if (t.done || t.id === 'locked') assert.deepEqual(plain(t), old);
  }
});

test('完成历史不因退役标记从执行统计消失；未知/已完成 ID 不能重启', () => {
  const { ZX } = boot();
  ZX.state.tasks = [{ id: 'done', done: true, abandoned: true, substituted: true, est: 25, actual: 20 }];
  assert.equal(ZX.exec.metrics().done, 1);
  assert.equal(ZX.exec.metrics().worked, 20);
  ZX.assistant.startTask('done');
  ZX.assistant.startTask('missing');
  assert.equal(ZX.state.running, null);
});

test('隐私说明披露配置 LLM 后的澄清文本与画像传输', () => {
  const { ZX } = boot();
  const html = ZX.views.me();
  assert.doesNotMatch(html, /当前版本未接入云端模型|不向第三方模型发送/);
  assert.match(html, /配置.*LLM/);
  assert.match(html, /澄清.*文本/);
  assert.match(html, /画像/);
  assert.match(html, /配置.*服务商/);
});
