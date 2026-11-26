'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function directory() {
  const root = path.join(__dirname, '..', '.tmp');
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, 'nova-admin-'));
}

function freshStore(file) {
  process.env.NOVA_STORE_FILE = file;
  delete process.env.NOVA_STORE_PARTITIONED;
  const resolved = require.resolve('../server/store/memory.js');
  delete require.cache[resolved];
  return require(resolved);
}

function seedStore(file) {
  const store = freshStore(file);
  store.reset();
  store.applyOps('admin-user', [{ opId: 'name', entity: 'user', entityId: 'u', field: 'name', value: '隔离用户', clientTs: 1 }]);
  store.applyOps('other-user', [{ opId: 'name', entity: 'user', entityId: 'u', field: 'name', value: '其他用户', clientTs: 1 }]);
  return store;
}

function cli(args, extraEnv = {}) {
  const env = { ...process.env };
  const storeIndex = args.indexOf('--store');
  if (storeIndex >= 0) {
    env.NOVA_STORE_FILE = args[storeIndex + 1];
    env.NOVA_ADMIN_BACKUP_DIR = path.join(__dirname, '..', '.tmp');
  }
  delete env.NOVA_STORE_PARTITIONED;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'server-data-admin.js'), ...args], {
    encoding: 'utf8', env
  });
}

