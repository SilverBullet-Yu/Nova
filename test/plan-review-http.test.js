'use strict';
require('./isolate-store').isolateStore();
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { start } = require('../server/main');
const { schedule } = require('../shared/engine/schedule');
const src = fs.readFileSync(require.resolve('../assets/js/api'), 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));

async function credential(server) {
  const res = await fetch(server.url + '/api/auth/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  });
  assert.equal(res.ok, true);
  return res.json();
}

async function remoteState(server, token) {
  const res = await fetch(server.url + '/api/state', {
    headers: { Authorization: 'Bearer ' + token }
  });
  assert.equal(res.ok, true);
  return res.json();
}

function planFixture() {
  const input = {
    tasks: [{ id: 'a', subject: 'math', estMin: 30, weight: 1 }],
    slots: [{ date: '三', startMin: 480, durMin: 30 }]
  };
  return { input, result: schedule(input) };
}

test('旧 pending_plan 重载与在线恢复后只保留，不自动复核或写远端计划', async () => {
  const server = await start(0, '127.0.0.1');
  const disk = new Map();
  const clientCalls = [];
  let offline = false;
  try {
    const auth = await credential(server);
    disk.set('zx.auth_token', JSON.stringify(auth));
    const { input, result } = planFixture();
    const pending = { id: crypto.randomUUID(), base: null, input, result };
    const pendingRaw = JSON.stringify(pending);
    const queueRaw = '[{"opId":"legacy","pending":true}]';
    disk.set('zx.pending_plan', pendingRaw);
    disk.set('zx.op_queue', queueRaw);
    const before = await remoteState(server, auth.token);

    function boot() {
      const ZX = {};
      vm.runInNewContext(src, {
        window: {
          ZX, location: { protocol: 'http:', origin: server.url },
          localStorage: {
            getItem: key => disk.has(key) ? disk.get(key) : null,
            setItem: (key, value) => disk.set(key, String(value)),
            removeItem: key => disk.delete(key)
          }
        },
        crypto, AbortController, setTimeout, clearTimeout,
        fetch: (...args) => {
          clientCalls.push(new URL(args[0]).pathname);
          return offline ? Promise.reject(new Error('offline')) : fetch(...args);
        }
      });
      return ZX.api;
    }

    offline = true;
    const first = boot();
    assert.deepEqual(JSON.parse(JSON.stringify(first.pendingPlan())), pending);
    await assert.rejects(first.health(), /offline/);
    assert.equal(first.queueOp({ opId: 'new-business' }), null);
    assert.deepEqual(JSON.parse(JSON.stringify(await first.flushQueue())), {
      status: 'isolated', sent: 0, accepted: [], pending: 1, serverSeq: 0
    });

    offline = false;
    await first.health();
    await first.flushQueue();
    const reloaded = boot();
    assert.deepEqual(JSON.parse(JSON.stringify(reloaded.pendingPlan())), pending);
    assert.equal(reloaded.pendingCount(), 0);
    assert.equal(reloaded.legacyPendingCount(), 1);
    assert.equal(typeof reloaded.stagePlan, 'undefined');
    assert.equal(typeof reloaded.reviewPlan, 'undefined');
    await turn();

    assert.deepEqual(clientCalls, ['/api/health', '/api/health']);
    assert.equal(disk.get('zx.pending_plan'), pendingRaw);
    assert.equal(disk.get('zx.op_queue'), queueRaw);
    assert.deepEqual(await remoteState(server, auth.token), before);
  } finally {
    await server.close();
  }
});

test('服务端计划复核接口仍支持冲突、二次确认与幂等收据', async () => {
  const server = await start(0, '127.0.0.1');
  try {
    const auth = await credential(server);
    const { input, result } = planFixture();
    const request = { id: crypto.randomUUID(), base: null, input, result };
    const post = async body => {
      const res = await fetch(server.url + '/api/plan/review', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + auth.token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      assert.equal(res.ok, true);
      return res.json();
    };

    const initial = await post(request);
    assert.equal(initial.status, 'committed');
    assert.equal((await remoteState(server, auth.token)).planBaseline.version, initial.version);
    const pending = { ...request, id: crypto.randomUUID(), base: initial.version };

    const other = await post({ ...pending, id: crypto.randomUUID() });
    assert.equal(other.status, 'committed');
    const conflict = await post(pending);
    assert.equal(conflict.status, 'conflict');
    assert.equal(conflict.reason, 'baseline-changed');
    assert.equal((await post(pending)).ticket, conflict.ticket);

    const later = await post({ ...pending, id: crypto.randomUUID(), base: other.version });
    assert.equal(later.status, 'committed');
    const stale = await post({ ...pending, ticket: conflict.ticket });
    assert.equal(stale.status, 'conflict');
    assert.notEqual(stale.ticket, conflict.ticket);
    assert.equal((await remoteState(server, auth.token)).planBaseline.version, later.version);

    const mismatch = await post({
      ...pending, id: crypto.randomUUID(), base: later.version,
      result: { ...pending.result, version: 'older' }
    });
    assert.equal(mismatch.status, 'conflict');
    assert.equal(mismatch.reason, 'result-changed');
    assert.equal((await remoteState(server, auth.token)).planBaseline.version, later.version);

    const confirmed = await post({ ...pending, ticket: stale.ticket });
    assert.equal(confirmed.status, 'committed');
    const committedState = await remoteState(server, auth.token);
    assert.equal(committedState.planBaseline.version, confirmed.version);
    assert.deepEqual(await post({ ...pending, ticket: stale.ticket }), confirmed);
    assert.deepEqual(await remoteState(server, auth.token), committedState);
  } finally {
    await server.close();
  }
});
