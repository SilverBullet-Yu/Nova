#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const USAGE = [
  '用法：',
  '  node scripts/server-data-admin.js export --user <userId> --out <backup.json> [--store <store.json>]',
  '  node scripts/server-data-admin.js delete --user <userId> --confirm <userId> --out <backup.json> [--store <store.json>]',
  '  node scripts/server-data-admin.js prune-op-index --user <userId> --keep-recent <N> --confirm prune-op-index --out <backup.json> [--store <store.json>]',
  '  node scripts/server-data-admin.js inventory [--store <store.json>] [--include-ids]',
  '  node scripts/server-data-admin.js compact [--store <store.json>]',
  '  node scripts/server-data-admin.js compact --purge --confirm purge --out <audit.json> [--store <store.json>]',
  '  node scripts/server-data-admin.js backup-all --out <bundle.json> [--store <store.json>]',
  '  node scripts/server-data-admin.js verify-backup --file <bundle.json>',
  '  node scripts/server-data-admin.js restore-all --file <bundle.json> --store <new-store.json> --confirm restore-all --out <audit.json>',
  '',
  'compact 默认只读；仅 partitioned 模式支持。purge 先写独占审计，再回收未引用 parts 与 .tmp，最后写独占结果审计。',
  'backup-all 输出当前 manifest/legacy 的全部逻辑分区；verify-backup 只读且不访问存储。',
  'inventory 默认只输出计数与键名 SHA-256/字节数；--include-ids 才输出原始 userId/entityId/字段名。',
  'restore-all 只恢复至不存在的目标，先写 prepared/confirmed 审计再导入，最后写结果审计；结果审计失败退出码 3 并明确报告已恢复。',
  'delete 先写独占备份、prepared 审计与 confirmed 意图，再按导出指纹删除；审计失败明确报告已删除。',
  'delete 同时写入持久化撤销清单；旧 token 立即返回 E4030，且不会静默重建空分区。旋转 NOVA_AUTH_SECRET 可撤销全部身份。',
  'prune-op-index 先在同一锁内写完整备份、prepared/confirmed 审计，再按 serverSeq 仅保留最新 N 条 opId 索引。',
  '保留期限必须由管理员依据业务可重放需求裁定；前端不使用，系统不会自动调用回收。',
  '风险：已回收的旧 opId 再次重试可能被重新应用，计数类操作可能重复累加；N=0 表示不保留任何 opId 索引。'
].join('\n');

function parse(args) {
  if (!args.length || args.includes('--help')) {
    process.stdout.write(USAGE + '\n');
    process.exit(0);
  }
  const command = args[0];
  if (!['export', 'delete', 'prune-op-index', 'inventory', 'compact', 'backup-all', 'verify-backup', 'restore-all'].includes(command)) {
    throw new Error('未知命令：' + command);
  }
  const options = {};
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i];
    if (key === '--purge' || key === '--include-ids') {
      if (Object.prototype.hasOwnProperty.call(options, key)) throw new Error('参数重复：' + key);
      options[key] = true;
      i -= 1;
      continue;
    }
    const value = args[i + 1];
    if (!key.startsWith('--') || !value || value.startsWith('--')) throw new Error('参数不完整：' + key);
    if (Object.prototype.hasOwnProperty.call(options, key)) throw new Error('参数重复：' + key);
    options[key] = value;
  }
  const allowed = command === 'inventory' ? ['--store', '--include-ids']
    : command === 'export' ? ['--user', '--out', '--store']
    : command === 'delete' ? ['--user', '--confirm', '--out', '--store']
    : command === 'prune-op-index' ? ['--user', '--keep-recent', '--confirm', '--out', '--store']
    : command === 'backup-all' ? ['--out', '--store']
    : command === 'verify-backup' ? ['--file']
    : command === 'restore-all' ? ['--file', '--store', '--confirm', '--out']
    : ['--store', '--purge', '--confirm', '--out'];
  for (const key of Object.keys(options)) if (!allowed.includes(key)) throw new Error('不支持参数：' + key);
  if (command === 'compact') {
    if (options['--purge']) {
      for (const key of ['--confirm', '--out']) if (!options[key]) throw new Error('缺少参数：' + key);
    } else {
      for (const key of Object.keys(options)) if (key !== '--store') throw new Error('compact 只读模式不支持参数：' + key);
    }
  } else if (command !== 'inventory') {
    for (const key of allowed.filter(key => key !== '--store')) if (!options[key]) throw new Error('缺少参数：' + key);
    if (command === 'restore-all' && !options['--store']) throw new Error('缺少参数：--store');
  }
  if ((command === 'export' || command === 'delete' || command === 'prune-op-index') && !/^[^\x00-\x1f\x7f]{1,128}$/.test(options['--user'])) throw new Error('userId 无效');
  if (command === 'prune-op-index') {
    const raw = options['--keep-recent'];
    if (!/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      throw new Error('--keep-recent 必须是非负安全整数（0 表示不保留）');
    }
  }
  return { command, options };
}

