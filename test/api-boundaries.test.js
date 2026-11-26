'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../assets/js/api.js'), 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(fetch, authenticated = true) {
  const disk = new Map();
  const timers = new Map();
  const calls = [];
  let id = 0;
  if (authenticated) disk.set('zx.auth_token', JSON.stringify({ token: 'stub-token' }));
  const window = {
    location: { protocol: 'http:', origin: 'http://stub.invalid' },
    localStorage: { getItem: k => disk.get(k), setItem: (k, v) => disk.set(k, v), removeItem: k => disk.delete(k) },
    ZX: { util: { randHex: () => 'stub', appendTrace() {} }, state: { serverSeq: 0 } }
  };
  vm.runInNewContext(source, {
    window, AbortController,
    setTimeout(fn, ms) { timers.set(++id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch(url, opts) { calls.push({ url, opts }); return fetch(url, opts); }
  });
  return {
    api: window.ZX.api, disk, timers, calls, state: window.ZX.state,
    expire() {
      for (const [id, timer] of [...timers]) { timers.delete(id); timer.fn(); }
    }
  };
}
function untilAbort(signal) {
  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      const error = new Error('aborted'); error.name = 'AbortError'; reject(error);
    }, { once: true });
  });
}

test('响应头已到但正文挂起时仍在 3000ms 中止，finally 清理计时器', async () => {
  const f = fixture((url, opts) => ({ ok: true, json: () => untilAbort(opts.signal) }));
  const done = f.api.health();
  const rejected = assert.rejects(done, { name: 'AbortError' });
  await turn();
  assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].ms, 3000);
  f.expire();
  await rejected;
  assert.equal(f.calls[0].opts.signal.aborted, true);
  assert.equal(f.timers.size, 0);
  assert.equal(f.api.isOnline(), false);
});

for (const phase of ['headers', 'body']) {
  test('鉴权共享带超时请求并在失败后释放锁：' + phase, async () => {
    let fail = true;
    const f = fixture((url, opts) => {
      if (url.endsWith('/api/auth/session')) {
        if (fail) return phase === 'headers' ? untilAbort(opts.signal) : { ok: true, json: () => untilAbort(opts.signal) };
        return response({ token: 'renewed' });
      }
      assert.equal(opts.headers.Authorization, 'Bearer renewed');
      return response({});
    }, false);
    const a = assert.rejects(f.api.schedule({}), { name: 'AbortError' });
    const b = assert.rejects(f.api.replan({}), { name: 'AbortError' });
    await turn();
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].opts.method, 'POST');
    assert.equal(f.calls[0].opts.body, '{}');
    assert.equal([...f.timers.values()][0].ms, 3000);
    f.expire();
    await Promise.all([a, b]);
    assert.equal(f.timers.size, 0);
    fail = false;
    await f.api.schedule({});
    assert.equal(f.calls.filter(c => c.url.endsWith('/api/auth/session')).length, 2);
    assert.equal(f.timers.size, 0);
  });
}

test('非 2xx 保留 HTTP status 和结构 error.code（含鉴权和 LLM）', async () => {
  for (const authenticated of [false, true]) {
    const f = fixture(() => response({ error: { code: 'E5012', message: 'stub failure' } }, 503), authenticated);
    await assert.rejects(f.api.llmAnalyze({}), error => {
      assert.equal(error.status, 503);
      assert.equal(error.code, 'E5012');
      assert.equal(error.message, 'stub failure');
      return true;
    });
    assert.equal(f.api.isOnline(), true);
    assert.equal(f.timers.size, 0);
  }
});

test('错误正文读取也受超时保护，HTTP 状态不丢失', async () => {
  const f = fixture((url, opts) => ({ ok: false, status: 503, json: () => untilAbort(opts.signal) }));
  const rejected = assert.rejects(f.api.health(), error => error.status === 503);
  await turn();
  assert.equal(f.timers.size, 1);
  f.expire();
  await rejected;
  assert.equal(f.timers.size, 0);
});

test('非 JSON 401 仍重签一次，第二次 401 保留错误码而不无限重试', async () => {
  let attempts = 0;
  const f = fixture(url => {
    if (url.endsWith('/api/auth/session')) return response({ token: 'renewed' });
    if (++attempts === 1) return { ok: false, status: 401, json() { throw new SyntaxError('not JSON'); } };
    return response({ error: { code: 'E4010' } }, 401);
  });
  await assert.rejects(f.api.schedule({}), error => error.status === 401 && error.code === 'E4010');
  assert.equal(attempts, 2);
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2].opts.headers.Authorization, 'Bearer renewed');
  assert.equal(f.timers.size, 0);
});

