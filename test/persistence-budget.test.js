'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, spawn } = require('node:child_process');

function freshStore(file, partitioned = false) {
  process.env.NOVA_STORE_FILE = file;
  if (partitioned) process.env.NOVA_STORE_PARTITIONED = '1';
  else delete process.env.NOVA_STORE_PARTITIONED;
  const store = require('../server/store/memory.js');
  store.setStoreFile(file, partitioned);
  store.reload();
  return store;
}

function adminCli(file, args, partitioned = true) {
  const env = { ...process.env, NOVA_STORE_FILE: file, NOVA_ADMIN_BACKUP_DIR: path.join(__dirname, '..', '.tmp') };
  if (partitioned) env.NOVA_STORE_PARTITIONED = '1';
  else delete env.NOVA_STORE_PARTITIONED;
  return spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'server-data-admin.js'), ...args], {
    encoding: 'utf8', env
  });
}

test('分区 manifest 提交前校验所有引用文件，未变化文件缺失也拒绝', () => {
  const file = isolatedFile();
  const store = seedPartitioned(file);
  store.applyOps('v', [{ opId: 'v1', entity: 'user', entityId: 'v', field: 'name', value: 'V', clientTs: 1 }]);
  const manifestPath = file + '.manifest.json';
  const before = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(before);
  fs.rmSync(path.join(file + '.parts', manifest.partitions.v.file));
  assert.throws(() => store.applyOps('u', [{ opId: 'u2', entity: 'user', entityId: 'u', field: 'name', value: 'U2', clientTs: 2 }]), /持久化文件损坏|文件缺失/);
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), before);
});

test('求和溢出整笔拒绝且不把 Infinity 持久化为 null', () => {
  const file = isolatedFile();
  const store = freshStore(file);
  store.applyOps('sum-user', [{ opId: 's1', entity: 'user', entityId: 'u', field: 'count', value: 1e308, clientTs: 1 }]);
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => store.applyOps('sum-user', [{ opId: 's2', entity: 'user', entityId: 'u', field: 'count', value: 1e308, clientTs: 2 }]), /有限数值/);
  assert.equal(store.getState('sum-user').seed.user.count, 1e308);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

for (const partitioned of [false, true]) {
  test((partitioned ? 'partitioned' : 'legacy') + ' 持久化字节预算超限时整笔回滚且不写新 parts', t => {
    const previous = process.env.NOVA_STORE_MAX_BYTES;
    process.env.NOVA_STORE_MAX_BYTES = String(64 * 1024);
    t.after(() => {
      if (previous === undefined) delete process.env.NOVA_STORE_MAX_BYTES;
      else process.env.NOVA_STORE_MAX_BYTES = previous;
    });
    const file = isolatedFile();
    const store = freshStore(file, partitioned);
    store.reset();
    store.applyOps('budget-user', [{ opId: 'name', entity: 'user', entityId: 'u', field: 'name', value: '基线', clientTs: 1 }]);
    const beforeStore = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    const beforeManifest = partitioned ? fs.readFileSync(file + '.manifest.json', 'utf8') : null;
    const beforeParts = partitioned ? partsSnapshot(file) : null;
    assert.throws(() => store.applyOps('budget-user', [
      { opId: 'large', entity: 'user', entityId: 'u', field: 'name', value: 'x'.repeat(70 * 1024), clientTs: 2 }
    ]), /持久化字节预算不足/);
    assert.equal(store.getState('budget-user').seed.user.name, '基线');
    if (partitioned) {
      assert.equal(fs.readFileSync(file + '.manifest.json', 'utf8'), beforeManifest);
      assert.deepEqual(partsSnapshot(file), beforeParts);
    } else {
      assert.equal(fs.readFileSync(file, 'utf8'), beforeStore);
    }
  });
}

test('partitioned 首次写入预算失败不留半提交状态，恢复预算后可重试', t => {
  const previous = process.env.NOVA_STORE_MAX_BYTES;
  process.env.NOVA_STORE_MAX_BYTES = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.NOVA_STORE_MAX_BYTES;
    else process.env.NOVA_STORE_MAX_BYTES = previous;
  });
  const file = isolatedFile();
  const store = freshStore(file, true);
  const op = { opId: 'first-budget', entity: 'user', entityId: 'u', field: 'name', value: '首次写入', clientTs: 1 };
  assert.throws(() => store.applyOps('first-user', [op]), /持久化字节预算不足/);
  for (const target of [file, file + '.partitioned.json', file + '.manifest.json', file + '.parts', file + '.lock']) {
    assert.equal(fs.existsSync(target), false, target + ' 不应残留');
  }

  process.env.NOVA_STORE_MAX_BYTES = String(64 * 1024);
  store.setStoreFile(file, true);
  store.reload();
  assert.deepEqual(store.applyOps('first-user', [op]).accepted, [op.opId]);
  assert.equal(freshStore(file, true).getState('first-user').seed.user.name, '首次写入');
});

test('匿名分区数量预算拒绝新建第二分区且不改变已有数据', t => {
  const previous = process.env.NOVA_STORE_MAX_PARTITIONS;
  process.env.NOVA_STORE_MAX_PARTITIONS = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.NOVA_STORE_MAX_PARTITIONS;
    else process.env.NOVA_STORE_MAX_PARTITIONS = previous;
  });
  const file = isolatedFile();
  const store = freshStore(file);
  store.reset();
  store.applyOps('first', [{ opId: 'name', entity: 'user', entityId: 'u', field: 'name', value: '保留', clientTs: 1 }]);
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => store.applyOps('second', [{ opId: 'name', entity: 'user', entityId: 'u', field: 'name', value: '拒绝', clientTs: 1 }]), /分区数量超过预算/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(Object.keys(JSON.parse(before)), ['first']);
});

test('测试存储重载复用单例，避免模块实例各自持有独立锁状态', () => {
  const firstFile = isolatedFile();
  const secondFile = isolatedFile();
  const first = freshStore(firstFile);
  first.applyOps('switch-user', [{ opId: 'name', entity: 'user', entityId: 'u', field: 'name', value: '甲', clientTs: 1 }]);
  const second = freshStore(secondFile);
  assert.strictEqual(second, first);
  assert.notEqual(second.getState('switch-user').seed.user.name, '甲');
  const reloaded = freshStore(firstFile);
  assert.strictEqual(reloaded, first);
  assert.equal(reloaded.getState('switch-user').seed.user.name, '甲');
  reloaded.withFreshStoreLock(() => {
    assert.throws(() => reloaded.setStoreFile(secondFile), /存储锁持有期间/);
    assert.throws(() => reloaded.reload(), /存储锁持有期间/);
  });
});

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

function isolatedFile() {
  const root = path.join(__dirname, '..', '.tmp');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'nova-persistence-'));
  return path.join(dir, 'state.json');
}

function failRename() {
  const original = fs.renameSync;
  fs.renameSync = () => {
    const error = new Error('synthetic rename failure');
    error.code = 'EACCES';
    throw error;
  };
  return () => { fs.renameSync = original; };
}

test('持久化失败整笔回滚内存，失败 opId 重试仍可落盘且不重复计数', () => {
  const file = isolatedFile();
  const store = freshStore(file);
  store.reset();
  const userId = 'rollback-user';
  const baseline = store.applyOps(userId, [{ opId: 'baseline', entity: 'user', entityId: 'u', field: 'name', value: '基线', clientTs: 1 }]);
  const beforeFile = fs.readFileSync(file, 'utf8');
  const ops = [
    { opId: 'retry-after-failure', entity: 'user', entityId: 'u', field: 'name', value: '修改', clientTs: 2 },
    { opId: 'retry-after-failure-role', entity: 'user', entityId: 'u', field: 'role', value: '修改角色', clientTs: 2 }
  ];
  const restoreRename = failRename();
  try { assert.throws(() => store.applyOps(userId, ops), /synthetic rename failure/); }
  finally { restoreRename(); }
  assert.equal(store.getState(userId).seed.user.name, '基线');
  assert.equal(store.getState(userId).seed.user.role, undefined);
  assert.equal(store.getSeq(userId), baseline.serverSeq);
  assert.equal(fs.readFileSync(file, 'utf8'), beforeFile);
  assert.deepEqual(store.applyOps(userId, ops).accepted, ops.map(op => op.opId));
  assert.equal(store.getSeq(userId), baseline.serverSeq + ops.length);
  const reloaded = freshStore(file);
  assert.equal(reloaded.getState(userId).seed.user.name, '修改');
  assert.equal(reloaded.getState(userId).seed.user.role, '修改角色');
  assert.equal(reloaded.getSeq(userId), baseline.serverSeq + ops.length);
});

test('重置持久化失败时保留全部分区，恢复后可再次重置', () => {
  const file = isolatedFile();
  const store = freshStore(file);
  store.reset();
  const userId = 'reset-rollback-user';
  const baseline = store.applyOps(userId, [{ opId: 'baseline', entity: 'user', entityId: 'u', field: 'name', value: '保留', clientTs: 1 }]);
  const beforeFile = fs.readFileSync(file, 'utf8');
  const restoreRename = failRename();
  try { assert.throws(() => store.reset(), /synthetic rename failure/); }
  finally { restoreRename(); }
  assert.equal(store.getState(userId).seed.user.name, '保留');
  assert.equal(store.getSeq(userId), baseline.serverSeq);
  assert.equal(fs.readFileSync(file, 'utf8'), beforeFile);
  store.reset();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {});
});

test('改期合并桶也整笔回滚，不被失败事务的较新时间戳污染', () => {
  const file = isolatedFile();
  const store = freshStore(file);
  store.reset();
  const userId = 'move-rollback-user';
  const move = (opId, day, clientTs) => ({ opId, entity: 'plan', entityId: 'dayAssign', field: 'moved', clientTs, value: { taskId: 't1', day } });
  store.applyOps(userId, [move('baseline-move', '二', 10)]);
  const restoreRename = failRename();
  try { assert.throws(() => store.applyOps(userId, [move('failed-move', '三', 20)]), /synthetic rename failure/); }
  finally { restoreRename(); }
  assert.equal(store.getState(userId).seed.dayAssign.t1, '二');
  const accepted = store.applyOps(userId, [move('after-rollback', '四', 15)]);
  assert.deepEqual(accepted.accepted, ['after-rollback']);
  assert.equal(store.getState(userId).seed.dayAssign.t1, '四');
});

test('重排与排程记录持久化失败时回滚记录、序号和计划基线', () => {
  const file = isolatedFile();
  const store = freshStore(file);
  store.reset();
  const userId = 'record-rollback-user';
  store.applyOps(userId, [{ opId: 'baseline', entity: 'user', entityId: 'u', field: 'name', value: '基线', clientTs: 1 }]);
  const beforeFile = fs.readFileSync(file, 'utf8');
  const result = { strategies: [], diff: [], loadDelta: 0, accepted: true, verdict: 'needsConfirmation', snapshot: {}, nextTasks: [], nextWeek: [] };
  const constraints = { version: 'v1', locks: {}, params: {} };
  let restoreRename = failRename();
  try { assert.throws(() => store.recordReplan(userId, result, constraints), /synthetic rename failure/); }
  finally { restoreRename(); }
  assert.equal(store.getLatestReplan(userId), null);
  assert.equal(store.getState(userId).planBaseline, null);
  assert.equal(fs.readFileSync(file, 'utf8'), beforeFile);
  const record = store.recordReplan(userId, result, constraints);
  assert.equal(record.id, 'rr_1');
  const baseline = store.getState(userId).planBaseline;
  const afterReplan = fs.readFileSync(file, 'utf8');
  restoreRename = failRename();
  try { assert.throws(() => store.recordSchedule(userId, 'v2', { blocks: [] }), /synthetic rename failure/); }
  finally { restoreRename(); }
  assert.deepEqual(store.getState(userId).planBaseline, baseline);
  assert.equal(fs.readFileSync(file, 'utf8'), afterReplan);
});

