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
    Rhythm: { seed: require('../shared/data/seed.js'), workflow: require('../shared/workflow.js'), replan: engine } },
    crypto: globalThis.crypto,
    document: { addEventListener() {}, createElement: () => ({}) } };
  const ctx = vm.createContext(sandbox);
  for (const path of ['util.js', 'state.js', 'assistant.js', 'flows/exec.js', 'flows/planedit.js', 'flows/rescue.js', 'flows/replan.js', 'views/me.js', 'views/today.js']) {
    vm.runInContext(fs.readFileSync(require.resolve('../assets/js/' + path), 'utf8'), ctx);
  }
  ZX.util.$ = () => ({ children: [], appendChild: e => messages.push(e.innerHTML) });
  ZX.util.prefs = () => ({});
  ZX.render = () => ZX.state.saveOverlay();
  ZX.engine = { replan: async input => engine.replan(input), undo: async snap => engine.undoReplan(snap) };
  ZX.flows.settings = { grid: () => [], summaryHtml: () => '', restoreInfo: () => null };
  return { ZX, messages, ops, ctx };
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
      refreshed.state.resetTimer();
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

for (const entry of ['openRecord', 'finishTask', 'commitRecord']) {
  test('已跳过任务不能经旧按钮直接记录完成：' + entry, () => {
    const { ZX } = boot();
    ZX.state.tasks = [ZX.state.normTask({ id: 'skipped', title: '已跳过', subject: '数学', est: 30, skipped: true, skipReason: '临时有事' })];
    Object.assign(ZX.state, { running: 'skipped', timerStart: 1000, pausedAt: null, pausedTotal: 0 });
    const before = plain(ZX.state.tasks);
    let sheets = 0;
    ZX.ui.footNav = () => '';
    ZX.engine.attributeNow = () => null;
    ZX.ui.sheet = () => { sheets++; return { root: { addEventListener() {}, querySelector: () => null }, $: () => null, close() {} }; };
    if (entry === 'openRecord') ZX.exec.openRecord('skipped');
    else if (entry === 'finishTask') ZX.assistant.finishTask('skipped', true);
    else ZX.exec.commitRecord('skipped', 30, 100, '', 1, 2);
    assert.equal(sheets, 0);
    assert.deepEqual(plain(ZX.state.tasks), before);
    assert.equal(ZX.state.sessions.length, 0);
    assert.equal(ZX.state.running, 'skipped');
    assert.equal(ZX.state.timerStart, 1000);
  });
}

