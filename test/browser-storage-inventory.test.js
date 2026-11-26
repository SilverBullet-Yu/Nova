'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../.tools/browser-storage-inventory.js');

function storage(values) {
  return { getItem: key => Object.hasOwn(values, key) ? values[key] : null };
}

function overlay(extra = {}) {
  return {
    format: 'nova-overlay', version: 3, syncMode: 'local-only', installId: 'install-test',
    revision: 7, updatedAt: 1, tasks: [{ id: 't1', title: '不得输出的正文', est: 60 }], sessions: [],
    placementModel: {
      schemaVersion: 1, days: Array.from({ length: 7 }, () => ({})),
      placements: [{ taskId: 't1', currentSegments: [{}], originalSegments: [] }], unplanned: []
    },
    week: [], weekShift: [], ...extra
  };
}

test('只读盘点输出 A 类聚合结构且不泄露正文或凭证', async () => {
  const result = await run(storage({
    'zx.overlay': JSON.stringify(overlay()),
    'zx.op_queue': '[{"pending":true,"token":"不得输出的凭证"}]'
  }));
  const text = JSON.stringify(result);
  assert.equal(result.readOnly, true);
  assert.equal(result.keys['zx.overlay'].classificationHint, 'A');
  assert.equal(result.keys['zx.overlay'].tasks, 1);
  assert.equal(result.keys['zx.overlay'].segmentCounts.current, 1);
  assert.match(result.keys['zx.overlay'].sha256, /^[0-9a-f]{64}$/);
  assert.equal(result.keys['zx.op_queue'].pending, 1);
  assert.doesNotMatch(text, /不得输出/);
});

test('无模型且无旧区块证据归类为 B，旧区块证据归类为 C', async () => {
  const legacy = overlay({ placementModel: null });
  legacy.week = [{ segs: [['数学', 60]] }];
  const b = await run(storage({ 'zx.overlay': JSON.stringify(overlay({ placementModel: null })) }));
  const c = await run(storage({ 'zx.overlay': JSON.stringify(legacy) }));
  assert.equal(b.keys['zx.overlay'].classificationHint, 'B');
  assert.equal(c.keys['zx.overlay'].classificationHint, 'C');
  assert.equal(c.keys['zx.overlay'].legacyBlockEvidence, 1);
});

test('悬空模型引用和重复任务 ID 归 C 并给出问题计数', async () => {
  const value = overlay();
  value.tasks.push({ id: 't1', done: true });
  value.placementModel.unplanned.push({ taskId: 'missing', reason: '悬空' });
  const result = await run(storage({ 'zx.overlay': JSON.stringify(value) }));
  assert.equal(result.keys['zx.overlay'].classificationHint, 'C');
  assert.equal(result.keys['zx.overlay'].duplicateTaskIds, 1);
  assert.ok(result.keys['zx.overlay'].issues.includes('dangling-model-references'));
});

test('缺失键与损坏 JSON 只输出状态，不输出原内容', async () => {
  const result = await run(storage({ 'zx.overlay': '{不得输出的损坏内容' }));
  assert.equal(result.keys['zx.op_queue'].present, false);
  assert.equal(result.keys['zx.overlay'].parseOk, false);
  assert.equal(result.keys['zx.overlay'].classificationHint, 'C');
  assert.doesNotMatch(JSON.stringify(result), /不得输出/);
});
