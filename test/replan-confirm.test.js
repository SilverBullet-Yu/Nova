'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const H = require('./helpers');
const source = fs.readFileSync(require.resolve('../assets/js/assistant.js'), 'utf8');
const replanSource = fs.readFileSync(require.resolve('../assets/js/flows/replan.js'), 'utf8');
const mainSource = fs.readFileSync(require.resolve('../assets/js/main.js'), 'utf8');
function setup(storage = new Map(), persist = false) {
  const messages = [], ops = [];
  let state = { tasks: [{ id: 't', est: 50 }], week: [], replanInput: () => ({}) };
  const ZX = { state, render() {}, setTab() {}, api: { queueOp: o => ops.push(o) }, engine: { replan: async () => ({ accepted: true, strategies: [{ level: 2, applied: true }], diff: [{ taskId: 't', op: 'compress', from: 50, to: 35 }], guards: {} }) } };
  const win = { ZX, localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) } };
  const sandbox = { window: win, document: { createElement: () => ({}) } };
  H.installUtil(sandbox);   /* 真实 util：appendTrace / pct / esc 与生产同源 */
  ZX.util.$ = () => ({ children: [], appendChild: e => messages.push(e.innerHTML) });
  if (persist) {
    win.Rhythm = { seed: require('../shared/data/seed.js') };
    vm.runInNewContext(fs.readFileSync(require.resolve('../assets/js/state.js'), 'utf8'), sandbox);
    state = ZX.state;
    ZX.render = () => state.saveOverlay();
    ZX.util.tsHM = () => '';
  }
  win.Rhythm = Object.assign({}, win.Rhythm, { workflow: require('../shared/workflow.js') });
  vm.runInNewContext(source, sandbox);
  vm.runInNewContext(replanSource, sandbox);   /* 重排域在 flows/replan.js */
  return { ZX, state, messages, ops };
}

/* 装载真实 main 点击委托；按钮由预览卡 HTML 的 data-draft 构造，点击经 document 监听器转发。 */
function installMainClicks(ZX, messages) {
  const listeners = {};
  const chat = {
    children: [], scrollTop: 0, scrollHeight: 0,
    appendChild(child) { this.children.push(child); messages.push(child.innerHTML); },
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); }
  };
  const element = () => ({
    innerHTML: '', textContent: '', value: '', hidden: false, dataset: {}, style: {}, offsetWidth: 0,
    children: [], scrollTop: 0, scrollHeight: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
    appendChild() {}, removeChild() {}, focus() {}, setAttribute() {}, removeAttribute() {},
    closest: () => null
  });
  ZX.util.$ = selector => selector === '#chat' ? chat : element();
  const document = {
    readyState: 'loading', documentElement: { dataset: {} }, activeElement: null,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    querySelector: () => element(), querySelectorAll: () => []
  };
  vm.runInNewContext(mainSource, {
    window: { ZX, addEventListener() {} }, document,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1
  });
  ZX.render = () => {};
  ZX.setTab = () => {};
  return {
    button(card) {
      const draft = card.match(/data-draft="([^"]+)"/)?.[1];
      assert.ok(draft, '预览卡应携带草案 ID');
      const button = {
        dataset: { act: 'confirm-replan', draft },
        closest: selector => selector === '[data-act]' ? button : null
      };
      return button;
    },
    click(button) {
      const target = { closest: selector => button.closest(selector) };
      (listeners.click || []).forEach(fn => fn({ target }));
    }
  };
}

async function setupConfirmedReplan() {
  const result = setup();
  const { ZX, state } = result;
  state.dayAssign = { t: '二' };
  state.normTask = task => task;
  ZX.util.tsHM = () => '';
  ZX.engine.replan = async () => ({
    accepted: true, strategies: [{ level: 1, applied: true }], guards: {},
    diff: [
      { taskId: 't', op: 'compress', from: 50, to: 35 },
      { taskId: 't', op: 'defer', from: '二', to: '三' }
    ]
  });
  ZX.flows.replan.replanFlow();
  await Promise.resolve();
  ZX.flows.replan.confirmReplan();
  assert.equal(JSON.stringify(state.snapshot.afterTasks), JSON.stringify(state.tasks));
  assert.equal(JSON.stringify(state.snapshot.afterDayAssign), JSON.stringify(state.dayAssign));
  return result;
}

