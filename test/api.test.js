'use strict';
/* 诺瓦 Nova · HTTP 端到端冒烟
 * 契约：docs/HANDOFF.md §5（全部端点）+ §8（幂等）
 * 运行：npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { start } = require('../server/main.js');
const memory = require('../server/store/memory.js');
const { seed } = require('../shared/data/seed.js');

let handle = null;
let base = '';

async function call(method, path, body) {
  const opt = { method: method, headers: {} };
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

test.before(async () => {
  memory.reset();
  handle = await start(0);
  base = handle.url;
});

test.after(async () => {
  if (handle) await handle.close();
});

/* ── 端点覆盖 ─────────────────────────────────────────────────────────── */

test('GET /api/health 返回 ok:true', async () => {
  const r = await call('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(typeof r.body.version, 'string');
  assert.equal(typeof r.body.uptimeMs, 'number');
});

test('GET /api/state 返回初始全量（seed / replan / notifications）', async () => {
  const r = await call('GET', '/api/state');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['notifications', 'replan', 'seed']);
  assert.equal(r.body.seed.tasks.length, 4);
  assert.equal(r.body.seed.user.name, '林清');
  assert.ok(Array.isArray(r.body.notifications));
  assert.equal(r.body.notifications.length, 4);
});

test('POST /api/feasibility 返回可行性结果（R 1.08）', async () => {
  const r = await call('POST', '/api/feasibility', seed.feas);
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
    params: { slotMinutes: 30, bufferRatio: 0.15, maxContiguousMin: 150, deadlineMs: 200 }
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.version, 'planner-1.0.0');
  assert.ok(Array.isArray(r.body.blocks));
  assert.equal(r.body.blocks.length, 3);
  assert.equal(r.body.blocks[0].taskId, 't2');
  assert.equal(r.body.blocks[0].durMin, 30);
  assert.equal(r.body.blocks[2].startMin, 690);
  assert.ok(typeof r.body.softScore === 'number');
  assert.equal(r.body.truncated, false);
});

test('POST /api/replan 返回四级策略与快照', async () => {
  const week = seed.week.map((d) => ({ date: d.d, minutes: d.total, buffer: d.buf }));
  const r = await call('POST', '/api/replan', {
    tasks: seed.tasks,
    week: week,
    params: {},
    history: { consecutiveNoImprove: 0 },
    timestamp: '2026-11-08T11:04:00+08:00'
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.strategies.length, 4);
  assert.equal(r.body.strategies[0].applied, false);
  assert.equal(r.body.strategies[1].applied, true);
  assert.equal(r.body.accepted, true);
  assert.equal(r.body.verdict, 'ok');
  assert.equal(r.body.snapshot.timestamp, '2026-11-08T11:04:00+08:00');
  assert.deepEqual(r.body.snapshot.week, week);

  /* 撤销：反向应用快照，不重算 */
  const u = await call('POST', '/api/replan/undo', { snapshot: r.body.snapshot });
  assert.equal(u.status, 200);
  assert.deepEqual(u.body.tasks, seed.tasks);
  assert.deepEqual(u.body.week, week);
});

test('POST /api/attribute 返回归因结果', async () => {
  const r = await call('POST', '/api/attribute', {
    planLoadRatio: 1.2,
    consecutiveZeroDays: 0,
    consecutiveTimeoutCount: 0,
    efficiencyRatio: 1,
    completion: 0,
    externalRatio: 0
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.type, '计划过载');
  assert.ok(r.body.confidence > 0 && r.body.confidence <= 1);
  assert.ok(Array.isArray(r.body.actions));
  assert.equal(typeof r.body.evidence, 'object');
});

test('GET /api/reports/weekly 返回周报', async () => {
  const r = await call('GET', '/api/reports/weekly');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), [
    'achievement', 'actions', 'attribution', 'effectiveHours', 'subjectMix', 'week'
  ]);
  assert.equal(r.body.week.length, 7);
  assert.equal(r.body.achievement, 68);
  assert.equal(r.body.effectiveHours, 11.2);
});

/* ── 幂等 ─────────────────────────────────────────────────────────────── */

test('POST /api/sessions 幂等：同 opId 重复提交返回首次 serverSeq', async () => {
  const payload = { opId: 'op-session-1', taskId: 't2', durationMin: 90, completion: 1 };
  const a = await call('POST', '/api/sessions', payload);
  assert.equal(a.status, 200);
  assert.equal(a.body.ok, true);
  assert.equal(typeof a.body.serverSeq, 'number');

  const b = await call('POST', '/api/sessions', payload);
  assert.equal(b.status, 200);
  assert.equal(b.body.ok, true);
  assert.equal(b.body.serverSeq, a.body.serverSeq);
});

test('POST /api/sync/ops 幂等：同 opId 重复提交不产生新 seq', async () => {
  const ops = [{ opId: 'op-sync-1', entity: 'task', entityId: 't3', field: 'status', value: 'scheduled', clientTs: 100 }];
  const a = await call('POST', '/api/sync/ops', { ops: ops });
  assert.equal(a.status, 200);
  assert.deepEqual(a.body.accepted, ['op-sync-1']);
  const seqA = a.body.serverSeq;

  const b = await call('POST', '/api/sync/ops', { ops: ops });
  assert.equal(b.status, 200);
  assert.deepEqual(b.body.accepted, ['op-sync-1']);
  assert.equal(b.body.serverSeq, seqA);

  /* 同一 opId 只在同步流里出现一次 */
  const s = await call('GET', '/api/sync?since=0');
  const hits = s.body.ops.filter((o) => o.opId === 'op-sync-1');
  assert.equal(hits.length, 1);
});

