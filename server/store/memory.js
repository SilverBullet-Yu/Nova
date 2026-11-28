'use strict';
/* 诺瓦 Nova · 内存存储（按用户分区，无数据库）
 *
 * 契约：docs/HANDOFF.md §5（同步协议 / 幂等 / 字段级合并）
 * 职责：每个用户一份 seed 副本 + opId 幂等索引 + replan_record 快照
 *
 * 身份：userId 只由 server/auth.js 从凭证解析后传入；本模块不读取请求体里的 userId。
 * 分区：所有读写都落在 partitions.get(userId) 上，用户之间不共享 state / ops / seq。
 * 纯度约束：服务端不读时钟做业务判断。时间一律用单调计数器（serverSeq）。
 */

const { seed } = require('../../shared/data/seed.js');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** 演示基线 seq（与现有 demo 顶栏「seq 88123」一致） */
const BASE_SEQ = 88123;

/** 单批上行上限（契约：≤ 200） */
const MAX_SYNC_BATCH = 200;
let STORE_FILE = process.env.NOVA_STORE_FILE || path.join(__dirname, '..', 'data', 'nova-store.json');
let STORE_PARTITIONED = process.env.NOVA_STORE_PARTITIONED === '1';
let MANIFEST_FILE = STORE_FILE + '.manifest.json';
let MODE_MARKER_FILE = STORE_FILE + '.partitioned.json';
let REVOKED_USERS_FILE = STORE_FILE + '.revoked.json';
let PARTS_DIR = STORE_FILE + '.parts';

function positiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(name + ' 必须是正安全整数');
  return value;
}

let MAX_STORE_BYTES = positiveIntEnv('NOVA_STORE_MAX_BYTES', 16 * 1024 * 1024);
let MAX_PARTITIONS = positiveIntEnv('NOVA_STORE_MAX_PARTITIONS', 1024);

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function num(v, dflt) {
  return typeof v === 'number' && isFinite(v) ? v : dflt;
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/* ── 字段级合并策略 ────────────────────────────────────────────────────────
 * tombstone：删除类，墓碑优先，一旦置位不可翻转
 * sum      ：计数类（可累加），求和
 * max      ：计数类（不可累加，如单次时长），取最大值
 * lastWrite：状态类，最后写入优先（同 clientTs 时以 serverSeq 大者为准）
 * ----------------------------------------------------------------------- */
const TOMBSTONE_FIELDS = ['deleted', 'isDeleted', 'deletedAt'];
const SUM_FIELDS = ['count', 'sessionCount', 'sessions', 'times'];
const MAX_FIELDS = ['actual', 'durationMin', 'minutes', 'duration'];

function policyOf(field) {
  const f = String(field || '');
  if (TOMBSTONE_FIELDS.indexOf(f) >= 0) return 'tombstone';
  if (SUM_FIELDS.indexOf(f) >= 0) return 'sum';
  if (MAX_FIELDS.indexOf(f) >= 0) return 'max';
  return 'lastWrite';
}

function isDeleteValue(v) {
  return v === true || v === 1 || v === '1' ||
    (typeof v === 'string' && v.toLowerCase() === 'true');
}

/* ── 用户分区 ─────────────────────────────────────────────────────────── */
/** userId → 分区；分区之间完全隔离 */
let partitions = new Map();
let storeLockHeld = false;
let storeLockToken = null;
let lastPersistWarning = null;
let diskPartitions = new Map();
let revokedUsers = new Set();
let LOCK_FILE = STORE_FILE + '.lock';

function createPartition(userId) {
  return {
    userId: userId,
    seq: BASE_SEQ,
    state: Object.assign(clone(seed), { sessionTombstones: {}, sessionsClearedAt: 0, dataClearedAt: 0 }),
    entities: {},       // entity → entityId → field → { value, tombstone, clientTs, seq }
    opIndex: new Map(), // opId → serverSeq（分区内 op_id 唯一，幂等兜底）
    dayAssignWrites: new Map(), // taskId → 改期字段合并桶，避免不同任务互相覆盖
    replanRecords: [],
    replanSeq: 0,
    planBaseline: null
  };
}

function partitionPayload(p) {
  return {
    userId: p.userId, seq: p.seq, state: p.state, entities: p.entities,
    opIndex: Array.from(p.opIndex.entries()),
    dayAssignWrites: Array.from(p.dayAssignWrites.entries()),
    replanRecords: p.replanRecords, replanSeq: p.replanSeq,
    planBaseline: p.planBaseline
  };
}

function partitionFingerprint(p) {
  return crypto.createHash('sha256').update(JSON.stringify(partitionPayload(p))).digest('hex');
}

function snapshotPartition(p) {
  return {
    seq: p.seq,
    state: clone(p.state),
    entities: clone(p.entities),
    opIndex: new Map(p.opIndex),
    dayAssignWrites: new Map(Array.from(p.dayAssignWrites, ([taskId, bucket]) => [taskId, clone(bucket)])),
    replanRecords: clone(p.replanRecords),
    replanSeq: p.replanSeq,
    planBaseline: clone(p.planBaseline)
  };
}

function restorePartition(p, saved) {
  p.seq = saved.seq;
  p.state = saved.state;
  p.entities = saved.entities;
  p.opIndex = saved.opIndex;
  p.dayAssignWrites = saved.dayAssignWrites;
  p.replanRecords = saved.replanRecords;
  p.replanSeq = saved.replanSeq;
  p.planBaseline = saved.planBaseline;
}

function partitionRevision(p) {
  return [p.seq, p.replanSeq, p.planBaseline ? p.planBaseline.version : ''].join(':');
}

function revisionConflict(expectedRevision, actualRevision) {
  const error = new Error('计划状态已变化，请重新预览');
  error.code = 'REVISION_CONFLICT';
  error.expectedRevision = expectedRevision;
  error.actualRevision = actualRevision;
  return error;
}

function commitPartition(userId, mutate, expectedRevision) {
  return withFreshStoreLock(function () {
    const id = String(userId === undefined || userId === null ? '' : userId);
    const existed = partitions.has(id);
    const p = partitionOf(userId);
    /* 锁内已重读提交点；expectedRevision 必须与这份最新快照一致。 */
    if (expectedRevision !== undefined && expectedRevision !== partitionRevision(p)) {
      throw revisionConflict(expectedRevision, partitionRevision(p));
    }
    const before = snapshotPartition(p);
    try {
      const result = mutate(p);
      persist();
      return result;
    } catch (e) {
      if (existed) restorePartition(p, before);
      else partitions.delete(id);
      throw e;
    }
  });
}

function storeLockTimeoutMs() {
  const raw = process.env.NOVA_STORE_LOCK_TIMEOUT_MS;
  const configured = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(configured) && configured >= 0 ? configured : 5000;
}

function acquireStoreLock() {
  if (storeLockHeld) return;
  const dir = path.dirname(STORE_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const timeoutMs = storeLockTimeoutMs();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let fd;
    let created = false;
    const token = crypto.randomBytes(16).toString('hex');
    try {
      fd = fs.openSync(LOCK_FILE, 'wx', 0o600);
      created = true;
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token }), 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      storeLockHeld = true;
      storeLockToken = token;
      return;
    } catch (e) {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch (closeError) { /* 保留原始错误 */ } }
      if (created) {
        try { fs.rmSync(LOCK_FILE, { force: true }); } catch (cleanupError) { /* 保留原始错误 */ }
      }
      if (!e || e.code !== 'EEXIST') throw e;
      /* PID/时间只能说明锁“可能”陈旧，不能证明路径仍属于原持有者。
         等待者绝不删除他人创建的锁，避免删除后被替换的新锁。 */
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const wait = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(wait, 0, 0, Math.min(20, remaining));
    }
  }
  const error = new Error('Nova 存储锁等待超时（' + timeoutMs + 'ms）：' + LOCK_FILE +
    '；未自动删除无法确认归属的锁，请人工核实锁文件及持有进程后处理');
  error.code = 'STORE_LOCK_TIMEOUT';
  throw error;
}