test('对话普通重排先预览，确认只写一次', async () => {
  const { ZX, state, messages, ops } = setup();
  ZX.flows.replan.replanFlow();
  await Promise.resolve();
  assert.equal(state.tasks[0].est, 50);
  assert.equal(ops.length, 0);
  assert.match(messages.at(-1), /重排待确认/);
  ZX.flows.replan.confirmReplan();
  ZX.flows.replan.confirmReplan();
  assert.equal(state.tasks[0].est, 35);
  assert.equal(state.replanHistory.length, 1);
  assert.equal(ops.filter(op => op.field === 'applied').length, 1);
  assert.equal(ops.length, 1);
});
test('确认后的结果卡渲染绑定草案与版本的逐条否决按钮', async () => {
  const { ZX, state, messages } = setup();
  state.currentPlanVersion = () => 'plan-test';
  ZX.flows.replan.replanFlow();
  await Promise.resolve();
  const draftId = messages.at(-1).match(/data-draft="([^"]+)"/)?.[1];
  assert.ok(draftId);
  ZX.flows.replan.confirmReplan(draftId);
  const card = messages.at(-1);
  assert.match(card, /重排已确认/);
  assert.match(card, /data-veto="t"/);
  assert.match(card, /data-vop="compress"/);
  assert.ok(card.includes('data-vdraft="' + draftId + '"'));
  assert.match(card, /data-vplan="plan-/);
});

