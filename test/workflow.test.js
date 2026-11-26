'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkflow } = require('../shared/workflow.js');

function setup() {
  let version = 1, writes = 0, fail = false;
  const flow = createWorkflow({
    now: () => 100, version: () => version, rulesVersion: 'test-rules-1',
    tools: { plan: { preview: () => ({ label: 'private text' }), commit(draft) {
      if (fail) throw new Error('private error');
      assert.equal(draft.label, 'private text');
      version++; writes++;
    } } }
  });
  return { flow, writes: () => writes, advance: () => version++, fail: () => { fail = true; } };
}

test('草案不写入；确认只提交内部结果，重复确认不重写', () => {
  const { flow, writes } = setup();
  const preview = flow.preview('plan', {});
  assert.equal(writes(), 0);
  preview.result.label = 'changed';
  assert.equal(flow.confirm(preview.id).status, 'committed');
  assert.equal(flow.confirm(preview.id).status, 'committed');
  assert.equal(writes(), 1);
});

test('同一时间及计划版本下，重新创建工作流不会复用草案关联 ID', () => {
  const first = setup().flow;
  const next = setup().flow;
  const a = first.preview('plan', {}).id;
  const b = next.preview('plan', {}).id;
  assert.notEqual(a, b);
  assert.equal(next.confirm(a).status, 'unknown');
  assert.equal(next.confirm(b).id, b);
});

test('拒绝、未知工具和过期预览均不写入', () => {
  const { flow, writes, advance } = setup();
  assert.equal(flow.preview('constructor', {}).status, 'unsupported');
  const first = flow.preview('plan', {});
  assert.equal(flow.reject(first.id).status, 'rejected');
  assert.equal(flow.confirm(first.id).status, 'rejected');
  const next = flow.preview('plan', {});
  advance();
  assert.equal(flow.confirm(next.id).status, 'stale');
  assert.equal(writes(), 0);
});

test('长会话 trace 与未结草案有界，旧草案明确失效且最新草案可用', () => {
  const flow = createWorkflow({
    tools: { plan: { preview: () => ({ value: 1 }), commit() {} } },
    version: () => 1, now: () => 1, rulesVersion: 'bounded', maxTrace: 200, maxDrafts: 20
  });
  const ids = [];
  for (let i = 0; i < 1000; i++) {
    const draft = flow.preview('plan', {});
    ids.push(draft.id);
    flow.confirm(draft.id);
  }
  assert.equal(flow.events().length, 200);
  assert.deepEqual(flow.events().slice(-2).map(event => event.status), ['pending', 'committed']);

  const pending = [];
  for (let i = 0; i < 25; i++) pending.push(flow.preview('plan', {}).id);
  assert.equal(flow.confirm(pending[0]).status, 'rejected');
  assert.equal(flow.confirm(pending[24]).status, 'committed');
  assert.ok(flow.events().length <= 200);
});

test('提交失败可追踪，追踪不包含输入、草案正文或原始错误', () => {
  const { flow, writes, fail } = setup();
  const draft = flow.preview('plan', { token: 'secret-token' });
  fail();
  assert.equal(flow.confirm(draft.id).status, 'failed');
  assert.equal(writes(), 0);
  const events = flow.events();
  assert.deepEqual(events.map(e => e.status), ['pending', 'failed']);
  assert.deepEqual(events[1], { id: draft.id, tool: 'plan', at: 100, planVersion: 1, rulesVersion: 'test-rules-1', status: 'failed' });
  assert.doesNotMatch(JSON.stringify(events), /secret-token|private/);
});

test('trace 与草案上限只接受有限正整数，Infinity 不能绕过边界', () => {
  const { createWorkflow } = require('../shared/workflow.js');
  const base = { tools: { plan: { preview: () => ({}), commit: () => {} } }, version: () => 1, now: () => 1, rulesVersion: 'r1' };
  for (const value of [Infinity, -Infinity, NaN, 0, -1, 1.5, 10001]) {
    assert.throws(() => createWorkflow({ ...base, maxTrace: value }), RangeError);
  }
  for (const value of [Infinity, -Infinity, NaN, 0, -1, 1.5, 1001]) {
    assert.throws(() => createWorkflow({ ...base, maxDrafts: value }), RangeError);
  }
});