function seedPruneStore(file) {
  const store = seedStore(file);
  store.applyOps('admin-user', [
    { opId: 'move', entity: 'plan', entityId: 'dayAssign', field: 'moved', clientTs: 2, value: { taskId: 't1', day: '三' } },
    { opId: 'count', entity: 'user', entityId: 'u', field: 'count', value: 2, clientTs: 3 }
  ]);
  store.recordReplan('admin-user', {
    strategies: [], diff: [], loadDelta: 0, accepted: true, verdict: 'needsConfirmation',
    snapshot: { marker: 'backup' }, nextTasks: [], nextWeek: []
  }, { version: 'v1', locks: {}, params: {} });
  return store;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function directoryFsyncFailureHook(log) {
  const hook = path.join(path.dirname(log), 'fail-directory-fsync.cjs');
  fs.writeFileSync(hook, [
    "'use strict';",
    'const fs = require("node:fs");',
    'const log = ' + JSON.stringify(log) + ';',
    'const originalWrite = fs.writeFileSync;',
    'const originalOpen = fs.openSync;',
    'const originalFsync = fs.fsyncSync;',
    'const originalLink = fs.linkSync;',
    'const originalRm = fs.rmSync;',
    'const originalChmod = fs.chmodSync;',
    'const originalClose = fs.closeSync;',
    'const events = [];',
    'const directoryFds = new Set();',
    'let linkedTmp = null;',
    'let directorySyncs = 0;',
    'originalWrite(log, "", "utf8");',
    'Object.defineProperty(process, "platform", { value: "linux", configurable: true });',
    'fs.openSync = function (file, ...args) {',
    '  let isDirectory = false;',
    '  if (typeof file === "string") {',
    '    try { isDirectory = fs.statSync(file).isDirectory(); }',
    '    catch (error) { if (!error || error.code !== "ENOENT") throw error; }',
    '  }',
    '  if (isDirectory) {',
    '    const fd = originalOpen(log, "r+");',
    '    directoryFds.add(fd);',
    '    return fd;',
    '  }',
    '  return originalOpen(file, ...args);',
    '};',
    'fs.linkSync = function (from, to) { events.push("link"); linkedTmp = String(from); return originalLink(from, to); };',
    'fs.rmSync = function (target, ...args) {',
    '  if (String(target) === linkedTmp) { events.push("temp-cleanup"); linkedTmp = null; }',
    '  return originalRm(target, ...args);',
    '};',
    'fs.chmodSync = function (file, mode) { events.push("chmod"); return originalChmod(file, mode); };',
    'fs.closeSync = function (fd) { directoryFds.delete(fd); return originalClose(fd); };',
    'fs.fsyncSync = function (fd) {',
    '  if (directoryFds.has(fd)) {',
    '    events.push("dir-fsync");',
    '    directorySyncs += 1;',
    '    if (directorySyncs === Number(process.env.NOVA_TEST_FAIL_DIR_FSYNC_AT)) throw new Error("synthetic directory fsync failure");',
    '  } else events.push("file-fsync");',
    '  return originalFsync(fd);',
    '};',
    'process.on("exit", () => originalWrite(log, JSON.stringify(events), "utf8"));'
  ].join('\n'), 'utf8');
  return hook;
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

test('默认旧 JSON 模式不提供 compact，CLI 明确拒绝且不修改存储', () => {
  const dir = directory();
  const file = path.join(dir, 'store.json');
  seedStore(file);
  const before = fs.readFileSync(file, 'utf8');
  const result = cli(['compact', '--store', file]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /旧 JSON 模式不提供 compact/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('inventory 默认脱敏键名，显式 --include-ids 才输出原始标识', () => {
  const dir = directory();
  const file = path.join(dir, 'store.json');
  seedStore(file);
  const before = fs.readFileSync(file, 'utf8');
  const result = cli(['inventory', '--store', file]);
  assert.equal(result.status, 0, result.stderr);
  const inventory = JSON.parse(result.stdout);
  assert.equal(inventory.format, 'nova-sync-inventory');
  assert.equal(inventory.version, 2);
  assert.equal(inventory.redacted, true);
  assert.equal(inventory.totals.partitions, 2);
  assert.ok(inventory.partitions.every(row => /^[0-9a-f]{64}$/.test(row.userId.sha256)));
  assert.doesNotMatch(result.stdout, /admin-user|other-user|"entityId":"u"|"fields":\["name"\]/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);

  const explicit = cli(['inventory', '--store', file, '--include-ids']);
  assert.equal(explicit.status, 0, explicit.stderr);
  const raw = JSON.parse(explicit.stdout);
  assert.equal(raw.redacted, false);
  assert.ok(raw.partitions.find(row => row.userId === 'admin-user').entities.some(bucket =>
    bucket.entity === 'user' && bucket.entityId === 'u' && bucket.fields.includes('name')));
});

test('CLI 所有输出命令拒绝写入存储 manifest、模式标记、撤销清单、lock 与 parts', () => {
  const file = path.join(directory(), 'store.json');
  seedStore(file);
  for (const target of [file + '.manifest.json', file + '.partitioned.json', file + '.revoked.json', file + '.lock', path.join(file + '.parts', 'injected.json')]) {
    const result = cli(['export', '--user', 'admin-user', '--out', target, '--store', file], false);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /输出路径不得/);
    assert.equal(fs.existsSync(target), false);
  }
  const compactMarker = cli(['compact', '--purge', '--confirm', 'purge', '--out', file + '.partitioned.json', '--store', file], false);
  assert.equal(compactMarker.status, 1);
  assert.match(compactMarker.stderr, /不得覆盖存储元数据/);
  assert.equal(fs.existsSync(file + '.partitioned.json'), false);
});

test('敏感 CLI 输出必须位于受控备份目录', () => {
  const dir = directory();
  const file = path.join(dir, 'store.json');
  seedStore(file);
  const outside = path.join(directory(), 'outside.json');
  const rejected = cli(['export', '--user', 'admin-user', '--out', outside, '--store', file], { NOVA_ADMIN_BACKUP_DIR: dir });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /受控目录/);
  assert.equal(fs.existsSync(outside), false);

  const defaultOutside = path.join(dir, 'legacy-output.json');
  const defaultRejected = cli(['export', '--user', 'admin-user', '--out', defaultOutside, '--store', file], { NOVA_ADMIN_BACKUP_DIR: '' });
  assert.equal(defaultRejected.status, 1);
  assert.match(defaultRejected.stderr, /受控目录/);
  assert.equal(fs.existsSync(defaultOutside), false);
});

test('分区导出不修改存储，指纹冲突拒绝删除且可整笔重试', () => {
  const dir = directory();
  const file = path.join(dir, 'store.json');
  const store = seedStore(file);
  const before = fs.readFileSync(file, 'utf8');
  const backup = store.exportUserData('admin-user');
  assert.equal(backup.format, 'nova-partition-backup');
  assert.equal(backup.version, 1);
  assert.equal(backup.data.state.user.name, '隔离用户');
  assert.match(backup.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.throws(() => store.deleteUserData('admin-user', '0'.repeat(64)), /分区已变化/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  const deleted = store.deleteUserData('admin-user', backup.fingerprint);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.tokenRevoked, true);
  assert.equal(fs.existsSync(file + '.revoked.json'), true);
  const reloaded = freshStore(file);
  assert.throws(() => reloaded.getState('admin-user'), error => error.code === 'USER_REVOKED');
  assert.throws(() => reloaded.applyOps('admin-user', [{ opId: 'resurrect', entity: 'user', entityId: 'u', field: 'name', value: '不应重建', clientTs: 2 }]), error => error.code === 'USER_REVOKED');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(Object.hasOwn(raw, 'admin-user'), false);
  assert.equal(raw['other-user'].state.user.name, '其他用户');
  assert.equal(freshStore(file).getState('other-user').seed.user.name, '其他用户');
});

test('删除后审计写入失败时明确报告已删除，保留 confirmed 意图', () => {
  const dir = directory();
  const file = path.join(dir, 'store.json');
  seedStore(file);
  const backup = path.join(dir, 'audit-fail.json');
  fs.writeFileSync(backup + '.deleted.json', 'occupied', 'utf8');
  const result = cli(['delete', '--user', 'admin-user', '--confirm', 'admin-user', '--out', backup, '--store', file]);
  assert.equal(result.status, 3, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.deleted, true);
  assert.match(output.auditError, /输出已存在/);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(file, 'utf8')), 'admin-user'), false);
  assert.equal(JSON.parse(fs.readFileSync(backup + '.delete-intent.json', 'utf8')).status, 'confirmed');
});

test('CLI 导出与确认删除先留备份和审计，拒绝错误确认与覆盖', () => {
  const dir = directory();
  const file = path.join(dir, 'store.json');
  seedStore(file);
  const backup = path.join(dir, 'partition.json');
  const exported = cli(['export', '--user', 'admin-user', '--out', backup, '--store', file]);
  assert.equal(exported.status, 0, exported.stderr);
  const exportedResult = JSON.parse(exported.stdout);
  assert.equal(exportedResult.exported, true);
  assert.match(exportedResult.sha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.parse(fs.readFileSync(backup, 'utf8')).data.state.user.name, '隔离用户');
  assert.equal(JSON.parse(fs.readFileSync(backup + '.audit.json', 'utf8')).status, 'exported');
  const overwrite = cli(['export', '--user', 'admin-user', '--out', backup, '--store', file]);
  assert.equal(overwrite.status, 1);
  assert.match(overwrite.stderr, /拒绝覆盖/);

  const beforeDelete = fs.readFileSync(file, 'utf8');
  const wrongConfirm = cli(['delete', '--user', 'admin-user', '--confirm', 'other-user', '--out', path.join(dir, 'wrong.json'), '--store', file]);
  assert.equal(wrongConfirm.status, 1);
  assert.match(wrongConfirm.stderr, /确认值/);
  assert.equal(fs.readFileSync(file, 'utf8'), beforeDelete);
  assert.equal(fs.existsSync(path.join(dir, 'wrong.json')), false);

  const deleted = cli(['delete', '--user', 'admin-user', '--confirm', 'admin-user', '--out', path.join(dir, 'delete.json'), '--store', file]);
  assert.equal(deleted.status, 0, deleted.stderr);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(Object.hasOwn(raw, 'admin-user'), false);
  assert.equal(Object.hasOwn(raw, 'other-user'), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'delete.json.audit.json'), 'utf8')).status, 'prepared');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'delete.json.deleted.json'), 'utf8')).status, 'deleted');
});