test('服务端草案仅参与计算，本地同步确认且忽略 draftId', async () => {
  const { ZX, state, ops } = setup();
  ZX.engine.replan = async () => ({
    draftId: 'server-draft', accepted: true, loadDelta: 0.1,
    strategies: [{ level: 2, applied: true }],
    diff: [{ taskId: 't', op: 'compress', from: 50, to: 35 }], guards: {}
  });
  ZX.engine.confirmReplan = () => { throw new Error('远程确认不得运行'); };
  ZX.flows.replan.replanFlow();
  await Promise.resolve();
  assert.equal(state.tasks[0].est, 50);
  ZX.flows.replan.confirmReplan();
  assert.equal(state.tasks[0].est, 35);
  assert.equal(state.replanHistory.length, 1);
  assert.equal(ops.length, 1);
  assert.equal(JSON.stringify(state.replanHistory[0]).includes('server-draft'), false);
  assert.match(state.replanHistory[0].requestId, /^draft-/);
  ZX.flows.replan.confirmReplan();
  assert.equal(state.replanHistory.length, 1);
  assert.equal(ops.length, 1);
});
test('独立修改使在线预览失效，不等待或采纳迟到回执', async () => {
  const storage = new Map();
  const { ZX, state, ops } = setup(storage);
  let resolvePreview;
  ZX.engine.replan = () => new Promise(resolve => { resolvePreview = resolve; });
  ZX.flows.replan.replanFlow();
  state.tasks[0].est = 60;
  resolvePreview({ accepted: true, strategies: [{ level: 2, applied: true }],
    diff: [{ taskId: 't', op: 'compress', from: 50, to: 35 }], guards: {} });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(state.tasks[0].est, 60);
  assert.equal(ops.length, 0);
  assert.equal(storage.has('zx.replanTrace'), false);
  ZX.flows.replan.confirmReplan();
  assert.equal(state.replanHistory, undefined);
  assert.equal(ops.length, 0);
});
test('预览不落盘，失效后仅写脱敏结案记录', async () => {
  const storage = new Map();
  const { ZX, state } = setup(storage);
  ZX.flows.replan.replanFlow();
  await Promise.resolve();
  assert.equal(storage.size, 0);
  state.tasks[0].est = 60;
  ZX.flows.replan.confirmReplan();
  const events = JSON.parse(storage.get('zx.replanTrace') || '[]');
  assert.deepEqual(events.map(e => e.status), ['stale']);
  assert.deepEqual(Object.keys(events[0]).sort(), ['at', 'id', 'planVersion', 'rulesVersion', 'status', 'tool']);
});
test('被新预览替换的草案记为拒绝，新草案重复确认只记一次提交', async () => {
  const storage = new Map();
  const { ZX, state, ops } = setup(storage);
  ZX.flows.replan.replanFlow();
  await Promise.resolve();
  ZX.flows.replan.replanFlow();
  await Promise.resolve();
  assert.equal(state.tasks[0].est, 50);
  assert.equal(ops.length, 0);
  ZX.flows.replan.confirmReplan();
  ZX.flows.replan.confirmReplan();
  const events = JSON.parse(storage.get('zx.replanTrace'));
  assert.deepEqual(events.map(e => e.status), ['rejected', 'committed']);
  assert.notEqual(events[0].id, events[1].id);
  assert.equal(events[1].id, state.replanHistory[0].requestId);
  assert.equal(ops.length, 1);
});
test('提交前异常仅记失败，不写业务数据或异常正文', async () => {
  const storage = new Map();
  const { ZX, state, ops } = setup(storage);
  ZX.flows.replan.replanFlow();
  await Promise.resolve();
  ZX.util.clone = () => { throw new Error('private test detail'); };
  ZX.flows.replan.confirmReplan();
  ZX.flows.replan.confirmReplan();
  const raw = storage.get('zx.replanTrace');
  assert.deepEqual(JSON.parse(raw).map(e => e.status), ['failed']);
  assert.doesNotMatch(raw, /private test detail/);
  assert.equal(state.tasks[0].est, 50);
  assert.equal(state.replanHistory, undefined);
  assert.equal(ops.length, 0);
});
test('重排引擎失败提示用户且不写计划', async () => {
  const storage = new Map();
  const { ZX, state, messages, ops } = setup(storage);
  state.currentPlanVersion = () => 'plan-at-request';
  ZX.engine.replan = async () => { throw new Error('private detail'); };
  ZX.flows.replan.replanFlow();
  await Promise.resolve();
  assert.match(messages.join(''), /无法生成重排预览/);
  assert.doesNotMatch(messages.join(''), /private detail/);
  const raw = storage.get('zx.replanTrace') || '[]';
  const events = JSON.parse(raw);
  assert.deepEqual(events.map(e => [e.status, e.stage, e.planVersion]), [['failed', 'engine', 'plan-at-request']]);
  assert.doesNotMatch(raw, /private detail/);
  assert.equal(state.tasks[0].est, 50);
  assert.equal(ops.length, 0);
});
test('旧重排请求迟到失败，不覆盖新草案或增加失败记录', async () => {
  const storage = new Map();
  const { ZX, messages, state } = setup(storage);
  const replan = ZX.engine.replan;
  let rejectOld;
  ZX.engine.replan = () => new Promise((resolve, reject) => { rejectOld = reject; });
  ZX.flows.replan.replanFlow();
  ZX.engine.replan = replan;
  ZX.flows.replan.replanFlow();
  await Promise.resolve();
  assert.match(messages.at(-1), /重排待确认/);
  rejectOld(new Error('obsolete'));
  await Promise.resolve();
  assert.doesNotMatch(messages.join(''), /无法生成重排预览/);
  assert.equal(storage.has('zx.replanTrace'), false);
  ZX.flows.replan.confirmReplan();
  assert.equal(state.tasks[0].est, 35);
  assert.deepEqual(JSON.parse(storage.get('zx.replanTrace')).map(event => event.status), ['committed']);
});

test('计划变化使预览失效', async () => {
  const { ZX, state, ops } = setup();
  ZX.flows.replan.replanFlow();
  await Promise.resolve();
  assert.equal(ops.length, 0);
  state.tasks[0].est = 60;
  ZX.flows.replan.confirmReplan();
  assert.equal(state.tasks[0].est, 60);
  assert.equal(ops.length, 0);
});

test('确认单日顺延更新落点，撤销恢复并发送逆向改期', async () => {
  const { ZX, state, ops } = setup();
  state.dayAssign = { t: '二' };
  state.normTask = t => t;
  ZX.util.tsHM = () => '';
  ZX.engine.replan = async () => ({ accepted: true, strategies: [{ level: 1, applied: true }], diff: [{ taskId: 't', op: 'defer', from: '二', to: '三' }], guards: {} });
  ZX.flows.replan.replanFlow();
  await Promise.resolve();
  assert.equal(state.dayAssign.t, '二');
  ZX.flows.replan.confirmReplan();
  assert.equal(state.dayAssign.t, '三');
  assert.equal(ops.find(o => o.field === 'moved').value.day, '三');
  ZX.flows.replan.undoReplan();
  assert.equal(state.dayAssign.t, '二');
  assert.equal(ops.filter(o => o.field === 'moved').at(-1).value.day, '二');
});

