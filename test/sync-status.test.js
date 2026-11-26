const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../assets/js/main.js'), 'utf8');

test('在线时只报告本地主数据与旧队列隔离，不显示已同步或待上行', () => {
  let legacy = 2;
  const text = {};
  const dot = {};
  const elements = { '#syncText': text, '#syncDot': dot, '#form': { addEventListener() {} } };
  const window = { ZX: { util: { $: key => elements[key] }, api: {
    isOnline: () => true, pendingCount: () => 0, legacyPendingCount: () => legacy
  } } };
  const document = { readyState: 'loading', addEventListener() {} };
  const instrumented = source.replace('function updateSync() {', 'ZX.testUpdateSync = updateSync; function updateSync() {');
  vm.runInNewContext(instrumented, { window, document });
  window.ZX.testUpdateSync();
  assert.equal(text.textContent, '本地主数据 · 旧队列已隔离 2');
  legacy = 0;
  window.ZX.testUpdateSync();
  assert.equal(text.textContent, '本地主数据 · 服务端仅计算');
  assert.doesNotMatch(text.textContent, /已同步|待上行/);
});
