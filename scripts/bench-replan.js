#!/usr/bin/env node
'use strict';
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const SCALES = [8, 16, 32, 64, 96, 128, 256, 500];
const CHILD_TIMEOUT_MS = 1500;
const SOFT_BUDGET_MS = 250;

function fixture(n) {
  return {
    tasks: Array.from({ length: n }, (_, i) => ({ id: 't' + i, est: 60, weight: i + 1, freq: i + 1, domain: 'math' })),
    week: Array.from({ length: 7 }, (_, i) => ({ date: 'd' + i, minutes: 300, capacity: 300, buffer: 45 }))
  };
}

if (process.argv[2] === '--one') {
  const n = Number(process.argv[3]);
  if (!SCALES.includes(n)) throw new Error('仅允许预设合理规模');
  const input = fixture(n);
  const { replan } = require('../shared/engine/replan.js');
  const start = performance.now();
  let outcome;
  let failed = false;
  try { outcome = replan(input).verdict; }
  catch (err) { outcome = err.code || err.message; failed = true; }
  console.log(JSON.stringify({ tasks: n, days: 7, ms: +(performance.now() - start).toFixed(3), outcome }));
  if (failed) process.exitCode = 1;
} else if (require.main === module) {
  for (const n of SCALES) {
    const child = spawnSync(process.execPath, [__filename, '--one', String(n)], {
      encoding: 'utf8', timeout: CHILD_TIMEOUT_MS
    });
    if (child.error || child.status !== 0) {
      process.stderr.write('基准失败：子进程异常、引擎报错或达到 ' + CHILD_TIMEOUT_MS + ' ms 终止边界\n');
      if (child.stderr) process.stderr.write(child.stderr);
      process.exitCode = 1;
      break;
    }
    const result = JSON.parse(child.stdout);
    process.stdout.write(child.stdout);
    if (result.ms > SOFT_BUDGET_MS) {
      process.stderr.write('基准超过 ' + SOFT_BUDGET_MS + ' ms 软预算：' + n + ' 任务\n');
      process.exitCode = 2;
      break;
    }
  }
}

module.exports = { fixture, SCALES, SOFT_BUDGET_MS };