const laterChanges = [
  ['完成任务', state => { state.tasks[0].done = true; }],
  ['记录 actual', state => { state.tasks[0].actual = 25; }],
  ['跳过任务', state => { state.tasks[0].skipped = true; }],
  ['暂缓任务', state => { state.tasks[0].deferred = true; }],
  ['修改 est', state => { state.tasks[0].est = 42; }],
  ['修改 dayAssign', state => { state.dayAssign.t = '四'; }]
];
for (const [label, change] of laterChanges) {
  test('重排后' + label + '再撤销：整笔拒绝且状态不变', async () => {
    const { ZX, state, messages, ops } = await setupConfirmedReplan();
    const snapshot = state.snapshot;
    const entry = state.replanHistory[0];
    change(state);
    const beforeTasks = JSON.stringify(state.tasks);
    const beforeDays = JSON.stringify(state.dayAssign);
    const opCount = ops.length;
    ZX.flows.replan.undoReplan();
    assert.equal(JSON.stringify(state.tasks), beforeTasks);
    assert.equal(JSON.stringify(state.dayAssign), beforeDays);
    assert.equal(state.snapshot, snapshot);
    assert.equal(state.replanned, true);
    assert.equal(entry.undone, false);
    assert.equal(Object.hasOwn(entry, 'undoneAt'), false);
    assert.equal(ops.length, opCount);
    assert.match(messages.at(-1), /撤销冲突/);
    assert.match(messages.at(-1), /整笔撤销已拒绝/);
  });
}

for (const field of ['afterTasks', 'afterDayAssign']) {
  test('旧快照缺少 ' + field + ' 时拒绝安全撤销', async () => {
    const { ZX, state, messages, ops } = await setupConfirmedReplan();
    const snapshot = state.snapshot;
    const entry = state.replanHistory[0];
    delete snapshot[field];
    const beforeTasks = JSON.stringify(state.tasks);
    const beforeDays = JSON.stringify(state.dayAssign);
    const opCount = ops.length;
    ZX.flows.replan.undoReplan();
    assert.equal(JSON.stringify(state.tasks), beforeTasks);
    assert.equal(JSON.stringify(state.dayAssign), beforeDays);
    assert.equal(state.snapshot, snapshot);
    assert.equal(state.replanned, true);
    assert.equal(entry.undone, false);
    assert.equal(Object.hasOwn(entry, 'undoneAt'), false);
    assert.equal(ops.length, opCount);
    assert.match(messages.at(-1), /缺少确认后的任务/);
  });
}

test('无冲突撤销成功恢复任务与落点并记录逆向改期', async () => {
  const { ZX, state, ops } = await setupConfirmedReplan();
  assert.equal(state.tasks[0].est, 35);
  assert.equal(state.dayAssign.t, '三');
  ZX.flows.replan.undoReplan();
  assert.equal(state.tasks[0].est, 50);
  assert.equal(state.dayAssign.t, '二');
  assert.equal(state.snapshot, null);
  assert.equal(state.replanned, false);
  assert.equal(state.replanHistory[0].undone, true);
  assert.deepEqual(ops.filter(op => op.field === 'moved').map(op => op.value.day), ['三', '二']);
});

test('main 点击委托：旧预览卡只拒绝旧草案，新卡可确认', async () => {
  const { ZX, state, messages, ops } = setup();
  const dom = installMainClicks(ZX, messages);
  ZX.flows.replan.replanFlow();
  await Promise.resolve();
  const oldCard = messages.at(-1);
  ZX.flows.replan.replanFlow();
  await Promise.resolve();
  const newCard = messages.at(-1);
  const oldButton = dom.button(oldCard);
  const newButton = dom.button(newCard);
  assert.notEqual(oldButton.dataset.draft, newButton.dataset.draft);

  dom.click(oldButton);
  assert.equal(state.tasks[0].est, 50);
  assert.equal(ops.length, 0);
  assert.match(messages.at(-1), /这份预览已失效/);

  dom.click(newButton);
  assert.equal(state.tasks[0].est, 35);
  assert.equal(state.replanHistory.length, 1);
  assert.equal(ops.filter(op => op.field === 'applied').length, 1);
});

