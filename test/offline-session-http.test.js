'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { start } = require('../server/main');
const seed = require('../shared/data/seed');

const scripts = ['util', 'state', 'api', 'flows/exec'].map(name =>
  fs.readFileSync(require.resolve('../assets/js/' + name + '.js'), 'utf8'));

test('离线执行记录重新加载后补传，服务端仅保留一条且版本不变', async () => {
  const server = await start(0);
  const disk = new Map();
  let offline = false;
  let uploads = 0;
  function boot() {
    const ZX = {};
    const window = { ZX, Rhythm: { seed }, location: { protocol: 'http:', origin: server.url },
      localStorage: { getItem: key => disk.get(key), setItem: (key, value) => disk.set(key, value) } };
    const context = vm.createContext({ window, crypto, AbortController, setTimeout, clearTimeout,
      document: { addEventListener() {} }, localStorage: window.localStorage,
      fetch: (url, opts) => {
        if (offline) return Promise.reject(new Error('offline'));
        if (url.endsWith('/api/sync/ops')) uploads++;
        return fetch(url, opts);
      } });
    for (const script of scripts) vm.runInContext(script, context);
    return ZX;
  }
  try {
    const first = boot();
    await first.api.getState();
    offline = true;
    await assert.rejects(first.api.health(), /offline/);
    const session = first.exec.record({ taskId: first.state.tasks[0].id, minutes: 2 });
    first.state.saveOverlay();
    const next = boot();
    assert.match(session.planVersion, /^plan-/);
    assert.equal(next.state.sessions.find(row => row.id === session.id)?.planVersion, session.planVersion);
    assert.equal(next.api.pendingCount(), 1);
    const events = JSON.parse(disk.get('zx.executionTrace') || '[]');
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], { id: session.id, tool: 'execution', at: session.endAt,
      planVersion: session.planVersion, rulesVersion: 'nova-execution-p0-1', status: 'recorded-local' });
    assert.equal(uploads, 0);
    assert.equal(disk.has('zx.syncTrace'), false);
    await assert.rejects(next.api.health(), /offline/);
    offline = false;
    await next.api.health();
    const deadline = Date.now() + 3000;
    while (next.api.pendingCount() && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(next.api.pendingCount(), 0);
    assert.equal(uploads, 1);
    const batches = JSON.parse(disk.get('zx.syncTrace') || '[]');
    assert.equal(batches.length, 1);
    assert.match(batches[0].id, /^sync-[0-9a-f]{32}$/);
    assert.equal(batches[0].status, 'accepted');
    assert.equal(batches[0].accepted, 1);
    assert.deepEqual(batches[0].sessions, [{ id: events[0].id, confirmed: true }]);
    const state = await next.api.getState();
    const rows = state.seed.sessions.filter(row => row.id === batches[0].sessions[0].id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].minutes, 2);
    assert.equal(rows[0].planVersion, session.planVersion);
  } finally {
    await server.close();
  }
});