test('原子替换前同步临时文件，再执行 rename', () => {
  const file = isolatedFile();
  const store = freshStore(file);
  store.reset();
  const events = [];
  const originalFsync = fs.fsyncSync;
  const originalRename = fs.renameSync;
  fs.fsyncSync = fd => { events.push('fsync'); return originalFsync(fd); };
  fs.renameSync = (from, to) => {
    const result = originalRename(from, to);
    events.push('rename');
    return result;
  };
  try {
    store.applyOps('fsync-user', [{ opId: 'fsync-op', entity: 'user', entityId: 'u', field: 'name', value: '同步', clientTs: 1 }]);
  } finally {
    fs.fsyncSync = originalFsync;
    fs.renameSync = originalRename;
  }
  assert.deepEqual(events, ['fsync', 'fsync', 'rename']);
});

for (const [layout, partitioned] of [['legacy', false], ['partitioned', true]]) {
  test(layout + ' 临时文件使用随机名与 wx，拒绝预置符号链接且不删除他人路径', () => {
    const file = isolatedFile();
    const store = freshStore(file, partitioned);
    store.reset();
    store.applyOps('temp-user', [
      { opId: 'baseline', entity: 'user', entityId: 'u', field: 'name', value: '基线', clientTs: 1 }
    ]);
    const beforeFile = partitioned ? fs.readFileSync(file + '.manifest.json', 'utf8') : fs.readFileSync(file, 'utf8');
    const victim = path.join(path.dirname(file), 'temp-victim');
    fs.mkdirSync(victim);
    const originalWrite = fs.writeFileSync;
    const tempPaths = [];
    fs.writeFileSync = function (target, ...args) {
      if (typeof target === 'string' && target.endsWith('.tmp')) {
        tempPaths.push(target);
        fs.symlinkSync(victim, target, 'junction');
      }
      return originalWrite(target, ...args);
    };
    let failure = null;
    try {
      store.applyOps('temp-user', [
        { opId: 'after-link', entity: 'user', entityId: 'u', field: 'name', value: '新值', clientTs: 2 }
      ]);
    } catch (error) {
      failure = error;
    } finally {
      fs.writeFileSync = originalWrite;
    }
    assert.equal(failure && failure.code, 'EEXIST');
    assert.equal(tempPaths.length, 1);
    const suffix = path.basename(tempPaths[0]).split('.json.').pop();
    assert.match(suffix, /^[0-9]+\.[0-9a-f]{32}\.tmp$/);
    assert.equal(fs.lstatSync(tempPaths[0]).isSymbolicLink(), true);
    assert.deepEqual(fs.readdirSync(victim), []);
    assert.equal(partitioned ? fs.readFileSync(file + '.manifest.json', 'utf8') : fs.readFileSync(file, 'utf8'), beforeFile);

    store.applyOps('temp-user', [
      { opId: 'after-link', entity: 'user', entityId: 'u', field: 'name', value: '新值', clientTs: 2 }
    ]);
    assert.equal(freshStore(file, partitioned).getState('temp-user').seed.user.name, '新值');
  });
}

for (const [label, raw] of [
  ['JSON null', 'null'],
  ['JSON 数组', '[]'],
  ['分区为 null', '{"persist-user":null}'],
  ['任务状态为数组', '{"persist-user":{"seq":88123,"state":[],"entities":{}}}']
]) {
  test('持久化结构损坏时拒绝启动且不覆盖原文件：' + label, () => {
    const file = isolatedFile();
    fs.writeFileSync(file, raw, 'utf8');
    assert.throws(() => freshStore(file), /持久化文件损坏/);
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
  });
}

test('新分区首次持久化失败时不留下未落盘的 seed 分区', () => {
  const file = isolatedFile();
  const store = freshStore(file);
  store.reset();
  const before = fs.readFileSync(file, 'utf8');
  const restoreRename = failRename();
  try { assert.throws(() => store.applyOps('new-user', [{ opId: 'first', entity: 'user', entityId: 'u', field: 'name', value: '新用户', clientTs: 1 }]), /synthetic rename failure/); }
  finally { restoreRename(); }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  const accepted = store.applyOps('new-user', [{ opId: 'first', entity: 'user', entityId: 'u', field: 'name', value: '新用户', clientTs: 1 }]);
  assert.deepEqual(accepted.accepted, ['first']);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))['new-user'].state.user.name, '新用户');
});

test('withFreshStoreLock 在锁内重读最新存储，避免 CLI 使用过期快照', () => {
  const file = isolatedFile();
  const first = freshStore(file);
  first.reset();
  first.applyOps('lock-user', [{ opId: 'name', entity: 'user', entityId: 'u', field: 'name', value: '旧值', clientTs: 1 }]);
  const stale = freshStore(file);
  first.applyOps('lock-user', [{ opId: 'name-new', entity: 'user', entityId: 'u', field: 'name', value: '新值', clientTs: 2 }]);
  const seen = stale.withFreshStoreLock(() => stale.exportUserData('lock-user').data.state.user.name);
  assert.equal(seen, '新值');
  assert.equal(fs.existsSync(file + '.lock'), false);
});

test('锁只由 owner token 释放，公开读取不退回旧缓存', () => {
  const file = isolatedFile();
  const store = freshStore(file);
  store.reset();
  store.applyOps('cache-user', [{ opId: 'name', entity: 'user', entityId: 'u', field: 'name', value: '缓存值', clientTs: 1 }]);
  store.withFreshStoreLock(() => {
    const lockPath = file + '.lock';
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    lock.token = 'other-owner';
    fs.writeFileSync(lockPath, JSON.stringify(lock), 'utf8');
  });
  assert.equal(fs.existsSync(file + '.lock'), true);
  fs.rmSync(file + '.lock', { force: true });
  fs.writeFileSync(file, '{broken', 'utf8');
  assert.throws(() => store.withFreshStoreLock(() => {}), /持久化文件损坏/);
  assert.throws(() => store.getState('cache-user'), /持久化文件损坏/);
});

test('无法证明归属的锁不会被等待者删除，超时明确要求人工核实', async () => {
  const file = isolatedFile();
  const store = freshStore(file);
  store.reset();
  const lockPath = file + '.lock';
  const lockText = JSON.stringify({ pid: 99999999, at: 1, token: 'dead' });
  fs.writeFileSync(lockPath, lockText, 'utf8');
  const previous = process.env.NOVA_STORE_LOCK_TIMEOUT_MS;
  process.env.NOVA_STORE_LOCK_TIMEOUT_MS = '25';
  try {
    assert.throws(() => store.applyOps('stale-lock-user', [
      { opId: 'name', entity: 'user', entityId: 'u', field: 'name', value: 'ok', clientTs: 1 }
    ]), error => error.code === 'STORE_LOCK_TIMEOUT' && /人工核实/.test(error.message));
    assert.equal(fs.readFileSync(lockPath, 'utf8'), lockText);

    const child = spawn(process.execPath, ['-e', [
      "const store = require(process.argv[1]);",
      "try { store.applyOps('waiting-user', []); }",
      "catch (error) { process.stdout.write(JSON.stringify({ code: error.code, message: error.message })); }"
    ].join('\n'), require.resolve('../server/store/memory.js')], {
      env: { ...process.env, NOVA_STORE_FILE: file, NOVA_STORE_LOCK_TIMEOUT_MS: '40' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const waiters = [child, spawn(process.execPath, ['-e', [
      "const store = require(process.argv[1]);",
      "try { store.applyOps('waiting-user-2', []); }",
      "catch (error) { process.stdout.write(JSON.stringify({ code: error.code, message: error.message })); }"
    ].join('\n'), require.resolve('../server/store/memory.js')], {
      env: { ...process.env, NOVA_STORE_FILE: file, NOVA_STORE_LOCK_TIMEOUT_MS: '40' },
      stdio: ['ignore', 'pipe', 'pipe']
    })];
    const results = await Promise.all(waiters.map(waiter => new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      waiter.stdout.on('data', chunk => { stdout += chunk; });
      waiter.stderr.on('data', chunk => { stderr += chunk; });
      waiter.on('error', reject);
      waiter.on('close', code => resolve({ code, stdout, stderr }));
    })));
    for (const result of results) {
      assert.equal(result.code, 0, result.stderr);
      const error = JSON.parse(result.stdout);
      assert.equal(error.code, 'STORE_LOCK_TIMEOUT');
      assert.match(error.message, /人工核实/);
    }
    assert.equal(fs.readFileSync(lockPath, 'utf8'), lockText);
  } finally {
    if (previous === undefined) delete process.env.NOVA_STORE_LOCK_TIMEOUT_MS;
    else process.env.NOVA_STORE_LOCK_TIMEOUT_MS = previous;
  }
});

test('rename 提交后目录同步失败只报告耐久性警告，不误判事务回滚', () => {
  const file = isolatedFile();
  const store = freshStore(file);
  store.reset();
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  try {
    store.applyOps('dir-sync-user', [{ opId: 'name', entity: 'user', entityId: 'u', field: 'name', value: '已提交', clientTs: 1 }]);
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
  assert.match(store.getPersistenceWarning(), /目录项同步失败/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))['dir-sync-user'].state.user.name, '已提交');
});

test('并发旧写入不会复活已被另一进程删除的分区', () => {
  const file = isolatedFile();
  const first = freshStore(file);
  first.reset();
  first.applyOps('delete-me', [{ opId: 'name', entity: 'user', entityId: 'u', field: 'name', value: '旧分区', clientTs: 1 }]);
  first.applyOps('keep-me', [{ opId: 'name', entity: 'user', entityId: 'u', field: 'name', value: '保留', clientTs: 1 }]);
  const stale = freshStore(file);
  const backup = first.exportUserData('delete-me');
  first.deleteUserData('delete-me', backup.fingerprint);
  stale.applyOps('keep-me', [{ opId: 'role', entity: 'user', entityId: 'u', field: 'role', value: '新写入', clientTs: 2 }]);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(Object.hasOwn(raw, 'delete-me'), false);
  assert.equal(raw['keep-me'].state.user.role, '新写入');
});