test('已跳过任务仍可经开始按钮显式恢复后计时', () => {
  const { ZX } = boot();
  ZX.state.tasks = [ZX.state.normTask({ id: 'skipped', title: '已跳过', subject: '数学', est: 30, skipped: true, skipReason: '临时有事' })];
  ZX.assistant.startTask('skipped');
  assert.equal(ZX.state.tasks[0].skipped, false);
  assert.equal(ZX.state.tasks[0].skipReason, null);
  assert.equal(ZX.state.running, 'skipped');
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

function deferredFixture(ZX) {
  ZX.state.tasks = [
    { id: 'pending', subject: '数学', title: '可执行任务', est: 30, time: '09:00–09:30', weight: 0.9 },
    { id: 'deferred', subject: '英语', title: '已顺延任务', est: 30, time: '10:00–10:30', weight: 0.1, deferred: true },
    { id: 'skipped', subject: '政治', title: '已跳过任务', est: 30, time: '11:00–11:30', weight: 0.2, skipped: true }
  ].map(task => ZX.state.normTask(task));
}

test('降载预览绑定任务与版本，运行中或计划变化后旧卡不得暂缓其他任务', () => {
  const { ZX } = boot();
  ZX.state.tasks = [
    { id: 'a', title: 'A', subject: '数学', est: 30, time: '09:00–09:30', weight: 0.2 },
    { id: 'b', title: 'B', subject: '英语', est: 30, time: '10:00–10:30', weight: 0.8 }
  ].map(task => ZX.state.normTask(task));
  ZX.assistant.tiredFlow();
  ZX.state.tasks[0].done = true;
  ZX.assistant.adoptTired();
  assert.equal(ZX.state.tasks[0].deferred, undefined);
  assert.equal(ZX.state.tasks[1].deferred, undefined);

  ZX.state.tasks[0].done = false;
  ZX.state.running = 'a';
  ZX.assistant.tiredFlow();
  ZX.assistant.adoptTired();
  assert.equal(ZX.state.tasks[0].deferred, undefined);
  assert.equal(ZX.state.tasks[1].deferred, true);
});

test('顺延任务不再出现在对话今日待办和提醒数量', () => {
  const { ZX, messages } = boot();
  deferredFixture(ZX);
  ZX.assistant.todayFlow();
  assert.match(messages.at(-1), /今天还剩 <b>1<\/b> 项/);
  assert.doesNotMatch(messages.at(-1), /已顺延任务/);
  assert.match(ZX.views.me(), /19:00 · 今日 1 项/);
});

test('采纳降载后播报的剩余项不包含刚顺延的任务', () => {
  const { ZX, messages } = boot();
  ZX.state.tasks = [
    { id: 'keep', title: '保留', subject: '数学', est: 30, time: '09:00–09:30', weight: 0.9 },
    { id: 'move', title: '顺延', subject: '英语', est: 30, time: '10:00–10:30', weight: 0.1 }
  ].map(task => ZX.state.normTask(task));
  ZX.assistant.tiredFlow();
  ZX.assistant.adoptTired();
  assert.equal(ZX.state.tasks[1].deferred, true);
  assert.match(messages.at(-1), /今天剩 1 项收工/);
});

test('降载提示如实说明仅标记顺延，未改变任务的计划落点', () => {
  const { ZX, messages } = boot();
  ZX.state.tasks = [{ id: 'tired', title: '待处理', subject: '英语', est: 30, time: '10:00–10:30', weight: 0.1 }].map(task => ZX.state.normTask(task));
  ZX.state.dayAssign = {};
  ZX.assistant.tiredFlow();
  assert.match(messages.at(-1), /仅标记顺延/);
  assert.match(messages.at(-1), /不会修改计划日期/);
  assert.doesNotMatch(messages.at(-1), /移入本周六弹性位/);
  ZX.assistant.adoptTired();
  assert.equal(ZX.state.tasks[0].deferred, true);
  assert.deepEqual(plain(ZX.state.dayAssign), {});
  assert.match(messages.at(-1), /仅标记顺延/);
  assert.match(messages.at(-1), /未修改计划日期/);
  assert.doesNotMatch(messages.at(-1), /移到周六弹性位/);
});

test('部分完成的确认和反馈不虚称剩余工时已进入弹性位', () => {
  const { ZX, messages } = boot();
  ZX.state.tasks = [ZX.state.normTask({ id: 'partial', title: '测试任务', subject: '数学', est: 60, time: '09:00–10:00' })];
  ZX.state.dayAssign = {};
  ZX.state.running = 'partial';
  ZX.state.timerStart = Date.now() - 120000;
  ZX.engine.attributeNow = require('../shared/engine/attribute.js').attribute;
  const note = {};
  let onClick;
  ZX.ui.footNav = () => '';
  ZX.ui.sheet = () => ({ root: { addEventListener: (_, fn) => { onClick = fn; }, querySelector: () => null }, $: () => note, close() {} });
  ZX.exec.openRecord('partial');
  onClick({ target: { closest: () => ({ dataset: { sc: 'pct', v: '50' } }) } });
  assert.match(note.textContent, /剩余.*预估/);
  assert.match(note.textContent, /不会自动移入弹性位/);
  assert.doesNotMatch(note.textContent, /已顺延到弹性位/);
  ZX.exec.commitRecord('partial', 20, 50, '', 1, 2);
  assert.equal(ZX.state.tasks[0].est, 30);
  assert.deepEqual(plain(ZX.state.dayAssign), {});
  const result = messages.at(-1);
  assert.match(result, /剩余.*预估/);
  assert.match(result, /未自动移入弹性位/);
  assert.doesNotMatch(result, /已顺延到弹性位|只占用弹性位|已落在弹性位/);
});

test('今日时间带不绘制已顺延或已跳过任务', () => {
  const { ZX } = boot();
  deferredFixture(ZX);
  const html = ZX.views.today();
  const band = html.slice(html.indexOf('class="tl"'), html.indexOf('class="tl-scale"'));
  assert.match(band, /可执行任务/);
  assert.doesNotMatch(band, /已顺延任务|已跳过任务/);
});

test('首页问候不把已顺延任务算入今日待办', () => {
  const { ZX, ctx } = boot();
  deferredFixture(ZX);
  ctx.document.readyState = 'loading';
  ZX.util.$ = () => ({ addEventListener() {}, dataset: {} });
  const main = fs.readFileSync(require.resolve('../assets/js/main.js'), 'utf8');
  vm.runInContext(main.replace('  function boot() {', '  ZX.testGreeting = greetingHtml;\n  function boot() {'), ctx);
  assert.match(ZX.testGreeting(), /今天还剩 <b class="hl">1<\/b> 项/);
});

test('未测量高效时段且静默时段在前端限制时不编造来源', () => {
  const { ZX } = boot();
  const html = ZX.views.me();
  assert.match(html, /高效时段<\/span><b>未分析<\/b>/);
  assert.doesNotMatch(html, /服务端裁决/);
});

test('本地模式明确服务端仅计算，并把旧队列显示为已隔离', () => {
  const { ZX } = boot();
  const html = ZX.views.me();
  assert.match(html, /数据模式<\/span><span class="v">本地主数据/);
  assert.match(html, /服务端角色<\/span><span class="v">仅计算辅助/);
  assert.match(html, /旧队列<\/span><span class="v" id="opPending">0 项已隔离/);
  assert.match(html, /删除本机业务数据，旧队列与待复核记录保留隔离/);
  assert.doesNotMatch(html, /上次同步|待确认冲突|待同步/);
});

test('今日对话转义任务科目、标题与时间，保留正常中文标点', () => {
  const { ZX, messages } = boot();
  ZX.state.tasks = [ZX.state.normTask({
    id: 'safe', s: '<img src=x onerror=alert(1)>', title: '<script>alert(1)</script>',
    time: '<svg onload=alert(1)>–10:00', est: 30
  })];
  ZX.assistant.todayFlow();
  assert.doesNotMatch(messages.at(-1), /<img|<script|<svg/);
  assert.match(messages.at(-1), /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(messages.at(-1), /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  ZX.state.tasks[0].s = '数学 / 408';
  ZX.state.tasks[0].title = '复习：极限、导数（重点）';
  ZX.state.tasks[0].time = '09:00–10:00';
  ZX.assistant.todayFlow();
  assert.match(messages.at(-1), /数学 \/ 408 · 复习：极限、导数（重点）/);
});

test('调参后的需求工时以 feas.demand 同步', () => {
  const { ZX, ops } = boot();
  ZX.engine.feasibilityNow = require('../shared/engine/feasibility.js').feasibility;
  ZX.assistant.adjustMath();
  assert.equal(ops.length, 1);
  assert.equal(ops[0].entity, 'feas');
  assert.equal(ops[0].entityId, 'current');
  assert.equal(ops[0].field, 'demand');
  assert.equal(ops[0].value, ZX.state.feas.demand);
});
