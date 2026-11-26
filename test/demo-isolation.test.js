'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const plain = value => JSON.parse(JSON.stringify(value));

const NOW = new Date(2026, 10, 24, 12, 0, 0).getTime();
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return NOW; }
}

function daysAgo(days) {
  const date = new FixedDate(NOW);
  date.setDate(date.getDate() - days);
  return date.getTime();
}

function boot(zeroDays = 0) {
  const messages = [], ops = [], toasts = [], sheets = [], listeners = [];
  const state = {
    tab: 'chat',
    goal: { name: '阶段目标', target: '100 分', deadline: '2027-12-25', weeks: 5 },
    feas: { weeklyH: 10, weeks: 5, demand: 500 },
    tasks: [
      { id: 'a', s: '数学', subject: '数学', title: '任务甲', est: 100, weight: 0.1, time: '09:00–10:40' },
      { id: 'b', s: '数学', subject: '数学', title: '任务乙', est: 100, weight: 0.9, time: '10:40–12:20' },
      { id: 'done', s: '数学', subject: '数学', title: '已完成', est: 40, actual: 40, weight: 1, done: true }
    ],
    locks: {},
    week: [{ d: '一', total: 600, buf: 60, segs: [['数学', 600]] }],
    dayAssign: { a: '一', b: '二', done: '三' },
    sessions: zeroDays ? [{ endAt: daysAgo(zeroDays) }] : [],
    consecutiveZeroDays: zeroDays,
    interrupted: zeroDays >= 3,
    rescueRecord: null,
    workedMin() { return this.tasks.reduce((sum, task) => sum + (task.done ? Number(task.actual || 0) : 0), 0); }
  };
  const ZX = {
    state,
    api: { queueOp: op => ops.push(op) },
    setTab: tab => { state.tab = tab; },
    render() {},
    ui: {
      toast: (message, type) => toasts.push({ message, type }),
      footNav: options => '<button data-sb="' + options.act + '">' + options.label + '</button>',
      flowSheet(config) {
        let click;
        const entry = { config, step: 1 };
        const controller = {
          root: {
            addEventListener: (type, handler) => { if (type === 'click') click = handler; },
            querySelector: () => null
          },
          close: config.onClose
        };
        const flow = {
          step: () => entry.step,
          go: step => { entry.step = step; },
          render() {},
          open() { config.bind(controller); return controller; }
        };
        entry.act = (action, value) => click({ target: { closest: () => ({ dataset: { sb: action, v: value } }) } });
        entry.body = () => config.steps[entry.step](entry.step).body;
        sheets.push(entry);
        return flow;
      }
    }
  };
  const chat = { children: [], appendChild: element => messages.push(element.innerHTML), scrollTop: 0 };
  const sandbox = {
    window: { ZX },
    Date: FixedDate,
    crypto: globalThis.crypto,
    document: {
      addEventListener: (type, handler) => { if (type === 'click') listeners.push(handler); },
      createElement: () => ({})
    }
  };
  const ctx = vm.createContext(sandbox);
  for (const path of ['util.js', 'assistant.js', 'flows/rescue.js']) {
    vm.runInContext(fs.readFileSync(require.resolve('../assets/js/' + path), 'utf8'), ctx);
  }
  ZX.util.$ = selector => selector === '#chat' ? chat : null;
  return { ZX, state, messages, ops, toasts, sheets, listeners };
}

function businessSnapshot(state) {
  return plain({
    consecutiveZeroDays: state.consecutiveZeroDays,
    interrupted: state.interrupted,
    rescueRecord: state.rescueRecord,
    goal: state.goal,
    feas: state.feas,
    tasks: state.tasks,
    week: state.week,
    dayAssign: state.dayAssign,
    locks: state.locks,
    sessions: state.sessions,
    tab: state.tab
  });
}

test('对话“演示挽救”进入独立演示入口，不触发真实挽救', () => {
  const { ZX, state, messages, sheets } = boot(1);
  const before = businessSnapshot(state);
  ZX.assistant.route('演示挽救');
  assert.equal(sheets.length, 0);
  assert.match(messages.at(-1), /演示数据 · 不会修改真实计划/);
  assert.deepEqual(businessSnapshot(state), before);
});