for (const [layout, partitioned] of [['legacy', false], ['partitioned', true]]) {
  test(layout + ' 旧实例公开读取锁内刷新，计划提交按 revision 拒绝覆盖并发更新', () => {
    const file = isolatedFile();
    const first = freshStore(file, partitioned);
    first.reset();
    const baselineSeq = first.applyOps('revision-user', [
      { opId: 'baseline', entity: 'user', entityId: 'u', field: 'name', value: '基线', clientTs: 1 }
    ]).serverSeq;
    const stale = freshStore(file, partitioned);
    const expectedRevision = stale.readSnapshot('revision-user').revision;

    first.applyOps('revision-user', [
      { opId: 'concurrent', entity: 'user', entityId: 'u', field: 'name', value: '并发更新', clientTs: 2 }
    ]);
    first.recordReplan('revision-user', {
      strategies: [], diff: [], loadDelta: 0, accepted: true, verdict: 'ok',
      guards: {}, snapshot: {}, nextTasks: [], nextWeek: []
    }, { version: 'v1', locks: {}, params: {} });

    const state = stale.getState('revision-user');
    assert.equal(state.seed.user.name, '并发更新');
    assert.equal(stale.getSeq('revision-user'), baselineSeq + 1);
    assert.equal(stale.getLatestReplan('revision-user').seq, 1);
    assert.deepEqual(stale.getPlanBaseline('revision-user'), { version: 'v1', stale: false });
    const snapshot = stale.readSnapshot('revision-user');
    assert.equal(snapshot.revision, [snapshot.seq, snapshot.replanSeq, snapshot.planBaseline.version].join(':'));
    assert.deepEqual(snapshot.latestReplan, state.replan);

    const before = first.exportAllData();
    const replanResult = {
      strategies: [], diff: [], loadDelta: 0, accepted: true, verdict: 'ok',
      guards: {}, snapshot: {}, nextTasks: [], nextWeek: []
    };
    assert.throws(() => stale.recordSchedule('revision-user', 'stale-schedule', { blocks: [] }, expectedRevision),
      error => error.code === 'REVISION_CONFLICT' && error.expectedRevision === expectedRevision && error.actualRevision === snapshot.revision);
    assert.throws(() => stale.recordReplan('revision-user', replanResult, { version: 'stale-replan' }, expectedRevision),
      error => error.code === 'REVISION_CONFLICT' && error.expectedRevision === expectedRevision && error.actualRevision === snapshot.revision);
    assert.deepEqual(first.exportAllData(), before);

    stale.recordSchedule('revision-user', 'v2', { blocks: [] }, snapshot.revision);
    const afterSchedule = stale.readSnapshot('revision-user');
    stale.recordReplan('revision-user', replanResult, { version: 'v3' }, afterSchedule.revision);
    const committed = stale.readSnapshot('revision-user');
    assert.equal(committed.planBaseline.version, 'v3');
    assert.equal(committed.replanSeq, 2);
    assert.equal(committed.latestReplan.seq, 2);
  });
}

for (const [label, raw] of [
  ['改期桶为 null', '{"u":{"seq":1,"state":{},"entities":{},"dayAssignWrites":[["t",null]]}}'],
  ['幂等序号为字符串', '{"u":{"seq":1,"state":{},"entities":{},"opIndex":[["x","bad"]]}}'],
  ['实体字段记录缺 value', '{"u":{"seq":1,"state":{},"entities":{"task":{"t":{"done":{}}}}}}'],
  ['实体字段记录缺 clientTs', '{"u":{"seq":1,"state":{},"entities":{"task":{"t":{"done":{"value":true,"seq":1,"tombstone":false}}}}}}'],
  ['实体字段 clientTs 为字符串', '{"u":{"seq":1,"state":{},"entities":{"task":{"t":{"done":{"value":true,"seq":1,"clientTs":"1","tombstone":false}}}}}}'],
  ['实体字段 clientTs 非有限', '{"u":{"seq":1,"state":{},"entities":{"task":{"t":{"done":{"value":true,"seq":1,"clientTs":1e400,"tombstone":false}}}}}}'],
  ['实体字段记录缺 seq', '{"u":{"seq":1,"state":{},"entities":{"task":{"t":{"done":{"value":true,"clientTs":1,"tombstone":false}}}}}}'],
  ['实体字段 seq 非有限', '{"u":{"seq":1,"state":{},"entities":{"task":{"t":{"done":{"value":true,"seq":1e400,"clientTs":1,"tombstone":false}}}}}}'],
  ['实体字段 tombstone 非布尔', '{"u":{"seq":1,"state":{},"entities":{"task":{"t":{"done":{"value":true,"seq":1,"clientTs":1,"tombstone":0}}}}}}'],
  ['改期桶字段记录损坏', '{"u":{"seq":1,"state":{},"entities":{},"dayAssignWrites":[["t",{"moved":{"value":{"day":"三"},"seq":1,"clientTs":1,"tombstone":"false"}}]]}}'],
  ['任务元素为 null', '{"u":{"seq":1,"state":{"tasks":[null]},"entities":{}}}'],
  ['任务元素缺 id', '{"u":{"seq":1,"state":{"tasks":[{}]},"entities":{}}}'],
  ['会话元素为数组', '{"u":{"seq":1,"state":{"sessions":[[]]},"entities":{}}}'],
  ['会话元素为字符串', '{"u":{"seq":1,"state":{"sessions":["bad"]},"entities":{}}}'],
  ['planBaseline 为数组', '{"u":{"seq":1,"state":{},"entities":{},"planBaseline":[]}}'],
  ['分区序号为非整数', '{"u":{"seq":1.5,"state":{},"entities":{}}}']
]) {
  test('持久化深层结构损坏时拒绝启动：' + label, () => {
    const file = isolatedFile();
    fs.writeFileSync(file, raw, 'utf8');
    assert.throws(() => freshStore(file), /持久化文件损坏/);
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
  });
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function assertPrivateFileMode(file) {
  const mode = fs.statSync(file).mode & 0o777;
  if (process.platform === 'win32') {
    /* Windows 只映射可写位；创建参数与 chmod 仍按 0600 执行。 */
    assert.equal(mode & 0o111, 0);
    assert.notEqual(mode & 0o200, 0);
  } else {
    assert.equal(mode, 0o600);
  }
}

function partitionName(userId, contentHash) {
  return sha256(userId) + '-' + contentHash + '.json';
}

function readManifest(file) {
  return JSON.parse(fs.readFileSync(file + '.manifest.json', 'utf8'));
}

function partsSnapshot(file) {
  const dir = file + '.parts';
  if (!fs.existsSync(dir)) return {};
  return Object.fromEntries(fs.readdirSync(dir).sort().map(name => {
    const target = path.join(dir, name);
    const stat = fs.statSync(target);
    return [name, { sha256: sha256(fs.readFileSync(target)), mtimeNs: stat.mtimeNs }];
  }));
}

function seedPartitioned(file) {
  const store = freshStore(file, true);
  store.reset();
  store.applyOps('u', [{ opId: 'baseline', entity: 'user', entityId: 'u', field: 'name', value: '基线', clientTs: 1 }]);
  return store;
}

function rewriteTestPartition(file, manifest, mutate) {
  const entry = manifest.partitions.u;
  const saved = JSON.parse(fs.readFileSync(path.join(file + '.parts', entry.file), 'utf8'));
  mutate(saved);
  const text = JSON.stringify(saved);
  const contentHash = sha256(text);
  const name = partitionName('u', contentHash);
  fs.writeFileSync(path.join(file + '.parts', name), text, 'utf8');
  entry.file = name;
  entry.sha256 = contentHash;
}

function failRenameTarget(target) {
  const original = fs.renameSync;
  const expected = path.resolve(target);
  fs.renameSync = (from, to) => {
    if (path.resolve(String(to)) === expected) {
      const error = new Error('synthetic rename failure');
      error.code = 'EACCES';
      throw error;
    }
    return original(from, to);
  };
  return () => { fs.renameSync = original; };
}

function seedPruneIndex(file, partitioned = false) {
  const store = freshStore(file, partitioned);
  store.reset();
  const userId = 'prune-user';
  const ops = [
    { opId: 'old-count', entity: 'user', entityId: 'u', field: 'count', value: 1, clientTs: 30 },
    { opId: 'middle-move', entity: 'plan', entityId: 'dayAssign', field: 'moved', clientTs: 20, value: { taskId: 't1', day: '三' } },
    { opId: 'new-count', entity: 'user', entityId: 'u', field: 'count', value: 2, clientTs: 10 }
  ];
  store.applyOps(userId, ops);
  store.recordReplan(userId, {
    strategies: [], diff: [], loadDelta: 0, accepted: true, verdict: 'needsConfirmation',
    snapshot: { marker: 'unchanged' }, nextTasks: [], nextWeek: []
  }, { version: 'v1', locks: {}, params: {} });
  return { store, userId, ops };
}

function assertPruneKeepsBusinessData(before, after) {
  for (const field of ['state', 'entities', 'dayAssignWrites', 'replanRecords', 'replanSeq', 'planBaseline', 'seq']) {
    assert.deepEqual(after.data[field], before.data[field], field + ' 不应被 opIndex 回收改变');
  }
}

test('pruneOpIndex 按 serverSeq 保留最新 N 条且不改变业务数据，重载后仍幂等', () => {
  const file = isolatedFile();
  const { store, userId, ops } = seedPruneIndex(file);
  const before = store.exportUserData(userId);
  const result = store.pruneOpIndex(userId, 2, before.fingerprint);
  assert.equal(result.removed, 1);
  assert.equal(result.kept, 2);
  assert.equal(result.fingerprintBefore, before.fingerprint);
  assert.match(result.fingerprintAfter, /^[0-9a-f]{64}$/);
  assert.notEqual(result.fingerprintAfter, result.fingerprintBefore);
  assert.equal(result.serverSeq, before.data.seq);
  const after = store.exportUserData(userId);
  assert.deepEqual(after.data.opIndex, before.data.opIndex.slice(1));
  assertPruneKeepsBusinessData(before, after);

  const reloaded = freshStore(file);
  assert.deepEqual(reloaded.exportUserData(userId), after);
  const retained = reloaded.applyOps(userId, [ops[1]]);
  assert.equal(retained.serverSeq, before.data.opIndex[1][1]);
  assert.equal(reloaded.getSeq(userId), before.data.seq);
  assert.deepEqual(reloaded.exportUserData(userId), after);
});

test('pruneOpIndex 允许 N=0，删除全部索引但持久化业务状态并保持 seq', () => {
  const file = isolatedFile();
  const { store, userId } = seedPruneIndex(file);
  const before = store.exportUserData(userId);
  const result = store.pruneOpIndex(userId, 0, before.fingerprint);
  assert.equal(result.removed, 3);
  assert.equal(result.kept, 0);
  assert.equal(result.serverSeq, before.data.seq);
  const after = store.exportUserData(userId);
  assert.deepEqual(after.data.opIndex, []);
  assertPruneKeepsBusinessData(before, after);
  assert.deepEqual(freshStore(file).exportUserData(userId), after);
});

test('pruneOpIndex 拒绝不存在的用户、非法保留数和错误指纹且不写存储', () => {
  const file = isolatedFile();
  const { store, userId } = seedPruneIndex(file);
  const before = store.exportUserData(userId);
  const beforeFile = fs.readFileSync(file, 'utf8');
  for (const missing of ['missing-user', '', null, undefined]) {
    assert.throws(() => store.pruneOpIndex(missing, 0, before.fingerprint), /用户分区不存在/);
  }
  for (const keepRecent of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', null]) {
    assert.throws(() => store.pruneOpIndex(userId, keepRecent, before.fingerprint), /keepRecent 必须是非负安全整数/);
  }
  for (const fingerprint of [undefined, null, '', '0'.repeat(63), 'g'.repeat(64), 'A'.repeat(64), 123]) {
    assert.throws(() => store.pruneOpIndex(userId, 1, fingerprint), /有效的分区指纹/);
  }
  assert.throws(() => store.pruneOpIndex(userId, 1, '0'.repeat(64)), /分区已变化，opIndex 回收已拒绝/);
  assert.deepEqual(store.exportUserData(userId), before);
  assert.equal(fs.readFileSync(file, 'utf8'), beforeFile);
  assert.equal(fs.existsSync(file + '.lock'), false);
});

test('pruneOpIndex 持久化失败时回滚内存与磁盘，恢复后可重试', () => {
  const file = isolatedFile();
  const { store, userId } = seedPruneIndex(file);
  const before = store.exportUserData(userId);
  const beforeFile = fs.readFileSync(file, 'utf8');
  const restoreRename = failRename();
  try { assert.throws(() => store.pruneOpIndex(userId, 1, before.fingerprint), /synthetic rename failure/); }
  finally { restoreRename(); }
  assert.deepEqual(store.exportUserData(userId), before);
  assert.equal(fs.readFileSync(file, 'utf8'), beforeFile);
  assert.equal(fs.existsSync(file + '.lock'), false);
  const retried = store.pruneOpIndex(userId, 1, before.fingerprint);
  assert.equal(retried.removed, 2);
  assert.equal(freshStore(file).exportUserData(userId).data.opIndex.length, 1);
});

test('partitioned pruneOpIndex 的 manifest 提交失败时回滚，不切换当前分区', () => {
  const file = isolatedFile();
  const { store, userId } = seedPruneIndex(file, true);
  const before = store.exportUserData(userId);
  const beforeManifest = fs.readFileSync(file + '.manifest.json', 'utf8');
  const currentFile = readManifest(file).partitions[userId].file;
  const restoreRename = failRenameTarget(file + '.manifest.json');
  try { assert.throws(() => store.pruneOpIndex(userId, 1, before.fingerprint), /synthetic rename failure/); }
  finally { restoreRename(); }
  assert.deepEqual(store.exportUserData(userId), before);
  assert.equal(fs.readFileSync(file + '.manifest.json', 'utf8'), beforeManifest);
  assert.equal(readManifest(file).partitions[userId].file, currentFile);
  assert.equal(fs.existsSync(file + '.lock'), false);
  const retried = store.pruneOpIndex(userId, 1, before.fingerprint);
  assert.equal(retried.removed, 2);
  assert.notEqual(readManifest(file).partitions[userId].file, currentFile);
  assert.equal(freshStore(file, true).exportUserData(userId).data.opIndex.length, 1);
});

test('显式回收旧 opId 后重试会再次应用，计数类操作可能重复累加', () => {
  const file = isolatedFile();
  const { store, userId, ops } = seedPruneIndex(file);
  const before = store.exportUserData(userId);
  assert.equal(before.data.state.user.count, 3);
  store.pruneOpIndex(userId, 0, before.fingerprint);
  const retried = store.applyOps(userId, [ops[0]]);
  const after = store.exportUserData(userId);
  assert.equal(retried.serverSeq, before.data.seq + 1);
  assert.equal(after.data.state.user.count, 4);
  assert.deepEqual(after.data.opIndex, [[ops[0].opId, before.data.seq + 1]]);
  assert.equal(freshStore(file).getState(userId).seed.user.count, 4);
});

test('legacy 模式仍只写单 JSON，freshStore 默认显式关闭 partitioned', () => {
  const file = isolatedFile();
  process.env.NOVA_STORE_PARTITIONED = '1';
  const store = freshStore(file);
  store.reset();
  store.applyOps('legacy-user', [{ opId: 'name', entity: 'user', entityId: 'u', field: 'name', value: '旧布局', clientTs: 1 }]);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))['legacy-user'].state.user.name, '旧布局');
  assert.equal(fs.existsSync(file + '.manifest.json'), false);
  assert.equal(fs.existsSync(file + '.parts'), false);
  assert.equal(freshStore(file).getState('legacy-user').seed.user.name, '旧布局');
});