function releaseStoreLock() {
  if (!storeLockHeld) return;
  const token = storeLockToken;
  storeLockHeld = false;
  storeLockToken = null;
  try {
    const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (lock.token === token) fs.rmSync(LOCK_FILE, { force: true });
  } catch (e) { /* 锁丢失或已替换时不删除他人锁 */ }
}

function atomicWriteFile(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(16).toString('hex') + '.tmp';
  let created = false;
  try {
    /* wx 拒绝预置文件/符号链接；只有确认由本次调用创建后才允许清理。 */
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    created = true;
    const fd = fs.openSync(tmp, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    let renamed = false;
    let lastError = null;
    for (let attempt = 0; attempt < 5 && !renamed; attempt++) {
      try {
        fs.renameSync(tmp, file);
        renamed = true;
      } catch (e) {
        lastError = e;
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(e && e.code)) throw e;
        const wait = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(wait, 0, 0, 10);
      }
    }
    if (!renamed) throw lastError;
    if (process.platform !== 'win32') {
      try {
        const dirFd = fs.openSync(dir, 'r');
        try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      } catch (syncError) { lastPersistWarning = '目录项同步失败，rename 已提交但掉电耐久性未确认'; }
    }
  } catch (e) {
    if (created) {
      try { fs.rmSync(tmp, { force: true }); } catch (cleanupError) { /* 保留原始错误 */ }
    }
    throw e;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

const PARTITION_FILE_PATTERN = /^[0-9a-f]{64}-[0-9a-f]{64}\.json$/;
const PARTITIONED_MODE_MARKER_TEXT = JSON.stringify({ format: 'nova-store-mode', version: 1, layout: 'partitioned' });

function isManifestTempFile(file) {
  const prefix = path.basename(MANIFEST_FILE) + '.';
  if (!file.startsWith(prefix)) return false;
  const suffix = file.slice(prefix.length);
  /* 同时识别历史计数器临时名与当前 PID + 32 位随机十六进制临时名。 */
  return /^[0-9]+\.[0-9]+\.tmp$/.test(suffix) || /^[0-9]+\.[0-9a-f]{32}\.tmp$/.test(suffix);
}

function partitionedTempPath(file) {
  if (path.basename(file) !== file) throw new Error('非法临时文件名：' + file);
  return isManifestTempFile(file)
    ? path.join(path.dirname(MANIFEST_FILE), file)
    : path.join(PARTS_DIR, file);
}

function partitionFileName(userId, contentHash) {
  return sha256(userId) + '-' + contentHash + '.json';
}

function assertSafePartsDirectory() {
  if (!storePathExists(PARTS_DIR)) return;
  const stat = fs.lstatSync(PARTS_DIR);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Nova 分区目录不是普通目录，拒绝写入：' + PARTS_DIR);
  }
}

function validatePartitionedModeMarker() {
  const stat = fs.lstatSync(MODE_MARKER_FILE);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Nova 分区模式标记不是普通文件：' + MODE_MARKER_FILE);
  try {
    const marker = JSON.parse(fs.readFileSync(MODE_MARKER_FILE, 'utf8'));
    if (!isPlainObject(marker) || marker.format !== 'nova-store-mode' ||
        marker.version !== 1 || marker.layout !== 'partitioned') throw new Error('invalid mode marker');
  } catch (e) {
    throw new Error('Nova 分区模式标记损坏：' + MODE_MARKER_FILE);
  }
}

function ensurePartitionedModeMarker() {
  if (storePathExists(MODE_MARKER_FILE)) {
    validatePartitionedModeMarker();
    return;
  }
  atomicWriteFile(MODE_MARKER_FILE, PARTITIONED_MODE_MARKER_TEXT);
}

/* manifest 是唯一提交点；盘点只读取 manifest 和文件元数据，不返回分区内容。 */
function readCompactionManifestUnlocked() {
  if (!STORE_PARTITIONED) {
    throw new Error('分区文件盘点与回收仅支持 NOVA_STORE_PARTITIONED=1；旧 JSON 模式不提供 compact');
  }
  if (!fs.existsSync(MANIFEST_FILE)) {
    throw new Error('Nova 分区 manifest 不存在，无法盘点或回收：' + MANIFEST_FILE);
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
    if (!isPlainObject(manifest) || manifest.format !== 'nova-store-manifest' ||
        manifest.version !== 1 || !isPlainObject(manifest.partitions)) {
      throw new Error('invalid manifest');
    }
    for (const [userId, entry] of Object.entries(manifest.partitions)) {
      if (!userId || !isPlainObject(entry) || typeof entry.file !== 'string' ||
          path.basename(entry.file) !== entry.file || !PARTITION_FILE_PATTERN.test(entry.file) ||
          typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256) ||
          entry.file !== partitionFileName(userId, entry.sha256) ||
          !Number.isSafeInteger(entry.seq) || entry.seq < 0) {
        throw new Error('invalid manifest partition');
      }
    }
  } catch (e) {
    throw new Error('Nova 分区 manifest 损坏，拒绝盘点或回收：' + MANIFEST_FILE);
  }
  return manifest;
}

function inspectPartitionedFilesUnlocked() {
  const manifest = readCompactionManifestUnlocked();
  const referenced = Array.from(new Set(Object.values(manifest.partitions).map(entry => entry.file))).sort();
  const referencedSet = new Set(referenced);
  const orphans = [];
  const tempFiles = [];
  let entries;
  try {
    const dirStat = fs.lstatSync(PARTS_DIR);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error('parts 路径不是普通目录');
    entries = fs.readdirSync(PARTS_DIR, { withFileTypes: true });
  } catch (e) {
    if (e && e.code === 'ENOENT') entries = [];
    else throw e;
  }
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of entries) {
    const isTemp = entry.name.endsWith('.tmp');
    if ((!isTemp && !PARTITION_FILE_PATTERN.test(entry.name)) || referencedSet.has(entry.name)) continue;
    /* 目录、符号链接和无法识别的文件一律不纳入回收范围。 */
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const target = path.join(PARTS_DIR, entry.name);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    if (isTemp) tempFiles.push(entry.name);
    else orphans.push({ file: entry.name, bytes: stat.size, mtimeMs: stat.mtimeMs });
  }
  const storeDir = path.dirname(MANIFEST_FILE);
  for (const entry of fs.readdirSync(storeDir, { withFileTypes: true })) {
    if (!isManifestTempFile(entry.name) || !entry.isFile() || entry.isSymbolicLink()) continue;
    const stat = fs.lstatSync(path.join(storeDir, entry.name));
    if (stat.isFile() && !stat.isSymbolicLink()) tempFiles.push(entry.name);
  }
  tempFiles.sort();
  return { referenced, orphans, tempFiles };
}

function withPartitionedFileLock(inspect) {
  if (!STORE_PARTITIONED) {
    throw new Error('分区文件盘点与回收仅支持 NOVA_STORE_PARTITIONED=1；旧 JSON 模式不提供 compact');
  }
  /* CLI 可在同一把锁内先写审计再回收；已持锁时只重读磁盘，不嵌套释放锁。 */
  return storeLockHeld ? inspect() : withFreshStoreLock(inspect);
}

function inspectPartitionedFiles() {
  return withPartitionedFileLock(inspectPartitionedFilesUnlocked);
}

