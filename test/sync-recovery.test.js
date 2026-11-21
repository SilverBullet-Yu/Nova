const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../assets/js/api.js'), 'utf8');
const stateSource = fs.readFileSync(require.resolve('../assets/js/state.js'), 'utf8');
const utilSource = fs.readFileSync(require.resolve('../assets/js/util.js'), 'utf8');

for (const failed of [false, true]) {
  test('清除后迟到同步不重新写入：' + (failed ? '失败' : '成功'), async () => {
    const disk = new Map();
    let release, reject, started;
    const waiting = new Promise(resolve => { started = resolve; });
    const window = { ZX:{},
      Rhythm:{seed:require('../shared/data/seed.js')}, location:{protocol:'http:', origin:'http://localhost'},
      localStorage:{getItem:k=>disk.get(k), setItem:(k,v)=>disk.set(k,v), removeItem:k=>disk.delete(k)} };
    /* 真实 util.js：currentPlanVersion 的 randHex 与 traceSync 的 appendTrace 与生产同源 */
    vm.runInNewContext(utilSource, {window, crypto, localStorage: window.localStorage});
    vm.runInNewContext(stateSource, {window, crypto});
    vm.runInNewContext(source, {crypto, window, localStorage: window.localStorage, setTimeout, clearTimeout, fetch:async url=>{
      if (url.endsWith('/api/auth/session')) return {ok:true,json:async()=>({token:'demo'})};
      return new Promise((yes,no)=>{ release=yes; reject=no; started(); });
    }});
    const api = window.ZX.api;
    api.queueOp({opId:'demo'});
    const done = api.flushQueue();
    await waiting;
    const state = window.ZX.state;
    const oldSeq = state.serverSeq;
    disk.set('zx.syncTrace', '[]');
    let reload;
    window.ZX.util.clone = structuredClone;
    window.ZX.ui = {confirm: async () => true, toast() {}};
    vm.runInNewContext(fs.readFileSync(require.resolve('../assets/js/flows/settings.js'), 'utf8'), {
      window, setTimeout: fn => { reload = fn; }
    });
    window.ZX.settings.confirmWipe();
    await Promise.resolve();
    assert.equal(typeof reload, 'function');
    assert.equal(disk.has('zx.op_queue'), false);
    assert.ok(JSON.parse(disk.get('zx.trash')).snapshot);
    assert.equal(disk.has('zx.syncTrace'), false);
    if (failed) {
      reject(new Error('offline'));
      await assert.rejects(done, /offline/);
    } else {
      release({ok:true,json:async()=>({accepted:['demo'],serverSeq:2})});
      await done;
    }
    assert.equal(disk.has('zx.syncTrace'), false);
    assert.equal(disk.has('zx.op_queue'), false);
    assert.equal(state.serverSeq, oldSeq);
  });
}

test('API 从离线恢复后补传，收到确认后才清除待上行状态', async () => {
  let reachable = false;
  const uploads = [];
  const disk = new Map();
  const window = { location: { protocol: 'http:', origin: 'http://localhost' }, localStorage: {
    getItem: key => disk.get(key), setItem: (key, value) => disk.set(key, value)
  } };
  vm.runInNewContext(source, { crypto, window, setTimeout, clearTimeout, fetch: async (url, opts) => {
    if (!reachable) throw new Error('offline');
    let body = {};
    if (url.endsWith('/api/auth/session')) body = { token: 'test-token' };
    if (url.endsWith('/api/sync/ops')) {
      const ids = JSON.parse(opts.body).ops.map(op => op.opId);
      uploads.push(...ids);
      body = { accepted: ids, serverSeq: 1 };
    }
    return { ok: true, json: async () => body };
  } });
  const api = window.ZX.api;
  await assert.rejects(api.health(), /offline/);
  api.queueOp({ opId: 'offline-1', entity: 'plan', field: 'moved' });
  assert.equal(api.pendingCount(), 1);
  reachable = true;
  await api.health();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(uploads, ['offline-1']);
  assert.equal(api.pendingCount(), 0);
});