test('检测到分区 manifest 后拒绝静默关闭 partitioned 读取旧 JSON', () => {
  const file = isolatedFile();
  const store = freshStore(file, true);
  store.reset();
  assert.equal(fs.existsSync(file + '.manifest.json'), true);
  assert.throws(() => freshStore(file, false), /NOVA_STORE_PARTITIONED=1/);
});

test('持久化分区模式标记在 manifest 误删后仍拒绝回退旧 JSON', () => {
  const file = isolatedFile();
  seedPartitioned(file);
  const markerPath = file + '.partitioned.json';
  assert.deepEqual(JSON.parse(fs.readFileSync(markerPath, 'utf8')), {
    format: 'nova-store-mode', version: 1, layout: 'partitioned'
  });
  fs.rmSync(file + '.manifest.json');
  fs.writeFileSync(file, '{}', 'utf8');
  assert.throws(() => freshStore(file, false), /NOVA_STORE_PARTITIONED=1/);
  assert.throws(() => freshStore(file, true), /manifest 缺失/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{}');
});

test('分区模式标记损坏时拒绝启动且不覆盖原标记', () => {
  const file = isolatedFile();
  seedPartitioned(file);
  const markerPath = file + '.partitioned.json';
  fs.writeFileSync(markerPath, '{broken', 'utf8');
  assert.throws(() => freshStore(file, true), /模式标记损坏/);
  assert.equal(fs.readFileSync(markerPath, 'utf8'), '{broken');
});

test('legacy 模式不写分区标记，严格备份不拒绝 legacy 容错加载', () => {
  const file = isolatedFile();
  const store = freshStore(file);
  store.reset();
  store.applyOps('legacy', [{ opId: 'name', entity: 'user', entityId: 'u', field: 'name', value: '旧布局', clientTs: 1 }]);
  assert.equal(fs.existsSync(file + '.partitioned.json'), false);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete saved.legacy.planBaseline;
  saved.legacy.entities.user.u.name.extra = 'legacy- tolerated';
  fs.writeFileSync(file, JSON.stringify(saved), 'utf8');
  assert.equal(freshStore(file).getState('legacy').seed.user.name, '旧布局');
  const backup = freshStore(file).exportAllData();
  delete backup.data.legacy.planBaseline;
  assert.throws(() => freshStore(file).verifyStoreBackup(backup), /invalid partition schema/);
});

test('partitioned 往返使用逻辑路径、安全内容寻址文件名和原子 manifest', () => {
  const file = isolatedFile();
  const userId = '../跨目录\\user';
  const store = freshStore(file, true);
  store.reset();
  assert.deepEqual(JSON.parse(fs.readFileSync(file + '.partitioned.json', 'utf8')), {
    format: 'nova-store-mode', version: 1, layout: 'partitioned'
  });
  store.applyOps(userId, [{ opId: 'name', entity: 'user', entityId: 'u', field: 'name', value: '分区值', clientTs: 1 }]);
  const manifest = readManifest(file);
  assert.equal(manifest.format, 'nova-store-manifest');
  assert.equal(manifest.version, 1);
  assert.deepEqual(Object.keys(manifest.partitions), [userId]);
  const entry = manifest.partitions[userId];
  assert.equal(entry.file, partitionName(userId, entry.sha256));
  assert.match(entry.file, /^[0-9a-f]{64}-[0-9a-f]{64}\.json$/);
  assert.equal(entry.seq, store.getSeq(userId));
  const saved = JSON.parse(fs.readFileSync(path.join(file + '.parts', entry.file), 'utf8'));
  assert.equal(saved.userId, userId);
  assert.equal(saved.state.user.name, '分区值');
  assert.equal(fs.existsSync(file), false);
  const reloaded = freshStore(file, true);
  assert.equal(reloaded.getState(userId).seed.user.name, '分区值');
  assert.equal(reloaded.getSeq(userId), entry.seq);
});

test('partitioned 只写内容 hash 变化的分区，未变文件 mtime 与 hash 不变且旧版本保留', () => {
  const file = isolatedFile();
  const store = freshStore(file, true);
  store.reset();
  store.applyOps('a', [{ opId: 'name', entity: 'user', entityId: 'u', field: 'name', value: 'A1', clientTs: 1 }]);
  store.applyOps('b', [{ opId: 'name', entity: 'user', entityId: 'u', field: 'name', value: 'B1', clientTs: 1 }]);
  const beforeManifest = readManifest(file);
  const beforeParts = partsSnapshot(file);
  const changed = { opId: 'name-2', entity: 'user', entityId: 'u', field: 'name', value: 'A2', clientTs: 2 };
  store.applyOps('a', [changed]);
  const afterManifest = readManifest(file);
  const afterParts = partsSnapshot(file);
  assert.notEqual(afterManifest.partitions.a.file, beforeManifest.partitions.a.file);
  assert.equal(afterManifest.partitions.b.file, beforeManifest.partitions.b.file);
  assert.deepEqual(afterParts[beforeManifest.partitions.b.file], beforeParts[beforeManifest.partitions.b.file]);
  assert.deepEqual(afterParts[beforeManifest.partitions.a.file], beforeParts[beforeManifest.partitions.a.file]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(file + '.parts', beforeManifest.partitions.a.file), 'utf8')).state.user.name, 'A1');
  assert.equal(JSON.parse(fs.readFileSync(path.join(file + '.parts', afterManifest.partitions.a.file), 'utf8')).state.user.name, 'A2');
  const unchangedParts = partsSnapshot(file);
  store.applyOps('a', [changed]);
  assert.deepEqual(partsSnapshot(file), unchangedParts);
});

for (const [label, mutate] of [
  ['manifest 格式错误', manifest => { manifest.format = 'other'; }],
  ['manifest 版本错误', manifest => { manifest.version = 2; }],
  ['manifest userId 不匹配', manifest => {
    const entry = manifest.partitions.u;
    delete manifest.partitions.u;
    manifest.partitions['../u'] = entry;
  }],
  ['分区 file 含路径', manifest => { manifest.partitions.u.file = 'nested/' + manifest.partitions.u.file; }],
  ['分区 file 与内容 hash 不符', manifest => { manifest.partitions.u.file = partitionName('u', '0'.repeat(64)); }],
  ['manifest seq 为字符串', manifest => { manifest.partitions.u.seq = String(manifest.partitions.u.seq); }],
  ['manifest seq 与分区不符', manifest => { manifest.partitions.u.seq += 1; }],
  ['当前分区 sha256 不符', (manifest, file) => {
    fs.appendFileSync(path.join(file + '.parts', manifest.partitions.u.file), '\n', 'utf8');
  }],
  ['当前分区文件缺失', (manifest, file) => {
    const target = path.join(file + '.parts', manifest.partitions.u.file);
    fs.renameSync(target, target + '.missing');
  }],
  ['分区深层结构损坏', (manifest, file) => rewriteTestPartition(file, manifest, saved => { saved.opIndex = [['op', 'bad']]; })],
  ['分区字段记录缺 clientTs', (manifest, file) => rewriteTestPartition(file, manifest, saved => { delete saved.entities.user.u.name.clientTs; })],
  ['分区任务元素结构损坏', (manifest, file) => rewriteTestPartition(file, manifest, saved => { saved.state.tasks = [null]; })],
  ['分区会话元素结构损坏', (manifest, file) => rewriteTestPartition(file, manifest, saved => { saved.state.sessions = ['bad']; })],
  ['分区 payload userId 不符', (manifest, file) => rewriteTestPartition(file, manifest, saved => { saved.userId = 'other'; })]
]) {
  test('partitioned 拒绝启动：' + label, () => {
    const file = isolatedFile();
    seedPartitioned(file);
    const manifest = readManifest(file);
    mutate(manifest, file);
    const manifestText = JSON.stringify(manifest);
    fs.writeFileSync(file + '.manifest.json', manifestText, 'utf8');
    assert.throws(() => freshStore(file, true), /持久化文件损坏/);
    assert.equal(fs.readFileSync(file + '.manifest.json', 'utf8'), manifestText);
  });
}