test('legacy backup-all/verify-backup/restore-all 保留全部分区且校验不访问默认存储', () => {
  const dir = directory();
  const file = path.join(dir, 'store.json');
  const store = seedStore(file);
  store.recordReplan('admin-user', {
    strategies: [], diff: [], loadDelta: 0, accepted: true, verdict: 'needsConfirmation',
    snapshot: { marker: 'legacy-all' }, nextTasks: [], nextWeek: []
  }, { version: 'v1', locks: {}, params: {} });
  const before = store.exportAllData();
  const bundle = path.join(dir, 'all.json');
  const backedUp = cli(['backup-all', '--out', bundle, '--store', file]);
  assert.equal(backedUp.status, 0, backedUp.stderr);
  const output = JSON.parse(backedUp.stdout);
  const bundleText = fs.readFileSync(bundle, 'utf8');
  assert.equal(output.layout, 'legacy');
  assert.equal(output.partitions, 2);
  assert.equal(output.opIndex, 2);
  assert.equal(output.sha256, sha256(bundleText));
  assertPrivateFileMode(bundle);
  assert.deepEqual(JSON.parse(bundleText), before);

  const defaultStore = path.join(dir, 'must-not-read.json');
  fs.writeFileSync(defaultStore, '{broken', 'utf8');
  const verified = cli(['verify-backup', '--file', bundle], {
    NOVA_STORE_FILE: defaultStore, NOVA_STORE_PARTITIONED: '1'
  });
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).valid, true);
  assert.equal(fs.readFileSync(defaultStore, 'utf8'), '{broken');

  const target = path.join(dir, 'restored.json');
  const audit = path.join(dir, 'restore-audit.json');
  const restored = cli(['restore-all', '--file', bundle, '--store', target, '--confirm', 'restore-all', '--out', audit]);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(JSON.parse(restored.stdout).restored, true);
  assert.deepEqual(freshStore(target).exportAllData(), before);
  assert.equal(JSON.parse(fs.readFileSync(audit, 'utf8')).status, 'prepared');
  assert.equal(JSON.parse(fs.readFileSync(audit + '.restore-intent.json', 'utf8')).status, 'confirmed');
  assert.equal(JSON.parse(fs.readFileSync(audit + '.result.json', 'utf8')).status, 'restored');
});

