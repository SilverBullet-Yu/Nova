'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const H = require('./helpers');
const { seed } = require('../shared/data/seed');
const { feasibility } = require('../shared/engine/feasibility');

function setup(disk) {
  const store = H.storage(disk);
  const errors = [], frames = [], elements = {};
  for (const key of ['#form', '#ctxR', '#ctxGoal', '#btTitle b', '#btMeta', '#view', '#chat']) {
    elements[key] = { dataset: {}, textContent: '', innerHTML: '', addEventListener() {} };
  }
  const document = {
    readyState: 'loading', documentElement: { dataset: {} }, addEventListener() {},
    querySelector: key => elements[key] || null
  };
  let engineCalls = 0;
  const ZX = {
    engine: { feasibilityNow: input => { engineCalls++; return feasibility(input); } },
    api: { pendingCount: () => 0 },
    assistant: { tickTimer() {} }
  };
  const sandbox = {
    window: { ZX, Rhythm: { seed: { seed: JSON.parse(JSON.stringify(seed)) } },
      localStorage: store.localStorage, console: { error: (...args) => errors.push(args) } },
    document, console: { error: (...args) => errors.push(args) },
    requestAnimationFrame: fn => frames.push(fn)
  };
  H.installUtil(sandbox);
  function load(file) {
    vm.runInNewContext(fs.readFileSync(require.resolve('../assets/js/' + file), 'utf8'), sandbox);
  }
  for (const file of ['state.js', 'ui.js', 'flows/settings.js', 'flows/exec.js',
    'flows/planedit.js', 'flows/rescue.js', 'views/today.js', 'views/plan.js',
    'views/data.js', 'views/me.js', 'main.js']) load(file);
  ZX.ui.confirm = async () => true;
  ZX.ui.toast = () => {};
  return { ZX, disk: store.disk, errors, frames, elements, engineCalls: () => engineCalls };
}

async function removeGoal(app) {
  app.ZX.state.goal.source = 'user';
  assert.equal(await app.ZX.flows.settings.confirmRemoveGoal(), true);
}

function assertAllTabs(app) {
  for (const tab of ['chat', 'today', 'plan', 'data', 'me']) {
    app.elements['#view'].innerHTML = '';
    app.ZX.state.tab = tab;
    app.ZX.render();
    assert.equal(app.elements['#ctxR'].textContent, 'R 未设定', tab);
    assert.doesNotMatch(app.elements['#view'].innerHTML, /这个视图渲染出错了/, tab);
    if (tab !== 'chat') assert.match(app.elements['#view'].innerHTML, /class="wrap"/, tab);
    if (tab === 'plan') {
      assert.match(app.elements['#view'].innerHTML, /未设定阶段目标/);
      assert.match(app.elements['#view'].innerHTML, /data-goal-new>新建目标/);
      assert.doesNotMatch(app.elements['#view'].innerHTML, /r-big|class="marker"|可正常进入拆解|日程已排定/);
      assert.doesNotMatch(app.elements['#btMeta'].textContent, /日程已排定/);
    }
  }
  assert.deepEqual(app.errors, []);
}

test('删除目标明确返回无评估态，所有页面基础渲染不受影响且保留任务记录', async () => {
  const app = setup();
  app.ZX.state.sessions.push({ id: 'local-session', taskId: 't1', minutes: 30 });
  const before = JSON.stringify([app.ZX.state.tasks, app.ZX.state.sessions]);
  await removeGoal(app);
  assert.equal(app.ZX.state.feasibility(), null);
  assertAllTabs(app);
  assert.equal(app.engineCalls(), 0);
  assert.equal(JSON.stringify([app.ZX.state.tasks, app.ZX.state.sessions]), before);
});

test('删除后刷新使用真实 util/overlay 恢复，无目标状态不退回种子', async () => {
  const first = setup();
  await removeGoal(first);
  const refreshed = setup(first.disk);
  assert.equal(refreshed.ZX.state.goal.source, 'removed');
  assert.equal(refreshed.ZX.state.feasibility(), null);
  assertAllTabs(refreshed);
});

test('无名称目标和显式删除均无评估，但有效目标损坏的需求仍报错', () => {
  const app = setup();
  const S = app.ZX.state;
  assert.deepEqual(JSON.parse(JSON.stringify(S.feasibility())), feasibility(S.feasInput()));
  S.feas.demand = 0;
  assert.throws(() => S.feasibility());
  for (const goal of [null, {}, { name: '   ' }, { name: '旧目标', source: 'removed' }]) {
    S.goal = goal;
    assert.equal(S.feasibility(), null);
    assertAllTabs(app);
  }
});

test('删除目标后对话可行性和加时指令返回空态，不访问 null 评估', () => {
  const messages = [];
  const box = { children: [], appendChild: el => messages.push(el.innerHTML) };
  const ZX = { state: { feasibility: () => null, feas: { demand: 0 } }, setTab() {} };
  const sandbox = { window: { ZX }, document: { createElement: () => ({}), querySelector: () => box } };
  H.installUtil(sandbox);
  vm.runInNewContext(fs.readFileSync(require.resolve('../assets/js/assistant.js'), 'utf8'), sandbox);
  assert.doesNotThrow(() => ZX.assistant.feasibilityFlow());
  assert.doesNotThrow(() => ZX.assistant.adjustMath());
  assert.equal(messages.length, 2);
  assert.ok(messages.every(text => text.includes('还没有阶段目标')));
});

test('删除时取消旧 R 数字动画，重新设置目标后恢复真实 R', async () => {
  const app = setup();
  app.ZX.util.prefs = () => ({ motion: true });
  const r = app.elements['#ctxR'];
  r.dataset.num = '0.5';
  app.ZX.render();
  assert.ok(app.frames.length > 0);
  await removeGoal(app);
  for (let now = 0; app.frames.length; now += 500) {
    assert.ok(now < 5000, '动画应该终止');
    app.frames.shift()(now);
  }
  assert.equal(r.textContent, 'R 未设定');
  assert.equal(r.dataset.num, undefined);
  app.ZX.state.goal = JSON.parse(JSON.stringify(seed.goal));
  app.ZX.state.feas = JSON.parse(JSON.stringify(seed.feas));
  app.ZX.state.tab = 'plan';
  app.ZX.render();
  assert.equal(r.textContent, 'R ' + feasibility(seed.feas).R.toFixed(2));
  assert.match(app.elements['#view'].innerHTML, /r-big/);
  assert.deepEqual(app.errors, []);
});