test('manifest JSON 损坏时优先拒绝，不回退旧 STORE_FILE', () => {
  const file = isolatedFile();
  seedPartitioned(file);
  fs.writeFileSync(file, '{}', 'utf8');
  fs.writeFileSync(file + '.manifest.json', '{', 'utf8');
  assert.throws(() => freshStore(file, true), /持久化文件损坏/);
  assert.equal(fs.readFileSync(file + '.manifest.json', 'utf8'), '{');
});

test('旧 JSON 在 partitioned 模式可读，第一次成功写入再迁移且不覆盖旧文件', () => {
  const file = isolatedFile();
  const legacy = freshStore(file);
  legacy.reset();
  legacy.applyOps('migrate', [{ opId: 'name', entity: 'user', entityId: 'u', field: 'name', value: '迁移前', clientTs: 1 }]);
  const legacyText = fs.readFileSync(file, 'utf8');
  const store = freshStore(file, true);
  assert.equal(store.getState('migrate').seed.user.name, '迁移前');
  assert.equal(fs.existsSync(file + '.manifest.json'), false);
  store.applyOps('migrate', [{ opId: 'role', entity: 'user', entityId: 'u', field: 'role', value: '迁移后', clientTs: 2 }]);
  assert.equal(fs.readFileSync(file, 'utf8'), legacyText);
  assert.equal(readManifest(file).partitions.migrate.seq, store.getSeq('migrate'));
  const reloaded = freshStore(file, true);
  assert.equal(reloaded.getState('migrate').seed.user.name, '迁移前');
  assert.equal(reloaded.getState('migrate').seed.user.role, '迁移后');
});

test('partitioned reset/delete 仅逻辑删除 manifest 条目并保留旧版本文件', () => {
  const file = isolatedFile();
  const store = seedPartitioned(file);
  store.applyOps('other', [{ opId: 'name', entity: 'user', entityId: 'u', field: 'name', value: '其他', clientTs: 1 }]);
  const oldParts = partsSnapshot(file);
  store.reset();
  assert.deepEqual(readManifest(file).partitions, {});
  for (const name of Object.keys(oldParts)) assert.equal(fs.existsSync(path.join(file + '.parts', name)), true);
  const reloaded = freshStore(file, true);
  assert.equal(reloaded.getSyncInventory().totals.partitions, 0);
  reloaded.applyOps('u', [{ opId: 'again', entity: 'user', entityId: 'u', field: 'name', value: '重建', clientTs: 1 }]);
  reloaded.applyOps('other', [{ opId: 'again', entity: 'user', entityId: 'u', field: 'name', value: '其他', clientTs: 1 }]);
  const deletedFile = readManifest(file).partitions.u.file;
  const backup = reloaded.exportUserData('u');
  reloaded.deleteUserData('u', backup.fingerprint);
  assert.deepEqual(Object.keys(readManifest(file).partitions), ['other']);
  assert.equal(fs.existsSync(path.join(file + '.parts', deletedFile)), true);
  const finalStore = freshStore(file, true);
  assert.deepEqual(finalStore.getSyncInventory(true).partitions.map(row => row.userId), ['other']);
});

test('partitioned 首次 manifest 提交失败时清理本次标记和 parts', () => {
  const file = isolatedFile();
  const store = freshStore(file, true);
  const op = { opId: 'first-commit', entity: 'user', entityId: 'u', field: 'name', value: '首次提交', clientTs: 1 };
  const restoreRename = failRenameTarget(file + '.manifest.json');
  try { assert.throws(() => store.applyOps('first-user', [op]), /synthetic rename failure/); }
  finally { restoreRename(); }
  for (const target of [file, file + '.partitioned.json', file + '.manifest.json', file + '.parts', file + '.lock']) {
    assert.equal(fs.existsSync(target), false, target + ' 不应残留');
  }
  assert.deepEqual(store.applyOps('first-user', [op]).accepted, [op.opId]);
  assert.equal(freshStore(file, true).getState('first-user').seed.user.name, '首次提交');
});

test('partitioned manifest 提交失败时回滚内存和磁盘 hash 基线，重试重新落盘', () => {
  const file = isolatedFile();
  const store = seedPartitioned(file);
  const beforeManifest = fs.readFileSync(file + '.manifest.json', 'utf8');
  const beforeParts = partsSnapshot(file);
  const beforeSeq = store.getSeq('u');
  const op = { opId: 'after-failure', entity: 'user', entityId: 'u', field: 'name', value: '修改', clientTs: 2 };
  const restoreRename = failRenameTarget(file + '.manifest.json');
  try { assert.throws(() => store.applyOps('u', [op]), /synthetic rename failure/); }
  finally { restoreRename(); }
  assert.equal(store.getState('u').seed.user.name, '基线');
  assert.equal(store.getSeq('u'), beforeSeq);
  assert.equal(fs.readFileSync(file + '.manifest.json', 'utf8'), beforeManifest);
  const orphan = Object.keys(partsSnapshot(file)).find(name => !Object.hasOwn(beforeParts, name));
  assert.ok(orphan, 'manifest 提交前应留下未提交的内容寻址文件');
  fs.renameSync(path.join(file + '.parts', orphan), path.join(file + '.parts', orphan + '.uncommitted'));
  assert.deepEqual(store.applyOps('u', [op]).accepted, [op.opId]);
  assert.equal(readManifest(file).partitions.u.file, orphan);
  assert.equal(fs.existsSync(path.join(file + '.parts', orphan)), true);
  assert.equal(freshStore(file, true).getState('u').seed.user.name, '修改');
  assert.equal(fs.existsSync(path.join(file + '.parts', Object.keys(beforeParts)[0])), true);
});

test('partitioned 并发旧写不会复活已被删除的分区', () => {
  const file = isolatedFile();
  const first = seedPartitioned(file);
  first.applyOps('keep', [{ opId: 'name', entity: 'user', entityId: 'u', field: 'name', value: '保留', clientTs: 1 }]);
  const stale = freshStore(file, true);
  const backup = first.exportUserData('u');
  first.deleteUserData('u', backup.fingerprint);
  stale.applyOps('keep', [{ opId: 'role', entity: 'user', entityId: 'u', field: 'role', value: '新写入', clientTs: 2 }]);
  const reloaded = freshStore(file, true);
  assert.deepEqual(Object.keys(readManifest(file).partitions), ['keep']);
  assert.equal(reloaded.getState('keep').seed.user.role, '新写入');
});

test('partitioned 模式下 CLI inventory/export/delete 与逻辑删除兼容', () => {
  const file = isolatedFile();
  const store = seedPartitioned(file);
  store.applyOps('other', [{ opId: 'name', entity: 'user', entityId: 'u', field: 'name', value: '其他用户', clientTs: 1 }]);
  const deletedFile = readManifest(file).partitions.u.file;
  const cli = args => adminCli(file, args);
  const inventory = cli(['inventory', '--store', file]);
  assert.equal(inventory.status, 0, inventory.stderr);
  assert.equal(JSON.parse(inventory.stdout).totals.partitions, 2);
  assert.doesNotMatch(inventory.stdout, /基线|其他用户/);
  const exportFile = path.join(path.dirname(file), 'export.json');
  const exported = cli(['export', '--user', 'u', '--out', exportFile, '--store', file]);
  assert.equal(exported.status, 0, exported.stderr);
  assert.equal(JSON.parse(fs.readFileSync(exportFile, 'utf8')).data.state.user.name, '基线');
  const deleteFile = path.join(path.dirname(file), 'delete.json');
  const deleted = cli(['delete', '--user', 'u', '--confirm', 'u', '--out', deleteFile, '--store', file]);
  assert.equal(deleted.status, 0, deleted.stderr);
  assert.deepEqual(Object.keys(readManifest(file).partitions), ['other']);
  assert.equal(fs.existsSync(path.join(file + '.parts', deletedFile)), true);
});

test('partitioned 盘点在锁内重读，只暴露未引用版本元数据且不输出分区内容', () => {
  const file = isolatedFile();
  const first = seedPartitioned(file);
  const oldFile = readManifest(file).partitions.u.file;
  const stale = freshStore(file, true);
  first.applyOps('u', [{ opId: 'new-version', entity: 'user', entityId: 'u', field: 'name', value: '不应出现在盘点中的值', clientTs: 2 }]);
  const currentFile = readManifest(file).partitions.u.file;
  const tempFile = 'interrupted.123.1.tmp';
  fs.writeFileSync(path.join(file + '.parts', tempFile), 'partial', 'utf8');
  const manifestTempFile = path.basename(file + '.manifest.json') + '.123.1.tmp';
  fs.writeFileSync(path.join(path.dirname(file), manifestTempFile), 'partial manifest', 'utf8');

  const inventory = stale.inspectPartitionedFiles();
  assert.deepEqual(inventory.referenced, [currentFile]);
  assert.deepEqual(inventory.orphans.map(row => row.file), [oldFile]);
  assert.deepEqual(inventory.tempFiles, [tempFile, manifestTempFile].sort());
  const oldStat = fs.statSync(path.join(file + '.parts', oldFile));
  assert.equal(inventory.orphans[0].bytes, oldStat.size);
  assert.equal(inventory.orphans[0].mtimeMs, oldStat.mtimeMs);
  assert.doesNotMatch(JSON.stringify(inventory), /不应出现在盘点中的值|基线/);
  assert.equal(fs.existsSync(file + '.lock'), false);
});

test('partitioned compact 默认及 CLI 只读模式均不删除旧版本或临时文件', () => {
  const file = isolatedFile();
  const store = seedPartitioned(file);
  const oldFile = readManifest(file).partitions.u.file;
  store.applyOps('u', [{ opId: 'new-version', entity: 'user', entityId: 'u', field: 'name', value: '新版本', clientTs: 2 }]);
  const tempFile = 'interrupted.123.1.tmp';
  fs.writeFileSync(path.join(file + '.parts', tempFile), 'partial', 'utf8');
  const manifestTempFile = path.basename(file + '.manifest.json') + '.123.1.tmp';
  const manifestTempPath = path.join(path.dirname(file), manifestTempFile);
  fs.writeFileSync(manifestTempPath, 'partial manifest', 'utf8');
  const before = partsSnapshot(file);

  const dryRun = store.compactPartitionedFiles(false);
  assert.equal(dryRun.deleted, 0);
  assert.equal(dryRun.retained, 4);
  assert.equal(dryRun.retainedOrphans, 1);
  assert.equal(dryRun.retainedTempFiles, 2);
  assert.equal(dryRun.persistenceWarning, null);
  assert.deepEqual(partsSnapshot(file), before);
  assert.equal(fs.readFileSync(manifestTempPath, 'utf8'), 'partial manifest');

  const result = adminCli(file, ['compact', '--store', file]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.format, 'nova-partitioned-file-inventory');
  assert.deepEqual(output.referenced, [readManifest(file).partitions.u.file]);
  assert.deepEqual(output.orphans.map(row => row.file), [oldFile]);
  assert.deepEqual(output.tempFiles, [tempFile, manifestTempFile].sort());
  assert.doesNotMatch(result.stdout, /基线|新版本/);
  assert.deepEqual(partsSnapshot(file), before);
  assert.equal(fs.readFileSync(manifestTempPath, 'utf8'), 'partial manifest');
});

