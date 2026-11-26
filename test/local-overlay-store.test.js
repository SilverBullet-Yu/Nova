'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const store = require('../shared/local-overlay-store.js');

test('IndexedDB 原型在不可用时明确失败，不伪装成已提交', async () => {
  assert.equal(store.available({}), false);
  await assert.rejects(store.commit({}, null, { overlay: 'synthetic' }), /IndexedDB unavailable/);
});

test('IndexedDB 原型拒绝非 overlay/trash 字段与非法值', async () => {
  const scope = { indexedDB: {} };
  assert.equal(store.available(scope), true);
  await assert.rejects(store.commit(scope, null, { unknown: 'synthetic' }), /unsupported overlay store field/);
  await assert.rejects(store.commit(scope, null, { overlay: 4 }), /must be strings or null/);
  await assert.rejects(store.commit(scope, null, null), /changes must be an object/);
});

test('浏览器 UMD 导出挂载到 ZX.localOverlayStore', () => {
  const sandbox = { self: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../shared/local-overlay-store.js'), 'utf8'), sandbox);
  assert.equal(typeof sandbox.self.ZX.localOverlayStore.commit, 'function');
  assert.equal(typeof sandbox.self.ZX.localOverlayStore.read, 'function');
});