function compactPartitionedFiles(removeOrphans = false) {
  if (typeof removeOrphans !== 'boolean') throw new Error('removeOrphans 必须是布尔值');
  return withPartitionedFileLock(function () {
    const inventory = inspectPartitionedFilesUnlocked();
    const deletedFiles = inventory.orphans.map(row => row.file).concat(inventory.tempFiles);
    const result = {
      referenced: inventory.referenced,
      orphans: inventory.orphans,
      tempFiles: inventory.tempFiles,
      deleted: 0,
      retained: inventory.referenced.length + deletedFiles.length,
      deletedOrphans: 0,
      deletedTempFiles: 0,
      retainedOrphans: inventory.orphans.length,
      retainedTempFiles: inventory.tempFiles.length,
      deletedFiles: [],
      retainedFiles: inventory.referenced.concat(deletedFiles),
      persistenceWarning: lastPersistWarning
    };
    if (!removeOrphans) return result;

    for (const file of deletedFiles) {
      /* 删除前再次重读提交点；即使锁外有人改动文件系统，也绝不删除已引用文件。 */
      const current = readCompactionManifestUnlocked();
      if (Object.values(current.partitions).some(entry => entry.file === file)) {
        throw new Error('分区文件已被 manifest 引用，回收已中止：' + file);
      }
      const target = partitionedTempPath(file);
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('待回收路径不是普通文件，回收已中止：' + file);
      }
      fs.rmSync(target, { force: true });
      result.deletedFiles.push(file);
      result.deleted += 1;
      if (file.endsWith('.tmp')) result.deletedTempFiles += 1;
      else result.deletedOrphans += 1;
    }
    result.retained -= result.deleted;
    result.retainedOrphans = 0;
    result.retainedTempFiles = 0;
    result.retainedFiles = inventory.referenced.slice();
    result.orphans = [];
    result.tempFiles = [];
    return result;
  });
}

function partitionedDiskBytesUnlocked() {
  let bytes = 0;
  for (const file of [MODE_MARKER_FILE, MANIFEST_FILE, REVOKED_USERS_FILE]) {
    if (!storePathExists(file)) continue;
    const stat = fs.lstatSync(file);
    if (stat.isFile() && !stat.isSymbolicLink()) bytes += stat.size;
  }
  if (!storePathExists(PARTS_DIR)) return bytes;
  for (const entry of fs.readdirSync(PARTS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    bytes += fs.lstatSync(path.join(PARTS_DIR, entry.name)).size;
  }
  return bytes;
}

/* 内容寻址文件不可覆盖；manifest 是唯一提交点，旧版本和已有存储上的失败事务孤儿文件均保留。 */
function persistPartitionedUnlocked() {
  const markerExisted = storePathExists(MODE_MARKER_FILE);
  const manifestExisted = storePathExists(MANIFEST_FILE);
  const partsExisted = storePathExists(PARTS_DIR);
  if (markerExisted) validatePartitionedModeMarker();
  assertSafePartsDirectory();
  const manifest = { format: 'nova-store-manifest', version: 1, partitions: Object.create(null) };
  const nextDiskPartitions = new Map();
  const writes = [];
  for (const [userId, p] of partitions) {
    const text = JSON.stringify(partitionPayload(p));
    const contentHash = sha256(text);
    const previous = diskPartitions.get(userId);
    const changed = !previous || previous.sha256 !== contentHash;
    const file = changed ? partitionFileName(userId, contentHash) : previous.file;
    const target = path.join(PARTS_DIR, file);
    if (storePathExists(target)) {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error('Nova 分区内容寻址文件不是普通文件：' + target);
      }
      if (sha256(fs.readFileSync(target)) !== contentHash) {
        throw new Error('Nova 分区内容寻址文件损坏：' + target);
      }
    } else if (changed) {
      writes.push({ target, text });
    } else {
      throw new Error('Nova 分区内容寻址文件缺失：' + target);
    }
    manifest.partitions[userId] = { file: file, sha256: contentHash, seq: p.seq };
    nextDiskPartitions.set(userId, { file: file, sha256: contentHash, seq: p.seq });
  }
  const manifestText = JSON.stringify(manifest);
  const oldManifestBytes = manifestExisted ? fs.lstatSync(MANIFEST_FILE).size : 0;
  const newPartsBytes = writes.reduce((sum, write) => sum + Buffer.byteLength(write.text, 'utf8'), 0);
  const markerBytes = markerExisted ? 0 : Buffer.byteLength(PARTITIONED_MODE_MARKER_TEXT, 'utf8');
  const bytes = partitionedDiskBytesUnlocked() - oldManifestBytes + markerBytes + newPartsBytes + Buffer.byteLength(manifestText, 'utf8');
  if (bytes > MAX_STORE_BYTES) throw new RangeError('持久化字节预算不足：' + bytes + ' / ' + MAX_STORE_BYTES);

  const createdParts = [];
  try {
    /* 预算通过后才创建模式标记；首次 manifest 提交失败时仅清理本次创建的文件。 */
    ensurePartitionedModeMarker();
    for (const write of writes) {
      createdParts.push(write.target);
      atomicWriteFile(write.target, write.text);
    }
    atomicWriteFile(MANIFEST_FILE, manifestText);
  } catch (e) {
    if (!manifestExisted) {
      for (const target of createdParts) {
        try { fs.rmSync(target, { force: true }); } catch (cleanupError) { /* 保留原始持久化错误 */ }
      }
      if (!markerExisted && storePathExists(MODE_MARKER_FILE)) {
        try { fs.rmSync(MODE_MARKER_FILE, { force: true }); } catch (cleanupError) { /* 保留原始持久化错误 */ }
      }
      if (!partsExisted && storePathExists(PARTS_DIR)) {
        try { fs.rmdirSync(PARTS_DIR); } catch (cleanupError) { /* 目录非空或已不存在时不删除他人文件 */ }
      }
    }
    throw e;
  }
  /* 只有 manifest 原子替换成功后才推进内存中的磁盘基线。 */
  diskPartitions = nextDiskPartitions;
}

function persistUnlocked() {
  if (STORE_PARTITIONED) {
    persistPartitionedUnlocked();
    return;
  }
  const payload = Object.create(null);
  for (const [userId, p] of partitions) payload[userId] = partitionPayload(p);
  const text = JSON.stringify(payload);
  const bytes = Buffer.byteLength(text, 'utf8') + (storePathExists(REVOKED_USERS_FILE) ? fs.lstatSync(REVOKED_USERS_FILE).size : 0);
  if (bytes > MAX_STORE_BYTES) throw new RangeError('持久化字节预算不足：' + bytes + ' / ' + MAX_STORE_BYTES);
  atomicWriteFile(STORE_FILE, text);
}

function reportPersistenceWarning() {
  if (!lastPersistWarning) return;
  if (typeof console !== 'undefined' && typeof console.warn === 'function') console.warn('[nova] ' + lastPersistWarning);
}

function persist() {
  lastPersistWarning = null;
  if (storeLockHeld) {
    persistUnlocked();
    reportPersistenceWarning();
    return;
  }
  acquireStoreLock();
  try { persistUnlocked(); reportPersistenceWarning(); }
  finally { releaseStoreLock(); }
}

function withFreshStoreLock(mutate) {
  /* 同步存储 API 不重入；外层锁已完成刷新，内层直接使用同一份快照。 */
  if (storeLockHeld) return mutate();
  acquireStoreLock();
  const previousPartitions = partitions;
  const previousDiskPartitions = diskPartitions;
  partitions = new Map();
  diskPartitions = new Map();
  try {
    restore();
    return mutate();
  } catch (e) {
    partitions = previousPartitions;
    diskPartitions = previousDiskPartitions;
    throw e;
  } finally {
    releaseStoreLock();
  }
}

function validPairEntries(value, label, validValue) {
  if (!Array.isArray(value)) return false;
  const seen = new Set();
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || seen.has(entry[0])) return false;
    if (!validValue(entry[1])) return false;
    seen.add(entry[0]);
  }
  return true;
}

function validFieldRecord(record, strict) {
  if (!isPlainObject(record) ||
      !Object.prototype.hasOwnProperty.call(record, 'value') ||
      !Number.isFinite(record.clientTs) || !Number.isFinite(record.seq) ||
      typeof record.tombstone !== 'boolean') return false;
  return !strict || (Object.keys(record).length === 4 &&
    ['value', 'clientTs', 'seq', 'tombstone'].every(key => Object.prototype.hasOwnProperty.call(record, key)));
}