test('partitioned purge 先写独占审计，只删未引用 parts 与 .tmp 且当前分区可重载', () => {
  const file = isolatedFile();
  const store = seedPartitioned(file);
  const oldFile = readManifest(file).partitions.u.file;
  store.applyOps('u', [{ opId: 'new-version', entity: 'user', entityId: 'u', field: 'name', value: '当前版本', clientTs: 2 }]);
  const currentFile = readManifest(file).partitions.u.file;
  const currentBefore = partsSnapshot(file)[currentFile];
  const tempFile = 'interrupted.123.1.tmp';
  fs.writeFileSync(path.join(file + '.parts', tempFile), 'partial', 'utf8');
  const manifestTempFile = path.basename(file + '.manifest.json') + '.123.1.tmp';
  const manifestTempPath = path.join(path.dirname(file), manifestTempFile);
  fs.writeFileSync(manifestTempPath, 'partial manifest', 'utf8');
  const unknownFile = 'operator-note.txt';
  fs.writeFileSync(path.join(file + '.parts', unknownFile), 'keep', 'utf8');
  const before = partsSnapshot(file);
  const expectedDelete = [
    { file: oldFile, target: path.join(file + '.parts', oldFile) },
    { file: tempFile, target: path.join(file + '.parts', tempFile) },
    { file: manifestTempFile, target: manifestTempPath }
  ].map(row => {
    const stat = fs.statSync(row.target);
    return { file: row.file, bytes: stat.size, mtimeMs: stat.mtimeMs, sha256: sha256(fs.readFileSync(row.target)) };
  });
  const audit = path.join(path.dirname(file), 'compact-audit.json');

  const wrongConfirm = adminCli(file, ['compact', '--purge', '--confirm', 'wrong', '--out', audit, '--store', file]);
  assert.equal(wrongConfirm.status, 1);
  assert.match(wrongConfirm.stderr, /确认值必须与 purge/);
  assert.equal(fs.existsSync(audit), false);
  assert.deepEqual(partsSnapshot(file), before);
  assert.equal(fs.readFileSync(manifestTempPath, 'utf8'), 'partial manifest');

  const purged = adminCli(file, ['compact', '--purge', '--confirm', 'purge', '--out', audit, '--store', file]);
  assert.equal(purged.status, 0, purged.stderr);
  const output = JSON.parse(purged.stdout);
  assert.equal(output.purged, true);
  assert.equal(output.deleted, 3);
  assert.equal(output.retained, 1);
  assert.deepEqual(output.deletedFiles.sort(), [oldFile, tempFile, manifestTempFile].sort());
  assert.equal(fs.existsSync(path.join(file + '.parts', oldFile)), false);
  assert.equal(fs.existsSync(path.join(file + '.parts', tempFile)), false);
  assert.equal(fs.existsSync(manifestTempPath), false);
  assert.equal(fs.existsSync(path.join(file + '.parts', unknownFile)), true);
  assert.deepEqual(partsSnapshot(file)[currentFile], currentBefore);

  const auditData = JSON.parse(fs.readFileSync(audit, 'utf8'));
  assert.equal(auditData.format, 'nova-partitioned-compaction-audit');
  assert.equal(auditData.status, 'prepared');
  assert.equal(auditData.store, path.resolve(file));
  assert.deepEqual(auditData.referenced, [currentFile]);
  assert.ok(Number.isFinite(Date.parse(auditData.at)));
  assert.deepEqual(auditData.pendingDelete.map(row => row.file).sort(), [oldFile, tempFile, manifestTempFile].sort());
  for (const row of auditData.pendingDelete) {
    const expected = expectedDelete.find(candidate => candidate.file === row.file);
    assert.ok(expected);
    assert.equal(row.bytes, expected.bytes);
    assert.equal(row.mtimeMs, expected.mtimeMs);
    assert.equal(row.sha256, expected.sha256);
    assert.match(row.sha256, /^[0-9a-f]{64}$/);
  }
  const resultData = JSON.parse(fs.readFileSync(audit + '.result.json', 'utf8'));
  assert.equal(resultData.status, 'purged');
  assert.equal(resultData.deleted, 3);
  assert.deepEqual(resultData.referenced, [currentFile]);
  assert.ok(Number.isFinite(Date.parse(resultData.completedAt)));

  const reloaded = freshStore(file, true);
  assert.equal(reloaded.getState('u').seed.user.name, '当前版本');
  assert.deepEqual(reloaded.inspectPartitionedFiles().orphans, []);
  assert.deepEqual(reloaded.inspectPartitionedFiles().tempFiles, []);

  const resultBefore = fs.readFileSync(audit + '.result.json', 'utf8');
  const repeated = adminCli(file, ['compact', '--purge', '--confirm', 'purge', '--out', audit, '--store', file]);
  assert.equal(repeated.status, 1);
  assert.match(repeated.stderr, /拒绝覆盖/);
  assert.equal(fs.readFileSync(audit + '.result.json', 'utf8'), resultBefore);
});

test('partitioned purge 审计写入失败时明确拒绝删除', () => {
  const file = isolatedFile();
  const store = seedPartitioned(file);
  const oldFile = readManifest(file).partitions.u.file;
  store.applyOps('u', [{ opId: 'new-version', entity: 'user', entityId: 'u', field: 'name', value: '新版本', clientTs: 2 }]);
  const before = partsSnapshot(file);
  const audit = path.join(path.dirname(file), 'occupied-audit.json');
  fs.writeFileSync(audit, 'occupied', 'utf8');

  const result = adminCli(file, ['compact', '--purge', '--confirm', 'purge', '--out', audit, '--store', file]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /输出已存在/);
  assert.deepEqual(partsSnapshot(file), before);
  assert.equal(fs.existsSync(path.join(file + '.parts', oldFile)), true);
  assert.equal(fs.existsSync(audit + '.result.json'), false);
});

test('partitioned purge 拒绝把审计写入 parts 目录，避免审计自身被回收', () => {
  const file = isolatedFile();
  const store = seedPartitioned(file);
  const oldFile = readManifest(file).partitions.u.file;
  store.applyOps('u', [{ opId: 'new-version', entity: 'user', entityId: 'u', field: 'name', value: '新版本', clientTs: 2 }]);
  const before = partsSnapshot(file);
  const audit = path.join(file + '.parts', '0'.repeat(64) + '-' + '2'.repeat(64) + '.json');

  const result = adminCli(file, ['compact', '--purge', '--confirm', 'purge', '--out', audit, '--store', file]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /审计路径不得位于分区 parts 目录/);
  assert.equal(fs.existsSync(audit), false);
  assert.deepEqual(partsSnapshot(file), before);
  assert.equal(fs.existsSync(path.join(file + '.parts', oldFile)), true);

  const reservedAudit = path.join(path.dirname(file), path.basename(file + '.manifest.json') + '.999.1.tmp');
  const reserved = adminCli(file, ['compact', '--purge', '--confirm', 'purge', '--out', reservedAudit, '--store', file]);
  assert.equal(reserved.status, 1);
  assert.match(reserved.stderr, /manifest 临时文件名/);
  assert.equal(fs.existsSync(reservedAudit), false);
  assert.deepEqual(partsSnapshot(file), before);
});

test('partitioned purge 拒绝经符号链接父目录把审计写入真实 parts', () => {
  const file = isolatedFile();
  const store = seedPartitioned(file);
  const oldFile = readManifest(file).partitions.u.file;
  store.applyOps('u', [{ opId: 'new-version', entity: 'user', entityId: 'u', field: 'name', value: '新版本', clientTs: 2 }]);
  const alias = path.join(path.dirname(file), 'parts-alias');
  fs.symlinkSync(file + '.parts', alias, 'junction');
  const audit = path.join(alias, 'audit.json');
  const result = adminCli(file, ['compact', '--purge', '--confirm', 'purge', '--out', audit, '--store', file]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /真实父目录不得指向分区 parts/);
  assert.equal(fs.existsSync(audit), false);
  assert.equal(fs.existsSync(path.join(file + '.parts', oldFile)), true);
});

test('partitioned purge 结果审计写入失败时明确报告已回收', () => {
  const file = isolatedFile();
  const store = seedPartitioned(file);
  const oldFile = readManifest(file).partitions.u.file;
  store.applyOps('u', [{ opId: 'new-version', entity: 'user', entityId: 'u', field: 'name', value: '新版本', clientTs: 2 }]);
  const audit = path.join(path.dirname(file), 'result-fail.json');
  fs.writeFileSync(audit + '.result.json', 'occupied', 'utf8');

  const result = adminCli(file, ['compact', '--purge', '--confirm', 'purge', '--out', audit, '--store', file]);
  assert.equal(result.status, 3, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.purged, true);
  assert.equal(output.deleted, 1);
  assert.match(output.auditError, /输出已存在/);
  assert.equal(JSON.parse(fs.readFileSync(audit, 'utf8')).status, 'prepared');
  assert.equal(fs.existsSync(path.join(file + '.parts', oldFile)), false);
  assert.equal(freshStore(file, true).getState('u').seed.user.name, '新版本');
});

test('旧 JSON 模式拒绝 compact，partitioned 缺 manifest 时启动即 fail-closed', () => {
  const legacyFile = isolatedFile();
  const legacy = freshStore(legacyFile, false);
  legacy.reset();
  const legacyBefore = fs.readFileSync(legacyFile, 'utf8');
  assert.throws(() => legacy.inspectPartitionedFiles(), /旧 JSON 模式不提供 compact/);
  assert.throws(() => legacy.compactPartitionedFiles(false), /旧 JSON 模式不提供 compact/);
  const legacyCli = adminCli(legacyFile, ['compact', '--store', legacyFile], false);
  assert.equal(legacyCli.status, 1);
  assert.match(legacyCli.stderr, /旧 JSON 模式不提供 compact/);
  assert.equal(fs.readFileSync(legacyFile, 'utf8'), legacyBefore);

  const missingFile = isolatedFile();
  const orphan = '0'.repeat(64) + '-' + '1'.repeat(64) + '.json';
  fs.mkdirSync(missingFile + '.parts', { recursive: true });
  fs.writeFileSync(path.join(missingFile + '.parts', orphan), '{}', 'utf8');
  assert.throws(() => freshStore(missingFile, true), /manifest 与模式标记缺失/);
  assert.equal(fs.existsSync(path.join(missingFile + '.parts', orphan)), true);
});

