#!/usr/bin/env node
'use strict';
const { performance } = require('node:perf_hooks');
const P = require('../shared/placement-model.js');

const DATES = Array.from({ length: 7 }, (_, i) => '2026-11-' + String(23 + i).padStart(2, '0'));

function fixture(n) {
  const tasks = [];
  const blocks = [];
  for (let i = 0; i < n; i++) {
    const id = 'bench-' + i;
    const date = DATES[i % DATES.length];
    const startMin = 480 + Math.floor(i / DATES.length) * 10;
    tasks.push({ id, subject: '数学', estMin: 10 });
    blocks.push({ id: 'block-' + i, taskId: id, date, startMin, durMin: 10 });
  }
  return P.createModel({
    startDate: DATES[0], timezone: 'UTC', idPrefix: 'bench_', tasks, blocks,
    slots: DATES.map(date => ({ date, startMin: 480, durMin: 960, isBuffer: false })),
    unplanned: []
  });
}

function run(n) {
  const model = fixture(n);
  const ids = model.placements.map(item => item.taskId);
  const startLegacy = performance.now();
  let legacyCount = 0;
  for (const id of ids) legacyCount += P.taskSegments(model, id).length;
  const legacyMs = performance.now() - startLegacy;
  const startMap = performance.now();
  const map = P.taskSegmentsMap(model);
  const mapCount = ids.reduce((sum, id) => sum + (map[id] || []).length, 0);
  const mapMs = performance.now() - startMap;
  if (legacyCount !== n || mapCount !== n) throw new Error('分段索引结果不一致');
  return { tasks: n, legacyMs: +legacyMs.toFixed(3), mapMs: +mapMs.toFixed(3), speedup: +(legacyMs / mapMs).toFixed(1) };
}

for (const n of [100, 500]) {
  const result = run(n);
  console.log(JSON.stringify(result));
  if (result.mapMs > 250) {
    console.error('批量分段索引超过 250ms 软预算：' + n);
    process.exitCode = 2;
  }
}

module.exports = { fixture };