function validFieldBucket(bucket, strict) {
  return isPlainObject(bucket) && Object.values(bucket).every(record => validFieldRecord(record, strict));
}

function validStateElement(field, value) {
  if (!isPlainObject(value)) return false;
  if (field === 'tasks') {
    return (typeof value.id === 'string' && value.id.length > 0) || Number.isSafeInteger(value.id);
  }
  /* session 允许完整记录、无 ID 对象与旧式 { entityId, field, value } 包装。 */
  return true;
}

function validatePersisted(raw, strict) {
  if (!isPlainObject(raw)) throw new Error('invalid root');
  for (const [userId, saved] of Object.entries(raw)) {
    if (!userId || !isPlainObject(saved)) throw new Error('invalid partition');
    if (saved.userId !== undefined && String(saved.userId) !== userId) throw new Error('invalid user id');
    if (saved.seq !== undefined && (!Number.isSafeInteger(saved.seq) || saved.seq < 0)) throw new Error('invalid seq');
    if (saved.state !== undefined && !isPlainObject(saved.state)) throw new Error('invalid state');
    if (isPlainObject(saved.state)) {
      for (const field of ['tasks', 'sessions']) {
        if (saved.state[field] !== undefined &&
            (!Array.isArray(saved.state[field]) || saved.state[field].some(value => !validStateElement(field, value)))) {
          throw new Error('invalid state ' + field);
        }
      }
      for (const field of ['user', 'goal', 'feas', 'notif', 'locks', 'dayAssign']) {
        if (saved.state[field] !== undefined && !isPlainObject(saved.state[field])) throw new Error('invalid state ' + field);
      }
    }
    if (saved.entities !== undefined && !isPlainObject(saved.entities)) throw new Error('invalid entities');
    if (isPlainObject(saved.entities)) {
      for (const [entity, byId] of Object.entries(saved.entities)) {
        if (!isPlainObject(byId)) throw new Error('invalid entity ' + entity);
        for (const [entityId, fields] of Object.entries(byId)) {
          if (!isPlainObject(fields)) throw new Error('invalid entity id ' + entityId);
          for (const [field, record] of Object.entries(fields)) {
            if (!validFieldRecord(record, strict)) throw new Error('invalid field ' + entity + '/' + field);
          }
        }
      }
    }
    if (saved.opIndex !== undefined && !validPairEntries(saved.opIndex, 'opIndex', value =>
      Number.isSafeInteger(value) && value >= 0)) {
      throw new Error('invalid opIndex');
    }
    if (saved.dayAssignWrites !== undefined && !validPairEntries(saved.dayAssignWrites, 'dayAssignWrites', bucket => validFieldBucket(bucket, strict))) {
      throw new Error('invalid dayAssignWrites');
    }
    if (saved.replanRecords !== undefined && (!Array.isArray(saved.replanRecords) || saved.replanRecords.some(record => !isPlainObject(record)))) throw new Error('invalid replan records');
    if (saved.replanSeq !== undefined && (!Number.isSafeInteger(saved.replanSeq) || saved.replanSeq < 0)) throw new Error('invalid replan seq');
    if (saved.planBaseline !== undefined && saved.planBaseline !== null && !isPlainObject(saved.planBaseline)) {
      throw new Error('invalid plan baseline');
    }
  }
}

function validatePersistedStrict(raw) {
  if (!isPlainObject(raw)) throw new Error('invalid root');
  const required = ['userId', 'seq', 'state', 'entities', 'opIndex', 'dayAssignWrites', 'replanRecords', 'replanSeq', 'planBaseline'];
  for (const [userId, saved] of Object.entries(raw)) {
    if (!userId || !isPlainObject(saved)) throw new Error('invalid partition');
    const keys = Object.keys(saved);
    if (keys.length !== required.length || !required.every(key => Object.prototype.hasOwnProperty.call(saved, key))) {
      throw new Error('invalid partition schema');
    }
  }
  validatePersisted(raw, true);
}