for (const failed of [false, true]) {
  test(failed ? '传输失败保留待上行且不记录错误正文' : '零确认保留待上行且不标记成功', async () => {
    const disk = new Map();
    const window = { ZX: { state: { currentPlanVersion: () => 'baseline' } },
      location: { protocol: 'http:', origin: 'http://localhost' },
      localStorage: { getItem: k => disk.get(k), setItem: (k,v) => disk.set(k,v) } };
    vm.runInNewContext(utilSource, { crypto, window, localStorage: window.localStorage });
    vm.runInNewContext(source, { crypto, window, localStorage: window.localStorage, setTimeout, clearTimeout, fetch: async url => {
      if (url.endsWith('/api/auth/session')) return { ok:true, json:async()=>({token:'synthetic-token'}) };
      assert.ok(url.endsWith('/api/sync/ops'));
      if (failed) throw new Error('synthetic-error');
      return {ok:true, json:async()=>({accepted:[]})};
    } });
    const api = window.ZX.api;
    api.queueOp({opId:'synthetic-op', value:'synthetic-payload'});
    assert.equal(disk.has('zx.syncTrace'), false);
    if (failed) await assert.rejects(api.flushQueue(), /synthetic-error/);
    else await api.flushQueue();
    assert.equal(api.pendingCount(), 1);
    const raw = disk.get('zx.syncTrace');
    const [e] = JSON.parse(raw);
    assert.equal(JSON.parse(raw).length, 1);
    assert.deepEqual(e, { id:e.id, tool:'sync', at:e.at, planVersion:'baseline',
      rulesVersion:'nova-sync-p0-1', status:failed ? 'failed' : 'unconfirmed', sent:1, accepted:0 });
    assert.match(e.id, /^sync-[0-9a-f]{32}$/);
    assert.ok(Number.isFinite(e.at));
    assert.doesNotMatch(raw, /synthetic/);
  });
}

test('部分上行确认只清除已确认项，重试仅发送剩余项', async () => {
  const disk = new Map();
  const batches = [];
  const window = { ZX: {}, location: { protocol: 'http:', origin: 'http://localhost' }, localStorage: {
    getItem: key => disk.get(key), setItem: (key, value) => disk.set(key, value)
  } };
  vm.runInNewContext(utilSource, { crypto, window, localStorage: window.localStorage });
  vm.runInNewContext(source, { crypto, window, localStorage: window.localStorage, setTimeout, clearTimeout, fetch: async (url, opts) => {
    if (url.endsWith('/api/auth/session')) return { ok: true, json: async () => ({ token: 'test-token' }) };
    assert.ok(url.endsWith('/api/sync/ops'));
    const ids = JSON.parse(opts.body).ops.map(op => op.opId);
    batches.push(ids);
    return { ok: true, json: async () => ({ accepted: ids.slice(0, 1), serverSeq: batches.length }) };
  } });
  const api = window.ZX.api;
  api.queueOp({ opId: 'partial-1', entity:'session', entityId:'same-task', field:'recorded', value:{id:'s_demo_1', feel:'private-note'} });
  api.queueOp({ opId: 'partial-2', entity:'session', entityId:'same-task', field:'recorded', value:{id:'s_demo_2'} });
  await api.flushQueue();
  assert.equal(api.pendingCount(), 1);
  assert.deepEqual(Array.from(api.loadQueue().filter(op => op.pending), op => op.opId), ['partial-2']);
  await api.flushQueue();
  assert.deepEqual(batches, [['partial-1', 'partial-2'], ['partial-2']]);
  const raw = disk.get('zx.syncTrace') || '[]';
  assert.deepEqual(JSON.parse(raw).map(e => [e.status, e.sent, e.accepted]), [['partial', 2, 1], ['accepted', 1, 1]]);
  assert.deepEqual(JSON.parse(raw).map(e => e.sessions), [
    [{id:'s_demo_1',confirmed:true},{id:'s_demo_2',confirmed:false}],
    [{id:'s_demo_2',confirmed:true}]
  ]);
  assert.doesNotMatch(raw, /test-token|partial-[12]|private-note|same-task/);
  assert.equal(api.pendingCount(), 0);
});
