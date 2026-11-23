'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('服务端测试不覆盖调用方指定的存储文件', () => {
  const root = path.join(__dirname, '..', '.tmp');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'test-store-sentinel-'));
  const sentinel = path.join(dir, 'sentinel.json');
  const before = JSON.stringify({ sentinel: { userId: 'sentinel', seq: 7, state: {}, entities: {}, opIndex: [], dayAssignWrites: [], replanRecords: [], replanSeq: 0, planBaseline: null } });
  fs.writeFileSync(sentinel, before, 'utf8');
  const env = { ...process.env, NOVA_STORE_FILE: sentinel };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ['--test', path.join(__dirname, 'sync-merge-order.test.js')], {
    cwd: path.join(__dirname, '..'), env, encoding: 'utf8', timeout: 30000
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.match(child.stdout, /tests 8/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), before, '测试不应修改外部指定的文件');
});
