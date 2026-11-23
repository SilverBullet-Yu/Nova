'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function boot() {
  const notices = [];
  const ZX = {
    util: { $: () => ({ children: [], appendChild() {} }), esc: String, hm: String, nowStr: () => '', num: (x, d) => Number.isFinite(x) ? x : d },
    state: { tasks: [{ id: 'a', title: 'A', est: 30 }, { id: 'b', title: 'B', est: 30 }], running: null, timerStart: null, pausedAt: null, pausedTotal: 0 },
    ui: { toast: message => notices.push(message) },
    render() {}
  };
  const context = vm.createContext({ window: { ZX }, document: { createElement: () => ({}) } });
  vm.runInContext(fs.readFileSync(require.resolve('../assets/js/assistant.js'), 'utf8'), context);
  return { ZX, notices };
}

for (const paused of [false, true]) {
  for (const target of ['a', 'b']) {
    test('已有' + (paused ? '暂停' : '运行') + '计时，启动 ' + target + ' 不覆盖当前计时', () => {
      const { ZX, notices } = boot();
      const timer = { running: 'a', timerStart: 1000, pausedAt: paused ? 2000 : null, pausedTotal: 300 };
      Object.assign(ZX.state, timer);
      ZX.assistant.startTask(target);
      for (const key of Object.keys(timer)) assert.equal(ZX.state[key], timer[key], key);
      assert.equal(notices.length, 1);
    });
  }
}

test('没有活动计时时仍可正常启动任务', () => {
  const { ZX } = boot();
  ZX.assistant.startTask('a');
  assert.equal(ZX.state.running, 'a');
  assert.ok(ZX.state.timerStart > 0);
});