function isStrictRecord(value) {
  if (!isPlainObject(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value, ancestors) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  ancestors.add(value);
  let valid;
  if (Array.isArray(value)) {
    valid = Object.keys(value).length === value.length;
    for (let i = 0; valid && i < value.length; i++) valid = isJsonValue(value[i], ancestors);
  } else if (isStrictRecord(value) && Object.getOwnPropertySymbols(value).length === 0) {
    valid = true;
    for (const key of Object.keys(value)) {
      if (!isJsonValue(value[key], ancestors)) { valid = false; break; }
    }
  } else {
    valid = false;
  }
  ancestors.delete(value);
  return valid;
}

function verifyStoreBackup(input) {
  let backup = input;
  let bytes = null;
  if (typeof input === 'string') {
    bytes = Buffer.byteLength(input, 'utf8');
    try { backup = JSON.parse(input); }
    catch (e) { throw new Error('无效的全库备份 JSON'); }
  }
  if (!isStrictRecord(backup)) throw new Error('invalid backup root');
  const keys = Object.keys(backup);
  if (keys.length !== 4 || !['format', 'version', 'layout', 'data'].every(key =>
    Object.prototype.hasOwnProperty.call(backup, key))) {
    throw new Error('invalid backup envelope');
  }
  if (backup.format !== 'nova-store-backup') throw new Error('invalid backup format');
  if (backup.version !== 1) throw new Error('invalid backup version');
  if (backup.layout !== 'legacy' && backup.layout !== 'partitioned') throw new Error('invalid backup layout');
  if (!isStrictRecord(backup.data)) throw new Error('invalid backup data');
  if (!isJsonValue(backup.data, new Set())) throw new Error('invalid backup JSON data');

  const userIds = Object.keys(backup.data);
  let opIndex = 0;
  for (const userId of userIds) {
    if (!userId) throw new Error('invalid backup user id');
    if (!isStrictRecord(backup.data[userId])) throw new Error('invalid backup partition');
    const single = Object.create(null);
    single[userId] = backup.data[userId];
    try { validatePersistedStrict(single); }
    catch (e) { throw new Error('备份分区损坏：' + userId + '（' + e.message + '）'); }
    if (Array.isArray(backup.data[userId].opIndex)) opIndex += backup.data[userId].opIndex.length;
  }
  const result = { valid: true, layout: backup.layout, partitions: userIds.length, opIndex };
  if (bytes !== null) result.bytes = bytes;
  return result;
}

function storePathExists(file) {
  try { fs.lstatSync(file); return true; }
  catch (e) { if (e && e.code === 'ENOENT') return false; throw e; }
}

function assertRestoreTargetAbsent() {
  if (storePathExists(STORE_FILE)) throw new Error('恢复目标已存在，拒绝覆盖：' + STORE_FILE);
  if (storePathExists(MANIFEST_FILE)) throw new Error('恢复目标 manifest 已存在，拒绝覆盖：' + MANIFEST_FILE);
  if (storePathExists(MODE_MARKER_FILE)) throw new Error('恢复目标分区模式标记已存在，拒绝覆盖：' + MODE_MARKER_FILE);
  if (storePathExists(REVOKED_USERS_FILE)) throw new Error('恢复目标已撤销身份清单已存在，拒绝覆盖：' + REVOKED_USERS_FILE);
  if (storePathExists(PARTS_DIR)) throw new Error('恢复目标 parts 目录已存在，拒绝覆盖：' + PARTS_DIR);
}

function exportAllDataUnlocked() {
  const data = Object.fromEntries(Array.from(partitions, function (entry) {
    return [entry[0], clone(partitionPayload(entry[1]))];
  }));
  return {
    format: 'nova-store-backup',
    version: 1,
    layout: STORE_PARTITIONED ? 'partitioned' : 'legacy',
    data
  };
}

/** 全库逻辑快照：锁内重读 manifest/legacy 提交点，旧版本与孤儿文件不参与。 */
function exportAllData() {
  if (!storeLockHeld) return withFreshStoreLock(exportAllDataUnlocked);
  /* 已持锁时仍重读磁盘，但不嵌套释放外层锁。 */
  const previousPartitions = partitions;
  const previousDiskPartitions = diskPartitions;
  partitions = new Map();
  diskPartitions = new Map();
  try {
    restore();
    return exportAllDataUnlocked();
  } catch (e) {
    partitions = previousPartitions;
    diskPartitions = previousDiskPartitions;
    throw e;
  }
}

function importAllDataUnlocked(snapshot, expectedLayout) {
  assertRestoreTargetAbsent();
  const verified = verifyStoreBackup(snapshot);
  if (expectedLayout !== undefined && expectedLayout !== verified.layout) {
    throw new Error('备份布局与 expectedLayout 不一致：' + verified.layout + ' / ' + expectedLayout);
  }
  const targetLayout = STORE_PARTITIONED ? 'partitioned' : 'legacy';
  if (verified.layout !== targetLayout) {
    throw new Error('备份布局与目标存储模式不一致：' + verified.layout + ' / ' + targetLayout);
  }

  const partsExisted = storePathExists(PARTS_DIR);
  const markerExisted = storePathExists(MODE_MARKER_FILE);
  const restored = new Map();
  for (const [userId, saved] of Object.entries(snapshot.data)) {
    const p = createPartition(userId);
    p.seq = num(saved.seq, BASE_SEQ);
    p.state = saved.state || p.state;
    p.entities = saved.entities || {};
    p.opIndex = new Map(saved.opIndex || []);
    p.dayAssignWrites = new Map(saved.dayAssignWrites || []);
    p.replanRecords = saved.replanRecords || [];
    p.replanSeq = num(saved.replanSeq, p.replanRecords.length);
    p.planBaseline = saved.planBaseline || null;
    if (restored.size >= MAX_PARTITIONS) throw new RangeError('恢复分区数量超过预算：' + MAX_PARTITIONS);
    restored.set(userId, p);
  }
  partitions = restored;
  try { persist(); }
  catch (e) {
    if (!partsExisted && !storePathExists(STORE_FILE) && !storePathExists(MANIFEST_FILE)) {
      try { fs.rmSync(PARTS_DIR, { recursive: true, force: true }); } catch (cleanupError) { /* 保留原始持久化错误 */ }
      if (!markerExisted && storePathExists(MODE_MARKER_FILE)) {
        try { fs.rmSync(MODE_MARKER_FILE, { force: true }); } catch (cleanupError) { /* 保留原始持久化错误 */ }
      }
    }
    throw e;
  }
  return { imported: true, layout: verified.layout, partitions: verified.partitions, opIndex: verified.opIndex };
}

/** 仅恢复到全新目标；任何已存在的 STORE_FILE 或 manifest 均拒绝覆盖。 */
function importAllData(backup, expectedLayout) {
  assertRestoreTargetAbsent();
  const verified = verifyStoreBackup(backup);
  if (expectedLayout !== undefined && expectedLayout !== 'legacy' && expectedLayout !== 'partitioned') {
    throw new Error('expectedLayout 必须是 legacy 或 partitioned');
  }
  if (expectedLayout !== undefined && expectedLayout !== verified.layout) {
    throw new Error('备份布局与 expectedLayout 不一致：' + verified.layout + ' / ' + expectedLayout);
  }
  const snapshot = clone(backup);
  /* JSON 文本在锁内重新解析，调用方传入对象则先脱离外部引用。 */
  const detached = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot;
  if (storeLockHeld) {
    const previousPartitions = partitions;
    const previousDiskPartitions = diskPartitions;
    try { return importAllDataUnlocked(detached, expectedLayout); }
    catch (e) {
      partitions = previousPartitions;
      diskPartitions = previousDiskPartitions;
      throw e;
    }
  }
  acquireStoreLock();
  const previousPartitions = partitions;
  const previousDiskPartitions = diskPartitions;
  partitions = new Map();
  diskPartitions = new Map();
  try { return importAllDataUnlocked(detached, expectedLayout); }
  catch (e) {
    partitions = previousPartitions;
    diskPartitions = previousDiskPartitions;
    throw e;
  } finally { releaseStoreLock(); }
}

function restoreLegacy() {
  if (!fs.existsSync(STORE_FILE)) return;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    validatePersisted(raw);
  } catch (e) { throw new Error('Nova 持久化文件损坏：' + STORE_FILE); }
  for (const [userId, saved] of Object.entries(raw)) {
    const p = createPartition(userId);
    p.seq = num(saved.seq, BASE_SEQ);
    p.state = saved.state || p.state;
    p.entities = saved.entities || {};
    p.opIndex = new Map(saved.opIndex || []);
    p.dayAssignWrites = new Map(saved.dayAssignWrites || []);
    p.replanRecords = saved.replanRecords || [];
    p.replanSeq = num(saved.replanSeq, p.replanRecords.length);
    p.planBaseline = saved.planBaseline || null;
    partitions.set(String(userId), p);
  }
}

function validateManifestPartition(userId, saved, entry) {
  if (!isPlainObject(saved) || saved.userId !== userId ||
      !Number.isSafeInteger(saved.seq) || saved.seq < 0 || saved.seq !== entry.seq ||
      !isPlainObject(saved.state) || !isPlainObject(saved.entities) ||
      !Array.isArray(saved.opIndex) || !Array.isArray(saved.dayAssignWrites) ||
      !Array.isArray(saved.replanRecords) || !Number.isSafeInteger(saved.replanSeq) ||
      saved.replanSeq < 0 || (saved.planBaseline !== null && !isPlainObject(saved.planBaseline))) {
    throw new Error('invalid partition payload');
  }
  const single = Object.create(null);
  single[userId] = saved;
  validatePersistedStrict(single);
}

function restorePartitioned() {
  assertSafePartsDirectory();
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  } catch (e) { throw new Error('Nova 持久化文件损坏：' + MANIFEST_FILE); }
  try {
    if (!isPlainObject(manifest) || manifest.format !== 'nova-store-manifest' ||
        manifest.version !== 1 || !isPlainObject(manifest.partitions)) {
      throw new Error('invalid manifest');
    }
    const nextDiskPartitions = new Map();
    const restored = [];
    for (const [userId, entry] of Object.entries(manifest.partitions)) {
      if (!userId || !isPlainObject(entry) || typeof entry.file !== 'string' ||
          path.basename(entry.file) !== entry.file || typeof entry.sha256 !== 'string' ||
          !/^[0-9a-f]{64}$/.test(entry.sha256) ||
          !Number.isSafeInteger(entry.seq) || entry.seq < 0) {
        throw new Error('invalid manifest partition');
      }
      const expectedFile = partitionFileName(userId, entry.sha256);
      if (entry.file !== expectedFile) throw new Error('invalid partition file name');
      const target = path.join(PARTS_DIR, entry.file);
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid partition file');
      const bytes = fs.readFileSync(target);
      if (sha256(bytes) !== entry.sha256) throw new Error('partition hash mismatch');
      const saved = JSON.parse(bytes.toString('utf8'));
      validateManifestPartition(userId, saved, entry);
      restored.push([userId, saved]);
      nextDiskPartitions.set(userId, { file: entry.file, sha256: entry.sha256, seq: entry.seq });
    }
    for (const [userId, saved] of restored) {
      const p = createPartition(userId);
      p.seq = saved.seq;
      p.state = saved.state;
      p.entities = saved.entities;
      p.opIndex = new Map(saved.opIndex);
      p.dayAssignWrites = new Map(saved.dayAssignWrites);
      p.replanRecords = saved.replanRecords;
      p.replanSeq = saved.replanSeq;
      p.planBaseline = saved.planBaseline;
      partitions.set(userId, p);
    }
    diskPartitions = nextDiskPartitions;
  } catch (e) { throw new Error('Nova 持久化文件损坏：' + MANIFEST_FILE); }
}

