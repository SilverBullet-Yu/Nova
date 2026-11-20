'use strict';
/* 诺瓦 Nova · HTTP 端到端冒烟
 * 契约：docs/HANDOFF.md §5（全部端点）+ §8（幂等）
 * 运行：npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { start } = require('../server/main.js');
const auth = require('../server/auth.js');
const memory = require('../server/store/memory.js');
const { seed } = require('../shared/data/seed.js');

let handle = null;
let base = '';
/* 两个独立身份：A 跑既有用例，B 用于越权与限流验证 */
let userA = null;
let userB = null;

async function call(method, path, body, token) {
  const opt = { method: method, headers: {} };
  if (token) opt.headers.authorization = 'Bearer ' + token;
  if (body !== undefined) {
    opt.headers['content-type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(base + path, opt);
  let json = null;
  try {
    json = await res.json();
  } catch (e) {
    json = null;
  }
  return { status: res.status, body: json, res: res };
}

/** 匿名签发一份身份凭证 */
async function newSession() {
  const r = await call('POST', '/api/auth/session', {});
  assert.equal(r.status, 200);
  assert.equal(typeof r.body.token, 'string');
  assert.equal(typeof r.body.userId, 'string');
  assert.equal(typeof r.body.expiresAt, 'number');
  assert.ok(r.body.expiresAt > Date.now());
  return r.body;
}

test.before(async () => {
  memory.reset();
  handle = await start(0);
  base = handle.url;
  userA = await newSession();
  userB = await newSession();
});

test.after(async () => {
  if (handle) await handle.close();
});

/* ── 端点覆盖 ─────────────────────────────────────────────────────────── */

test('GET /api/health 返回 ok:true（无需凭证）', async () => {
  const r = await call('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(typeof r.body.version, 'string');
  assert.equal(typeof r.body.uptimeMs, 'number');
});

test('GET /api/state 返回初始全量（seed / replan / notifications）', async () => {
  const r = await call('GET', '/api/state', undefined, userA.token);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['notifications', 'planBaseline', 'replan', 'seed']);
  assert.equal(r.body.seed.tasks.length, 4);
  assert.equal(r.body.seed.user.name, '林清');
  assert.ok(Array.isArray(r.body.notifications));
  assert.equal(r.body.notifications.length, 4);
});

test('POST /api/feasibility 返回可行性结果（R 1.08）', async () => {
  const r = await call('POST', '/api/feasibility', seed.feas, userA.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.T, 986);
  assert.equal(r.body.D, 913);
  assert.equal(r.body.R, 1.08);
  assert.equal(r.body.margin, 73);
  assert.equal(r.body.verdict, '合理');
});

test('POST /api/schedule 返回排程结果', async () => {
  const r = await call('POST', '/api/schedule', {
    tasks: [{ id: 't2', subject: '数学', estMin: 90, weight: 0.92 }],
    slots: [
      { date: '一', startMin: 630, durMin: 30, available: true, isBuffer: false },
      { date: '一', startMin: 660, durMin: 30, available: true, isBuffer: false },
      { date: '一', startMin: 690, durMin: 30, available: true, isBuffer: false }
    ],
    params: { bufferRatio: 0.15, maxContiguousMin: 150 }
  }, userA.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.version, 'planner-1.0.0');
  assert.ok(Array.isArray(r.body.blocks));
  assert.equal(r.body.blocks.length, 3);
  assert.equal(r.body.blocks[0].taskId, 't2');
  assert.equal(r.body.blocks[0].durMin, 30);
  assert.equal(r.body.blocks[2].startMin, 690);
});

test('POST /api/replan 返回四级策略与快照（L4 需确认，不落库）', async () => {
  const week = seed.week.map((d) => ({ date: d.d, minutes: d.total, buffer: d.buf }));
  const r = await call('POST', '/api/replan', {
    tasks: seed.tasks,
    week: week,
    params: {},
    history: { consecutiveNoImprove: 0 },
    timestamp: '2026-11-08T11:04:00+08:00'
  }, userA.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.strategies.length, 4);
  assert.equal(r.body.strategies[0].applied, false);
  /* 种子周无容量溢出：L2 不触发，L4 只给放弃建议 */
  assert.equal(r.body.strategies[1].applied, false);
  assert.equal(r.body.strategies[3].applied, true);
  assert.equal(r.body.accepted, false);
  assert.equal(r.body.needsConfirmation, true);
  assert.equal(r.body.verdict, 'needsConfirmation');
  assert.equal(r.body.snapshot.timestamp, '2026-11-08T11:04:00+08:00');
  assert.deepEqual(r.body.snapshot.week, week);

  /* 撤销：反向应用快照，不重算 */
  const u = await call('POST', '/api/replan/undo', { snapshot: r.body.snapshot }, userA.token);
  assert.equal(u.status, 200);
  assert.deepEqual(u.body.tasks, seed.tasks);
  assert.deepEqual(u.body.week, week);
});

test('POST /api/replan/confirm 确认后才落库', async () => {
  const week = seed.week.map((d) => ({ date: d.d, minutes: d.total, buffer: d.buf }));
  const before = await call('GET', '/api/state', undefined, userA.token);
  assert.equal(before.body.replan, null);
  assert.equal(before.body.planBaseline, null);

  const r = await call('POST', '/api/replan', {
    tasks: seed.tasks, week: week, params: {},
    history: { consecutiveNoImprove: 0 }, timestamp: 2000
  }, userA.token);
  assert.equal(r.body.needsConfirmation, true);

  /* 未确认：放弃项必须可预览，服务端全量业务状态保持不变。 */
  assert.ok(r.body.diff.some(change => change.op === 'abandon'));
  const mid = await call('GET', '/api/state', undefined, userA.token);
  assert.equal(mid.status, 200);
  assert.deepEqual(mid.body, before.body);

  assert.equal(typeof r.body.draftId, 'string');
  const c = await call('POST', '/api/replan/confirm', { draftId: r.body.draftId }, userA.token);
  assert.equal(c.status, 200);
  assert.equal(c.body.accepted, true);
  assert.equal(c.body.needsConfirmation, false);
  assert.equal(c.body.verdict, 'ok');

  const after = await call('GET', '/api/state', undefined, userA.token);
  assert.ok(after.body.replan);
  assert.equal(after.body.replan.accepted, true);
  assert.match(after.body.planBaseline.version, /^[0-9a-f-]{36}$/);
  assert.equal(after.body.planBaseline.stale, false);
  assert.equal((await call('GET', '/api/state', undefined, userB.token)).body.planBaseline, null);

  const again = await call('POST', '/api/replan/confirm', { draftId: r.body.draftId }, userA.token);
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, c.body);
  assert.deepEqual((await call('GET', '/api/state', undefined, userA.token)).body, after.body);
});

test('普通在线重排预览不改变服务端重排记录', async () => {
  const before = await call('GET', '/api/state', undefined, userA.token);
  const input = {
    tasks: [{ id: 'preview-only', subject: '数学', est: 30, weight: 0.8 }],
    week: ['二', '三', '四', '五', '六', '日', '一'].map(date => ({ date, minutes: 100, capacity: date === '二' ? 130 : 100, buffer: 60 })),
    timestamp: 1000
  };
  const preview = await call('POST', '/api/replan', input, userA.token);
  const parallel = await call('POST', '/api/replan', input, userA.token);
  assert.equal(preview.status, 200);
  assert.equal(parallel.status, 200);
  assert.equal(preview.body.accepted, true);
  const after = await call('GET', '/api/state', undefined, userA.token);
  assert.equal(after.status, 200);
  assert.deepEqual(after.body, before.body);
  const confirmed = await call('POST', '/api/replan/confirm', { draftId: preview.body.draftId }, userA.token);
  assert.equal(confirmed.status, 200);
  const committed = (await call('GET', '/api/state', undefined, userA.token)).body;
  assert.equal(committed.replan.accepted, true);
  const stale = await call('POST', '/api/replan/confirm', { draftId: parallel.body.draftId }, userA.token);
  assert.equal(stale.status, 409);
  assert.deepEqual((await call('GET', '/api/state', undefined, userA.token)).body, committed);
});

test('POST /api/attribute 返回归因结果', async () => {
  const r = await call('POST', '/api/attribute', {
    planLoadRatio: 1.2,
    consecutiveZeroDays: 0,
    consecutiveTimeoutCount: 0,
    efficiencyRatio: 1,
    completion: 0,
    externalRatio: 0
  }, userA.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.type, '计划过载');
  assert.ok(r.body.confidence > 0 && r.body.confidence <= 1);
  assert.ok(Array.isArray(r.body.actions));
  assert.equal(typeof r.body.evidence, 'object');
});

/* ── 下线端点（简化批撤除）：一律 404 / E2001 ─────────────────────────── */

test('下线端点：sessions / sync 拉取 / weekly 周报返回 404', async () => {
  const cases = [
    ['POST', '/api/sessions', { opId: 'x', taskId: 't1', durationMin: 1, completion: 1 }],
    ['GET', '/api/sync?since=0', undefined],
    ['GET', '/api/reports/weekly', undefined]
  ];
  for (const c of cases) {
    const r = await call(c[0], c[1], c[2], userA.token);
    assert.equal(r.status, 404, c[0] + ' ' + c[1]);
    assert.equal(r.body.error.code, 'E2001');
  }
});

/* ── 幂等 ─────────────────────────────────────────────────────────────── */

test('GET /api/state 回读 session：sync 上行的记录以完整会话对象返回', async () => {
  const sess = { id: 's_readback_1', taskId: 't2', startAt: 1000, endAt: 2000, minutes: 30, completion: 100, status: 'backfill', feel: null, isBackfill: true, planVersion: null };
  const up = await call('POST', '/api/sync/ops', {
    ops: [{ opId: 'op-session-readback', entity: 'session', entityId: 't2', field: 'recorded', value: sess, clientTs: 300 },
      { opId: 'op-session-version', entity: 'session', entityId: 't2', field: 'recorded', value: { ...sess, id: 's_readback_version', isBackfill: false, status: 'done', planVersion: 'plan-0123456789abcdef0123456789abcdef' }, clientTs: 301 }]
  }, userA.token);
  assert.equal(up.status, 200);
  assert.deepEqual(up.body.accepted, ['op-session-readback', 'op-session-version']);

  const r = await call('GET', '/api/state', undefined, userA.token);
  assert.equal(r.status, 200);
  const sessions = (r.body.seed && Array.isArray(r.body.seed.sessions)) ? r.body.seed.sessions : [];
  const hit = sessions.find((x) => x && x.id === 's_readback_1');
  assert.ok(hit, 'seed.sessions 应包含完整会话对象');
  assert.equal(hit.status, 'backfill');
  assert.equal(hit.minutes, 30);
  assert.equal(hit.feel, null);
  assert.equal(hit.planVersion, null);
  assert.equal(sessions.find(x => x.id === 's_readback_version')?.planVersion, 'plan-0123456789abcdef0123456789abcdef');
});

test('POST /api/sync/ops 幂等：同 opId 重复提交不产生新 seq', async () => {
  const ops = [{ opId: 'op-sync-1', entity: 'task', entityId: 't3', field: 'status', value: 'scheduled', clientTs: 100 }];
  const a = await call('POST', '/api/sync/ops', { ops: ops }, userA.token);
  assert.equal(a.status, 200);
  assert.deepEqual(a.body.accepted, ['op-sync-1']);
  const seqA = a.body.serverSeq;

  const b = await call('POST', '/api/sync/ops', { ops: ops }, userA.token);
  assert.equal(b.status, 200);
  assert.deepEqual(b.body.accepted, ['op-sync-1']);
  assert.equal(b.body.serverSeq, seqA);
});

test('同步混合批次：旧操作重试不会覆盖新改期', async () => {
  const { token } = await newSession();
  const old = { opId: 'old', entity: 'plan', entityId: 'dayAssign', field: 'moved', value: { taskId: 't2', day: '二' }, clientTs: 100 };
  const first = await call('POST', '/api/sync/ops', { ops: [old] }, token);
  assert.equal(first.status, 200);
  const moved = { ...old, opId: 'new', value: { taskId: 't2', day: '三' }, clientTs: 200 };
  const retry = { ...old, clientTs: 300 };
  const mixed = await call('POST', '/api/sync/ops', { ops: [moved, retry] }, token);
  assert.equal(mixed.status, 200);
  assert.deepEqual(mixed.body.accepted, ['new', 'old']);
  assert.equal(mixed.body.serverSeq, first.body.serverSeq);
  const state = await call('GET', '/api/state', undefined, token);
  assert.equal(state.status, 200);
  assert.equal(state.body.seed.dayAssign.t2, '三');
});

/* ── 字段级合并规则 ───────────────────────────────────────────────────── */

test('同步合并：状态类最后写入优先', async () => {
  await call('POST', '/api/sync/ops', {
    ops: [{ opId: 'm-status-1', entity: 'task', entityId: 't4', field: 'status', value: 'running', clientTs: 1000 }]
  }, userA.token);
  await call('POST', '/api/sync/ops', {
    ops: [{ opId: 'm-status-2', entity: 'task', entityId: 't4', field: 'status', value: 'done', clientTs: 2000 }]
  }, userA.token);
  const model = memory.getModel(userA.userId);
  const t4 = model.tasks.find((t) => t.id === 't4');
  assert.equal(t4.status, 'done');
});

test('同步合并：计数类求和 / 取最大值', async () => {
  await call('POST', '/api/sync/ops', {
    ops: [{ opId: 'm-count-1', entity: 'task', entityId: 't1', field: 'sessionCount', value: 1, clientTs: 1000 }]
  }, userA.token);
  await call('POST', '/api/sync/ops', {
    ops: [{ opId: 'm-count-2', entity: 'task', entityId: 't1', field: 'sessionCount', value: 2, clientTs: 1100 }]
  }, userA.token);
  await call('POST', '/api/sync/ops', {
    ops: [{ opId: 'm-count-3', entity: 'task', entityId: 't1', field: 'actual', value: 70, clientTs: 1000 }]
  }, userA.token);
  await call('POST', '/api/sync/ops', {
    ops: [{ opId: 'm-count-4', entity: 'task', entityId: 't1', field: 'actual', value: 50, clientTs: 1100 }]
  }, userA.token);
  const model = memory.getModel(userA.userId);
  assert.equal(model.tasks.find((t) => t.id === 't1').sessionCount, 3);
  assert.equal(model.tasks.find((t) => t.id === 't1').actual, 70);
});

test('同步合并：删除类墓碑优先且不可翻转', async () => {
  await call('POST', '/api/sync/ops', {
    ops: [{ opId: 'm-del-1', entity: 'task', entityId: 't3', field: 'deleted', value: true, clientTs: 1000 }]
  }, userA.token);
  await call('POST', '/api/sync/ops', {
    ops: [{ opId: 'm-del-2', entity: 'task', entityId: 't3', field: 'deleted', value: false, clientTs: 2000 }]
  }, userA.token);
  const model = memory.getModel(userA.userId);
  assert.equal(model.tasks.find((t) => t.id === 't3').deleted, true);
});

test('HTTP 回读：撤销顺延恢复原非默认落点', async () => {
  const { token } = await newSession();
  for (const [i, day] of ['二', '三', '二'].entries()) {
    const opId = 'undo-placement-' + i;
    const up = await call('POST', '/api/sync/ops', { ops: [{
      opId, entity: 'plan', entityId: 'dayAssign', field: 'moved', value: { taskId: 't2', day }, clientTs: 900 + i
    }] }, token);
    assert.equal(up.status, 200);
    assert.deepEqual(up.body.accepted, [opId]);
    const state = await call('GET', '/api/state', undefined, token);
    assert.equal(state.status, 200);
    assert.equal(state.body.seed.dayAssign.t2, day);
  }
});

test('回放：moved / locked / notif / buffer 经 state 可读（多端一致）', async () => {
  await call('POST', '/api/sync/ops', {
    ops: [
      { opId: 'rp-1', entity: 'plan', entityId: 'dayAssign', field: 'moved', value: { taskId: 't2', day: '三' }, clientTs: 500 },
      { opId: 'rp-2', entity: 'plan', entityId: 't2', field: 'locked', value: true, clientTs: 501 },
      { opId: 'rp-3', entity: 'notif', entityId: 'daily', field: 'daily', value: false, clientTs: 502 },
      { opId: 'rp-4', entity: 'buffer', entityId: 'today', field: 'occupied', value: true, clientTs: 503 }
    ]
  }, userA.token);

  const r = await call('GET', '/api/state', undefined, userA.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.seed.dayAssign.t2, '三');
  assert.equal(r.body.seed.locks.t2, true);
  const daily = r.body.notifications.find((n) => n.kind === 'daily');
  assert.equal(daily.enabled, false);
  assert.equal(r.body.seed.buffer.free, false);

  /* 回基线日 = 撤销改期；value=false 解锁 = 删除键 */
  await call('POST', '/api/sync/ops', {
    ops: [
      { opId: 'rp-5', entity: 'plan', entityId: 'dayAssign', field: 'moved', value: { taskId: 't2', day: '日' }, clientTs: 600 },
      { opId: 'rp-6', entity: 'plan', entityId: 't2', field: 'locked', value: false, clientTs: 601 }
    ]
  }, userA.token);
  const r2 = await call('GET', '/api/state', undefined, userA.token);
  assert.equal(r2.body.seed.dayAssign.t2, undefined);
  assert.equal(r2.body.seed.locks.t2, undefined);
});

/* ── 错误码 ───────────────────────────────────────────────────────────── */

test('错误：未知接口返回 E2001 / 404', async () => {
  const r = await call('GET', '/api/nope', undefined, userA.token);
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'E2001');
  assert.equal(typeof r.body.error.message, 'string');
});

