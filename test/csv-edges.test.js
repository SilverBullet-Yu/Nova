'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function csv(state) {
  const ZX = { util: { pad2: n => String(n).padStart(2, '0'), num: (v, d) => typeof v === 'number' && Number.isFinite(v) ? v : d }, state };
  vm.runInNewContext(fs.readFileSync(require.resolve('../assets/js/flows/settings.js'), 'utf8'), { window: { ZX } });
  return ZX.settings.csv();
}

test('记录缺失日期和时长时导出留空，不伪造当天和零分钟', () => {
  const line = csv({ tasks: [], sessions: [{ taskId: 'a' }] }).trimEnd().split('\n')[1].split(',');
  assert.equal(line[5], '');
  assert.equal(line[8], '');
});

test('没有数据时只导出表头，没有额外空数据行', () => {
  const lines = csv({ tasks: [], sessions: [] }).split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[1], '');
});

test('制表符开头的内容进行 CSV 公式防护', () => {
  const result = csv({ tasks: [{ id: 'a', title: '\t=1+1' }], sessions: [] });
  assert.ok(result.includes("'\t=1+1"));
});