test('不能把跨日拆分静默写成单日顺延', async () => {
  const { ZX, state, ops } = setup();
  state.dayAssign = { t: '二' };
  ZX.engine.replan = async () => ({ accepted: true, strategies: [{ level: 1, applied: true }], diff: [{ taskId: 't', op: 'defer', to: '三/四' }], guards: {} });
  ZX.flows.replan.replanFlow();
  await Promise.resolve();
  ZX.flows.replan.confirmReplan();
  assert.equal(state.dayAssign.t, '二');
  assert.equal(ops.length, 0);
});

test('旧预览卡不能确认新草案', async () => {
  const { ZX, state, messages, ops } = setup();
  ZX.flows.replan.replanFlow();
  await Promise.resolve();
  const oldCard = messages.at(-1);
  ZX.flows.replan.replanFlow();
  await Promise.resolve();
  const newCard = messages.at(-1);
  const id = card => card.match(/data-draft="([^"]+)"/)?.[1];
  assert.match(oldCard, /data-act="confirm-replan"/);
  assert.ok(id(oldCard) && id(newCard));
  assert.notEqual(id(oldCard), id(newCard));
  ZX.flows.replan.confirmReplan(id(oldCard));
  assert.equal(state.tasks[0].est, 50);
  assert.equal(ops.length, 0);
  ZX.flows.replan.confirmReplan(id(newCard));
  assert.equal(state.tasks[0].est, 35);
  assert.equal(ops.length, 1);
});

test('已确认重排保留提交前后计划版本及关联 ID', async () => {
  const { ZX, state } = setup();
  state.currentPlanVersion = () => state.tasks[0].est === 50 ? 'plan-before' : 'plan-after';
  ZX.flows.replan.replanFlow();
  await Promise.resolve();
  assert.equal(state.replanHistory, undefined);
  ZX.flows.replan.confirmReplan();
  const entry = state.replanHistory[0];
  assert.equal(entry.planVersionBefore, 'plan-before');
  assert.equal(entry.planVersionAfter, 'plan-after');
  assert.match(entry.requestId, /^draft-/);
  assert.equal(entry.rulesVersion, 'nova-replan-p0-1');
});

test('撤销保留提交版本并记录撤销时间与结果版本', async () => {
  const storage = new Map();
  const { ZX, state } = setup(storage);
  ZX.engine.undo = () => { throw new Error('撤销必须直接恢复本机快照'); };
  state.normTask = t => t;
  ZX.util.tsHM = () => '';
  let version = 'plan-before';
  state.currentPlanVersion = () => state.tasks[0].est === 35 ? 'plan-applied' : version;
  ZX.flows.replan.replanFlow();
  await Promise.resolve();
  ZX.flows.replan.confirmReplan();
  version = 'plan-restored';
  ZX.flows.replan.undoReplan();
  const entry = state.replanHistory[0];
  assert.equal(entry.planVersionAfter, 'plan-applied');
  assert.equal(entry.planVersionAfterUndo, 'plan-restored');
  assert.ok(entry.undoneAt >= entry.at);
  assert.equal(entry.undone, true);
  ZX.flows.replan.undoReplan();
  const events = JSON.parse(storage.get('zx.replanTrace'));
  assert.deepEqual(events.map(e => e.status), ['committed', 'undone']);
  assert.deepEqual(events[1], { id: entry.requestId, tool: 'replan', at: entry.undoneAt,
    planVersion: entry.planVersionAfterUndo, rulesVersion: entry.rulesVersion, status: 'undone' });
});