test('错误：参数缺失返回 E1001 / 400', async () => {
  const r = await call('POST', '/api/feasibility', { weeklyH: 20 }, userA.token);
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'E1001');
});

test('同步拒绝非标量实体标识，且不应用同批合法操作', async () => {
  const before = await call('GET', '/api/state', undefined, userA.token);
  const r = await call('POST', '/api/sync/ops', { ops: [
    { opId: 'invalid-key-batch-valid', entity: 'task', entityId: 't1', field: 'status', value: 'scheduled' },
    { opId: 'invalid-key-batch-invalid', entity: 'task', entityId: ['t1'], field: 'status', value: 'scheduled' }
  ] }, userA.token);
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'E1001');
  const after = await call('GET', '/api/state', undefined, userA.token);
  assert.equal(after.body.serverSeq, before.body.serverSeq);
});

test('错误：单批上行超过 200 条返回 E4002 / 400', async () => {
  const ops = [];
  for (let i = 0; i < 201; i++) {
    ops.push({ opId: 'over-' + i, entity: 'task', entityId: 't1', field: 'status', value: 'x', clientTs: i });
  }
  const r = await call('POST', '/api/sync/ops', { ops: ops }, userA.token);
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'E4002');
});

/* ── 鉴权：未带凭证 / 伪造凭证 ───────────────────────────────────────── */

