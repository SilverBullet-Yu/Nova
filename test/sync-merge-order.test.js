'use strict';
require('./isolate-store').isolateStore();

const test = require('node:test');
const assert = require('node:assert/strict');
const memory = require('../server/store/memory.js');

const userId = 'sync-merge-order';
test.beforeEach(() => memory.reset());

function sessionOp(opId, id, clientTs) {
  return { opId, entity: 'session', entityId: 't1', field: 'recorded', clientTs,
    value: { id, taskId: 't1', minutes: 10, status: 'done', planVersion: 'plan-test' } };
}

function moveOp(opId, taskId, day, clientTs) {
  return { opId, entity: 'plan', entityId: 'dayAssign', field: 'moved',
    value: { taskId, day }, clientTs };
}

function model() {
  return memory.getState(userId).seed;
}

test('同任务不同 session 逆序到达均保留完整记录（跨批次）', () => {
  const newer = sessionOp('session-newer', 's-newer', 200);
  const older = sessionOp('session-older', 's-older', 100);
  memory.applyOps(userId, [newer]);
  memory.applyOps(userId, [older]);
  assert.deepEqual(model().sessions, [newer.value, older.value]);
});

test('同 session 同 op 重试幂等，不同 op/时间戳也不重复或覆盖', () => {
  const first = sessionOp('first', 's-one', 200);
  const result = memory.applyOps(userId, [first]);
  assert.deepEqual(memory.applyOps(userId, [first]), result);
  assert.equal(memory.getSeq(userId), result.serverSeq);
  memory.applyOps(userId, [
    { ...sessionOp('older-copy', 's-one', 100), value: { ...first.value, minutes: 5 } },
    { ...sessionOp('newer-copy', 's-one', 300), value: { ...first.value, minutes: 30 } }
  ]);
  assert.deepEqual(model().sessions, [first.value]);
  assert.equal(memory.getSeq(userId), result.serverSeq + 2);
});

test('无 ID session 按 opId 幂等，旧非对象包装和无 ID 对象形态不变', () => {
  const first = { opId: 'legacy-first', entity: 'session', entityId: 't1',
    field: 'recorded', value: 10, clientTs: 300 };
  const second = { ...first, opId: 'legacy-second', value: 5, clientTs: 200 };
  const third = { ...first, opId: 'legacy-object', value: { taskId: 't1', minutes: 3 }, clientTs: 100 };
  memory.applyOps(userId, [first, second, third]);
  memory.applyOps(userId, [first, second, third]);
  assert.deepEqual(model().sessions, [
    { entityId: 't1', field: 'recorded', value: 10 },
    { entityId: 't1', field: 'recorded', value: 5 },
    third.value
  ]);
});

test('跨 task 逆序改期独立，同 task 旧值拒绝，同时间戳按 seq，回到日撤销', () => {
  memory.applyOps(userId, [
    moveOp('move-t1', 't1', '三', 300),
    moveOp('move-t2', 't2', '二', 100)
  ]);
  assert.equal(model().dayAssign.t1, '三');
  assert.equal(model().dayAssign.t2, '二');
  memory.applyOps(userId, [moveOp('old-t1', 't1', '四', 200)]);
  assert.equal(model().dayAssign.t1, '三');
  memory.applyOps(userId, [moveOp('tie-t2', 't2', '五', 100)]);
  assert.equal(model().dayAssign.t2, '五');
  memory.applyOps(userId, [moveOp('reset-t2', 't2', '日', 200)]);
  assert.equal(Object.hasOwn(model().dayAssign, 't2'), false);
  memory.applyOps(userId, [moveOp('stale-t2', 't2', '六', 150)]);
  assert.equal(Object.hasOwn(model().dayAssign, 't2'), false);
  assert.equal(model().dayAssign.t1, '三');
});

test('max 首次读取业务种子基线，此后仅增不减且不受 clientTs 逆序影响', () => {
  assert.equal(model().tasks.find(t => t.id === 't1').actual, 60);
  const op = { entity: 'task', entityId: 't1', field: 'actual', clientTs: 300 };
  memory.applyOps(userId, [{ ...op, opId: 'max-low', value: 10 }]);
  assert.equal(model().tasks.find(t => t.id === 't1').actual, 60);
  memory.applyOps(userId, [{ ...op, opId: 'max-high', value: 90, clientTs: 200 }]);
  memory.applyOps(userId, [{ ...op, opId: 'max-later-low', value: 20, clientTs: 400 }]);
  assert.equal(model().tasks.find(t => t.id === 't1').actual, 90);
});

test('无业务基线的 max 仍从 0 开始，sum 保持增量累加及 opId 幂等', () => {
  const op = { entity: 'task', entityId: 't2', clientTs: 300 };
  const sum = { ...op, opId: 'sum-first', field: 'count', value: 2 };
  memory.applyOps(userId, [
    { ...op, opId: 'max-negative', field: 'actual', value: -5 }, sum,
    { ...sum, opId: 'sum-second', value: 3, clientTs: 100 }, sum
  ]);
  const task = model().tasks.find(t => t.id === 't2');
  assert.equal(task.actual, 0);
  assert.equal(task.count, 5);
});

test('旧 session 计数和墓碑字段仍使用原合并策略及包装', () => {
  const op = { entity: 'session', entityId: 't1', clientTs: 100 };
  memory.applyOps(userId, [
    { ...op, opId: 'count-one', field: 'count', value: 2 },
    { ...op, opId: 'count-two', field: 'count', value: 3, clientTs: 50 },
    { ...op, opId: 'delete', field: 'deleted', value: true },
    { ...op, opId: 'undelete', field: 'deleted', value: false, clientTs: 200 }
  ]);
  assert.deepEqual(model().sessions, [
    { entityId: 't1', field: 'count', value: 2 },
    { entityId: 't1', field: 'count', value: 5 },
    { entityId: 't1', field: 'deleted', value: true }
  ]);
});

test('session ID 去重按用户隔离，max 不修改共享种子', () => {
  const op = sessionOp('shared-op', 'shared-session', 100);
  memory.applyOps(userId, [op, { opId: 'increase', entity: 'task', entityId: 't1', field: 'actual', value: 100 }]);
  memory.applyOps('other-user', [op]);
  assert.deepEqual(memory.getState('other-user').seed.sessions, [op.value]);
  assert.equal(memory.getState('other-user').seed.tasks.find(t => t.id === 't1').actual, 60);
});