test('真实引擎超载预览展示压缩、负载与约束，确认前不写入', async () => {
  const storage = new Map();
  const { ZX, state, messages, ops } = setup(storage);
  const { replan } = require('../shared/engine/replan.js');
  state.tasks = [
    { id: 'open', subject: '数学', est: 140, weight: 0.9 },
    { id: 'locked', subject: '政治', est: 40, weight: 0.1 }
  ];
  state.locks = { locked: true };
  state.week = Array.from({ length: 7 }, (_, i) => ({ date: 'D' + (i + 1), minutes: 100, capacity: 115, buffer: 60 }));
  state.replanInput = () => ({ tasks: state.tasks, locks: state.locks, week: state.week, timestamp: 1000 });
  ZX.engine.replan = async input => replan(input);
  const before = structuredClone([state.tasks, state.week, state.locks]);
  ZX.flows.replan.replanFlow();
  await Promise.resolve();
  const card = messages.at(-1);
  assert.match(card, /140 → 105 min/);
  assert.match(card, /数学/);
  assert.doesNotMatch(card, /政治/);
  assert.match(card, /未来 7 天/);
  assert.match(card, /1 个锁定块保持原样/);
  assert.ok(card.includes('弹性位保留'));
  assert.ok(card.includes('容量内'));
  assert.match(card, /容量内无足够空闲时段/);
  assert.doesNotMatch(card, /超过单次上限/);
  assert.match(card, /当前计划板不能保存跨日拆分/);
  assert.doesNotMatch(card, /data-act="confirm-replan"/);
  assert.deepEqual([state.tasks, state.week, state.locks], before);
  assert.equal(storage.size, 0);
  assert.equal(ops.length, 0);
});

test('弹性位冲突阻断重排时，不误报连续未改善', async () => {
  const storage = new Map();
  const { ZX, state, messages, ops } = setup(storage);
  const { replan } = require('../shared/engine/replan.js');
  state.noImproveCount = () => 0;
  state.replanInput = () => ({ tasks: state.tasks, week: [{ date: '一', minutes: 400, buffer: 60 }], timestamp: 1000 });
  ZX.engine.replan = async input => replan(input);
  ZX.flows.replan.replanFlow();
  await Promise.resolve();
  const card = messages.at(-1);
  assert.match(card, /重排已停止/);
  assert.match(card, /用户指令：重排；建议来源：确定性引擎/);
  assert.match(card, /顺延无法恢复/);
  assert.doesNotMatch(card, /次重排未见改善|data-act="confirm-replan"/);
  assert.equal(storage.size, 0);
  assert.equal(ops.length, 0);
});

test('重排追踪保留最近 100 条，新事件只含白名单字段', async () => {
  const key = 'zx.replanTrace';
  const old = Array.from({ length: 100 }, (_, i) => ({ id: 'old-' + i, at: i }));
  const storage = new Map([[key, JSON.stringify(old)]]);
  const { ZX, state, ops } = setup(storage);
  ZX.flows.replan.replanFlow();
  await Promise.resolve();
  assert.deepEqual(JSON.parse(storage.get(key)), old);
  state.tasks[0].est = 60;
  ZX.flows.replan.confirmReplan();
  const events = JSON.parse(storage.get(key));
  assert.equal(events.length, 100);
  assert.deepEqual(events.slice(0, -1), old.slice(1));
  assert.equal(events.at(-1).status, 'stale');
  assert.deepEqual(Object.keys(events.at(-1)).sort(), ['at', 'id', 'planVersion', 'rulesVersion', 'status', 'tool']);
  assert.equal(ops.length, 0);
});

test('局部中断：只顺延待调整项，预览不写入且可确认', async () => {
  const storage = new Map();
  const { ZX, state, messages, ops } = setup(storage);
  const { replan } = require('../shared/engine/replan.js');
  state.tasks = [
    { id: 'done', subject: '英语', est: 60, done: true },
    { id: 'move', subject: '数学', title: '积分练习', est: 30, weight: 0.8 },
    { id: 'fixed', subject: '政治', est: 30, weight: 0.2 }
  ];
  state.locks = { fixed: true };
  state.dayAssign = { done: '一', move: '一', fixed: '三' };
  state.week = ['二', '三', '四', '五', '六', '日', '一'].map(date => ({ date, minutes: 100, capacity: date === '二' ? 130 : 100, buffer: 60 }));
  state.replanInput = () => ({ tasks: state.tasks, locks: state.locks, week: state.week, timestamp: 1000 });
  ZX.engine.replan = async input => replan(input);
  const before = structuredClone(state.tasks);
  ZX.flows.replan.replanFlow();
  await Promise.resolve();
  const card = messages.at(-1);
  assert.match(card, /重排待确认/);
  assert.match(card, /确认后可回复「撤销」/);
  assert.match(card, /1 个锁定块保持原样/);
  assert.match(card, /数学 · 积分练习/);
  assert.doesNotMatch(card, /英语|政治/);
  assert.deepEqual(state.dayAssign, { done: '一', move: '一', fixed: '三' });
  assert.deepEqual(state.tasks, before);
  assert.equal(storage.size, 0);
  assert.equal(ops.length, 0);
  ZX.flows.replan.confirmReplan();
  assert.deepEqual({ ...state.dayAssign }, { done: '一', move: '二', fixed: '三' });
  assert.deepEqual(ops.filter(op => op.field === 'moved').map(op => [op.value.taskId, op.value.day]), [['move', '二']]);
});