function seedBackupStore(file, partitioned = false) {
  const store = freshStore(file, partitioned);
  store.reset();
  store.applyOps('backup-user', [
    { opId: 'name-old', entity: 'user', entityId: 'u', field: 'name', value: '旧版本', clientTs: 1 },
    { opId: 'count', entity: 'user', entityId: 'u', field: 'count', value: 2, clientTs: 2 },
    { opId: 'move', entity: 'plan', entityId: 'dayAssign', field: 'moved', clientTs: 3, value: { taskId: 't1', day: '三' } }
  ]);
  store.applyOps('../备份\\user', [
    { opId: 'other-name', entity: 'user', entityId: 'u', field: 'name', value: '其他分区', clientTs: 1 }
  ]);
  store.recordReplan('backup-user', {
    strategies: [], diff: [], loadDelta: 0, accepted: true, verdict: 'needsConfirmation',
    snapshot: { marker: 'full-backup' }, nextTasks: [], nextWeek: []
  }, { version: 'v1', locks: {}, params: {} });
  store.applyOps('backup-user', [
    { opId: 'name-current', entity: 'user', entityId: 'u', field: 'name', value: '当前版本', clientTs: 4 }
  ]);
  return store;
}

for (const [layout, partitioned] of [['legacy', false], ['partitioned', true]]) {
  test(layout + ' 全库备份锁内重读并恢复到全新目标，业务数据与幂等索引一致', () => {
    const source = isolatedFile();
    const target = isolatedFile();
    const store = seedBackupStore(source, partitioned);
    if (partitioned) {
      const orphan = 'f'.repeat(64) + '-' + 'e'.repeat(64) + '.json';
      fs.writeFileSync(path.join(source + '.parts', orphan), JSON.stringify({ ghost: true }), 'utf8');
      fs.writeFileSync(source, JSON.stringify({ ghost: { state: { user: { name: '孤儿旧 JSON' } } } }), 'utf8');
    }
    const stale = freshStore(source, partitioned);
    store.applyOps('backup-user', [
      { opId: 'after-stale-load', entity: 'user', entityId: 'u', field: 'role', value: '锁内最新', clientTs: 5 }
    ]);
    const manifestBefore = partitioned ? fs.readFileSync(source + '.manifest.json', 'utf8') : null;
    const legacyBefore = fs.existsSync(source) ? fs.readFileSync(source, 'utf8') : null;
    const partsBefore = partitioned ? partsSnapshot(source) : null;

    const backup = stale.exportAllData();
    assert.equal(backup.format, 'nova-store-backup');
    assert.equal(backup.version, 1);
    assert.equal(backup.layout, layout);
    assert.deepEqual(Object.keys(backup.data).sort(), ['../备份\\user', 'backup-user']);
    assert.equal(backup.data['backup-user'].state.user.name, '当前版本');
    assert.equal(backup.data['backup-user'].state.user.role, '锁内最新');
    assert.equal(backup.data['backup-user'].state.user.count, 2);
    assert.equal(backup.data['backup-user'].state.dayAssign.t1, '三');
    assert.equal(backup.data['backup-user'].replanRecords.length, 1);
    assert.ok(backup.data['backup-user'].dayAssignWrites.some(entry => entry[0] === 't1'));
    assert.equal(backup.data['../备份\\user'].state.user.name, '其他分区');
    assert.equal(Object.hasOwn(backup.data, 'ghost'), false);
    assert.equal(fs.existsSync(source + '.lock'), false);
    if (partitioned) {
      assert.equal(fs.readFileSync(source + '.manifest.json', 'utf8'), manifestBefore);
      assert.deepEqual(partsSnapshot(source), partsBefore);
    } else {
      assert.equal(fs.readFileSync(source, 'utf8'), legacyBefore);
    }

    const backupText = JSON.stringify(backup);
    const expectedOpIndex = Object.values(backup.data).reduce((sum, saved) => sum + saved.opIndex.length, 0);
    assert.deepEqual(stale.verifyStoreBackup(backupText), {
      valid: true, layout, partitions: 2, opIndex: expectedOpIndex, bytes: Buffer.byteLength(backupText)
    });
    const imported = freshStore(target, partitioned).importAllData(backupText, layout);
    assert.deepEqual(imported, { imported: true, layout, partitions: 2, opIndex: expectedOpIndex });
    assert.deepEqual(freshStore(target, partitioned).exportAllData(), backup);
    assert.equal(fs.existsSync(target + '.lock'), false);
    if (partitioned) {
      assert.equal(fs.existsSync(target), false);
      assert.equal(fs.existsSync(target + '.manifest.json'), true);
    } else {
      assert.equal(fs.existsSync(target), true);
      assert.equal(fs.existsSync(target + '.manifest.json'), false);
    }

    const restored = freshStore(target, partitioned);
    const beforeRetry = restored.exportAllData();
    const retry = restored.applyOps('backup-user', [
      { opId: 'count', entity: 'user', entityId: 'u', field: 'count', value: 2, clientTs: 2 }
    ]);
    assert.equal(retry.serverSeq, beforeRetry.data['backup-user'].opIndex.find(entry => entry[0] === 'count')[1]);
    assert.deepEqual(restored.exportAllData(), beforeRetry);
  });
}

test('partitioned 拒绝符号链接 parts 目录用于写入或恢复', () => {
  const file = isolatedFile();
  const store = seedBackupStore(file, true);
  const backup = store.exportAllData();
  const realParts = file + '.parts-real';
  fs.renameSync(file + '.parts', realParts);
  fs.symlinkSync(realParts, file + '.parts', 'junction');
  const before = fs.readdirSync(realParts).sort();
  assert.throws(() => store.applyOps('backup-user', [
    { opId: 'after-link', entity: 'user', entityId: 'u', field: 'role', value: '不应写出', clientTs: 10 }
  ]), /分区目录不是普通目录/);
  assert.deepEqual(fs.readdirSync(realParts).sort(), before);

  const target = isolatedFile();
  fs.symlinkSync(realParts, target + '.parts', 'junction');
  assert.throws(() => freshStore(target, true), /manifest 与模式标记缺失|分区目录不是普通目录/);
});

test('verifyStoreBackup 严格拒绝损坏 envelope 与分区且不写存储', () => {
  const file = isolatedFile();
  const store = seedBackupStore(file);
  const beforeFile = fs.readFileSync(file, 'utf8');
  const backup = store.exportAllData();
  const mutations = [
    ['格式', value => { value.format = 'other'; }],
    ['版本', value => { value.version = 2; }],
    ['布局', value => { value.layout = 'other'; }],
    ['数据为数组', value => { value.data = []; }],
    ['额外 envelope 字段', value => { value.exportedAt = new Date().toISOString(); }],
    ['空 userId', value => { value.data[''] = value.data['backup-user']; }],
    ['userId 不符', value => { value.data['backup-user'].userId = 'other'; }],
    ['分区缺 canonical 字段', value => { delete value.data['backup-user'].planBaseline; }],
    ['planBaseline 为数组', value => { value.data['backup-user'].planBaseline = []; }],
    ['planBaseline 为字符串', value => { value.data['backup-user'].planBaseline = 'bad'; }],
    ['分区含额外字段', value => { value.data['backup-user'].extra = true; }],
    ['序号损坏', value => { value.data['backup-user'].seq = 'bad'; }],
    ['opIndex 损坏', value => { value.data['backup-user'].opIndex = [['op', 'bad']]; }],
    ['opIndex 三元组', value => { value.data['backup-user'].opIndex = [['op', 1, 'extra']]; }],
    ['opIndex 重复键', value => { value.data['backup-user'].opIndex = [['op', 1], ['op', 2]]; }],
    ['dayAssignWrites 重复键', value => { value.data['backup-user'].dayAssignWrites = [['t1', {}], ['t1', {}]]; }],
    ['实体字段缺 value', value => { value.data['backup-user'].entities.user.u.name = {}; }],
    ['实体字段缺 clientTs', value => { delete value.data['backup-user'].entities.user.u.name.clientTs; }],
    ['实体字段 seq 损坏', value => { value.data['backup-user'].entities.user.u.name.seq = 'bad'; }],
    ['实体字段 tombstone 损坏', value => { value.data['backup-user'].entities.user.u.name.tombstone = 0; }],
    ['实体字段含额外键', value => { value.data['backup-user'].entities.user.u.name.extra = true; }],
    ['改期桶字段记录损坏', value => { value.data['backup-user'].dayAssignWrites[0][1].moved.clientTs = null; }],
    ['任务元素结构损坏', value => { value.data['backup-user'].state.tasks = [null]; }],
    ['会话元素结构损坏', value => { value.data['backup-user'].state.sessions = [[]]; }],
    ['分区为 null', value => { value.data['backup-user'] = null; }]
  ];
  for (const [label, mutate] of mutations) {
    const damaged = JSON.parse(JSON.stringify(backup));
    mutate(damaged);
    assert.throws(() => store.verifyStoreBackup(damaged), undefined, label);
    assert.throws(() => store.verifyStoreBackup(JSON.stringify(damaged)), undefined, label);
  }
  assert.throws(() => store.verifyStoreBackup('{broken'), /JSON/);
  assert.deepEqual(store.verifyStoreBackup(backup), { valid: true, layout: 'legacy', partitions: 2, opIndex: 5 });
  const undefinedValue = JSON.parse(JSON.stringify(backup));
  undefinedValue.data['backup-user'].state.nonJson = undefined;
  assert.throws(() => store.verifyStoreBackup(undefinedValue), /invalid backup JSON data/);
  const cyclic = JSON.parse(JSON.stringify(backup));
  cyclic.data['backup-user'].state.cycle = cyclic.data['backup-user'].state;
  assert.throws(() => store.verifyStoreBackup(cyclic), /invalid backup JSON data/);
  const nonFinite = JSON.parse(JSON.stringify(backup));
  nonFinite.data['backup-user'].state.nonFinite = NaN;
  assert.throws(() => store.verifyStoreBackup(nonFinite), /invalid backup JSON data/);
  assert.equal(fs.readFileSync(file, 'utf8'), beforeFile);
  assert.equal(fs.existsSync(file + '.lock'), false);
});

test('importAllData 拒绝已存在 STORE_FILE/manifest、布局错误与损坏备份且不覆盖', () => {
  const source = isolatedFile();
  const backup = seedBackupStore(source).exportAllData();
  const existing = isolatedFile();
  const occupied = freshStore(existing);
  occupied.reset();
  occupied.applyOps('occupied', [{ opId: 'name', entity: 'user', entityId: 'u', field: 'name', value: '保留', clientTs: 1 }]);
  const existingBefore = fs.readFileSync(existing, 'utf8');
  assert.throws(() => occupied.importAllData(backup, 'legacy'), /拒绝覆盖/);
  assert.equal(fs.readFileSync(existing, 'utf8'), existingBefore);

  const partitionedBackup = seedBackupStore(isolatedFile(), true).exportAllData();
  const manifestTarget = isolatedFile();
  const partitioned = freshStore(manifestTarget, true);
  partitioned.reset();
  const manifestBefore = fs.readFileSync(manifestTarget + '.manifest.json', 'utf8');
  assert.throws(() => partitioned.importAllData(partitionedBackup, 'partitioned'), /manifest 已存在，拒绝覆盖/);
  assert.equal(fs.readFileSync(manifestTarget + '.manifest.json', 'utf8'), manifestBefore);

  const layoutTarget = isolatedFile();
  const legacyTarget = freshStore(layoutTarget);
  assert.throws(() => legacyTarget.importAllData(backup, 'partitioned'), /expectedLayout 不一致/);
  assert.throws(() => legacyTarget.importAllData(partitionedBackup), /目标存储模式不一致/);
  assert.equal(fs.existsSync(layoutTarget), false);
  assert.equal(fs.existsSync(layoutTarget + '.manifest.json'), false);

  const damagedTarget = isolatedFile();
  const damaged = JSON.parse(JSON.stringify(backup));
  damaged.data['backup-user'].opIndex = [['bad', -1]];
  assert.throws(() => freshStore(damagedTarget).importAllData(damaged), /opIndex/);
  assert.equal(fs.existsSync(damagedTarget), false);
  assert.equal(fs.existsSync(damagedTarget + '.lock'), false);
});

