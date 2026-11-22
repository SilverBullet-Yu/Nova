#!/usr/bin/env node
'use strict';
// 有界单次本地基准：每个规模独立进程，超时 1500 ms；单次超过 250 ms 即停止。
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
function fixture(n) {
  return {
    tasks: Array.from({ length: n }, (_, i) => ({ id: 't' + i, est: 60, weight: i + 1, freq: i + 1, domain: 'math' })),
    week: Array.from({ length: 7 }, (_, i) => ({ date: 'd' + i, minutes: 300, capacity: 300, buffer: 45 }))
  };
}
if (process.argv[2] === '--one') {
  const n = Number(process.argv[3]);
  if (![8, 16, 32, 64, 96, 128].includes(n)) throw new Error('仅允许预设合理规模');
  const input = fixture(n);
  const { replan } = require('../shared/engine/replan.js');
  const start = performance.now();
  let outcome;
  try { outcome = replan(input).verdict; } catch (err) { outcome = err.code || err.message; }
  console.log(JSON.stringify({ tasks: n, days: 7, ms: +(performance.now() - start).toFixed(3), outcome }));
} else if (require.main === module) {
  for (const n of [8, 16, 32, 64, 96, 128]) {
    const child = spawnSync(process.execPath, [__filename, '--one', String(n)], { encoding: 'utf8', timeout: 1500 });
    if (child.error || child.status !== 0) { console.log('基准停止：子进程失败或达到 1500 ms 终止边界'); break; }
    process.stdout.write(child.stdout);
    if (JSON.parse(child.stdout).ms > 250) break;
  }
}
module.exports = { fixture };