function hasPartitionedFileEvidence() {
  if (storePathExists(MODE_MARKER_FILE) || storePathExists(MANIFEST_FILE)) return true;
  if (!storePathExists(PARTS_DIR)) return false;
  const stat = fs.lstatSync(PARTS_DIR);
  if (stat.isSymbolicLink() || !stat.isDirectory()) return true;
  return fs.readdirSync(PARTS_DIR).length > 0;
}

function restoreRevokedUsers() {
  revokedUsers = new Set();
  if (!storePathExists(REVOKED_USERS_FILE)) return;
  try {
    const stat = fs.lstatSync(REVOKED_USERS_FILE);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('invalid revoked users file');
    const saved = JSON.parse(fs.readFileSync(REVOKED_USERS_FILE, 'utf8'));
    if (!isPlainObject(saved) || saved.format !== 'nova-revoked-users' || saved.version !== 1 ||
        !Array.isArray(saved.users) || saved.users.some(id => typeof id !== 'string' || !id) ||
        new Set(saved.users).size !== saved.users.length) throw new Error('invalid revoked users');
    revokedUsers = new Set(saved.users);
  } catch (e) {
    throw new Error('Nova 已撤销身份清单损坏：' + REVOKED_USERS_FILE);
  }
}

function restore() {
  restoreRevokedUsers();
  diskPartitions = new Map();
  const hasMarker = storePathExists(MODE_MARKER_FILE);
  const hasManifest = fs.existsSync(MANIFEST_FILE);
  if (!STORE_PARTITIONED && hasPartitionedFileEvidence()) {
    throw new Error('检测到分区存储标记或 manifest，必须设置 NOVA_STORE_PARTITIONED=1；拒绝回退读取旧 JSON');
  }
  if (STORE_PARTITIONED && hasMarker) {
    validatePartitionedModeMarker();
    if (!hasManifest) throw new Error('Nova 分区 manifest 缺失，已启用分区模式标记；拒绝回退读取旧 JSON');
  }
  if (STORE_PARTITIONED && hasManifest) {
    restorePartitioned();
    return;
  }
  if (STORE_PARTITIONED && hasPartitionedFileEvidence()) {
    throw new Error('Nova 分区 manifest 与模式标记缺失，但存在分区文件；拒绝回退读取旧 JSON');
  }
  /* 无分区证据时允许首次写入前兼容旧单 JSON 文件。 */
  restoreLegacy();
}

function setStoreFile(file, partitioned = STORE_PARTITIONED) {
  if (storeLockHeld) throw new Error('存储锁持有期间不可切换存储路径');
  if (typeof file !== 'string' || !file.trim()) throw new TypeError('存储路径必须是非空字符串');
  STORE_FILE = path.resolve(file);
  STORE_PARTITIONED = partitioned === true;
  MANIFEST_FILE = STORE_FILE + '.manifest.json';
  MODE_MARKER_FILE = STORE_FILE + '.partitioned.json';
  REVOKED_USERS_FILE = STORE_FILE + '.revoked.json';
  PARTS_DIR = STORE_FILE + '.parts';
  LOCK_FILE = STORE_FILE + '.lock';
  MAX_STORE_BYTES = positiveIntEnv('NOVA_STORE_MAX_BYTES', 16 * 1024 * 1024);
  MAX_PARTITIONS = positiveIntEnv('NOVA_STORE_MAX_PARTITIONS', 1024);
}

function reload() {
  if (storeLockHeld) throw new Error('存储锁持有期间不可重载存储');
  partitions = new Map();
  diskPartitions = new Map();
  revokedUsers = new Set();
  lastPersistWarning = null;
  restore();
}

function partitionOf(userId) {
  const id = String(userId === undefined || userId === null ? '' : userId);
  if (!id) throw new Error('缺少用户身份，无法定位分区');
  if (revokedUsers.has(id)) {
    const error = new Error('用户身份已撤销');
    error.code = 'USER_REVOKED';
    throw error;
  }
  let p = partitions.get(id);
  if (!p) {
    if (partitions.size >= MAX_PARTITIONS) throw new RangeError('存储分区数量超过预算：' + MAX_PARTITIONS);
    p = createPartition(id);
    partitions.set(id, p);
  }
  return p;
}

restore();

function ensureBucket(p, entity, entityId) {
  if (!p.entities[entity]) p.entities[entity] = {};
  const byId = p.entities[entity];
  if (!byId[entityId]) byId[entityId] = {};
  return byId[entityId];
}

function applyToState(p, entity, entityId, field, value) {
  const s = p.state;
  switch (entity) {
    case 'task': {
      const t = (s.tasks || []).find((x) => String(x.id) === entityId);
      if (t) t[field] = value;
      break;
    }
    case 'user': {
      s.user = s.user || {};
      s.user[field] = value;
      break;
    }
    case 'settings': {
      if (s.notif && Object.prototype.hasOwnProperty.call(s.notif, field)) s.notif[field] = value;
      else {
        s.settings = s.settings || {};
        s.settings[field] = value;
      }
      break;
    }
    case 'goal': {
      s.goal = s.goal || {};
      s.goal[field] = value;
      break;
    }
    case 'feas': {
      s.feas = s.feas || {};
      s.feas[field] = value;
      break;
    }
    case 'week': {
      s.weekState = s.weekState || {};
      s.weekState[entityId] = s.weekState[entityId] || {};
      s.weekState[entityId][field] = value;
      break;
    }
    case 'session': {
      /* 回读形态：value 即完整 session 记录（exec.record 产出，含 status/feel），
         GET /api/state 的 seed.sessions 直接可读——闭合「后端无 session 回读接口」缺口；
         非对象 value（旧式包装）保持原样容错 */
      s.sessions = s.sessions || [];
      const id = isPlainObject(value) && value.id !== undefined && value.id !== null ? String(value.id) : '';
      if (id && s.sessions.some((x) => x && x.id !== undefined && x.id !== null && String(x.id) === id)) return false;
      s.sessions.push(isPlainObject(value) ? clone(value) : { entityId: entityId, field: field, value: value });
      return true;
    }
    case 'plan': {
      /* 回放形态：手工改期 / 锁定 / 逐条否决，GET /api/state 的 seed.dayAssign /
         seed.locks 与 replan.vetoed 直接可读——闭合「op 只写不读」的多端一致缺口 */
      if (field === 'moved' && isPlainObject(value) && value.taskId !== undefined) {
        s.dayAssign = s.dayAssign || {};
        const day = String(value.day === undefined ? '' : value.day);
        if (day && day !== '日') s.dayAssign[String(value.taskId)] = day;
        else delete s.dayAssign[String(value.taskId)];   // 回到基线日「日」= 撤销改期
      } else if (field === 'locked') {
        s.locks = s.locks || {};
        if (value === true) s.locks[String(entityId)] = true;
        else delete s.locks[String(entityId)];
      } else if (field === 'vetoed' && p.replanRecords.length) {
        const rec = p.replanRecords[p.replanRecords.length - 1];
        rec.vetoed = rec.vetoed || [];
        rec.vetoed.push({
          taskId: String(value && value.taskId !== undefined ? value.taskId : entityId),
          op: (value && value.op) || null,
          at: num(value && value.at, 0)
        });
      } else {
        applyExtra(s, entity, entityId, field, value);
      }
      break;
    }
    case 'notif': {
      /* 通知开关回放：getNotifications 由 state.notif 派生，开关状态多端可见 */
      if (s.notif && Object.prototype.hasOwnProperty.call(s.notif, field)) s.notif[field] = value;
      else applyExtra(s, entity, entityId, field, value);
      break;
    }
    case 'buffer': {
      /* 弹性位占用回放：value=true 占用（free=false） */
      if (field === 'occupied') {
        s.buffer = Object.assign({}, s.buffer || {}, { free: value !== true });
      } else {
        applyExtra(s, entity, entityId, field, value);
      }
      break;
    }
    default: {
      applyExtra(s, entity, entityId, field, value);
    }
  }
}

