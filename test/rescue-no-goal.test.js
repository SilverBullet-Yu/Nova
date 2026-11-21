'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const H = require('./helpers');
test('已删除阶段目标时不打开或提交中断挽救', () => {
  const messages = [], tasks = [{ id: 'a', est: 30 }];
  let opened = 0;
  const ZX = { state: { goal: { source: 'removed' }, tasks }, ui: {
    toast: text => messages.push(text), flowSheet: () => { opened++; return { open() {} }; }
  } };
  const sandbox = { window: { ZX }, document: { addEventListener() {} } };
  H.installUtil(sandbox);
  vm.runInNewContext(fs.readFileSync(require.resolve('../assets/js/flows/rescue.js'), 'utf8'), sandbox);
  ZX.flows.rescue.open();
  assert.equal(opened, 0);
  ZX.flows.rescue.apply();
  assert.equal(messages.length, 2);
  assert.ok(messages.every(text => text.includes('阶段目标')));
  assert.deepEqual(ZX.state.tasks, [{ id: 'a', est: 30 }]);
});