for (const mode of ['success', 'json-failure', 'fetch-throw', 'fetch-reject']) {
  test('请求完成所有分支都清理 timer：' + mode, async () => {
    const f = fixture(() => {
      if (mode === 'fetch-throw') throw new Error(mode);
      if (mode === 'fetch-reject') return Promise.reject(new Error(mode));
      if (mode === 'json-failure') return { ok: true, json: async () => { throw new SyntaxError(mode); } };
      return response({ ok: true });
    });
    if (mode === 'success') await f.api.health();
    else await assert.rejects(f.api.health(), new RegExp(mode));
    assert.equal(f.timers.size, 0);
  });
}

test('LLM 客户端预算保持原 3 秒，服务端 30 秒预算差异待产品审定', async () => {
  const body = deferred();
  const f = fixture(() => ({ ok: true, json: () => body.promise }));
  const done = f.api.llmClarify({});
  await turn();
  assert.equal([...f.timers.values()][0].ms, 3000);
  body.resolve({});
  await done;
  assert.equal(f.timers.size, 0);
});

test('旧队列原样隔离：新业务不写队列，健康恢复后 flush 仍不发网络', async () => {
  const original = '[{"opId":"old-pending","pending":true,"value":{"note":"private"}},{"opId":"old-done","pending":false},null]';
  let reachable = false;
  const f = fixture(url => {
    assert.equal(new URL(url).pathname, '/api/health');
    if (!reachable) throw new Error('offline');
    return response({ ok: true });
  });
  f.disk.set('zx.op_queue', original);
  f.state.serverSeq = 7;

  assert.equal(f.api.queueOp({ opId: 'new-offline', value: 'local-only' }), null);
  assert.equal(f.api.pendingCount(), 0);
  assert.equal(f.api.legacyPendingCount(), 1);
  await assert.rejects(f.api.health(), /offline/);

  reachable = true;
  await f.api.health();
  assert.equal(f.api.queueOp({ opId: 'new-online', value: 'local-only' }), null);
  const first = f.api.flushQueue();
  const second = f.api.flushQueue();
  assert.notEqual(first, second);
  const expected = { status: 'isolated', sent: 0, accepted: [], pending: 1, serverSeq: 7 };
  assert.deepEqual(JSON.parse(JSON.stringify(await first)), expected);
  assert.deepEqual(JSON.parse(JSON.stringify(await second)), expected);
  await turn();

  assert.deepEqual(f.calls.map(call => new URL(call.url).pathname), ['/api/health', '/api/health']);
  assert.equal(f.disk.get('zx.op_queue'), original);
  assert.equal(f.api.pendingCount(), 0);
  assert.equal(f.api.legacyPendingCount(), 1);
  assert.equal(f.disk.has('zx.syncTrace'), false);
  assert.equal(f.state.serverSeq, 7);
  for (const name of ['getState', 'stagePlan', 'reviewPlan', 'confirmReplan', 'undo', 'syncOps']) {
    assert.equal(f.api[name], undefined, name + ' 不应继续暴露');
  }
});

test('超过 200 条旧 pending 也原样保留，不裁剪且不产生待同步计数', async () => {
  const f = fixture(() => { throw new Error('must stay offline'); });
  const legacy = Array.from({ length: 450 }, (_, i) => ({ opId: 'old-' + i, pending: true }));
  const history = Array.from({ length: 205 }, (_, i) => ({ opId: 'history-' + i, pending: false }));
  const original = JSON.stringify([...legacy, ...history]);
  f.disk.set('zx.op_queue', original);

  for (let i = 0; i < 450; i++) assert.equal(f.api.queueOp({ opId: 'new-' + i }), null);
  assert.equal(f.api.pendingCount(), 0);
  assert.equal(f.api.legacyPendingCount(), 450);
  assert.equal(JSON.parse(JSON.stringify(f.api.loadQueue())).length, 655);
  assert.deepEqual(JSON.parse(JSON.stringify(await f.api.flushQueue())), {
    status: 'isolated', sent: 0, accepted: [], pending: 450, serverSeq: 0
  });
  assert.equal(f.disk.get('zx.op_queue'), original);
  assert.equal(f.calls.length, 0);
});
