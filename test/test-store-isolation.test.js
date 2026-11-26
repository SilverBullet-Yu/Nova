'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseTapOutput, assertIsolatedRun } = require('./isolation-assertions.js');

/* 子进程要跑的服务端测试文件（自带隔离存储，不碰真实数据） */
const CHILD_TEST_FILE = 'sync-merge-order.test.js';

/* 关键用例：子进程必须真实执行且通过这几条。
 * 子文件新增用例不会让断言失效；只有改名、没执行或被跳过才会失败。 */
const EXPECTED_KEY_TESTS = [
  '同任务不同 session 逆序到达均保留完整记录（跨批次）',
  'session ID 去重按用户隔离，max 不修改共享种子'
];

/** 在隔离环境里跑子进程：reporter 显式指定 TAP，便于结构化解析而不是匹配摘要数字 */
function runIsolatedChild(sentinel) {
  const env = { ...process.env, NOVA_STORE_FILE: sentinel };
  /* 子进程若继承 NODE_TEST_CONTEXT，node:test 会认为自己在测试内递归执行而跳过用例 */
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--test', '--test-reporter=tap', path.join(__dirname, CHILD_TEST_FILE)], {
    cwd: path.join(__dirname, '..'), env, encoding: 'utf8', timeout: 30000
  });
}

/** 拼一段 TAP 文本，供下方回归用例构造可控输入 */
function tapOutput(lines) {
  return ['TAP version 13'].concat(lines).join('\n') + '\n';
}

test('服务端测试不覆盖调用方指定的存储文件', () => {
  const root = path.join(__dirname, '..', '.tmp');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'test-store-sentinel-'));
  const sentinel = path.join(dir, 'sentinel.json');
  const before = JSON.stringify({ sentinel: { userId: 'sentinel', seq: 7, state: {}, entities: {}, opIndex: [], dayAssignWrites: [], replanRecords: [], replanSeq: 0, planBaseline: null } });
  fs.writeFileSync(sentinel, before, 'utf8');

  const child = runIsolatedChild(sentinel);

  assert.equal(child.status, 0, child.stderr || child.stdout);
  /* 不再写死子测试数量：解析 TAP，确认关键用例真的跑过并通过 */
  const parsed = assertIsolatedRun(child.stdout, EXPECTED_KEY_TESTS);
  assert.ok(parsed.passed.length >= EXPECTED_KEY_TESTS.length, '子进程实际通过的用例数少于关键用例数');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), before, '测试不应修改外部指定的文件');
});

test('隔离断言：子测试数量增加仍然接受', () => {
  const stdout = tapOutput([
    'ok 1 - ' + EXPECTED_KEY_TESTS[0],
    'ok 2 - ' + EXPECTED_KEY_TESTS[1],
    'ok 3 - 后续新增用例一',
    'ok 4 - 后续新增用例二',
    '1..4',
    '# tests 4',
    '# pass 4',
    '# fail 0',
    '# skipped 0'
  ]);
  const parsed = assertIsolatedRun(stdout, EXPECTED_KEY_TESTS);
  assert.equal(parsed.passed.length, 4);
  assert.equal(parsed.total, 4);
});

test('隔离断言：空输出或零用例拒绝', () => {
  assert.throws(() => assertIsolatedRun('', EXPECTED_KEY_TESTS), /没有输出任何 TAP 用例结果/);
  assert.throws(
    () => assertIsolatedRun(tapOutput(['1..0', '# tests 0', '# pass 0', '# fail 0']), EXPECTED_KEY_TESTS),
    /没有输出任何 TAP 用例结果/
  );
});

test('隔离断言：关键用例缺失拒绝', () => {
  const stdout = tapOutput([
    'ok 1 - ' + EXPECTED_KEY_TESTS[0],
    'ok 2 - 另外一个用例',
    '1..2',
    '# tests 2',
    '# pass 2',
    '# fail 0',
    '# skipped 0'
  ]);
  assert.throws(() => assertIsolatedRun(stdout, EXPECTED_KEY_TESTS), /未真正执行预期关键用例/);
});

test('隔离断言：关键用例被跳过拒绝', () => {
  const stdout = tapOutput([
    'ok 1 - ' + EXPECTED_KEY_TESTS[0],
    'ok 2 - ' + EXPECTED_KEY_TESTS[1] + ' # SKIP',
    '1..2',
    '# tests 2',
    '# pass 1',
    '# fail 0',
    '# skipped 1'
  ]);
  assert.throws(() => assertIsolatedRun(stdout, EXPECTED_KEY_TESTS), /跳过或 todo 用例/);
});

test('隔离断言：存在失败用例拒绝', () => {
  const stdout = tapOutput([
    'ok 1 - ' + EXPECTED_KEY_TESTS[0],
    'not ok 2 - ' + EXPECTED_KEY_TESTS[1],
    '1..2',
    '# tests 2',
    '# pass 1',
    '# fail 1',
    '# skipped 0'
  ]);
  assert.throws(() => assertIsolatedRun(stdout, EXPECTED_KEY_TESTS), /存在失败用例/);
});

test('隔离断言：TAP 解析能区分通过、失败与跳过', () => {
  const stdout = tapOutput([
    'ok 1 - 通过的用例',
    'not ok 2 - 失败的用例',
    'ok 3 - 跳过的用例 # SKIP',
    'ok 4 - todo 的用例 # TODO',
    '1..4',
    '# tests 4',
    '# pass 2',
    '# fail 1',
    '# skipped 1'
  ]);
  const parsed = parseTapOutput(stdout);
  assert.deepEqual(parsed.passed, ['通过的用例']);
  assert.deepEqual(parsed.failed, ['失败的用例']);
  assert.deepEqual(parsed.skipped, ['跳过的用例', 'todo 的用例']);
  assert.equal(parsed.total, 4);
});

test('隔离断言：TAP 解析忽略 ANSI 颜色码', () => {
  const stdout = tapOutput([
    '\u001b[32mok 1 - 带颜色的用例\u001b[39m',
    '1..1',
    '# tests 1',
    '# pass 1',
    '# fail 0'
  ]);
  const parsed = parseTapOutput(stdout);
  assert.deepEqual(parsed.passed, ['带颜色的用例']);
});