/** 未识别的实体 / 字段统一落入 extra 桶（原 default 分支） */
function applyExtra(s, entity, entityId, field, value) {
  s.extra = s.extra || {};
  s.extra[entity] = s.extra[entity] || {};
  s.extra[entity][entityId] = s.extra[entity][entityId] || {};
  s.extra[entity][entityId][field] = value;
}

/** max 首次合并的基线：与 applyToState 的业务字段落点一致；sum 仍按增量从 0 起算。 */
function readStateField(p, entity, entityId, field) {
  const s = p.state;
  let target;
  switch (entity) {
    case 'task': target = (s.tasks || []).find((x) => String(x.id) === entityId); break;
    case 'user': case 'goal': case 'feas': target = s[entity]; break;
    case 'settings':
      target = s.notif && Object.prototype.hasOwnProperty.call(s.notif, field) ? s.notif : s.settings;
      break;
    case 'week': target = s.weekState && s.weekState[entityId]; break;
    case 'notif':
      if (s.notif && Object.prototype.hasOwnProperty.call(s.notif, field)) {
        target = s.notif;
        break;
      }
      // 其他通知字段与 plan / buffer 的 max 字段一样落入 extra。
    default: target = s.extra && s.extra[entity] && s.extra[entity][entityId];
  }
  return target && target[field];
}

/** 字段级合并：返回是否实际改写了状态 */
function mergeField(p, record) {
  const entity = record.entity;
  const entityId = String(record.entityId === undefined ? '' : record.entityId);
  const field = record.field;
  const value = record.value;
  const policy = policyOf(field);
  /* session 记录是追加事件而非任务上的 LWW 字段；有 ID 按记录去重，
     无 ID 保留旧回读形态，由 applyOps 的 opId 索引兜底；旧计数/墓碑策略不变。 */
  if (entity === 'session' && policy === 'lastWrite') return applyToState(p, entity, entityId, field, value);

  let bucket;
  if (entity === 'plan' && entityId === 'dayAssign' && field === 'moved' &&
      isPlainObject(value) && value.taskId !== undefined) {
    const taskId = String(value.taskId);
    if (!p.dayAssignWrites.has(taskId)) p.dayAssignWrites.set(taskId, {});
    bucket = p.dayAssignWrites.get(taskId);
  } else {
    bucket = ensureBucket(p, entity, entityId);
  }
  const prev = bucket[field];
  const clientTs = num(record.clientTs, 0);
  const seq = num(record.serverSeq, p.seq);

  if (policy === 'tombstone') {
    if (prev && prev.tombstone) return false;          // 墓碑优先，不可翻转
    if (isDeleteValue(value)) {
      bucket[field] = { value: true, tombstone: true, clientTs: clientTs, seq: seq };
      applyToState(p, entity, entityId, field, true);
      return true;
    }
    if (!prev || clientTs >= prev.clientTs) {
      bucket[field] = { value: value, tombstone: false, clientTs: clientTs, seq: seq };
      applyToState(p, entity, entityId, field, value);
      return true;
    }
    return false;
  }

  if (policy === 'sum') {
    const base = prev ? num(prev.value, 0) : 0;
    const next = base + num(value, 0);
    if (!Number.isFinite(next)) throw new TypeError('求和字段超出有限数值范围');
    bucket[field] = { value: next, tombstone: false, clientTs: clientTs, seq: seq };
    applyToState(p, entity, entityId, field, next);
    return true;
  }

  if (policy === 'max') {
    const base = prev ? num(prev.value, 0) : num(readStateField(p, entity, entityId, field), 0);
    const next = Math.max(base, num(value, 0));
    if (next !== base || !prev) {
      bucket[field] = { value: next, tombstone: false, clientTs: clientTs, seq: seq };
      applyToState(p, entity, entityId, field, next);
    }
    return true;
  }

  /* lastWrite：状态类最后写入优先 */
  if (!prev || clientTs > prev.clientTs || (clientTs === prev.clientTs && seq >= prev.seq)) {
    bucket[field] = { value: value, tombstone: false, clientTs: clientTs, seq: seq };
    applyToState(p, entity, entityId, field, value);
    return true;
  }
  return false;
}

/* ── 对外接口 ─────────────────────────────────────────────────────────── */

/** 清空全部用户分区（测试与本地重置用） */
function reset() {
  return withFreshStoreLock(function () {
    const before = new Map(Array.from(partitions, ([userId, p]) => [userId, snapshotPartition(p)]));
    partitions.clear();
    try { persist(); }
    catch (e) {
      partitions.clear();
      for (const [userId, saved] of before) partitions.set(userId, Object.assign(createPartition(userId), saved));
      throw e;
    }
  });
}

function notificationsFromState(state) {
  const n = state.notif || {};
  return [
    { id: 'n_daily', kind: 'daily', enabled: n.daily !== false, title: '每日提醒', body: '19:00 · 今日 3 项' },
    { id: 'n_weekly', kind: 'weekly', enabled: n.weekly !== false, title: '周报', body: '周日 20:00 · 最少打扰' },
    { id: 'n_alert', kind: 'alert', enabled: n.alert !== false, title: '进度预警', body: '必须附带补救方案' },
    { id: 'n_rescue', kind: 'rescue', enabled: n.rescue !== false, title: '中断挽救', body: '连续 3 天无记录时触发' }
  ];
}

function readSnapshotUnlocked(userId) {
  const p = partitionOf(userId);
  return {
    userId: p.userId,
    seq: p.seq,
    revision: partitionRevision(p),
    state: clone(p.state),
    replanSeq: p.replanSeq,
    latestReplan: p.replanRecords.length ? clone(p.replanRecords[p.replanRecords.length - 1]) : null,
    planBaseline: clone(p.planBaseline)
  };
}

/** 单一锁内快照：revision、状态、重排记录与基线来自同一次磁盘刷新。 */
function readSnapshot(userId) {
  return storeLockHeld ? readSnapshotUnlocked(userId) : withFreshStoreLock(function () {
    return readSnapshotUnlocked(userId);
  });
}

function getLatestReplan(userId) {
  return readSnapshot(userId).latestReplan;
}

function recordReplan(userId, result, constraints, expectedRevision) {
  const rec = commitPartition(userId, function (partition) {
    partition.replanSeq += 1;
    const record = {
      id: 'rr_' + partition.replanSeq,
      seq: partition.replanSeq,
      strategies: clone(result.strategies || []),
      diff: clone(result.diff || []),
      loadDelta: num(result.loadDelta, 0),
      accepted: result.accepted === true,
      verdict: result.verdict || 'blocked',
      guards: clone(result.guards || {}),
      snapshot: clone(result.snapshot || null),
      nextTasks: clone(result.nextTasks || []),
      nextWeek: clone(result.nextWeek || [])
    };
    partition.replanRecords.push(record);
    if (record.accepted && constraints) {
      partition.planBaseline = { version: constraints.version, seq: partition.seq, record,
        locks: clone(constraints.locks || {}), params: clone(constraints.params || {}) };
    }
    return record;
  }, expectedRevision);
  return clone(rec);
}

/** 批量上行：opId 幂等（分区内 (user_id, op_id) 唯一），身份只取入参 userId */
function applyOps(userId, ops) {
  return commitPartition(userId, function (partition) {
    const accepted = [];
    let serverSeq = partition.seq;
    ops.forEach((op) => {
      const opId = String(op.opId);
      if (partition.opIndex.has(opId)) {
        accepted.push(opId);
        serverSeq = partition.opIndex.get(opId);
        return;
      }
      partition.seq += 1;
      const seq = partition.seq;
      partition.opIndex.set(opId, seq);
      const record = {
        serverSeq: seq,
        userId: partition.userId,
        opId: opId,
        entity: String(op.entity || 'unknown'),
        entityId: String(op.entityId === undefined ? '' : op.entityId),
        field: String(op.field || ''),
        value: op.value,
        clientTs: num(op.clientTs, 0),
        baseSeq: num(op.baseSeq, 0)
      };
      mergeField(partition, record);
      accepted.push(opId);
      serverSeq = seq;
    });
    return { accepted: accepted, serverSeq: serverSeq };
  });
}

