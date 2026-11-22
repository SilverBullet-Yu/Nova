'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshStore(file) {
  process.env.NOVA_STORE_FILE = file;
  const resolved = require.resolve('../server/store/memory.js');
  delete require.cache[resolved];
  return require(resolved);
}

test('JSON 持久化后重新加载仍保留跨日改期和删除墓碑', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-store-'));
  const file = path.join(dir, 'state.json');
  const first = freshStore(file);
  first.reset();
  first.applyOps('persist-user', [{ opId: 'move-1', entity: 'plan', entityId: 'dayAssign', field: 'moved', clientTs: 10, value: { taskId: 't1', day: '三' } }]);
  first.applyOps('persist-user', [{ opId: 'delete-1', entity: 'session', entityId: 's1', field: 'deleted', clientTs: 10, value: true }]);
  const second = freshStore(file);
  assert.equal(second.getState('persist-user').seed.dayAssign.t1, '三');
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'))['persist-user'];
  assert.equal(persisted.entities.session.s1.deleted.tombstone, true);
  second.applyOps('persist-user', [{ opId: 'undelete-1', entity: 'session', entityId: 's1', field: 'deleted', clientTs: 99, value: false }]);
  const afterUndelete = JSON.parse(fs.readFileSync(file, 'utf8'))['persist-user'];
  assert.equal(afterUndelete.entities.session.s1.deleted.tombstone, true);
});

test('重排超过规模上限时明确拒绝而不修改任务', () => {
  const replan = require('../shared/engine/replan.js').replan;
  const tasks = Array.from({ length: 501 }, (_, i) => ({ id: 't' + i, est: 30, weight: 0.5 }));
  assert.throws(() => replan({ tasks, week: [{ date: '一', minutes: 0, buffer: 60, capacity: 300 }], params: { maxTasks: 500 } }), /规模|上限|limit/i);
});
