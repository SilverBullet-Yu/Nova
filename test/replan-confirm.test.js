'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require.resolve('../assets/js/assistant.js'), 'utf8');
function setup(storage = new Map(), persist = false) {
  const messages = [], ops = [];
  let state = { tasks: [{ id: 't', est: 50 }], week: [], replanInput: () => ({}) };
  const ZX = { state, util: { $: () => ({ children: [], appendChild: e => messages.push(e.innerHTML) }), nowStr: () => '', pct: String, esc: String, clone: structuredClone, num: (v, fallback) => Number.isFinite(v) ? v : fallback }, render() {}, setTab() {}, api: { queueOp: o => ops.push(o) }, engine: { replan: async () => ({ accepted: true, strategies: [{ level: 2, applied: true }], diff: [{ taskId: 't', op: 'compress', from: 50, to: 35 }], guards: {} }) } };
  if (persist) {
    vm.runInNewContext(fs.readFileSync(require.resolve('../assets/js/state.js'), 'utf8'), {
      crypto, window: { ZX, Rhythm: { seed: require('../shared/data/seed.js') },
        localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) } }
    });
    state = ZX.state;
    ZX.render = () => state.saveOverlay();
    ZX.engine.undo = async snapshot => require('../shared/engine/replan.js').undoReplan(snapshot);
    ZX.util.tsHM = () => '';
  }
  vm.runInNewContext(source, { window: { ZX, localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) }, Rhythm: { workflow: require('../shared/workflow.js') } }, document: { createElement: () => ({}) } });
  return { ZX, state, messages, ops };
}
test('对话普通重排先预览，确认只写一次', async () => {
  const { ZX, state, messages, ops } = setup();
  ZX.assistant.replanFlow();
  await Promise.resolve();
  assert.equal(state.tasks[0].est, 50);
  assert.equal(ops.length, 0);
  assert.match(messages.at(-1), /重排待确认/);
  ZX.assistant.confirmReplan();
  ZX.assistant.confirmReplan();
  assert.equal(state.tasks[0].est, 35);
  assert.equal(ops.length, 1);
});
test('在线重排等待服务端草案确认后才修改本地计划', async () => {
  const { ZX, state, ops } = setup();
  const preview = await ZX.engine.replan();
  ZX.engine.replan = async () => ({ ...preview, draftId: 'server-draft' });
  let release;
  let calls = 0;
  ZX.engine.confirmReplan = id => {
    assert.equal(id, 'server-draft');
    calls++;
    return new Promise(resolve => { release = resolve; });
  };
  ZX.assistant.replanFlow();
  await Promise.resolve();
  const request = ZX.assistant.confirmReplan();
  ZX.assistant.confirmReplan();
  assert.equal(state.tasks[0].est, 50);
  assert.equal(ops.length, 0);
  assert.equal(calls, 1);
  release(preview);
  await request;
  assert.equal(state.tasks[0].est, 35);
  assert.equal(ops.length, 1);
});
for (const rejected of [false, true]) {
  test('在线确认不覆盖独立修改：' + (rejected ? '服务端拒绝' : '迟到回执'), async () => {
    const { ZX, state, ops } = setup();
    const preview = await ZX.engine.replan();
    ZX.engine.replan = async () => ({ ...preview, draftId: 'server-draft' });
    let settle;
    ZX.engine.confirmReplan = () => new Promise((resolve, reject) => {
      settle = () => rejected ? reject(new Error('conflict')) : resolve(preview);
    });
    ZX.assistant.replanFlow();
    await Promise.resolve();
    const request = ZX.assistant.confirmReplan();
    state.tasks[0].est = 60;
    settle();
    await request;
    assert.equal(state.tasks[0].est, 60);
    assert.equal(ops.length, 0);
  });
}
test('预览不落盘，失效后仅写脱敏结案记录', async () => {
  const storage = new Map();
  const { ZX, state } = setup(storage);
  ZX.assistant.replanFlow();
  await Promise.resolve();
  assert.equal(storage.size, 0);
  state.tasks[0].est = 60;
  ZX.assistant.confirmReplan();
  const events = JSON.parse(storage.get('zx.replanTrace') || '[]');
  assert.deepEqual(events.map(e => e.status), ['stale']);
  assert.deepEqual(Object.keys(events[0]).sort(), ['at', 'id', 'planVersion', 'rulesVersion', 'status', 'tool']);
});
test('被新预览替换的草案记为拒绝，新草案重复确认只记一次提交', async () => {
  const storage = new Map();
  const { ZX, state, ops } = setup(storage);
  ZX.assistant.replanFlow();
  await Promise.resolve();
  ZX.assistant.replanFlow();
  await Promise.resolve();
  assert.equal(state.tasks[0].est, 50);
  assert.equal(ops.length, 0);
  ZX.assistant.confirmReplan();
  ZX.assistant.confirmReplan();
  const events = JSON.parse(storage.get('zx.replanTrace'));
  assert.deepEqual(events.map(e => e.status), ['rejected', 'committed']);
  assert.notEqual(events[0].id, events[1].id);
  assert.equal(events[1].id, state.replanHistory[0].requestId);
  assert.equal(ops.length, 1);
});
test('提交前异常仅记失败，不写业务数据或异常正文', async () => {
  const storage = new Map();
  const { ZX, state, ops } = setup(storage);
  ZX.assistant.replanFlow();
  await Promise.resolve();
  ZX.util.clone = () => { throw new Error('private test detail'); };
  ZX.assistant.confirmReplan();
  ZX.assistant.confirmReplan();
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
  ZX.assistant.replanFlow();
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
  ZX.assistant.replanFlow();
  ZX.engine.replan = replan;
  ZX.assistant.replanFlow();
  await Promise.resolve();
  assert.match(messages.at(-1), /重排待确认/);
  rejectOld(new Error('obsolete'));
  await Promise.resolve();
  assert.doesNotMatch(messages.join(''), /无法生成重排预览/);
  assert.equal(storage.has('zx.replanTrace'), false);
  ZX.assistant.confirmReplan();
  assert.equal(state.tasks[0].est, 35);
  assert.deepEqual(JSON.parse(storage.get('zx.replanTrace')).map(event => event.status), ['committed']);
});