test('鉴权：未带凭证访问业务接口返回 401 / E4010', async () => {
  const cases = [
    ['GET', '/api/state', undefined],
    ['POST', '/api/replan', { tasks: [], week: [] }],
    ['POST', '/api/sync/ops', { ops: [] }]
  ];
  for (const c of cases) {
    const r = await call(c[0], c[1], c[2]);
    assert.equal(r.status, 401, c[0] + ' ' + c[1]);
    assert.equal(r.body.error.code, 'E4010');
  }
});

test('鉴权：伪造 / 过期凭证被拒', async () => {
  const forged = await call('GET', '/api/state', undefined, 'nj1.forged.signature');
  assert.equal(forged.status, 401);
  assert.equal(forged.body.error.code, 'E4010');

  /* 把合法凭证的 payload 篡改后签名不再匹配 */
  const parts = userA.token.split('.');
  const tampered = parts[0] + '.' + Buffer.from(
    JSON.stringify({ u: userB.userId, iat: Date.now(), exp: Date.now() + 60000 })
  ).toString('base64url') + '.' + parts[2];
  const r = await call('GET', '/api/state', undefined, tampered);
  assert.equal(r.status, 401);
  assert.equal(r.body.error.code, 'E4010');
});

/* ── 越权：分区隔离 ───────────────────────────────────────────────────── */