test('prune-op-index 帮助明确管理员裁定保留期限、前端禁用与旧 op 重试风险', () => {
  const dir = directory();
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'server-data-admin.js'), '--help'], {
    encoding: 'utf8', env: { ...process.env, NOVA_STORE_FILE: path.join(dir, 'unused.json') }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /prune-op-index --user <userId> --keep-recent <N> --confirm prune-op-index/);
  assert.match(result.stdout, /保留期限必须由管理员/);
  assert.match(result.stdout, /前端不使用/);
  assert.match(result.stdout, /不会自动调用/);
  assert.match(result.stdout, /旧 opId 再次重试可能被重新应用/);
  assert.match(result.stdout, /N=0/);
});

test('prune-op-index 错误确认与非法保留数均不写业务或输出', () => {
  const dir = directory();
  const file = path.join(dir, 'store.json');
  seedPruneStore(file);
  const before = fs.readFileSync(file, 'utf8');
  const wrongOut = path.join(dir, 'wrong-confirm.json');
  const wrong = cli(['prune-op-index', '--user', 'admin-user', '--keep-recent', '1', '--confirm', 'wrong', '--out', wrongOut, '--store', file]);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /确认值必须与 prune-op-index/);
  assert.equal(fs.existsSync(wrongOut), false);

  const invalidValues = ['-1', '1.5', 'abc', '9007199254740992'];
  invalidValues.forEach((value, index) => {
    const out = path.join(dir, 'invalid-' + index + '.json');
    const result = cli(['prune-op-index', '--user', 'admin-user', '--keep-recent', value, '--confirm', 'prune-op-index', '--out', out, '--store', file]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /--keep-recent 必须是非负安全整数/);
    assert.equal(fs.existsSync(out), false);
    assert.equal(fs.existsSync(out + '.audit.json'), false);
    assert.equal(fs.existsSync(out + '.prune-intent.json'), false);
    assert.equal(fs.existsSync(out + '.result.json'), false);
  });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.existsSync(file + '.lock'), false);
});