test('计划变化使预览失效', async () => {
  const { ZX, state, ops } = setup();
  ZX.assistant.replanFlow();
  await Promise.resolve();
  assert.equal(ops.length, 0);
  state.tasks[0].est = 60;
  ZX.assistant.confirmReplan();
  assert.equal(state.tasks[0].est, 60);
  assert.equal(ops.length, 0);
});

test('确认单日顺延更新落点，撤销恢复并发送逆向改期', async () => {
  const { ZX, state, ops } = setup();
  state.dayAssign = { t: '二' };
  state.normTask = t => t;
  ZX.util.tsHM = () => '';
  ZX.engine.undo = async snap => snap;
  ZX.engine.replan = async () => ({ accepted: true, strategies: [{ level: 1, applied: true }], diff: [{ taskId: 't', op: 'defer', from: '二', to: '三' }], guards: {} });
  ZX.assistant.replanFlow();
  await Promise.resolve();
  assert.equal(state.dayAssign.t, '二');
  ZX.assistant.confirmReplan();
  assert.equal(state.dayAssign.t, '三');
  assert.equal(ops.find(o => o.field === 'moved').value.day, '三');
  ZX.assistant.undoReplan();
  assert.equal(state.dayAssign.t, '二');
  assert.equal(ops.filter(o => o.field === 'moved').at(-1).value.day, '二');
});

test('不能把跨日拆分静默写成单日顺延', async () => {
  const { ZX, state, ops } = setup();
  state.dayAssign = { t: '二' };
  ZX.engine.replan = async () => ({ accepted: true, strategies: [{ level: 1, applied: true }], diff: [{ taskId: 't', op: 'defer', to: '三/四' }], guards: {} });
  ZX.assistant.replanFlow();
  await Promise.resolve();
  ZX.assistant.confirmReplan();
  assert.equal(state.dayAssign.t, '二');
  assert.equal(ops.length, 0);
});

test('旧预览卡不能确认新草案', async () => {
  const { ZX, state, messages, ops } = setup();
  ZX.assistant.replanFlow();
  await Promise.resolve();
  const oldCard = messages.at(-1);
  ZX.assistant.replanFlow();
  await Promise.resolve();
  const newCard = messages.at(-1);
  const id = card => card.match(/data-draft="([^"]+)"/)?.[1];
  assert.match(oldCard, /data-act="confirm-replan"/);
  assert.ok(id(oldCard) && id(newCard));
  assert.notEqual(id(oldCard), id(newCard));
  ZX.assistant.confirmReplan(id(oldCard));
  assert.equal(state.tasks[0].est, 50);
  assert.equal(ops.length, 0);
  ZX.assistant.confirmReplan(id(newCard));
  assert.equal(state.tasks[0].est, 35);
  assert.equal(ops.length, 1);
});

