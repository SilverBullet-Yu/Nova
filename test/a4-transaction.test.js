'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const H = require('./helpers');

function boot() {
  const disk = new Map();
  const ZX = {};
  const localStorage = {
    getItem: key => disk.has(key) ? disk.get(key) : null,
    setItem: (key, value) => disk.set(key, String(value)),
    removeItem: key => disk.delete(key)
  };
  const sandbox = { window: { ZX, Rhythm: { seed: require('../shared/data/seed.js') }, localStorage }, localStorage, crypto: globalThis.crypto };
  H.installUtil(sandbox);
  vm.runInNewContext(fs.readFileSync(require.resolve('../assets/js/state.js'), 'utf8'), sandbox);
  return { ZX, disk, localStorage };
}

test('state.transact 保存失败时回滚内存与本次可安全回滚的存储', () => {
  const { ZX, disk, localStorage } = boot();
  const S = ZX.state;
  S.tasks[0].title = '基线';
  assert.equal(S.saveOverlay(), true);
  const before = disk.get('zx.overlay');
  const nativeSet = localStorage.setItem;
  localStorage.setItem = () => { throw new Error('quota'); };
  assert.throws(() => S.transact(() => {
    S.tasks[0].title = '未保存修改';
    S.goal.name = '未保存目标';
  }), /本机保存失败/);
  localStorage.setItem = nativeSet;
  assert.equal(S.tasks[0].title, '基线');
  assert.equal(disk.get('zx.overlay'), before);
  assert.equal(S.overlaySaveFailed, true);
});

test('state.transact 遇到外部写入时保留外部数据并回滚本页', () => {
  const { ZX, disk } = boot();
  const S = ZX.state;
  S.tasks[0].title = '本页基线';
  assert.equal(S.saveOverlay(), true);
  const external = JSON.parse(disk.get('zx.overlay'));
  external.tasks[0].title = '另一页写入';
  external.revision += 1;
  disk.set('zx.overlay', JSON.stringify(external));
  assert.throws(() => S.transact(() => { S.tasks[0].title = '本页未保存修改'; }), /保存失败/);
  assert.equal(S.tasks[0].title, '本页基线');
  assert.equal(JSON.parse(disk.get('zx.overlay')).tasks[0].title, '另一页写入');
});

test('state.transact 成功时持久化完整业务快照', () => {
  const { ZX, disk } = boot();
  const S = ZX.state;
  assert.equal(S.transact(() => { S.tasks[0].title = '事务提交'; }), undefined);
  assert.equal(JSON.parse(disk.get('zx.overlay')).tasks[0].title, '事务提交');
});
