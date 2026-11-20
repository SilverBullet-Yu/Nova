'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { attribute } = require('../shared/engine/attribute');
test('归因卡片显示实际输入、全部命中规则和规则评分', () => {
  const ZX = { state: {} };
  const ctx = vm.createContext({window:{ZX},document:{addEventListener(){}}});
  const source = fs.readFileSync(require.resolve('../assets/js/flows/exec.js'),'utf8');
  vm.runInContext(fs.readFileSync(require.resolve('../assets/js/util.js'),'utf8'),ctx);
  vm.runInContext(source.replace('  function attributionHtml(', '  ZX.testCard = attributionHtml;\n  function attributionHtml('),ctx);
  const result = attribute({planLoadRatio:1.25,consecutiveTimeoutCount:4});
  const html = ZX.testCard(result,false);
  assert.match(html,/规则评分/);
  assert.match(html,/计划负载比[^<]*1[.]25/);
  assert.match(html,/超时次数[^<]*4/);
  assert.ok(result.evidence.matched.every(rule => html.includes(ZX.util.esc(rule))));
});