function inventoryLabel(value) {
  const text = String(value);
  return { sha256: sha256(text), bytes: Buffer.byteLength(text, 'utf8') };
}

function getSyncInventory(includeIds) {
  return withFreshStoreLock(function () {
    const showIds = includeIds === true;
    const rows = Array.from(partitions.values()).map(function (p) {
      const entities = [];
      Object.keys(p.entities).sort().forEach(function (entity) {
        Object.keys(p.entities[entity]).sort().forEach(function (entityId) {
          const fields = Object.keys(p.entities[entity][entityId]).sort();
          entities.push(showIds ? {
            entity: entity, entityId: entityId, fields: fields
          } : {
            entity: inventoryLabel(entity), entityId: inventoryLabel(entityId),
            fields: fields.map(inventoryLabel)
          });
        });
      });
      return Object.assign({
        seq: p.seq,
        opIndexCount: p.opIndex.size,
        dayAssignWritesCount: p.dayAssignWrites.size,
        entities: entities
      }, showIds ? { userId: p.userId } : { userId: inventoryLabel(p.userId) });
    });
    return {
      format: 'nova-sync-inventory',
      version: 2,
      redacted: !showIds,
      partitions: rows,
      totals: {
        partitions: rows.length,
        entityBuckets: rows.reduce(function (sum, row) { return sum + row.entities.length; }, 0),
        opIndex: rows.reduce(function (sum, row) { return sum + row.opIndexCount; }, 0)
      }
    };
  });
}

function exportUserData(userId) {
  if (!storeLockHeld) return withFreshStoreLock(function () { return exportUserData(userId); });
  const id = String(userId === undefined || userId === null ? '' : userId);
  const p = partitions.get(id);
  if (!p) throw new Error('用户分区不存在：' + id);
  return {
    format: 'nova-partition-backup',
    version: 1,
    userId: id,
    fingerprint: partitionFingerprint(p),
    data: clone(partitionPayload(p))
  };
}

function deleteUserData(userId, expectedFingerprint) {
  if (!storeLockHeld) return withFreshStoreLock(function () { return deleteUserData(userId, expectedFingerprint); });
  const id = String(userId === undefined || userId === null ? '' : userId);
  const p = partitions.get(id);
  if (!p) throw new Error('用户分区不存在：' + id);
  if (typeof expectedFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(expectedFingerprint)) {
    throw new Error('删除需要有效的分区指纹');
  }
  if (partitionFingerprint(p) !== expectedFingerprint) throw new Error('分区已变化，删除已拒绝');
  const before = snapshotPartition(p);
  revokedUsers.add(id);
  atomicWriteFile(REVOKED_USERS_FILE, JSON.stringify({
    format: 'nova-revoked-users', version: 1, users: Array.from(revokedUsers).sort()
  }));
  partitions.delete(id);
  try { persist(); }
  catch (e) {
    partitions.set(id, Object.assign(createPartition(id), before));
    throw e;
  }
  return { userId: id, deleted: true, tokenRevoked: true, serverSeq: before.seq, fingerprint: expectedFingerprint };
}

/**
 * 显式回收用户分区的 opId 幂等索引，仅保留 serverSeq 最新的 N 条。
 *
 * 必须由管理员依据业务可重放期限裁定 keepRecent；前端不得调用，也不会自动调用。
 * 风险：旧 opId 被回收后，客户端重试可能再次应用该操作（计数类操作可能重复累加）。
 * 调用方应先在同一个 withFreshStoreLock 内取得完整备份和当前指纹；本函数在锁内重读、
 * 校验并持久化，持久化失败时恢复分区快照，state/entities/dayAssignWrites/replanRecords 不变。
 */
function pruneOpIndex(userId, keepRecent, expectedFingerprint) {
  if (!storeLockHeld) {
    return withFreshStoreLock(function () { return pruneOpIndex(userId, keepRecent, expectedFingerprint); });
  }
  const id = String(userId === undefined || userId === null ? '' : userId);
  if (!id || !partitions.has(id)) throw new Error('用户分区不存在：' + id);
  if (!Number.isSafeInteger(keepRecent) || keepRecent < 0) {
    throw new Error('keepRecent 必须是非负安全整数（0 表示不保留）');
  }
  if (typeof expectedFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(expectedFingerprint)) {
    throw new Error('回收 opIndex 需要有效的分区指纹');
  }
  const p = partitions.get(id);
  const fingerprintBefore = partitionFingerprint(p);
  if (fingerprintBefore !== expectedFingerprint) throw new Error('分区已变化，opIndex 回收已拒绝');

  const before = snapshotPartition(p);
  /* serverSeq 正常单调递增；若旧数据存在重复 seq，稳定排序按原索引顺序打破平局。 */
  const newestFirst = Array.from(p.opIndex.entries()).sort(function (a, b) {
    if (a[1] === b[1]) return 0;
    return a[1] < b[1] ? 1 : -1;
  });
  const retained = new Set(newestFirst.slice(0, keepRecent).map(function (entry) { return entry[0]; }));
  const nextOpIndex = new Map();
  for (const entry of p.opIndex) {
    if (retained.has(entry[0])) nextOpIndex.set(entry[0], entry[1]);
  }
  const removed = p.opIndex.size - nextOpIndex.size;
  p.opIndex = nextOpIndex;
  try { persist(); }
  catch (e) {
    restorePartition(p, before);
    throw e;
  }
  return {
    removed: removed,
    kept: nextOpIndex.size,
    fingerprintBefore: fingerprintBefore,
    fingerprintAfter: partitionFingerprint(p),
    serverSeq: p.seq
  };
}

function isUserRevoked(userId) {
  return revokedUsers.has(String(userId));
}

module.exports = {
  setStoreFile: setStoreFile,
  reload: reload,
  isUserRevoked: isUserRevoked,
  reset: reset,
  getSyncInventory: getSyncInventory,
  getPersistenceWarning: function () { return lastPersistWarning; },
  exportUserData: exportUserData,
  exportAllData: exportAllData,
  verifyStoreBackup: verifyStoreBackup,
  importAllData: importAllData,
  deleteUserData: deleteUserData,
  pruneOpIndex: pruneOpIndex,
  inspectPartitionedFiles: inspectPartitionedFiles,
  compactPartitionedFiles: compactPartitionedFiles,
  withFreshStoreLock: withFreshStoreLock,
  /** 该用户分区合并后的状态快照（仅测试检查内部结构用；克隆返回，
      避免业务代码经此引用绕过 applyOps 的幂等索引与合并策略直写分区） */
  getModel: function (userId) {
    return readSnapshot(userId).state;
  },
  getSeq: function (userId) {
    return readSnapshot(userId).seq;
  },
  readSnapshot: readSnapshot,
  getState: function (userId) {
    const snapshot = readSnapshot(userId);
    const baseline = snapshot.planBaseline;
    return {
      seed: snapshot.state,
      planBaseline: baseline ? { version: baseline.version, stale: baseline.seq !== snapshot.seq } : null,
      replan: snapshot.latestReplan,
      notifications: notificationsFromState(snapshot.state)
    };
  },
  getPlanBaseline: function (userId) {
    const snapshot = readSnapshot(userId);
    const baseline = snapshot.planBaseline;
    return baseline ? { version: baseline.version, stale: baseline.seq !== snapshot.seq } : null;
  },
  getLatestReplan: getLatestReplan,
  recordReplan: recordReplan,
  recordSchedule: function (userId, version, result, expectedRevision) {
    commitPartition(userId, function (partition) {
      partition.planBaseline = { version, seq: partition.seq, record: clone(result) };
    }, expectedRevision);
  },
  applyOps: applyOps,
  MAX_SYNC_BATCH: MAX_SYNC_BATCH
};