test('越权：只能读写自己的分区，伪造 userId 被拒', async () => {
  /* A 写一条独占数据 */
  const w = await call('POST', '/api/sync/ops', {
    ops: [{ opId: 'iso-a-1', entity: 'task', entityId: 't2', field: 'title', value: 'A 专属标题', clientTs: 99999 }]
  }, userA.token);
  assert.equal(w.status, 200);

  /* 读：A 的分区可见该写入，B 的分区保持种子原值 */
  const aState = await call('GET', '/api/state', undefined, userA.token);
  const bState = await call('GET', '/api/state', undefined, userB.token);
  assert.equal(aState.body.seed.tasks.find((t) => t.id === 't2').title, 'A 专属标题');
  assert.equal(bState.body.seed.tasks.find((t) => t.id === 't2').title, seed.tasks.find((t) => t.id === 't2').title);

  /* 写：请求体声称自己是 B，服务端按凭证 A 判定并拒绝 */
  const forged = await call('POST', '/api/sync/ops', {
    ops: [{
      opId: 'iso-forged-1', entity: 'task', entityId: 't2',
      field: 'title', value: '越权写入', clientTs: 100000, userId: userB.userId
    }]
  }, userA.token);
  assert.equal(forged.status, 403);
  assert.equal(forged.body.error.code, 'E4030');

  /* B 的分区未被污染 */
  const bAfter = await call('GET', '/api/state', undefined, userB.token);
  assert.equal(bAfter.body.seed.tasks.find((t) => t.id === 't2').title, seed.tasks.find((t) => t.id === 't2').title);
});

