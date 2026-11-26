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

test('任务状态覆盖暂缓、放弃、替代与模型未排入，日期只取明确计划日期', () => {
  const result = csv({
    tasks: [
      { id: 'deferred', title: '暂缓', deferred: true, date: '2026-11-26' },
      { id: 'abandoned', title: '放弃', abandoned: true, date: '2026-11-27' },
      { id: 'substituted', title: '替代', substituted: true, date: '2026-11-28' },
      { id: 'unplanned', title: '未排入', date: null },
      { id: 'legacy', title: '旧任务' },
      { id: 'invalid', title: '非法日期', date: '2026-02-31' }
    ],
    sessions: [],
    placementModel: { unplanned: [{ taskId: 'unplanned', reason: '容量不足' }] }
  });
  const rows = result.trimEnd().split('\n').slice(1).map(row => row.split(','));
  assert.deepEqual(rows.map(row => [row[7], row[8]]), [
    ['今日暂缓', '2026-11-26'],
    ['已放弃', '2026-11-27'],
    ['已替代', '2026-11-28'],
    ['未排入', ''],
    ['未开始', ''],
    ['未开始', '']
  ]);
});

test('制表符开头的内容进行 CSV 公式防护', () => {
  const result = csv({ tasks: [{ id: 'a', title: '\t=1+1' }], sessions: [] });
  assert.ok(result.includes("'\t=1+1"));
});
