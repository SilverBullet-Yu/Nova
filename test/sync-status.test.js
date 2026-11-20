const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../assets/js/main.js'), 'utf8');

test('在线时仍有待上行操作，不显示已同步；队列清空后才显示已同步', () => {
  let pending = 2;
  const text = {};
  const dot = {};
  const elements = { '#syncText': text, '#syncDot': dot, '#form': { addEventListener() {} } };
  const window = { ZX: { util: { $: key => elements[key] }, api: {
    isOnline: () => true, pendingCount: () => pending
  } } };
  const document = { readyState: 'loading', addEventListener() {} };
  const instrumented = source.replace('function updateSync() {', 'ZX.testUpdateSync = updateSync; function updateSync() {');
  vm.runInNewContext(instrumented, { window, document });
  window.ZX.testUpdateSync();
  assert.equal(text.textContent, '本地优先 · 待上行 2');
  pending = 0;
  window.ZX.testUpdateSync();
  assert.equal(text.textContent, '本地优先 · 已同步');
});
