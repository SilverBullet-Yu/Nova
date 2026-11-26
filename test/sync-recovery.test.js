'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../assets/js/api.js'), 'utf8');
const stateSource = fs.readFileSync(require.resolve('../assets/js/state.js'), 'utf8');
const utilSource = fs.readFileSync(require.resolve('../assets/js/util.js'), 'utf8');
const settingsSource = fs.readFileSync(require.resolve('../assets/js/flows/settings.js'), 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));

function installApi(ZX, disk, fetch) {
  const window = {
    ZX,
    location: { protocol: 'http:', origin: 'http://localhost' },
    localStorage: {
      getItem: key => disk.has(key) ? disk.get(key) : null,
      setItem: (key, value) => disk.set(key, String(value)),
      removeItem: key => disk.delete(key)
    }
  };
  vm.runInNewContext(source, { crypto, window, localStorage: window.localStorage, setTimeout, clearTimeout, fetch });
  return { window, api: window.ZX.api };
}

test('离线恢复只发 health，旧队列与新业务均不产生远端 op', async () => {
  const disk = new Map([
    ['zx.op_queue', '[{"opId":"legacy","pending":true,"value":{"note":"private"}}]']
  ]);
  const original = disk.get('zx.op_queue');
  const calls = [];
  let reachable = false;
  const { api } = installApi({ state: { serverSeq: 12 } }, disk, async url => {
    calls.push(new URL(url).pathname);
    if (!reachable) throw new Error('offline');
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });

  await assert.rejects(api.health(), /offline/);
  assert.equal(api.queueOp({ opId: 'offline-business', entity: 'session', field: 'recorded' }), null);
  assert.equal(api.pendingCount(), 0);
  assert.equal(api.legacyPendingCount(), 1);

  reachable = true;
  await api.health();
  assert.equal(api.queueOp({ opId: 'online-business', entity: 'plan', field: 'moved' }), null);
  const isolated = await api.flushQueue();
  await api.flushQueue();
  await turn();

  assert.deepEqual(JSON.parse(JSON.stringify(isolated)), {
    status: 'isolated', sent: 0, accepted: [], pending: 1, serverSeq: 12
  });
  assert.deepEqual(calls, ['/api/health', '/api/health']);
  assert.equal(disk.get('zx.op_queue'), original);
  assert.equal(api.pendingCount(), 0);
  assert.equal(api.legacyPendingCount(), 1);
  assert.equal(disk.has('zx.syncTrace'), false);
});

test('清除数据后旧队列与待复核记录保持隔离，重复 flush 不发网络', async () => {
  const oldQueue = '[{"opId":"legacy","pending":true}]';
  const oldPendingPlan = '{"id":"legacy-plan","input":{},"result":{}}';
  const disk = new Map([
    ['zx.op_queue', oldQueue],
    ['zx.pending_plan', oldPendingPlan],
    ['zx.syncTrace', '[]']
  ]);
  const calls = [];
  const window = {
    ZX: {},
    Rhythm: { seed: require('../shared/data/seed.js') },
    location: { protocol: 'http:', origin: 'http://localhost', reload() { throw new Error('unexpected reload'); } },
    localStorage: {
      getItem: key => disk.has(key) ? disk.get(key) : null,
      setItem: (key, value) => disk.set(key, String(value)),
      removeItem: key => disk.delete(key)
    }
  };
  vm.runInNewContext(utilSource, { window, crypto, localStorage: window.localStorage });
  vm.runInNewContext(stateSource, { window, crypto });
  vm.runInNewContext(source, {
    crypto, window, localStorage: window.localStorage, setTimeout, clearTimeout,
    fetch: async url => { calls.push(String(url)); throw new Error('must not sync'); }
  });
  const api = window.ZX.api;
  const oldSeq = window.ZX.state.serverSeq;
  assert.equal((await api.flushQueue()).status, 'isolated');

  let reload;
  window.ZX.ui = { confirm: async () => true, toast() {} };
  vm.runInNewContext(settingsSource, { window, setTimeout: fn => { reload = fn; } });
  await window.ZX.settings.confirmWipe();

  assert.equal(typeof reload, 'function');
  assert.equal(disk.get('zx.op_queue'), oldQueue);
  assert.equal(disk.get('zx.pending_plan'), oldPendingPlan);
  assert.equal(disk.has('zx.syncTrace'), false);
  assert.ok(JSON.parse(disk.get('zx.trash')).snapshot);
  api.invalidatePendingSync();
  assert.equal((await api.flushQueue()).status, 'isolated');
  await turn();
  assert.equal(calls.length, 0);
  assert.equal(disk.get('zx.op_queue'), oldQueue);
  assert.equal(disk.get('zx.pending_plan'), oldPendingPlan);
  assert.equal(api.legacyPendingCount(), 1);
  assert.equal(disk.has('zx.syncTrace'), false);
  assert.equal(window.ZX.state.serverSeq, oldSeq);
});

test('服务端计算请求仍可正常调用，且不生成待同步操作', async () => {
  const disk = new Map([
    ['zx.auth_token', JSON.stringify({ token: 'stub-token' })],
    ['zx.op_queue', '[{"opId":"legacy","pending":true}]']
  ]);
  const original = disk.get('zx.op_queue');
  const calls = [];
  const { api } = installApi({ state: { serverSeq: 3 } }, disk, async (url, opts) => {
    calls.push({ path: new URL(url).pathname, opts });
    return { ok: true, status: 200, json: async () => ({ blocks: [] }) };
  });

  const result = await api.schedule({ tasks: [], slots: [] });
  assert.deepEqual(result, { blocks: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/schedule');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer stub-token');
  assert.equal(api.queueOp({ opId: 'schedule-business' }), null);
  assert.equal((await api.flushQueue()).status, 'isolated');
  assert.equal(calls.length, 1);
  assert.equal(disk.get('zx.op_queue'), original);
  assert.equal(api.pendingCount(), 0);
  assert.equal(disk.has('zx.syncTrace'), false);
});