test('GET /api/sync?since=N 按 seq 升序返回且 hasMore 正确', async () => {
  const ops = [
    { opId: 'op-seq-1', entity: 'task', entityId: 't4', field: 'status', value: 'scheduled', clientTs: 200 },
    { opId: 'op-seq-2', entity: 'task', entityId: 't4', field: 'status', value: 'running', clientTs: 201 },
    { opId: 'op-seq-3', entity: 'task', entityId: 't4', field: 'status', value: 'done', clientTs: 202 }
  ];
  const a = await call('POST', '/api/sync/ops', { ops: ops });
  assert.equal(a.status, 200);
  assert.deepEqual(a.body.accepted, ['op-seq-1', 'op-seq-2', 'op-seq-3']);

  const all = await call('GET', '/api/sync?since=0');
  assert.equal(all.status, 200);
  const seqs = all.body.ops.map((o) => o.serverSeq);
  assert.deepEqual(seqs, seqs.slice().sort((x, y) => x - y));
  assert.equal(all.body.hasMore, false);

  /* since 之后只返回更新的 */
  const tail = await call('GET', '/api/sync?since=' + seqs[seqs.length - 2]);
  assert.equal(tail.body.ops.length, 1);
  assert.equal(tail.body.ops[0].opId, 'op-seq-3');
  assert.equal(tail.body.serverSeq, seqs[seqs.length - 1]);
  assert.equal(tail.body.hasMore, false);

  /* 分页 */
  const page = await call('GET', '/api/sync?since=0&limit=2');
  assert.equal(page.body.ops.length, 2);
  assert.equal(page.body.hasMore, true);
});

/* ── 字段级合并规则 ───────────────────────────────────────────────────── */

test('同步合并：状态类最后写入优先', async () => {
  await call('POST', '/api/sync/ops', {
    ops: [{ opId: 'm-status-1', entity: 'task', entityId: 't4', field: 'status', value: 'running', clientTs: 1000 }]
  });
  await call('POST', '/api/sync/ops', {
    ops: [{ opId: 'm-status-2', entity: 'task', entityId: 't4', field: 'status', value: 'done', clientTs: 2000 }]
  });
  const model = memory.getModel();
  const t4 = model.tasks.find((t) => t.id === 't4');
  assert.equal(t4.status, 'done');
});

test('同步合并：计数类求和 / 取最大值', async () => {
  await call('POST', '/api/sync/ops', {
    ops: [{ opId: 'm-count-1', entity: 'task', entityId: 't1', field: 'sessionCount', value: 1, clientTs: 1000 }]
  });
  await call('POST', '/api/sync/ops', {
    ops: [{ opId: 'm-count-2', entity: 'task', entityId: 't1', field: 'sessionCount', value: 2, clientTs: 1100 }]
  });
  await call('POST', '/api/sync/ops', {
    ops: [{ opId: 'm-count-3', entity: 'task', entityId: 't1', field: 'actual', value: 70, clientTs: 1000 }]
  });
  await call('POST', '/api/sync/ops', {
    ops: [{ opId: 'm-count-4', entity: 'task', entityId: 't1', field: 'actual', value: 50, clientTs: 1100 }]
  });
  const model = memory.getModel();
  assert.equal(model.tasks.find((t) => t.id === 't1').sessionCount, 3);
  assert.equal(model.tasks.find((t) => t.id === 't1').actual, 70);
});

test('同步合并：删除类墓碑优先且不可翻转', async () => {
  await call('POST', '/api/sync/ops', {
    ops: [{ opId: 'm-del-1', entity: 'task', entityId: 't3', field: 'deleted', value: true, clientTs: 1000 }]
  });
  await call('POST', '/api/sync/ops', {
    ops: [{ opId: 'm-del-2', entity: 'task', entityId: 't3', field: 'deleted', value: false, clientTs: 2000 }]
  });
  const model = memory.getModel();
  assert.equal(model.tasks.find((t) => t.id === 't3').deleted, true);
});

/* ── 错误码 ───────────────────────────────────────────────────────────── */

test('错误：未知接口返回 E2001 / 404', async () => {
  const r = await call('GET', '/api/nope');
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'E2001');
  assert.equal(typeof r.body.error.message, 'string');
});

test('错误：参数缺失返回 E1001 / 400', async () => {
  const r = await call('POST', '/api/feasibility', { weeklyH: 20 });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'E1001');
});

test('错误：单批上行超过 200 条返回 E4002 / 400', async () => {
  const ops = [];
  for (let i = 0; i < 201; i++) {
    ops.push({ opId: 'over-' + i, entity: 'task', entityId: 't1', field: 'status', value: 'x', clientTs: i });
  }
  const r = await call('POST', '/api/sync/ops', { ops: ops });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'E4002');
});

test('错误：非法 since 返回 E1001', async () => {
  const r = await call('GET', '/api/sync?since=abc');
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'E1001');
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