/* ── 限流：超限被拒 ───────────────────────────────────────────────────── */

test('限流：同一身份 60 秒内第 13 次 replan 返回 429 / E4290', async () => {
  const payload = {
    tasks: [{ id: 't1', subject: '数学', est: 60, weight: 0.9, done: false }],
    week: [{ date: '一', minutes: 0, buffer: 45 }],
    params: {},
    history: {},
    timestamp: 0
  };
  for (let i = 0; i < 12; i++) {
    const ok = await call('POST', '/api/replan', payload, userB.token);
    assert.equal(ok.status, 200, '第 ' + (i + 1) + ' 次应放行');
  }
  const over = await call('POST', '/api/replan', payload, userB.token);
  assert.equal(over.status, 429);
  assert.equal(over.body.error.code, 'E4290');
  assert.ok(Number(over.res.headers.get('retry-after')) >= 1);

  /* 限流按身份隔离：A 不受 B 的窗口影响 */
  const aStillOk = await call('POST', '/api/replan', payload, userA.token);
  assert.equal(aStillOk.status, 200);
});

/* ── 限流来源标识：clientIp（单元级，不依赖网络） ─────────────────────── */

test('clientIp：默认不信任 X-Forwarded-For（可伪造，按 TCP 对端隔离）', () => {
  const saved = process.env.NOVA_TRUST_PROXY;
  delete process.env.NOVA_TRUST_PROXY;
  try {
    const req = { socket: { remoteAddress: '203.0.113.7' },
      headers: { 'x-forwarded-for': '198.51.100.9, 10.0.0.2' } };
    assert.equal(auth.clientIp(req), '203.0.113.7');
  } finally {
    if (saved === undefined) delete process.env.NOVA_TRUST_PROXY;
    else process.env.NOVA_TRUST_PROXY = saved;
  }
});

