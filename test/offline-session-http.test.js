'use strict';
require('./isolate-store').isolateStore();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { start } = require('../server/main');
const seed = require('../shared/data/seed');

const scripts = ['util', 'state', 'api', 'flows/exec'].map(name =>
  fs.readFileSync(require.resolve('../assets/js/' + name + '.js'), 'utf8'));
const turn = () => new Promise(resolve => setImmediate(resolve));

test('离线执行记录刷新后仍在本机，恢复仅探测 health 且服务端无新增', async () => {
  const server = await start(0, '127.0.0.1');
  const disk = new Map();
  const clientCalls = [];
  let offline = false;

  const issued = await fetch(server.url + '/api/auth/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  });
  assert.equal(issued.ok, true);
  const credential = await issued.json();
  disk.set('zx.auth_token', JSON.stringify(credential));
  const serverState = async () => {
    const res = await fetch(server.url + '/api/state', {
      headers: { Authorization: 'Bearer ' + credential.token }
    });
    assert.equal(res.ok, true);
    return res.json();
  };
  const before = await serverState();

  function boot() {
    const ZX = {};
    const window = {
      ZX, Rhythm: { seed }, location: { protocol: 'http:', origin: server.url },
      localStorage: {
        getItem: key => disk.has(key) ? disk.get(key) : null,
        setItem: (key, value) => disk.set(key, String(value)),
        removeItem: key => disk.delete(key)
      }
    };
    const context = vm.createContext({
      window, crypto, AbortController, setTimeout, clearTimeout,
      document: { addEventListener() {} }, localStorage: window.localStorage,
      fetch: (url, opts) => {
        clientCalls.push(new URL(url).pathname);
        if (offline) return Promise.reject(new Error('offline'));
        return fetch(url, opts);
      }
    });
    for (const script of scripts) vm.runInContext(script, context);
    return ZX;
  }

  try {
    offline = true;
    const first = boot();
    await assert.rejects(first.api.health(), /offline/);
    const session = first.exec.record({ taskId: first.state.tasks[0].id, minutes: 2 });
    assert.equal(first.state.saveOverlay(), true);
    assert.match(session.planVersion, /^plan-/);
    assert.equal(first.api.pendingCount(), 0);
    assert.equal(disk.has('zx.op_queue'), false);

    const next = boot();
    const restored = next.state.sessions.find(row => row.id === session.id);
    assert.equal(restored?.minutes, 2);
    assert.equal(restored?.planVersion, session.planVersion);
    assert.equal(next.api.pendingCount(), 0);
    assert.equal(next.api.legacyPendingCount(), 0);
    const events = JSON.parse(disk.get('zx.executionTrace') || '[]');
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], {
      id: session.id, tool: 'execution', at: session.endAt,
      planVersion: session.planVersion, rulesVersion: 'nova-execution-p0-1', status: 'recorded-local'
    });

    await assert.rejects(next.api.health(), /offline/);
    offline = false;
    await next.api.health();
    const isolated = await next.api.flushQueue();
    await turn();

    assert.deepEqual(JSON.parse(JSON.stringify(isolated)), {
      status: 'isolated', sent: 0, accepted: [], pending: 0, serverSeq: next.state.serverSeq
    });
    assert.deepEqual(clientCalls, ['/api/health', '/api/health', '/api/health']);
    assert.equal(disk.has('zx.op_queue'), false);
    assert.equal(disk.has('zx.syncTrace'), false);
    assert.equal(next.state.sessions.filter(row => row.id === session.id).length, 1);

    const after = await serverState();
    assert.deepEqual(after, before);
    assert.equal((after.seed.sessions || []).some(row => row.id === session.id), false);
  } finally {
    await server.close();
  }
});
