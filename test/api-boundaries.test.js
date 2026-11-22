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
function enqueue(api, count, prefix = 'op') {
  for (let i = 0; i < count; i++) api.queueOp({ opId: prefix + i, value: i });
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

test('超过 200 个 pending 全保留，只裁剪最旧的已确认历史', () => {
  const f = fixture(() => { throw new Error('must stay offline'); });
  const history = Array.from({ length: 205 }, (_, i) => ({ opId: 'history' + i, pending: false }));
  f.disk.set('zx.op_queue', JSON.stringify([{ opId: 'old-pending', pending: true }, ...history]));
  enqueue(f.api, 450);
  const q = Array.from(f.api.loadQueue());
  assert.equal(f.api.pendingCount(), 451);
  assert.equal(q.length, 651);
  assert.equal(q[0].opId, 'old-pending');
  assert.deepEqual(q.filter(o => !o.pending).map(o => o.opId), history.slice(-200).map(o => o.opId));
  assert.equal(f.calls.length, 0);
});

test('flush 按 200 分批串行上行，确认历史最多保留 200 条', async () => {
  const batches = [];
  const f = fixture((url, opts) => {
    const ops = JSON.parse(opts.body).ops;
    batches.push(ops);
    return response({ accepted: ops.map(o => o.opId), serverSeq: batches.length });
  });
  enqueue(f.api, 450);
  await f.api.flushQueue();
  assert.deepEqual(batches.map(b => b.length), [200, 200, 50]);
  assert.equal(new Set(batches.flat().map(o => o.opId)).size, 450);
  assert.equal(batches[0][0].pending, undefined);
  assert.equal(f.api.pendingCount(), 0);
  assert.equal(f.api.loadQueue().length, 200);
  assert.equal(f.state.serverSeq, 3);
});

test('部分确认本轮不重发，零确认停止；下次 flush 只发送未确认项', async () => {
  let acceptAll = false;
  const batches = [];
  const f = fixture((url, opts) => {
    const ids = JSON.parse(opts.body).ops.map(o => o.opId);
    batches.push(ids);
    return response({ accepted: acceptAll ? ids : batches.length === 1 ? ids.slice(0, 1) : [] });
  });
  enqueue(f.api, 450);
  await f.api.flushQueue();
  await turn();
  assert.deepEqual(batches.map(b => b.length), [200, 200]);
  assert.equal(f.api.pendingCount(), 449);
  acceptAll = true;
  await f.api.flushQueue();
  assert.deepEqual(batches.slice(2).map(b => b.length), [200, 200, 49]);
  assert.ok(batches.slice(2).flat().every(id => id !== 'op0'));
  assert.equal(f.api.pendingCount(), 0);
});

for (const accepted of [true, false]) {
  test('并发 flush 共享请求，运行中新增项不被旧快照覆盖：' + accepted, async () => {
    const first = deferred();
    const batches = [];
    const f = fixture((url, opts) => {
      if (url.endsWith('/api/health')) return response({});
      const ids = JSON.parse(opts.body).ops.map(o => o.opId);
      batches.push(ids);
      return batches.length === 1 ? first.promise : response({ accepted: ids });
    });
    enqueue(f.api, 2);
    await f.api.health();
    const done = f.api.flushQueue();
    assert.equal(f.api.flushQueue(), done);
    await turn();
    f.api.queueOp({ opId: 'new-during-flight' });
    await turn();
    assert.equal(batches.length, 1);
    // 即使服务端返回未发送的 ID，也不能误确认运行中新加的写入。
    first.resolve(response({ accepted: accepted ? ['op0', 'op1'] : ['new-during-flight'] }));
    await done;
    assert.equal(f.api.loadQueue().some(o => o.opId === 'new-during-flight'), true);
    if (accepted) {
      assert.deepEqual(batches, [['op0', 'op1'], ['new-during-flight']]);
      assert.equal(f.api.pendingCount(), 0);
    } else {
      assert.equal(batches.length, 1);
      assert.equal(f.api.pendingCount(), 3);
    }
  });
}

test('中途网络失败保留剩余项且释放 flush 锁', async () => {
  let count = 0;
  const f = fixture((url, opts) => {
    const ids = JSON.parse(opts.body).ops.map(o => o.opId);
    if (++count === 2) throw new Error('stub offline');
    return response({ accepted: ids });
  });
  enqueue(f.api, 450);
  await assert.rejects(f.api.flushQueue(), /stub offline/);
  assert.equal(f.api.pendingCount(), 250);
  await f.api.flushQueue();
  assert.equal(f.api.pendingCount(), 0);
});

test('失效后的旧批次不能覆盖队列或清除新一轮 flush 锁', async () => {
  const old = deferred(), fresh = deferred();
  let requests = 0;
  const f = fixture(() => ++requests === 1 ? old.promise : fresh.promise);
  enqueue(f.api, 450);
  const before = f.api.flushQueue();
  await turn();
  f.api.invalidatePendingSync();
  f.disk.delete('zx.op_queue');
  f.api.queueOp({ opId: 'fresh' });
  const after = f.api.flushQueue();
  await turn();
  old.resolve(response({ accepted: ['op0'], serverSeq: 99 }));
  await before;
  assert.equal(f.state.serverSeq, 0);
  assert.equal(f.api.pendingCount(), 1);
  assert.equal(f.api.flushQueue(), after);
  fresh.resolve(response({ accepted: ['fresh'], serverSeq: 1 }));
  await after;
  assert.equal(requests, 2);
  assert.equal(f.api.loadQueue().length, 1);
  assert.equal(f.api.pendingCount(), 0);
});