test('clientIp：TRUST_PROXY=1 取 XFF 最后一跳；无头 / 空跳回落 socket 地址', () => {
  const saved = process.env.NOVA_TRUST_PROXY;
  process.env.NOVA_TRUST_PROXY = '1';
  try {
    const req = { socket: { remoteAddress: '10.0.0.2' },
      headers: { 'x-forwarded-for': '198.51.100.9, 203.0.113.7' } };
    assert.equal(auth.clientIp(req), '203.0.113.7');
    const noXff = { socket: { remoteAddress: '10.0.0.2' }, headers: {} };
    assert.equal(auth.clientIp(noXff), '10.0.0.2');
    const blank = { socket: { remoteAddress: '10.0.0.2' },
      headers: { 'x-forwarded-for': ' , ,' } };
    assert.equal(auth.clientIp(blank), '10.0.0.2');
  } finally {
    if (saved === undefined) delete process.env.NOVA_TRUST_PROXY;
    else process.env.NOVA_TRUST_PROXY = saved;
  }
});

/* ── 静态托管 ─────────────────────────────────────────────────────────── */

test('静态托管：GET / 返回 index.html', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
});

test('静态托管：GET /shared/engine/*.js 可直接被浏览器加载', async () => {
  const res = await fetch(base + '/shared/engine/feasibility.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /javascript/);
  const text = await res.text();
  assert.match(text, /Rhythm\.feasibility/);
});

test('静态托管：未授权路径不泄漏文件系统', async () => {
  const res = await fetch(base + '/server/main.js');
  assert.equal(res.status, 404);
});
