'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const H = require('./helpers');

const clarifySrc = fs.readFileSync(require.resolve('../assets/js/flows/clarify.js'), 'utf8');

/* 沙箱装配：真实 util.js（日期口径与生产同源）+ 可控的 api/engine/flows 桩。
   document 桩收集 click 监听，用 dispatch 模拟聊天卡片按钮点击。 */
function makeSandbox() {
  const ZX = {};
  const disk = new Map();
  const docListeners = [];
  const sandbox = {
    window: { ZX, localStorage: { getItem: k => (disk.has(k) ? disk.get(k) : null), setItem: (k, v) => disk.set(k, v) } },
    document: {
      addEventListener(type, fn) { docListeners.push([type, fn]); },
      dispatch(target) {
        docListeners.forEach(([type, fn]) => { if (type === 'click') fn({ target: target }); });
      }
    }
  };
  H.installUtil(sandbox);
  vm.runInNewContext(clarifySrc, sandbox);
  return { ZX, doc: sandbox.document };
}

/* 微任务冲刷：等 Promise 链（sendTurn 的 then 回调）跑完 */
async function flush(n) {
  for (let i = 0; i < (n || 6); i++) await Promise.resolve();
}

/* 可行性桩：R = weeklyH / cap（cap 可调），供校准路径真实迭代 */
function feasStub(capRef) {
  return (input) => {
    const r = input.weeklyH / capRef.v;
    return { R: r, T: input.weeklyH * input.weeks * input.discount, D: input.demand,
      verdict: r >= 0.9 ? '合理' : r >= 0.7 ? '偏紧' : '不可行' };
  };
}

