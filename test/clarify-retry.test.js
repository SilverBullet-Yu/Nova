'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const H = require('./helpers');

const turn = () => new Promise(resolve => setImmediate(resolve));

function boot() {
  const messages = [];
  const listeners = [];
  let planVersion = 'plan-before';
  let applyCalls = 0;
  const state = { currentPlanVersion: () => planVersion };
  const ZX = {
    state,
    api: {},
    ui: {},
    assistant: { say: html => messages.push(html) },
    flows: { goal: { apply: () => {
      applyCalls++;
      return Promise.resolve(applyCalls > 1);
    } } },
    engine: { feasibilityNow: () => ({ R: 1, verdict: '合理' }) }
  };
  const sandbox = {
    window: { ZX },
    document: { addEventListener: (type, fn) => listeners.push({ type, fn }) }
  };
  H.installUtil(sandbox);
  let source = fs.readFileSync(require.resolve('../assets/js/flows/clarify.js'), 'utf8');
  source = source.replace(
    'ZX.flows.clarify = {\n    start: start,\n    hook: hook,\n    active: active\n  };',
    'ZX.flows.clarify = {\n    start: start, hook: hook, active: active,\n    testApply: applySuggestion,\n    testSet: function (p, s) { profile = p; sug = s; phase = "calib"; }\n  };'
  );
  vm.runInNewContext(source, sandbox);
  ZX.flows.clarify.testSet(
    { goalType: '考研', goalName: '合成目标', deadline: '2027-12-25', level: '一轮', subjects: ['数学'] },
    { weeklyH: 10, weeks: 50, demand: 500, summary: '合成建议', risks: [], advice: '', tasks: [
      { id: 'd_1', s: '数学', title: '合成任务', est: 60, weight: 1, order: 0 }
    ] }
  );
  return {
    ZX, state, messages, applyCalls: () => applyCalls,
    setPlan: value => { planVersion = value; },
    click(action) {
      const card = messages.at(-1);
      const match = card.match(new RegExp('data-cl="' + action + '" data-cl-session="(\\d+)" data-cl-revision="(\\d+)" data-cl-phase="([^"]+)"(?: data-cl-plan="([^"]*)")?'));
      assert.ok(match, 'missing action ' + action);
      const button = { dataset: { cl: action, clSession: match[1], clRevision: match[2], clPhase: match[3], clPlan: match[4] } };
      const target = { closest: selector => selector === '[data-cl]' ? button : null };
      listeners.filter(entry => entry.type === 'click').forEach(entry => entry.fn({ target }));
    }
  };
}

test('澄清排程失败保留会话与建议，并渲染绑定计划版本的重试卡', async () => {
  const f = boot();
  f.ZX.flows.clarify.testApply();
  await turn();
  assert.equal(f.ZX.flows.clarify.active(), true);
  assert.equal(f.state.goalDraft.source, 'clarify');
  assert.equal(f.state.planDraft.length, 1);
  assert.match(f.messages.at(-1), /排程待重试/);
  assert.match(f.messages.at(-1), /data-cl-plan="plan-before"/);
});

test('旧重试卡在计划变化后失效，新确认成功后才结束会话', async () => {
  const f = boot();
  f.ZX.flows.clarify.testApply();
  await turn();
  f.setPlan('plan-after');
  f.click('retry-apply');
  assert.equal(f.applyCalls(), 1);
  assert.ok(f.messages.some(message => /旧重试卡已失效/.test(message)));
  f.click('apply');
  await turn();
  assert.equal(f.applyCalls(), 2);
  assert.equal(f.ZX.flows.clarify.active(), false);
});