test('可提交的超载重排：确认前不落盘，确认后应用压缩和顺延', async () => {
  const storage = new Map();
  const { ZX, state, messages, ops } = setup(storage, true);
  const { replan } = require('../shared/engine/replan.js');
  state.tasks = [{ id: 'open', subject: '数学', est: 40, weight: 0.9 }];
  state.dayAssign = { open: '一' };
  state.week = ['二', '三', '四', '五', '六', '日', '一'].map((date, i) =>
    ({ date, minutes: 100, capacity: i ? 100 : 130, buffer: 60 }));
  state.replanInput = () => ({ tasks: state.tasks, week: state.week, timestamp: 1000 });
  ZX.engine.replan = async input => replan(input);
  const element = { children: [], addEventListener() {}, appendChild: e => messages.push(e.innerHTML) };
  ZX.util.$ = selector => selector === '#ctxR' ? null : element;
  ZX.views = { plan: () => '' };
  vm.runInNewContext(fs.readFileSync(require.resolve('../assets/js/main.js'), 'utf8'), {
    window: { ZX }, document: { readyState: 'loading', documentElement: { dataset: {} }, addEventListener() {} }
  });
  state.tab = 'chat';
  ZX.flows.replan.replanFlow();
  await Promise.resolve();
  assert.equal(state.tab, 'plan');
  const card = messages.at(-1);
  assert.match(card, /40 → 30 min/);
  assert.match(card, /用户指令：重排；建议来源：确定性引擎/);
  assert.match(card, /未来 7 天/);
  assert.match(card, /弹性位保留/);
  assert.match(card, /容量内/);
  assert.match(card, /确认后可回复「撤销」/);
  assert.match(card, /confirm-replan/);
  assert.equal(state.tasks[0].est, 40);
  assert.equal(state.dayAssign.open, '一');
  assert.equal(storage.size, 0);
  assert.equal(ops.length, 0);
  ZX.flows.replan.confirmReplan();
  assert.equal(state.tasks[0].est, 30);
  assert.equal(state.dayAssign.open, '二');
  assert.equal(JSON.stringify(state.snapshot.afterTasks), JSON.stringify(state.tasks));
  assert.equal(JSON.stringify(state.snapshot.afterDayAssign), JSON.stringify(state.dayAssign));
  assert.deepEqual(ops.filter(op => op.field === 'moved').map(op => [op.value.taskId, op.value.day]), [['open', '二']]);
  const refreshed = setup(storage, true);
  assert.equal(refreshed.state.tasks[0].est, 30);
  assert.equal(refreshed.state.dayAssign.open, '二');
  assert.equal(JSON.stringify(refreshed.state.snapshot.afterTasks.map(refreshed.state.normTask)), JSON.stringify(refreshed.state.tasks));
  assert.deepEqual(JSON.parse(JSON.stringify(refreshed.state.snapshot.afterDayAssign)), JSON.parse(JSON.stringify(refreshed.state.dayAssign)));
  refreshed.ZX.flows.replan.undoReplan();
  const restored = setup(storage, true).state;
  assert.equal(restored.tasks[0].est, 40);
  assert.equal(restored.dayAssign.open, '一');
  assert.equal(restored.replanHistory.at(-1).undone, true);
  const overlay = storage.get('zx.overlay');
  storage.delete('zx.overlay');
  ZX.setTab('plan');
  assert.equal(typeof overlay, 'string');
  assert.equal(state.overlayConflict, true);
  assert.equal(storage.has('zx.overlay'), false, '旧页面不得把外部删除当成可覆盖空白存储');
  const reloaded = setup(storage, true);
  assert.equal(reloaded.state.saveOverlay(), true, '刷新后才按当前存储建立新快照');
  assert.equal(typeof storage.get('zx.overlay'), 'string');
});