test('prune-op-index 在同一锁内留完整备份和 prepared/confirmed/result 审计', () => {
  const dir = directory();
  const file = path.join(dir, 'store.json');
  const store = seedPruneStore(file);
  const before = store.exportUserData('admin-user');
  const otherBefore = store.exportUserData('other-user');
  const out = path.join(dir, 'prune.json');
  const result = cli(['prune-op-index', '--user', 'admin-user', '--keep-recent', '1', '--confirm', 'prune-op-index', '--out', out, '--store', file]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.pruned, true);
  assert.equal(output.removed, 2);
  assert.equal(output.kept, 1);
  assert.equal(output.fingerprintBefore, before.fingerprint);
  assert.equal(output.serverSeq, before.data.seq);

  const backupText = fs.readFileSync(out, 'utf8');
  const backup = JSON.parse(backupText);
  assert.equal(backup.format, 'nova-partition-backup');
  assert.deepEqual(backup.data, before.data);
  assert.deepEqual(backup.data.opIndex, before.data.opIndex);
  assert.equal(backup.data.replanRecords.length, 1);
  assert.ok(backup.data.dayAssignWrites.some(entry => entry[0] === 't1'));
  assert.equal(backup.fingerprint, before.fingerprint);
  assert.ok(Number.isFinite(Date.parse(backup.exportedAt)));
  assert.equal(output.sha256, sha256(backupText));

  const prepared = JSON.parse(fs.readFileSync(out + '.audit.json', 'utf8'));
  const confirmed = JSON.parse(fs.readFileSync(out + '.prune-intent.json', 'utf8'));
  const resultAudit = JSON.parse(fs.readFileSync(out + '.result.json', 'utf8'));
  assert.equal(prepared.format, 'nova-op-index-prune-audit');
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.userId, 'admin-user');
  assert.equal(prepared.keepRecent, 1);
  assert.equal(prepared.fingerprint, before.fingerprint);
  assert.equal(prepared.backup, path.basename(out));
  assert.equal(prepared.backupSha256, output.sha256);
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.confirm, 'prune-op-index');
  assert.equal(confirmed.backupSha256, output.sha256);
  assert.equal(resultAudit.status, 'pruned');
  assert.equal(resultAudit.removed, 2);
  assert.equal(resultAudit.kept, 1);
  assert.equal(resultAudit.fingerprintBefore, before.fingerprint);
  assert.equal(resultAudit.fingerprintAfter, output.fingerprintAfter);
  assert.ok(Number.isFinite(Date.parse(resultAudit.completedAt)));

  const after = freshStore(file).exportUserData('admin-user');
  assert.deepEqual(after.data.opIndex, [before.data.opIndex[2]]);
  for (const field of ['state', 'entities', 'dayAssignWrites', 'replanRecords', 'replanSeq', 'planBaseline', 'seq']) {
    assert.deepEqual(after.data[field], before.data[field], field + ' 不应被 CLI 回收改变');
  }
  assert.deepEqual(freshStore(file).exportUserData('other-user'), otherBefore);
});

test('prune-op-index CLI 允许 N=0 并持久化空索引', () => {
  const dir = directory();
  const file = path.join(dir, 'store.json');
  const store = seedPruneStore(file);
  const before = store.exportUserData('admin-user');
  const out = path.join(dir, 'prune-zero.json');
  const result = cli(['prune-op-index', '--user', 'admin-user', '--keep-recent', '0', '--confirm', 'prune-op-index', '--out', out, '--store', file]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.removed, 3);
  assert.equal(output.kept, 0);
  assert.equal(output.serverSeq, before.data.seq);
  const after = freshStore(file).exportUserData('admin-user');
  assert.deepEqual(after.data.opIndex, []);
  assert.deepEqual(after.data.state, before.data.state);
  assert.deepEqual(after.data.entities, before.data.entities);
});

