'use strict';
/* 隔离断言：把子进程 TAP 输出解析成结构化结果，据此判断「关键用例确实执行并通过」。
 *
 * 为什么不再写死子测试数量：子文件新增用例会让「数量写死」的断言立刻失效，属于脆弱的
 * 跨文件耦合。本模块只做三件事：
 *   1) 解析 TAP 结果行，得到每个用例的真实状态（通过 / 失败 / 跳过）；
 *   2) 拒绝空输出、零用例、失败用例、跳过或 todo 用例；
 *   3) 要求调用方关心的关键用例确实出现在「通过」集合里。
 * 用例数量增删不影响结论，只有「关键用例没真跑」才会失败。
 *
 * TAP 形态（node:test 的 TAP reporter，Node 22+ 实测）：
 *   TAP version 13
 *   # Subtest: <用例名>
 *   ok 1 - <用例名>
 *   not ok 2 - <用例名>            失败
 *   ok 3 - <用例名> # SKIP         跳过
 *   1..8
 *   # tests 8 / # pass 8 / # fail 0 / # skipped 0 / # todo 0
 */

const assert = require('node:assert/strict');

const OK_LINE = /^\s*ok\s+(\d+)\s+-\s+(.+)$/;
const NOT_OK_LINE = /^\s*not ok\s+(\d+)\s+-\s+(.+)$/;
const SUMMARY_LINE = /^\s*#\s*(tests|pass|failed|fail|skipped|todo|cancelled)\s+(\d+)\s*$/;
const DIRECTIVE = /\s+#\s*(SKIP|TODO)\b.*$/i;

/** 去掉 TAP 指令后缀（# SKIP / # TODO）并去掉首尾空白 */
function stripDirective(name) {
  return String(name).replace(DIRECTIVE, '').trim();
}

/**
 * 解析 TAP 输出。
 * @param {string} stdout 子进程 stdout
 * @returns {{passed: string[], failed: string[], skipped: string[], summary: object, total: number}}
 */
function parseTapOutput(stdout) {
  /* 先剥掉 ANSI 颜色码，避免 FORCE_COLOR 之类环境变量让行首出现转义序列 */
  const text = String(stdout === undefined || stdout === null ? '' : stdout).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const passed = [];
  const failed = [];
  const skipped = [];
  const summary = {};
  for (const line of text.split(/\r?\n/)) {
    const notOk = NOT_OK_LINE.exec(line);
    if (notOk) {
      failed.push(stripDirective(notOk[2]));
      continue;
    }
    const ok = OK_LINE.exec(line);
    if (ok) {
      const name = stripDirective(ok[2]);
      if (DIRECTIVE.test(ok[2])) skipped.push(name);
      else passed.push(name);
      continue;
    }
    const sum = SUMMARY_LINE.exec(line);
    if (sum) summary[sum[1].toLowerCase()] = Number(sum[2]);
  }
  return {
    passed: passed,
    failed: failed,
    skipped: skipped,
    summary: summary,
    total: passed.length + failed.length + skipped.length
  };
}

/**
 * 校验子进程输出：必须真的跑过预期关键用例，而不是只看退出码。
 * @param {string} stdout 子进程 stdout（TAP）
 * @param {string[]} expectedKeyTests 必须真实执行且通过的关键用例名
 * @returns {object} 解析结果，便于调用方进一步断言
 */
function assertIsolatedRun(stdout, expectedKeyTests) {
  const parsed = parseTapOutput(stdout);
  assert.ok(parsed.total > 0, '子进程没有输出任何 TAP 用例结果（空输出不能当作通过）');
  assert.ok(parsed.failed.length === 0, '子进程存在失败用例：' + parsed.failed.join('、'));
  assert.ok(parsed.skipped.length === 0, '子进程存在跳过或 todo 用例：' + parsed.skipped.join('、'));
  assert.ok(Number(parsed.summary.fail || 0) === 0, '子进程 reporter 汇总显示存在失败用例');
  assert.ok(Number(parsed.summary.skipped || 0) === 0, '子进程 reporter 汇总显示存在跳过用例');
  assert.ok(Number(parsed.summary.cancelled || 0) === 0, '子进程 reporter 汇总显示存在被取消用例');
  const passed = new Set(parsed.passed);
  const missing = (expectedKeyTests || []).filter((name) => !passed.has(name));
  assert.ok(missing.length === 0, '子进程未真正执行预期关键用例：' + missing.join('、'));
  return parsed;
}

module.exports = { parseTapOutput: parseTapOutput, assertIsolatedRun: assertIsolatedRun };