function writeExclusive(file, text) {
  if (fs.existsSync(file)) throw new Error('输出已存在，拒绝覆盖：' + file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  let created = false;
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    created = true;
    const fd = fs.openSync(tmp, 'r+');
    try { fs.fchmodSync(fd, 0o600); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.linkSync(tmp, file);
    fs.rmSync(tmp, { force: true });
    created = false;
    if (process.platform !== 'win32') {
      /* 独占输出已提交且临时链接已清理；目录项必须耐久后才允许后续删除/恢复。 */
      const dirFd = fs.openSync(path.dirname(file), 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    }
  } catch (e) {
    if (created) { try { fs.rmSync(tmp, { force: true }); } catch (cleanupError) { /* 保留原始错误 */ } }
    throw e;
  }
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function isManifestTempName(storePath, file) {
  const prefix = path.basename(storePath + '.manifest.json') + '.';
  if (!file.startsWith(prefix)) return false;
  const suffix = file.slice(prefix.length);
  return /^[0-9]+\.[0-9]+\.tmp$/.test(suffix) || /^[0-9]+\.[0-9a-f]{32}\.tmp$/.test(suffix);
}

function compactionCandidates(inventory, storePath) {
  const partsDir = storePath + '.parts';
  return inventory.orphans.map(row => ({ file: row.file, kind: 'orphan', location: 'parts' }))
    .concat(inventory.tempFiles.map(file => ({
      file, kind: 'temp', location: isManifestTempName(storePath, file) ? 'store' : 'parts'
    })))
    .map(row => {
      if (path.basename(row.file) !== row.file) throw new Error('非法待回收文件名：' + row.file);
      const target = path.join(row.location === 'store' ? path.dirname(storePath) : partsDir, row.file);
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('待回收路径不是普通文件：' + row.file);
      return {
        file: row.file, kind: row.kind, location: row.location,
        bytes: stat.size, mtimeMs: stat.mtimeMs,
        sha256: sha256(fs.readFileSync(target))
      };
    });
}

function isWithin(parent, target) {
  const relative = path.relative(parent, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

let outputRoot = null;

function assertOutputWithinRoot(file) {
  if (!outputRoot) return;
  const resolved = path.resolve(file);
  if (!isWithin(outputRoot, resolved)) throw new Error('输出路径必须位于 NOVA_ADMIN_BACKUP_DIR 指定的受控目录内');
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const realRoot = fs.realpathSync(outputRoot);
  const realParent = fs.realpathSync(path.dirname(resolved));
  if (!isWithin(realRoot, realParent)) throw new Error('输出路径必须位于 NOVA_ADMIN_BACKUP_DIR 指定的受控目录内');
  if (pathExists(resolved)) {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) throw new Error('输出路径不得为符号链接');
  }
}

function validateCompactionOutput(storePath, file) {
  const parts = path.resolve(storePath + '.parts');
  const reserved = [storePath, storePath + '.manifest.json', storePath + '.partitioned.json', storePath + '.revoked.json', storePath + '.lock'];
  if (reserved.some(target => samePath(target, file)) || isWithin(parts, path.resolve(file)) || isManifestTempName(storePath, path.basename(file))) {
    throw new Error('compact 审计路径不得位于分区 parts 目录内；不得覆盖存储元数据或使用 manifest 临时文件名');
  }
  assertOutputWithinRoot(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const realParts = fs.existsSync(parts) ? fs.realpathSync(parts) : parts;
  const realParent = fs.realpathSync(path.dirname(file));
  if (isWithin(realParts, realParent)) throw new Error('compact 审计路径的真实父目录不得指向分区 parts 目录');
}

function pathExists(file) {
  try { fs.lstatSync(file); return true; }
  catch (e) { if (e && e.code === 'ENOENT') return false; throw e; }
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function validateNewOutput(storePath, file, sourceFile) {
  const resolved = path.resolve(file);
  const reserved = [storePath, storePath + '.manifest.json', storePath + '.partitioned.json', storePath + '.revoked.json', storePath + '.lock'];
  if (reserved.some(target => samePath(resolved, target))) throw new Error('输出路径不得覆盖存储文件或其元数据：' + file);
  if (sourceFile && samePath(resolved, sourceFile)) throw new Error('输出路径不得覆盖输入备份：' + file);
  const parts = path.resolve(storePath + '.parts');
  if (isWithin(parts, resolved)) throw new Error('输出路径不得位于分区 parts 目录内：' + file);
  assertOutputWithinRoot(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const realParts = fs.existsSync(parts) ? fs.realpathSync(parts) : parts;
  const realParent = fs.realpathSync(path.dirname(resolved));
  if (isWithin(realParts, realParent)) throw new Error('输出路径的真实父目录不得指向分区 parts 目录：' + file);
}

function validateRestoreOutputs(storePath, sourceFile, out) {
  for (const file of [out, out + '.restore-intent.json', out + '.result.json']) {
    validateNewOutput(storePath, file, sourceFile);
  }
}

function assertNewRestoreTarget(storePath) {
  if (pathExists(storePath)) throw new Error('恢复目标路径已存在，拒绝覆盖：' + storePath);
  if (pathExists(storePath + '.manifest.json')) throw new Error('恢复目标 manifest 已存在，拒绝覆盖：' + storePath + '.manifest.json');
  if (pathExists(storePath + '.partitioned.json')) throw new Error('恢复目标分区模式标记已存在，拒绝覆盖：' + storePath + '.partitioned.json');
  if (pathExists(storePath + '.revoked.json')) throw new Error('恢复目标已撤销身份清单已存在，拒绝覆盖：' + storePath + '.revoked.json');
}

function main() {
  const { command, options } = parse(process.argv.slice(2));
  const storePath = path.resolve(options['--store'] || process.env.NOVA_STORE_FILE || path.join(__dirname, '..', 'server', 'data', 'nova-store.json'));
  const inputFile = options['--file'] ? path.resolve(options['--file']) : null;
  const out = options['--out'] ? path.resolve(options['--out']) : null;
  if (out) {
    outputRoot = path.resolve(process.env.NOVA_ADMIN_BACKUP_DIR || path.join(path.dirname(storePath), 'nova-admin-output'));
    fs.mkdirSync(outputRoot, { recursive: true });
    const rootStat = fs.lstatSync(outputRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('NOVA_ADMIN_BACKUP_DIR 必须是普通目录');
  }
  if (out === storePath) throw new Error('输出路径不得覆盖存储文件');
  if (command === 'prune-op-index' && options['--confirm'] !== 'prune-op-index') {
    throw new Error('确认值必须与 prune-op-index 完全一致');
  }
  if (command === 'compact' && options['--purge']) {
    if (options['--confirm'] !== 'purge') throw new Error('确认值必须与 purge 完全一致');
    validateCompactionOutput(storePath, out);
    validateCompactionOutput(storePath, out + '.result.json');
  }
  if (command === 'backup-all') validateNewOutput(storePath, out, null);
  if (command === 'export' || command === 'delete' || command === 'prune-op-index') {
    const outputs = [out, out + '.audit.json'];
    if (command === 'delete') outputs.push(out + '.delete-intent.json', out + '.deleted.json');
    if (command === 'prune-op-index') outputs.push(out + '.prune-intent.json', out + '.result.json');
    outputs.forEach(file => validateNewOutput(storePath, file, null));
  }
  if (command === 'restore-all') {
    if (options['--confirm'] !== 'restore-all') throw new Error('确认值必须与 restore-all 完全一致');
    validateRestoreOutputs(storePath, inputFile, out);
    assertNewRestoreTarget(storePath);
  }
  if (command === 'verify-backup') {
    /* 校验是纯读操作：用不存在的临时路径加载模块，避免触碰默认或真实存储。 */
    process.env.NOVA_STORE_FILE = path.join(os.tmpdir(), 'nova-verify-' + process.pid + '-' + crypto.randomBytes(8).toString('hex') + '.json');
    delete process.env.NOVA_STORE_PARTITIONED;
  } else {
    process.env.NOVA_STORE_FILE = storePath;
  }
  let restoreText = null;
  if (command === 'restore-all') {
    restoreText = fs.readFileSync(inputFile, 'utf8');
    let parsed;
    try { parsed = JSON.parse(restoreText); }
    catch (e) { throw new Error('全库备份 JSON 损坏：' + inputFile); }
    if (parsed && parsed.layout === 'partitioned') process.env.NOVA_STORE_PARTITIONED = '1';
    else delete process.env.NOVA_STORE_PARTITIONED;
  }
  const store = require('../server/store/memory.js');
  if (command === 'backup-all') {
    const result = store.withFreshStoreLock(function () {
      const backup = store.exportAllData();
      const verified = store.verifyStoreBackup(backup);
      const text = JSON.stringify(backup, null, 2) + '\n';
      writeExclusive(out, text);
      return {
        backedUp: true, store: storePath, backup: out, sha256: sha256(text),
        layout: verified.layout, partitions: verified.partitions, opIndex: verified.opIndex,
        bytes: Buffer.byteLength(text, 'utf8')
      };
    });
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  if (command === 'verify-backup') {
    const text = fs.readFileSync(inputFile, 'utf8');
    const verified = store.verifyStoreBackup(text);
    process.stdout.write(JSON.stringify(Object.assign({}, verified, {
      file: inputFile, sha256: sha256(text)
    })) + '\n');
    return;
  }
  if (command === 'restore-all') {
    const verified = store.verifyStoreBackup(restoreText);
    const backupHash = sha256(restoreText);
    const generatedAt = new Date().toISOString();
    const auditPath = out;
    const intentPath = out + '.restore-intent.json';
    const resultPath = out + '.result.json';
    const auditBase = {
      format: 'nova-store-restore-audit', version: 1, at: generatedAt,
      store: storePath, backup: path.basename(inputFile), backupSha256: backupHash,
      layout: verified.layout, partitions: verified.partitions, opIndex: verified.opIndex
    };
    writeExclusive(auditPath, JSON.stringify(Object.assign({}, auditBase, { status: 'prepared' }), null, 2) + '\n');
    writeExclusive(intentPath, JSON.stringify(Object.assign({}, auditBase, {
      status: 'confirmed', confirm: 'restore-all'
    }), null, 2) + '\n');

    let auditError = null;
    const imported = store.importAllData(restoreText, verified.layout);
    try {
      writeExclusive(resultPath, JSON.stringify(Object.assign({}, auditBase, imported, {
        restored: true, completedAt: new Date().toISOString(), status: 'restored',
        resultOf: path.basename(out)
      }), null, 2) + '\n');
    } catch (e) {
      auditError = e.message;
    }
    const result = {
      restored: true, store: storePath, backup: inputFile, audit: auditPath,
      confirmedAudit: intentPath, result: resultPath, sha256: backupHash,
      layout: imported.layout, partitions: imported.partitions, opIndex: imported.opIndex
    };
    if (store.getPersistenceWarning()) result.persistenceWarning = store.getPersistenceWarning();
    if (auditError) {
      result.auditError = auditError;
      result.message = '数据已恢复，但结果审计写入失败';
      process.stdout.write(JSON.stringify(result) + '\n');
      process.stderr.write('结果审计写入失败，数据已恢复：' + auditError + '\n');
      process.exitCode = 3;
      return;
    }
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  if (command === 'inventory') {
    process.stdout.write(JSON.stringify(Object.assign({}, store.getSyncInventory(options['--include-ids'] === true), { generatedAt: new Date().toISOString() })) + '\n');
    return;
  }
  if (command === 'compact') {
    const generatedAt = new Date().toISOString();
    if (!options['--purge']) {
      const inventory = store.withFreshStoreLock(() => store.inspectPartitionedFiles());
      process.stdout.write(JSON.stringify({
        format: 'nova-partitioned-file-inventory', version: 1, generatedAt,
        store: storePath, referenced: inventory.referenced, orphans: inventory.orphans,
        tempFiles: inventory.tempFiles, persistenceWarning: store.getPersistenceWarning()
      }) + '\n');
      return;
    }

    let auditError = null;
    const resultPath = out + '.result.json';
    const result = store.withFreshStoreLock(function () {
      const inventory = store.inspectPartitionedFiles();
      const pendingDelete = compactionCandidates(inventory, storePath);
      writeExclusive(out, JSON.stringify({
        format: 'nova-partitioned-compaction-audit', version: 1, at: generatedAt,
        status: 'prepared', store: storePath, referenced: inventory.referenced, pendingDelete
      }, null, 2) + '\n');
      const compacted = store.compactPartitionedFiles(true);
      const auditedFiles = pendingDelete.map(row => row.file);
      if (JSON.stringify(compacted.deletedFiles) !== JSON.stringify(auditedFiles)) {
        throw new Error('实际回收清单与独占审计不一致，拒绝写入成功结果');
      }
      try {
        writeExclusive(resultPath, JSON.stringify({
          format: 'nova-partitioned-compaction-audit', version: 1,
          at: new Date().toISOString(), completedAt: new Date().toISOString(),
          status: 'purged', store: storePath, audit: path.basename(out),
          referenced: compacted.referenced, deletedFiles: compacted.deletedFiles,
          deleted: compacted.deleted, retained: compacted.retained,
          deletedOrphans: compacted.deletedOrphans, deletedTempFiles: compacted.deletedTempFiles,
          persistenceWarning: compacted.persistenceWarning
        }, null, 2) + '\n');
      } catch (e) {
        auditError = e.message;
      }
      return {
        purged: true, store: storePath, audit: out, result: resultPath,
        deleted: compacted.deleted, retained: compacted.retained,
        deletedFiles: compacted.deletedFiles, persistenceWarning: compacted.persistenceWarning
      };
    });
    if (auditError) {
      process.stdout.write(JSON.stringify(Object.assign({}, result, { auditError })) + '\n');
      process.exitCode = 3;
      return;
    }
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  if (command === 'prune-op-index') {
    const userId = options['--user'];
    const keepRecent = Number(options['--keep-recent']);
    const exportedAt = new Date().toISOString();
    let auditError = null;
    const result = store.withFreshStoreLock(function () {
      const backup = Object.assign({}, store.exportUserData(userId), { exportedAt });
      if (typeof backup.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(backup.fingerprint)) {
        throw new Error('备份指纹无效，拒绝回收 opIndex');
      }
      const backupText = JSON.stringify(backup, null, 2) + '\n';
      writeExclusive(out, backupText);
      const backupHash = sha256(backupText);
      const auditPath = out + '.audit.json';
      const auditBase = {
        format: 'nova-op-index-prune-audit', version: 1, at: exportedAt,
        userId, keepRecent, fingerprint: backup.fingerprint,
        backup: path.basename(out), backupSha256: backupHash
      };
      writeExclusive(auditPath, JSON.stringify(Object.assign({}, auditBase, { status: 'prepared' }), null, 2) + '\n');
      const intentPath = out + '.prune-intent.json';
      writeExclusive(intentPath, JSON.stringify(Object.assign({}, auditBase, {
        status: 'confirmed', confirm: 'prune-op-index'
      }), null, 2) + '\n');
      const pruned = store.pruneOpIndex(userId, keepRecent, backup.fingerprint);
      const resultPath = out + '.result.json';
      try {
        writeExclusive(resultPath, JSON.stringify(Object.assign({}, pruned, auditBase, {
          completedAt: new Date().toISOString(), status: 'pruned', resultOf: path.basename(out)
        }), null, 2) + '\n');
      } catch (e) {
        auditError = e.message;
      }
      return {
        pruned: true, userId, keepRecent, backup: out, audit: auditPath,
        confirmedAudit: intentPath, result: resultPath, sha256: backupHash,
        removed: pruned.removed, kept: pruned.kept,
        fingerprintBefore: pruned.fingerprintBefore, fingerprintAfter: pruned.fingerprintAfter,
        serverSeq: pruned.serverSeq
      };
    });
    if (store.getPersistenceWarning()) result.persistenceWarning = store.getPersistenceWarning();
    if (auditError) {
      process.stdout.write(JSON.stringify(Object.assign({}, result, { auditError })) + '\n');
      process.exitCode = 3;
      return;
    }
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  const userId = options['--user'];
  if (command === 'delete' && options['--confirm'] !== userId) throw new Error('确认值必须与 userId 完全一致');
  const exportedAt = new Date().toISOString();
  let auditError = null;
  const result = store.withFreshStoreLock(function () {
    const backup = Object.assign({}, store.exportUserData(userId), { exportedAt });
    const backupText = JSON.stringify(backup, null, 2) + '\n';
    writeExclusive(out, backupText);
    const backupHash = sha256(backupText);
    const auditPath = out + '.audit.json';
    writeExclusive(auditPath, JSON.stringify({
      format: 'nova-partition-deletion-audit', version: 1, at: exportedAt,
      userId, status: command === 'delete' ? 'prepared' : 'exported', backup: path.basename(out), backupSha256: backupHash
    }, null, 2) + '\n');
    if (command === 'export') return { exported: true, userId, backup: out, audit: auditPath, sha256: backupHash };

    const intentPath = out + '.delete-intent.json';
    writeExclusive(intentPath, JSON.stringify({
      format: 'nova-partition-deletion-audit', version: 1, at: exportedAt, userId,
      status: 'confirmed', fingerprint: backup.fingerprint, backup: path.basename(out), backupSha256: backupHash
    }, null, 2) + '\n');
    const deleted = store.deleteUserData(userId, backup.fingerprint);
    const deletedAudit = out + '.deleted.json';
    try {
      writeExclusive(deletedAudit, JSON.stringify(Object.assign({}, deleted, {
        format: 'nova-partition-deletion-audit', version: 1, at: exportedAt,
        deletedAt: new Date().toISOString(), status: 'deleted', backup: path.basename(out), backupSha256: backupHash
      }), null, 2) + '\n');
    } catch (e) {
      auditError = e.message;
    }
    return { deleted: true, tokenRevoked: deleted.tokenRevoked === true, userId, backup: out, audit: deletedAudit, sha256: backupHash };
  });
  if (store.getPersistenceWarning()) result.persistenceWarning = store.getPersistenceWarning();
  if (auditError) {
    process.stdout.write(JSON.stringify(Object.assign({}, result, { deleted: true, auditError })) + '\n');
    process.exitCode = 3;
    return;
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}

try { main(); }
catch (e) {
  process.stderr.write('操作失败：' + e.message + '\n');
  process.exitCode = 1;
}
