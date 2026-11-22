'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const H = require('./helpers');
const plain = value => JSON.parse(JSON.stringify(value));

function boot(storage = new Map()) {
  let renders = 0, attributions = 0;
  const ZX = { api: { queueOp() {} }, ui: { toast() {} } };
  const ctx = vm.createContext({ window: { ZX, localStorage: H.storage(storage).localStorage,
    Rhythm: { seed: require('../shared/data/seed.js') } }, crypto: globalThis.crypto,
    document: { addEventListener() {}, createElement: () => ({}) } });
  for (const path of ['util.js', 'state.js', 'assistant.js', 'flows/exec.js', 'flows/rescue.js']) {
    vm.runInContext(fs.readFileSync(require.resolve('../assets/js/' + path), 'utf8'), ctx);
  }
  ZX.util.$ = () => ({ children: [], appendChild() {} });
  ZX.render = () => { renders++; ZX.state.saveOverlay(); };
  ZX.engine = { attributeNow: input => {
    attributions++;
    return { type: '效率不足', evidence: input, confidence: 0.8, actions: ['降载'] };
  } };
  return { ZX, counts: () => ({ renders, attributions }) };
}

for (const paused of [false, true]) {
  for (const completion of [50, 100]) {
    test('记录 B（' + completion + '%）保留 A 的' + (paused ? '暂停' : '运行') + '计时四元组', () => {
      const { ZX, counts } = boot();
      ZX.state.tasks = ['a', 'b'].map(id => ({ id, title: id, est: 60, time: '09:00–10:00' }));
      const timer = { running: 'a', timerStart: Date.now() - 120000, pausedAt: paused ? Date.now() - 1000 : null, pausedTotal: 500 };
      Object.assign(ZX.state, timer);
      if (completion === 100) ZX.assistant.finishTask('b', true);
      else ZX.exec.commitRecord('b', 25, completion, '', 100, 200);
      for (const key of Object.keys(timer)) assert.equal(ZX.state[key], timer[key], key);
      assert.equal(ZX.state.sessions.length, 1);
      assert.equal(ZX.state.sessions[0].taskId, 'b');
      assert.equal(ZX.state.tasks[0].est, 60);
      assert.equal(ZX.state.tasks[0].done, undefined);
      assert.equal(counts().attributions, 1);
    });
  }
}

test('记录当前 A 后复位四元组，归因先于持久化；刷新与重复完成不重计数', () => {
  const storage = new Map();
  const { ZX, counts } = boot(storage);
  ZX.state.tasks = [{ id: 'a', title: 'A', est: 60 }];
  Object.assign(ZX.state, { running: 'a', timerStart: 100, pausedAt: 200, pausedTotal: 50 });
  ZX.exec.commitRecord('a', 70, 100, '', 100, 4200100);
  assert.deepEqual(['running', 'timerStart', 'pausedAt', 'pausedTotal'].map(k => ZX.state[k]), [null, null, null, 0]);
  assert.equal(counts().attributions, 1);
  assert.equal(counts().renders, 1);
  assert.deepEqual(plain(ZX.state.attrCounts), { '效率不足': 1 });
  const next = boot(storage).ZX;
  assert.deepEqual(plain(next.state.attrCounts), { '效率不足': 1 });
  assert.equal(next.state.sessions.length, 1);
  next.assistant.finishTask('a', true);
  next.exec.commitRecord('a', 70, 100, '', 100, 4200100);
  next.render();
  const refreshed = boot(storage).ZX;
  assert.equal(refreshed.state.sessions.length, 1);
  assert.deepEqual(plain(refreshed.state.attrCounts), { '效率不足': 1 });
});