test('真实挽救入口无参 detect 按 sessions 真算；未达 3 天不打开且不写状态', () => {
  const { ZX, state, messages, sheets } = boot(2);
  const before = businessSnapshot(state);
  const detectCalls = [];
  const detect = ZX.flows.rescue.detect;
  ZX.flows.rescue.detect = function (...args) {
    detectCalls.push(args);
    return detect.apply(this, args);
  };

  ZX.assistant.route('我中断了，想挽救');

  assert.deepEqual(detectCalls, [[]]);
  assert.equal(state.consecutiveZeroDays, 2);
  assert.equal(state.interrupted, false);
  assert.equal(sheets.length, 0);
  assert.deepEqual(businessSnapshot(state), before);
  assert.match(messages.at(-1), /尚未达到连续 3 天/);
  assert.match(messages.at(-1), /目前连续 2 天没有记录/);
  assert.match(messages.at(-1), /暂不打开挽救/);
  assert.match(messages.at(-1), /不会改变当前计划/);
  assert.doesNotMatch(messages.at(-1), /连续 4 天/);
});

test('真实断更达标仍进入真实挽救，确认后保留真实 apply 生效', () => {
  const { ZX, state, messages, ops, sheets } = boot(3);
  const planBefore = plain({ goal: state.goal, feas: state.feas, tasks: state.tasks, week: state.week, dayAssign: state.dayAssign });
  const detectCalls = [];
  const detect = ZX.flows.rescue.detect;
  ZX.flows.rescue.detect = function (...args) {
    detectCalls.push(args);
    return detect.apply(this, args);
  };

  ZX.assistant.rescueFlow();

  assert.deepEqual(detectCalls, [[]]);
  assert.equal(state.consecutiveZeroDays, 3);
  assert.equal(state.interrupted, true);
  assert.equal(sheets.length, 1);
  assert.match(messages.at(-1), /连续 3 天没有记录/);
  assert.doesNotMatch(messages.at(-1), /演示数据/);
  assert.deepEqual(plain({ goal: state.goal, feas: state.feas, tasks: state.tasks, week: state.week, dayAssign: state.dayAssign }), planBefore);

  sheets[0].act('next');
  assert.match(sheets[0].config.steps[2](2).footer, /data-sb="apply"/);
  sheets[0].act('apply');

  assert.equal(state.consecutiveZeroDays, 0);
  assert.equal(state.interrupted, false);
  assert.deepEqual(Array.from(state.tasks, task => [task.id, task.est]), [['b', 60], ['done', 40]]);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].entity, 'rescue');
  assert.equal(ops[0].field, 'applied');
});

test('独立演示入口使用局部 4 天预览，显著标注且不写任何业务快照或调用真实挽救', () => {
  const { ZX, state, messages, ops, sheets } = boot(1);
  const before = businessSnapshot(state);
  const forbiddenCalls = [];
  for (const name of ['detect', 'open', 'apply']) {
    ZX.flows.rescue[name] = () => { forbiddenCalls.push(name); throw new Error('演示不得调用真实 ' + name); };
  }

  const preview = ZX.assistant.demoRescueFlow();
  const html = messages.at(-1);

  assert.equal(preview.zeroDays, 4);
  assert.equal(preview.metrics.days, 3);
  assert.equal(preview.metrics.planned, 600);
  assert.equal(preview.metrics.worked, 40);
  assert.equal(preview.metrics.gap, 303);
  assert.deepEqual(Array.from(preview.options, option => option.key), ['compress', 'defer', 'downgrade']);
  assert.equal(preview.options[0].gap, 0);
  assert.equal(preview.options[1].days, 10);
  assert.equal(preview.options[1].weeksAfter, 6);
  assert.equal(preview.options[2].targetAfter, 70);
  assert.match(html, /演示数据 · 不会修改真实计划/);
  assert.match(html, /连续 4 天没有记录/);
  assert.match(html, /剩余 3 天/);
  assert.match(html, /5h03/);
  assert.match(html, /压缩/);
  assert.match(html, /顺延/);
  assert.match(html, /降级/);
  assert.doesNotMatch(html, /data-sb="apply"|data-demo-rescue="apply"/);
  assert.deepEqual(forbiddenCalls, []);
  assert.equal(ops.length, 0);
  assert.equal(sheets.length, 0);
  assert.deepEqual(businessSnapshot(state), before);
});

test('演示预览只接受局部天数，改变演示天数不改变真实断更或计划', () => {
  const { ZX, state, ops } = boot(1);
  const before = businessSnapshot(state);
  const detect = ZX.flows.rescue.detect;
  let detectCalls = 0;
  ZX.flows.rescue.detect = function (...args) { detectCalls++; return detect.apply(this, args); };

  const preview = ZX.flows.rescue.preview(6);

  assert.equal(preview.zeroDays, 6);
  assert.equal(preview.metrics.days, 1);
  assert.equal(preview.metrics.gap, 474);
  assert.equal(detectCalls, 0);
  assert.equal(ops.length, 0);
  assert.deepEqual(businessSnapshot(state), before);
});