/* 从真实渲染的卡片提取按钮标记，再走生产 click 委托；缺少按钮直接失败。 */
function cardButton(html, act) {
  const tag = (html.match(/<button\b[^>]*>/g) || []).find(s => s.includes('data-cl="' + act + '"'));
  assert.ok(tag, '卡片必须实际渲染按钮：' + act);
  const dataset = {};
  for (const [, key, value] of tag.matchAll(/data-([\w-]+)="([^"]*)"/g)) {
    dataset[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  assert.ok(dataset.clSession && dataset.clRevision && dataset.clPhase, '按钮必须绑定会话、版本与阶段');
  return { dataset };
}

function clickButton(doc, button) {
  doc.dispatch({ closest: s => s === '[data-cl]' ? button : null });
}

function clickCl(doc, act, html) {
  clickButton(doc, cardButton(html, act));
}

function deferred() {
  let resolve, reject;
  const p = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { p, resolve, reject };
}

const FULL_PROFILE = { goalType: '考研', goalName: '2027 考研 · 计算机', deadline: '2027-12-25', weeklyH: 20, level: '一轮', subjects: ['数学', '英语'] };

test('澄清会话：多轮追问 → 画像确认卡 → LLM 建议 → 校准 → 引擎落地', async () => {
  const { ZX, doc } = makeSandbox();
  const says = [];
  const calls = { clarify: 0, analyze: 0, apply: 0 };
  let pending = deferred();
  ZX.assistant = { say: (html, eng) => says.push([html, eng]), typing: () => ({ remove() {} }) };
  ZX.api = {
    llmClarify: () => { calls.clarify++; return pending.p; },
    llmAnalyze: (p) => {
      calls.analyze++;
      assert.equal(p.profile.goalName, '2027 考研 · 计算机');
      return Promise.resolve({
        summary: '先过一轮数学基础', demandH: 913, weeklyH: 20,
        tasks: [
          { s: '数学', title: '高数 · 极限与连续 40 题', est: 90, weight: 0.92 },
          { s: '英语', title: '阅读真题 · 2 篇精读', est: 60, weight: 0.78 }
        ],
        risks: ['中断四天以上'], advice: '先保数学'
      });
    },
    isOnline: () => true
  };
  ZX.state = {};   /* applySuggestion 需要 state 承接 goalDraft/planDraft */
  ZX.engine = { feasibilityNow: feasStub({ v: 50 }) };
  ZX.flows.goal = { open() {}, apply() { calls.apply++; } };

  ZX.flows.clarify.start('新建目标');
  assert.ok(ZX.flows.clarify.active());
  assert.equal(calls.clarify, 1);
  assert.match(says.at(-1)[0], /把想法理清楚/);

  /* 第 1 轮：整体方向 */
  pending.resolve({ reply: '想考什么方向？', profile: { goalType: '考研' }, done: false });
  await flush();
  assert.match(says.at(-1)[0], /想考什么方向/);

  /* 会话中 hook 拦截一切文本（不再走关键词指令） */
  pending = deferred();
  assert.equal(ZX.flows.clarify.hook('我想考研，但很迷茫'), true);
  assert.equal(calls.clarify, 2);
  pending.resolve({ reply: '什么时候考？每周能投入多少？', profile: FULL_PROFILE, done: false });
  await flush();
  assert.match(says.at(-1)[0], /什么时候考/);

  /* 第 3 轮 done → 画像确认卡 */
  pending = deferred();
  assert.equal(ZX.flows.clarify.hook('2027-12-25 考，每周 20 小时'), true);
  pending.resolve({ reply: '画像齐了', profile: FULL_PROFILE, done: true });
  await flush();
  assert.match(says.at(-1)[0], /需求画像/);
  assert.match(says.at(-1)[0], /2027 考研 · 计算机/);

  /* 确认卡按钮 → buildPlan：R = 20/50 = 0.4 偏紧，先进校准 */
  clickCl(doc, 'build', says.at(-1)[0]);
  await flush();
  assert.match(says.at(-1)[0], /提高周投入/);
  assert.doesNotMatch(says.at(-1)[0], /确认，开始排程/);

  /* 应用「提高周投入」→ solveWeekly → 45 h → R 0.9 → 建议卡出现 */
  clickCl(doc, 'cal-h', says.at(-1)[0]);
  await flush();
  assert.match(says.at(-1)[0], /确认，开始排程/);
  assert.match(says.at(-1)[0], /高数 · 极限与连续 40 题/);
  /* 校准只调参数，不重调 LLM */
  assert.equal(calls.analyze, 1);

  /* apply：组装 goalDraft / planDraft 后交给 goal.apply()，会话结束 */
  clickCl(doc, 'apply', says.at(-1)[0]);
  assert.equal(calls.apply, 1);
  assert.equal(ZX.state.goalDraft.name, '2027 考研 · 计算机');
  assert.equal(ZX.state.goalDraft.source, 'clarify');
  assert.equal(ZX.state.goalDraft.demand, 913);
  assert.equal(ZX.state.goalDraft.weeklyH, 45);
  assert.equal(ZX.state.planDraft.length, 2);
  assert.equal(ZX.state.planDraft[0].est, 90);
  assert.ok(ZX.state.planDraft[0].title.indexOf('<') === -1);
  assert.equal(ZX.flows.clarify.active(), false);
});

test('可行性偏紧：缩需求路径不达标时继续校准，拉回后才放行排程', async () => {
  const { ZX, doc } = makeSandbox();
  const says = [];
  let analyzeCalls = 0;
  let applyCalls = 0;
  let pending = deferred();
  ZX.assistant = { say: (html, eng) => says.push([html, eng]), typing: () => ({ remove() {} }) };
  ZX.api = {
    llmClarify: () => pending.p,
    llmAnalyze: () => { analyzeCalls++; return Promise.resolve({
      summary: 's', demandH: 900, weeklyH: 10,
      tasks: [{ s: '数学', title: '刷题', est: 60, weight: 0.9 }], risks: [], advice: ''
    }); },
    isOnline: () => true
  };
  /* cap=50：R=weeklyH/50。10 → 0.2 偏紧；缩需求 / 延周期在本桩下不改 R，
     用于验证「应用后仍偏紧则继续留在校准、不放行排程」 */
  const capRef = { v: 50 };
  ZX.state = {};
  ZX.engine = { feasibilityNow: feasStub(capRef) };
  ZX.flows.goal = { open() {}, apply() { applyCalls++; } };

  ZX.flows.clarify.start('新建目标');
  pending.resolve({ reply: '好', profile: FULL_PROFILE, done: true });
  await flush();
  assert.match(says.at(-1)[0], /需求画像/);

  clickCl(doc, 'build', says.at(-1)[0]);
  assert.equal(analyzeCalls, 1);
  await flush();
  assert.match(says.at(-1)[0], /可行性偏紧/);
  assert.match(says.at(-1)[0], /缩小范围/);

  clickCl(doc, 'cal-d', says.at(-1)[0]);
  await flush();
  assert.match(says.at(-1)[0], /提高周投入/);
  assert.doesNotMatch(says.at(-1)[0], /确认，开始排程/);
  assert.equal(applyCalls, 0);

  clickCl(doc, 'cal-h', says.at(-1)[0]);
  await flush();
  assert.match(says.at(-1)[0], /确认，开始排程/);
  clickCl(doc, 'apply', says.at(-1)[0]);
  assert.equal(applyCalls, 1);
  assert.equal(ZX.state.goalDraft.weeklyH, 45);
});

test('降级链：未配置自动回落四步表单，且后续 start 不再打必败请求', async () => {
  const { ZX } = makeSandbox();
  const says = [];
  let clarifyCalls = 0;
  let openCalls = 0;
  ZX.assistant = { say: (html, eng) => says.push([html, eng]), typing: () => ({ remove() {} }) };
  ZX.api = {
    llmClarify: () => { clarifyCalls++; return Promise.reject({ code: 'E5010' }); },
    isOnline: () => true
  };
  ZX.engine = { feasibilityNow: () => ({ R: 1 }) };
  ZX.flows.goal = { open() { openCalls++; }, apply() {} };

  ZX.flows.clarify.start('新建目标');
  await flush();
  assert.equal(openCalls, 1);
  assert.match(says.at(-1)[0], /四步表单/);
  assert.equal(ZX.flows.clarify.active(), false);

  /* E5010 置位后：再次 start 直接降级，不再发请求 */
  ZX.flows.clarify.start('新建目标');
  await flush();
  assert.equal(clarifyCalls, 1);
  assert.equal(openCalls, 2);
});

test('退出与迟到响应：退出词结束会话，重开后旧响应不得污染新会话', async () => {
  const { ZX } = makeSandbox();
  const says = [];
  let clarifyCalls = 0;
  const turn1 = deferred();
  let turnN = deferred();
  ZX.assistant = { say: (html, eng) => says.push([html, eng]), typing: () => ({ remove() {} }) };
  ZX.api = {
    llmClarify: () => { clarifyCalls++; return clarifyCalls === 1 ? turn1.p : turnN.p; },
    llmAnalyze: () => Promise.resolve({ tasks: [] }),
    isOnline: () => true
  };
  ZX.engine = { feasibilityNow: () => ({ R: 1 }) };
  ZX.flows.goal = { open() {}, apply() {} };

  ZX.flows.clarify.start('新建目标');
  await flush();
  assert.ok(ZX.flows.clarify.active());

  assert.equal(ZX.flows.clarify.hook('退出澄清'), true);
  assert.equal(ZX.flows.clarify.active(), false);
  assert.match(says.at(-1)[0], /已退出澄清/);

  /* 重开新会话；旧轮（turn1）此刻才 resolve —— 必须被丢弃 */
  turnN = deferred();
  ZX.flows.clarify.start('新建目标');
  await flush();
  const beforeLate = says.length;
  turn1.resolve({ reply: '迟到消息', profile: {}, done: true });
  await flush();
  assert.equal(says.length, beforeLate);
  assert.equal(ZX.flows.clarify.active(), true);
  /* 新会话仍 busy，不能因旧响应清锁而多发请求。 */
  assert.equal(ZX.flows.clarify.hook('继续'), true);
  assert.equal(clarifyCalls, 2);
  assert.match(says.at(-1)[0], /等我看完/);
});

/* 每个请求独立可控，typing 也各自记账，不直接访问 flow 私有状态。 */
function controlledFlow(cap = 20) {
  const { ZX, doc } = makeSandbox();
  const says = [], turns = [], plans = [], typings = [];
  const calls = { open: 0, apply: 0 };
  function request(queue, input) {
    const d = deferred();
    queue.push({ ...d, input });
    return d.p;
  }
  ZX.assistant = {
    say: (html, eng) => says.push([html, eng]),
    typing: () => {
      const t = { removed: 0, remove() { this.removed++; } };
      typings.push(t);
      return t;
    }
  };
  ZX.api = {
    llmClarify: input => request(turns, input),
    llmAnalyze: input => request(plans, input),
    isOnline: () => true
  };
  ZX.state = {};
  ZX.engine = { feasibilityNow: feasStub({ v: cap }) };
  ZX.flows.goal = { open() { calls.open++; }, apply() { calls.apply++; } };
  return { ZX, doc, says, turns, plans, typings, calls };
}

function clarified(name) {
  return { reply: name, profile: { ...FULL_PROFILE, goalName: name, subjects: ['数学', '英语'] }, done: true };
}
function analyzed(name, demand = 600) {
  return { summary: name, demandH: demand, weeklyH: 20,
    tasks: [{ s: '数学', title: name, est: 60, weight: 0.8 }], risks: [], advice: '' };
}
async function confirmFlow(f, name) {
  f.turns.at(-1).resolve(clarified(name));
  await flush();
  assert.match(f.says.at(-1)[0], /需求画像/);
}
async function buildFlow(f, name) {
  clickCl(f.doc, 'build', f.says.at(-1)[0]);
  f.plans.at(-1).resolve(analyzed(name));
  await flush();
}
function buttonsIn(html) {
  return [...html.matchAll(/data-cl="([^"]+)"/g)].map(([, act]) => cardButton(html, act));
}
function assertIgnored(f, buttons) {
  const before = [f.says.length, f.turns.length, f.plans.length, f.calls.open, f.calls.apply];
  const state = JSON.stringify(f.ZX.state);
  buttons.forEach(b => clickButton(f.doc, b));
  assert.deepEqual([f.says.length, f.turns.length, f.plans.length, f.calls.open, f.calls.apply], before);
  assert.equal(JSON.stringify(f.ZX.state), state);
  assert.equal(f.ZX.flows.clarify.active(), true);
}

for (const oldKind of ['clarify', 'analyze']) {
  for (const outcome of ['success', 'failure']) {
    for (const newStage of ['ask', 'analyze', 'calib']) {
      test(`迟到 ${oldKind} ${outcome}：不污染新 ${newStage} 会话、busy 或降级状态`, async () => {
        const f = controlledFlow();
        const flow = f.ZX.flows.clarify;
        flow.start('旧会话');
        if (oldKind === 'analyze') {
          await confirmFlow(f, '旧画像');
          clickCl(f.doc, 'build', f.says.at(-1)[0]);
        }
        const oldRequest = (oldKind === 'clarify' ? f.turns : f.plans).at(-1);
        const oldTyping = f.typings.at(-1);
        flow.hook('退出澄清');
        flow.start('新会话');
        if (newStage !== 'ask') {
          await confirmFlow(f, '新画像');
          clickCl(f.doc, 'build', f.says.at(-1)[0]);
        }
        if (newStage === 'calib') {
          f.plans.at(-1).resolve(analyzed('新计划'));
          await flush();
        }
        const newTyping = f.typings.at(-1);
        const beforeLate = f.says.length;
        if (outcome === 'success') {
          oldRequest.resolve(oldKind === 'clarify' ? clarified('迟到旧画像') : analyzed('迟到旧计划', 999));
        } else {
          oldRequest.reject({ code: 'E5010' });
        }
        await flush();
        assert.equal(f.says.length, beforeLate, '旧响应不得发消息或渲染卡片');
        assert.equal(f.calls.open, 0, '旧失败不得降级新会话');
        assert.equal(flow.active(), true);
        assert.equal(oldTyping.removed, 1, '仅清理自己的 typing');
        assert.equal(newTyping.removed, newStage === 'calib' ? 1 : 0);
        if (newStage !== 'calib') {
          const counts = [f.turns.length, f.plans.length];
          assert.equal(flow.hook('新请求还在处理中'), true);
          assert.deepEqual([f.turns.length, f.plans.length], counts, '旧响应不得清除新 busy');
          assert.match(f.says.at(-1)[0], /等我看完/);
          if (newStage === 'ask') {
            await confirmFlow(f, '新画像');
            clickCl(f.doc, 'build', f.says.at(-1)[0]);
          }
          f.plans.at(-1).resolve(analyzed('新计划'));
          await flush();
        }
        clickCl(f.doc, 'apply', f.says.at(-1)[0]);
        assert.equal(f.calls.apply, 1);
        assert.equal(f.ZX.state.goalDraft.name, '新画像');
        assert.equal(f.ZX.state.goalDraft.demand, 600);
        assert.equal(f.ZX.state.planDraft[0].title, '新计划');
        assert.equal(flow.active(), false);
        const beforeStart = f.turns.length;
        flow.start('再开会话');
        assert.equal(f.turns.length, beforeStart + 1, '旧 E5010 不得置位 llmDown');
        assert.equal(f.calls.open, 0);
      });
    }
  }
}

for (const kind of ['confirm', 'calibration', 'suggestion']) {
  for (const scope of ['session', 'revision']) {
    test(`卡片 ${kind}：拒绝旧 ${scope} 全部按钮，合法新卡仍可用`, async () => {
      const f = controlledFlow(kind === 'calibration' ? 50 : 20);
      if (kind === 'calibration') {
        const U = f.ZX.util;
        const baseWeeks = Math.max(1, Math.floor((U.parseDay(FULL_PROFILE.deadline) - U.today0()) / 604800000));
        f.ZX.engine.feasibilityNow = input => {
          const R = input.weeklyH / 50 * input.weeks / baseWeeks;
          return { R, verdict: R >= 0.9 ? '合理' : '不可行' };
        };
      }
      const flow = f.ZX.flows.clarify;
      flow.start('旧画像');
      await confirmFlow(f, '旧画像');
      if (kind !== 'confirm') await buildFlow(f, '旧计划');
      const oldHtml = f.says.at(-1)[0];
      const oldButtons = buttonsIn(oldHtml);
      if (scope === 'session') {
        flow.hook('退出澄清');
        flow.start('新画像');
        assertIgnored(f, oldButtons); // 新会话 busy 时连旧 cancel 也不可执行
        await confirmFlow(f, '新画像');
        if (kind !== 'confirm') await buildFlow(f, '新计划');
      } else if (kind === 'calibration') {
        clickCl(f.doc, 'cal-d', oldHtml); // 同阶段重绘，仍须拒绝前一个版本
      } else {
        clickCl(f.doc, 'edit', oldHtml);
        assertIgnored(f, oldButtons); // 已离开卡片阶段
        flow.hook('修改画像');
        assertIgnored(f, oldButtons); // 修改请求尚未完成
        await confirmFlow(f, '新画像');
        if (kind !== 'confirm') await buildFlow(f, '新计划');
      }
      const newHtml = f.says.at(-1)[0];
      const newButtons = buttonsIn(newHtml);
      assert.notEqual(oldButtons[0].dataset.clRevision, newButtons[0].dataset.clRevision);
      assert.equal(oldButtons[0].dataset.clSession === newButtons[0].dataset.clSession, scope === 'revision');
      assertIgnored(f, oldButtons);
      if (kind === 'confirm') {
        await buildFlow(f, '新计划');
      } else if (kind === 'calibration') {
        clickCl(f.doc, 'cal-w', newHtml);
        assertIgnored(f, newButtons); // 延周期达标后，旧校准卡仍不可操作
        assert.match(f.says.at(-1)[0], /确认，开始排程/);
      }
      clickCl(f.doc, 'apply', f.says.at(-1)[0]);
      assert.equal(f.calls.apply, 1);
      assert.equal(flow.active(), false);
      assert.equal(f.ZX.state.goalDraft.demand, kind === 'calibration' && scope === 'revision' ? 510 : 600);
    });
  }
}

test('委托拒绝无标记、残缺标记、错误阶段与非当前卡动作；新卡取消有效', async () => {
  const f = controlledFlow(50);
  f.ZX.flows.clarify.start('新建目标');
  await confirmFlow(f, '画像');
  const html = f.says.at(-1)[0];
  const build = cardButton(html, 'build');
  const invalid = ['build', 'edit', 'cancel', 'form', 'apply', 'cal-h', 'cal-w', 'cal-d']
    .map(cl => ({ dataset: { cl } }));
  for (const key of ['clSession', 'clRevision', 'clPhase']) {
    const dataset = { ...build.dataset };
    delete dataset[key];
    invalid.push({ dataset });
  }
  invalid.push({ dataset: { ...build.dataset, clPhase: 'calib' } });
  for (const cl of ['apply', 'cal-h', 'form']) invalid.push({ dataset: { ...build.dataset, cl } });
  assertIgnored(f, invalid);
  await buildFlow(f, '计划');
  const calibration = f.says.at(-1)[0];
  const cal = cardButton(calibration, 'cal-h');
  assertIgnored(f, ['build', 'apply', 'cancel'].map(cl => ({ dataset: { ...cal.dataset, cl } })));
  clickCl(f.doc, 'edit', calibration);
  f.ZX.flows.clarify.hook('调整');
  await confirmFlow(f, '新画像');
  clickCl(f.doc, 'cancel', f.says.at(-1)[0]);
  assert.equal(f.ZX.flows.clarify.active(), false);
  assert.equal(f.calls.apply, 0);
  assert.equal(f.calls.open, 0);
});