for (const [label, occupiedSuffix] of [
  ['完整备份', ''],
  ['prepared 审计', '.audit.json'],
  ['confirmed 审计', '.prune-intent.json']
]) {
  test('prune-op-index ' + label + '写入失败时拒绝删除索引', () => {
    const dir = directory();
    const file = path.join(dir, 'store.json');
    seedPruneStore(file);
    const before = fs.readFileSync(file, 'utf8');
    const out = path.join(dir, 'audit-fail.json');
    const occupied = out + occupiedSuffix;
    fs.writeFileSync(occupied, 'occupied', 'utf8');
    const result = cli(['prune-op-index', '--user', 'admin-user', '--keep-recent', '1', '--confirm', 'prune-op-index', '--out', out, '--store', file]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /拒绝覆盖/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(fs.readFileSync(occupied, 'utf8'), 'occupied');
    assert.equal(fs.existsSync(out + '.result.json'), false);
    if (occupiedSuffix === '') {
      assert.equal(fs.existsSync(out + '.audit.json'), false);
      assert.equal(fs.existsSync(out + '.prune-intent.json'), false);
    } else if (occupiedSuffix === '.audit.json') {
      assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).data.opIndex.length, 3);
      assert.equal(fs.existsSync(out + '.prune-intent.json'), false);
    } else {
      assert.equal(JSON.parse(fs.readFileSync(out + '.audit.json', 'utf8')).status, 'prepared');
    }
  });
}

test('prune-op-index 结果审计失败时退出码 3 并明确报告索引已回收', () => {
  const dir = directory();
  const file = path.join(dir, 'store.json');
  seedPruneStore(file);
  const out = path.join(dir, 'result-fail.json');
  fs.writeFileSync(out + '.result.json', 'occupied', 'utf8');
  const result = cli(['prune-op-index', '--user', 'admin-user', '--keep-recent', '1', '--confirm', 'prune-op-index', '--out', out, '--store', file]);
  assert.equal(result.status, 3, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.pruned, true);
  assert.equal(output.removed, 2);
  assert.equal(output.kept, 1);
  assert.match(output.auditError, /输出已存在/);
  assert.equal(JSON.parse(fs.readFileSync(out + '.audit.json', 'utf8')).status, 'prepared');
  assert.equal(JSON.parse(fs.readFileSync(out + '.prune-intent.json', 'utf8')).status, 'confirmed');
  assert.equal(fs.readFileSync(out + '.result.json', 'utf8'), 'occupied');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))['admin-user'].opIndex.length, 1);
  assert.equal(freshStore(file).getState('admin-user').seed.user.count, 2);
});

for (const failAt of [1, 2]) {
  test('restore-all 第 ' + failAt + ' 个独占审计目录 fsync 失败时不继续恢复', () => {
    const dir = directory();
    const source = path.join(dir, 'source.json');
    seedStore(source);
    const bundle = path.join(dir, 'bundle.json');
    assert.equal(cli(['backup-all', '--out', bundle, '--store', source]).status, 0);
    const target = path.join(dir, 'restored.json');
    const audit = path.join(dir, 'restore.json');
    const log = path.join(dir, 'fsync-events.json');
    const hook = directoryFsyncFailureHook(log);
    const nodeOptions = (process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + ' ' : '') + '--require=' + hook;
    const result = cli(['restore-all', '--file', bundle, '--store', target, '--confirm', 'restore-all', '--out', audit], {
      NODE_OPTIONS: nodeOptions, NOVA_TEST_FAIL_DIR_FSYNC_AT: String(failAt)
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /synthetic directory fsync failure/);
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(target + '.manifest.json'), false);
    assert.equal(fs.existsSync(target + '.lock'), false);
    assert.equal(JSON.parse(fs.readFileSync(audit, 'utf8')).status, 'prepared');
    assert.equal(fs.existsSync(audit + '.restore-intent.json'), failAt === 2);
    assert.equal(fs.existsSync(audit + '.result.json'), false);
    const events = JSON.parse(fs.readFileSync(log, 'utf8')).filter(event => event !== 'file-fsync');
    assert.deepEqual(events, Array.from({ length: failAt }, () => ['link', 'temp-cleanup', 'dir-fsync']).flat());
    assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')), []);
  });
}