for (const [layout, partitioned] of [['legacy', false], ['partitioned', true]]) {
  test(layout + ' importAllData 持久化失败不提交目标，恢复后可重试', () => {
    const source = isolatedFile();
    const backup = seedBackupStore(source, partitioned).exportAllData();
    const target = isolatedFile();
    const store = freshStore(target, partitioned);
    const commitTarget = partitioned ? target + '.manifest.json' : target;
    const restoreRename = failRenameTarget(commitTarget);
    try { assert.throws(() => store.importAllData(backup, layout), /synthetic rename failure/); }
    finally { restoreRename(); }
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(target + '.manifest.json'), false);
    assert.equal(fs.existsSync(target + '.partitioned.json'), false);
    assert.equal(fs.existsSync(target + '.lock'), false);
    assert.deepEqual(store.importAllData(backup, layout), { imported: true, layout, partitions: 2, opIndex: 5 });
    assert.deepEqual(freshStore(target, partitioned).exportAllData(), backup);
  });
}

test('partitioned backup-all/verify-backup/restore-all 形成只读校验与新路径恢复闭环', () => {
  const source = isolatedFile();
  seedBackupStore(source, true);
  const oldFile = readManifest(source).partitions['backup-user'].file;
  const manifestBefore = fs.readFileSync(source + '.manifest.json', 'utf8');
  const bundle = path.join(path.dirname(source), 'all.json');
  const backedUp = adminCli(source, ['backup-all', '--out', bundle, '--store', source], true);
  assert.equal(backedUp.status, 0, backedUp.stderr);
  const output = JSON.parse(backedUp.stdout);
  const bundleText = fs.readFileSync(bundle, 'utf8');
  assert.equal(output.backedUp, true);
  assert.equal(output.layout, 'partitioned');
  assert.equal(output.partitions, 2);
  assert.equal(output.opIndex, 5);
  assert.equal(output.sha256, sha256(bundleText));
  assertPrivateFileMode(bundle);
  assert.equal(fs.readFileSync(source + '.manifest.json', 'utf8'), manifestBefore);
  assert.equal(fs.existsSync(path.join(source + '.parts', oldFile)), true);

  const verified = adminCli(source, ['verify-backup', '--file', bundle], true);
  assert.equal(verified.status, 0, verified.stderr);
  const verification = JSON.parse(verified.stdout);
  assert.equal(verification.valid, true);
  assert.equal(verification.layout, 'partitioned');
  assert.equal(verification.partitions, 2);
  assert.equal(verification.opIndex, 5);
  assert.equal(verification.bytes, Buffer.byteLength(bundleText));
  assert.equal(verification.sha256, output.sha256);
  assert.equal(fs.readFileSync(source + '.manifest.json', 'utf8'), manifestBefore);
  assert.equal(fs.existsSync(source + '.lock'), false);

  const target = isolatedFile();
  const audit = path.join(path.dirname(target), 'restore.json');
  const restored = adminCli(source, ['restore-all', '--file', bundle, '--store', target, '--confirm', 'restore-all', '--out', audit], true);
  assert.equal(restored.status, 0, restored.stderr);
  const restoreOutput = JSON.parse(restored.stdout);
  assert.equal(restoreOutput.restored, true);
  assert.equal(restoreOutput.layout, 'partitioned');
  assert.equal(restoreOutput.partitions, 2);
  assert.equal(restoreOutput.opIndex, 5);
  assert.equal(restoreOutput.sha256, output.sha256);
  assert.deepEqual(freshStore(target, true).exportAllData(), JSON.parse(bundleText));
  assert.equal(JSON.parse(fs.readFileSync(audit, 'utf8')).status, 'prepared');
  assert.equal(JSON.parse(fs.readFileSync(audit + '.restore-intent.json', 'utf8')).status, 'confirmed');
  assert.equal(JSON.parse(fs.readFileSync(audit + '.result.json', 'utf8')).status, 'restored');
  assertPrivateFileMode(audit);
});

test('restore-all 拒绝错误确认、已存在目标与 manifest，且不写审计或覆盖目标', () => {
  const source = isolatedFile();
  seedBackupStore(source, true);
  const bundle = path.join(path.dirname(source), 'all.json');
  assert.equal(adminCli(source, ['backup-all', '--out', bundle, '--store', source], true).status, 0);
  const target = isolatedFile();
  const wrongAudit = path.join(path.dirname(target), 'wrong.json');
  const wrong = adminCli(source, ['restore-all', '--file', bundle, '--store', target, '--confirm', 'wrong', '--out', wrongAudit], true);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /确认值必须与 restore-all/);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(wrongAudit), false);

  fs.writeFileSync(target, 'occupied', 'utf8');
  const occupiedAudit = path.join(path.dirname(target), 'occupied-audit.json');
  const occupied = adminCli(source, ['restore-all', '--file', bundle, '--store', target, '--confirm', 'restore-all', '--out', occupiedAudit], true);
  assert.equal(occupied.status, 1);
  assert.match(occupied.stderr, /目标路径已存在，拒绝覆盖/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'occupied');
  assert.equal(fs.existsSync(occupiedAudit), false);

  const manifestTarget = isolatedFile();
  fs.writeFileSync(manifestTarget + '.manifest.json', 'occupied-manifest', 'utf8');
  const manifestAudit = path.join(path.dirname(manifestTarget), 'manifest-audit.json');
  const manifestResult = adminCli(source, ['restore-all', '--file', bundle, '--store', manifestTarget, '--confirm', 'restore-all', '--out', manifestAudit], true);
  assert.equal(manifestResult.status, 1);
  assert.match(manifestResult.stderr, /manifest 已存在，拒绝覆盖/);
  assert.equal(fs.readFileSync(manifestTarget + '.manifest.json', 'utf8'), 'occupied-manifest');
  assert.equal(fs.existsSync(manifestTarget), false);
  assert.equal(fs.existsSync(manifestAudit), false);

  const markerTarget = isolatedFile();
  fs.writeFileSync(markerTarget + '.partitioned.json', 'occupied-marker', 'utf8');
  const markerAudit = path.join(path.dirname(markerTarget), 'marker-audit.json');
  const markerResult = adminCli(source, ['restore-all', '--file', bundle, '--store', markerTarget, '--confirm', 'restore-all', '--out', markerAudit], true);
  assert.equal(markerResult.status, 1);
  assert.match(markerResult.stderr, /分区模式标记已存在，拒绝覆盖/);
  assert.equal(fs.readFileSync(markerTarget + '.partitioned.json', 'utf8'), 'occupied-marker');
  assert.equal(fs.existsSync(markerTarget), false);
  assert.equal(fs.existsSync(markerAudit), false);
});

for (const [label, suffix, expectedStatus] of [
  ['prepared', '', 1],
  ['confirmed', '.restore-intent.json', 1]
]) {
  test('restore-all ' + label + ' 审计写入失败时不创建目标', () => {
    const source = isolatedFile();
    seedBackupStore(source, true);
    const bundle = path.join(path.dirname(source), 'all.json');
    assert.equal(adminCli(source, ['backup-all', '--out', bundle, '--store', source], true).status, 0);
    const target = isolatedFile();
    const audit = path.join(path.dirname(target), 'audit-fail.json');
    fs.writeFileSync(audit + suffix, 'occupied', 'utf8');
    const result = adminCli(source, ['restore-all', '--file', bundle, '--store', target, '--confirm', 'restore-all', '--out', audit], true);
    assert.equal(result.status, expectedStatus, result.stderr);
    assert.match(result.stderr, /拒绝覆盖/);
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(target + '.manifest.json'), false);
    assert.equal(fs.readFileSync(audit + suffix, 'utf8'), 'occupied');
    assert.equal(fs.existsSync(audit + '.result.json'), false);
    if (suffix) assert.equal(JSON.parse(fs.readFileSync(audit, 'utf8')).status, 'prepared');
  });
}

test('restore-all 结果审计失败退出码 3 并明确报告目标已恢复', () => {
  const source = isolatedFile();
  seedBackupStore(source, true);
  const bundle = path.join(path.dirname(source), 'all.json');
  assert.equal(adminCli(source, ['backup-all', '--out', bundle, '--store', source], true).status, 0);
  const target = isolatedFile();
  const audit = path.join(path.dirname(target), 'result-fail.json');
  fs.writeFileSync(audit + '.result.json', 'occupied', 'utf8');
  const result = adminCli(source, ['restore-all', '--file', bundle, '--store', target, '--confirm', 'restore-all', '--out', audit], true);
  assert.equal(result.status, 3, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.restored, true);
  assert.match(output.message, /数据已恢复/);
  assert.match(output.auditError, /输出已存在/);
  assert.match(result.stderr, /数据已恢复/);
  assert.equal(JSON.parse(fs.readFileSync(audit, 'utf8')).status, 'prepared');
  assert.equal(JSON.parse(fs.readFileSync(audit + '.restore-intent.json', 'utf8')).status, 'confirmed');
  assert.equal(fs.readFileSync(audit + '.result.json', 'utf8'), 'occupied');
  assert.equal(freshStore(target, true).getState('backup-user').seed.user.name, '当前版本');
});

test('verify-backup 拒绝损坏文件且不修改源存储或损坏文件', () => {
  const source = isolatedFile();
  seedBackupStore(source);
  const before = fs.readFileSync(source, 'utf8');
  const bundle = path.join(path.dirname(source), 'all.json');
  assert.equal(adminCli(source, ['backup-all', '--out', bundle, '--store', source], false).status, 0);
  const damaged = JSON.parse(fs.readFileSync(bundle, 'utf8'));
  damaged.data['backup-user'].state.tasks = {};
  const damagedText = JSON.stringify(damaged);
  fs.writeFileSync(bundle, damagedText, 'utf8');
  const result = adminCli(source, ['verify-backup', '--file', bundle], false);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid state tasks/);
  assert.equal(fs.readFileSync(bundle, 'utf8'), damagedText);
  assert.equal(fs.readFileSync(source, 'utf8'), before);
  assert.equal(fs.existsSync(source + '.lock'), false);
});

test('重排超过规模上限时明确拒绝而不修改任务', () => {
  const replan = require('../shared/engine/replan.js').replan;
  const tasks = Array.from({ length: 501 }, (_, i) => ({ id: 't' + i, est: 30, weight: 0.5 }));
  assert.throws(() => replan({ tasks, week: [{ date: '一', minutes: 0, buffer: 60, capacity: 300 }], params: { maxTasks: 500 } }), /规模|上限|limit/i);
});