test('已确认重排保留提交前后计划版本及关联 ID', async () => {
  const { ZX, state } = setup();
  state.currentPlanVersion = () => state.tasks[0].est === 50 ? 'plan-before' : 'plan-after';
  ZX.assistant.replanFlow();
  await Promise.resolve();
  assert.equal(state.replanHistory, undefined);
  ZX.assistant.confirmReplan();
  const entry = state.replanHistory[0];
  assert.equal(entry.planVersionBefore, 'plan-before');
  assert.equal(entry.planVersionAfter, 'plan-after');
  assert.match(entry.requestId, /^draft-/);
  assert.equal(entry.rulesVersion, 'nova-replan-p0-1');
});

test('撤销保留提交版本并记录撤销时间与结果版本', async () => {
  const storage = new Map();
  const { ZX, state } = setup(storage);
  state.normTask = t => t;
  ZX.util.tsHM = () => '';
  ZX.engine.undo = async snap => snap;
  let version = 'plan-before';
  state.currentPlanVersion = () => state.tasks[0].est === 35 ? 'plan-applied' : version;
  ZX.assistant.replanFlow();
  await Promise.resolve();
  ZX.assistant.confirmReplan();
  version = 'plan-restored';
  ZX.assistant.undoReplan();
  const entry = state.replanHistory[0];
  assert.equal(entry.planVersionAfter, 'plan-applied');
  assert.equal(entry.planVersionAfterUndo, 'plan-restored');
  assert.ok(entry.undoneAt >= entry.at);
  assert.equal(entry.undone, true);
  ZX.assistant.undoReplan();
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
  ZX.assistant.replanFlow();
  await Promise.resolve();
  const card = messages.at(-1);
  assert.match(card, /140 → 105 min/);
  assert.match(card, /数学/);
  assert.doesNotMatch(card, /政治/);
  assert.match(card, /未来 7 天/);
  assert.match(card, /1 个锁定块保持原样/);
  assert.ok(card.includes('1 / 1 保留'));
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
  ZX.assistant.replanFlow();
  await Promise.resolve();
  const card = messages.at(-1);
  assert.match(card, /重排已停止/);
  assert.match(card, /用户指令：重排；建议来源：确定性引擎/);
  assert.match(card, /顺延无法恢复到弹性位保留状态/);
  assert.doesNotMatch(card, /次重排未见改善|data-act="confirm-replan"/);
  assert.equal(storage.size, 0);
  assert.equal(ops.length, 0);
});

test('重排追踪保留最近 100 条，新事件只含白名单字段', async () => {
  const key = 'zx.replanTrace';
  const old = Array.from({ length: 100 }, (_, i) => ({ id: 'old-' + i, at: i }));
  const storage = new Map([[key, JSON.stringify(old)]]);
  const { ZX, state, ops } = setup(storage);
  ZX.assistant.replanFlow();
  await Promise.resolve();
  assert.deepEqual(JSON.parse(storage.get(key)), old);
  state.tasks[0].est = 60;
  ZX.assistant.confirmReplan();
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
  ZX.assistant.replanFlow();
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
  ZX.assistant.confirmReplan();
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
  ZX.assistant.replanFlow();
  await Promise.resolve();
  assert.equal(state.tab, 'plan');
  const card = messages.at(-1);
  assert.match(card, /40 → 30 min/);
  assert.match(card, /用户指令：重排；建议来源：确定性引擎/);
  assert.match(card, /未来 7 天/);
  assert.match(card, /1 \/ 1 保留/);
  assert.match(card, /确认后可回复「撤销」/);
  assert.match(card, /confirm-replan/);
  assert.equal(state.tasks[0].est, 40);
  assert.equal(state.dayAssign.open, '一');
  assert.equal(storage.size, 0);
  assert.equal(ops.length, 0);
  ZX.assistant.confirmReplan();
  assert.equal(state.tasks[0].est, 30);
  assert.equal(state.dayAssign.open, '二');
  assert.deepEqual(ops.filter(op => op.field === 'moved').map(op => [op.value.taskId, op.value.day]), [['open', '二']]);
  const refreshed = setup(storage, true);
  assert.equal(refreshed.state.tasks[0].est, 30);
  assert.equal(refreshed.state.dayAssign.open, '二');
  refreshed.ZX.assistant.undoReplan();
  const restored = setup(storage, true).state;
  assert.equal(restored.tasks[0].est, 40);
  assert.equal(restored.dayAssign.open, '一');
  assert.equal(restored.replanHistory.at(-1).undone, true);
  const overlay = storage.get('zx.overlay');
  storage.delete('zx.overlay');
  ZX.setTab('plan');
  assert.equal(typeof overlay, 'string');
  assert.equal(typeof storage.get('zx.overlay'), 'string');
});