test('delete 完整备份目录 fsync 失败时不继续删除且保留已提交输出', () => {
  const dir = directory();
  const file = path.join(dir, 'store.json');
  seedStore(file);
  const before = fs.readFileSync(file, 'utf8');
  const out = path.join(dir, 'delete.json');
  const log = path.join(dir, 'fsync-events.json');
  const hook = directoryFsyncFailureHook(log);
  const nodeOptions = (process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + ' ' : '') + '--require=' + hook;
  const result = cli(['delete', '--user', 'admin-user', '--confirm', 'admin-user', '--out', out, '--store', file], {
    NODE_OPTIONS: nodeOptions, NOVA_TEST_FAIL_DIR_FSYNC_AT: '1'
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /synthetic directory fsync failure/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).data.state.user.name, '隔离用户');
  assert.equal(fs.existsSync(out + '.audit.json'), false);
  assert.equal(fs.existsSync(out + '.delete-intent.json'), false);
  assert.equal(fs.existsSync(out + '.deleted.json'), false);
  const events = JSON.parse(fs.readFileSync(log, 'utf8')).filter(event => event !== 'file-fsync');
  assert.deepEqual(events, ['link', 'temp-cleanup', 'dir-fsync']);
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')), []);
});

for (const [label, mode, expectedError] of [
  ['格式无效', 'invalid', /备份指纹无效/],
  ['指纹冲突', 'mismatch', /opIndex 回收已拒绝/]
]) {
  test('prune-op-index CLI 拒绝' + label + '指纹且不修改业务', () => {
    const dir = directory();
    const file = path.join(dir, 'store.json');
    seedPruneStore(file);
    const before = fs.readFileSync(file, 'utf8');
    const hook = path.join(dir, 'bad-fingerprint.cjs');
    const modulePath = path.join(__dirname, '..', 'server', 'store', 'memory.js');
    fs.writeFileSync(hook, [
      "'use strict';",
      'const store = require(' + JSON.stringify(modulePath) + ');',
      'const original = store.exportUserData;',
      'store.exportUserData = function (userId) {',
      '  const backup = original(userId);',
      '  if (process.env.NOVA_TEST_FINGERPRINT_MODE === "invalid") backup.fingerprint = "bad";',
      '  else backup.fingerprint = (backup.fingerprint[0] === "0" ? "1" : "0") + backup.fingerprint.slice(1);',
      '  return backup;',
      '};'
    ].join('\n'), 'utf8');
    const out = path.join(dir, 'bad-fingerprint.json');
    const nodeOptions = (process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + ' ' : '') + '--require=' + hook;
    const result = cli(['prune-op-index', '--user', 'admin-user', '--keep-recent', '1', '--confirm', 'prune-op-index', '--out', out, '--store', file], {
      NODE_OPTIONS: nodeOptions, NOVA_TEST_FINGERPRINT_MODE: mode
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, expectedError);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(fs.existsSync(out + '.result.json'), false);
    if (mode === 'invalid') {
      assert.equal(fs.existsSync(out), false);
      assert.equal(fs.existsSync(out + '.audit.json'), false);
      assert.equal(fs.existsSync(out + '.prune-intent.json'), false);
    } else {
      assert.equal(JSON.parse(fs.readFileSync(out + '.audit.json', 'utf8')).status, 'prepared');
      assert.equal(JSON.parse(fs.readFileSync(out + '.prune-intent.json', 'utf8')).status, 'confirmed');
    }
  });
}
