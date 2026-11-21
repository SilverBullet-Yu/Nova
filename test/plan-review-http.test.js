'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { start } = require('../server/main');
const { schedule } = require('../shared/engine/schedule');
const src = fs.readFileSync(require.resolve('../assets/js/api'), 'utf8');

test('离线确认的新计划刷新后复核，冲突需二次确认，重复提交不再写入', async () => {
  const server = await start(0);
  const disk = new Map();
  let offline = false;
  function boot() {
    const ZX = {};
    vm.runInNewContext(src, { window: { ZX, location: {protocol:'http:', origin:server.url},
      localStorage: {getItem:k=>disk.get(k), setItem:(k,v)=>disk.set(k,v), removeItem:k=>disk.delete(k)} },
      crypto, AbortController, setTimeout, clearTimeout, fetch: (...args) => offline ? Promise.reject(new Error('offline')) : fetch(...args) });
    return ZX.api;
  }
  try {
    const input = {tasks:[{id:'a',subject:'math',estMin:30,weight:1}],slots:[{date:'三',startMin:480,durMin:30}]};
    const first = boot();
    await first.getState();
    first.stagePlan(input, schedule(input));
    const initial = await first.reviewPlan();
    assert.equal(initial.status, 'committed');
    assert.equal((await first.getState()).planBaseline.version, initial.version);
    offline = true;
    first.stagePlan(input, schedule(input));
    await assert.rejects(first.reviewPlan(), /offline/);
    const next = boot();
    assert.ok(next.pendingPlan());
    offline = false;
    const request = next.pendingPlan();
    const token = JSON.parse(disk.get('zx.auth_token')).token;
    const post = async body => (await fetch(server.url + '/api/plan/review', {method:'POST', headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
    const other = await post({...request, id:crypto.randomUUID()});
    assert.equal(other.status, 'committed');
    const conflict = await next.reviewPlan();
    assert.equal(conflict.status, 'conflict');
    assert.equal((await next.getState()).planBaseline.version, other.version);
    assert.equal((await next.reviewPlan()).status, 'conflict');
    const later = await post({...request, id:crypto.randomUUID(), base:other.version});
    assert.equal(later.status, 'committed');
    const stale = await next.reviewPlan(conflict.ticket);
    assert.equal(stale.status, 'conflict');
    assert.notEqual(stale.ticket, conflict.ticket);
    assert.equal((await next.getState()).planBaseline.version, later.version);
    const mismatch = await post({...request, id:crypto.randomUUID(), base:later.version, result:{...request.result, version:'older'}});
    assert.equal(mismatch.reason, 'result-changed');
    assert.equal((await next.getState()).planBaseline.version, later.version);
    const confirmed = await next.reviewPlan(stale.ticket);
    assert.equal(confirmed.status, 'committed');
    assert.equal(boot().pendingPlan(), null);
    assert.equal((await post({...request,ticket:stale.ticket})).version, confirmed.version);
    assert.equal((await next.getState()).planBaseline.version, confirmed.version);
  } finally { await server.close(); }
});
