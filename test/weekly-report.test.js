'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const H = require('./helpers');

test('周报只统计本地周一零点至下周一零点前的非补录会话', () => {
  const stamp = d => new Date(2026, 10, d).getTime();
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [stamp(20)])); } }
  const state = {tasks:[{id:'t',s:'数学'}], sessions:[
    {taskId:'t',endAt:stamp(16)-1,minutes:120},
    {taskId:'t',endAt:stamp(16),minutes:30},
    {taskId:'t',endAt:stamp(23)-1,minutes:30},
    {taskId:'t',endAt:stamp(23),minutes:120},
    {taskId:'t',endAt:stamp(20),minutes:120,isBackfill:true}
  ]};
  const ZX = {state, ui:{fold:()=>''}, flows:{exec:{metrics:()=>({rate:22})}}};
  const sandbox = {window:{ZX}, Date: FixedDate};
  H.installUtil(sandbox);          /* 真实 util：findById / dayKey 与生产同源 */
  ZX.util.isoWeek = () => 47;
  vm.runInNewContext(fs.readFileSync(require.resolve('../assets/js/views/data.js'),'utf8'), sandbox);
  assert.match(ZX.views.data(), /有效学习 <b class="hl">1 小时/);
});

test('数据页区分今日达成率与缺少分母的周指标，不显示演示目标或趋势', () => {
  const ZX = {state:{tasks:[],weekStats:{kpis:{targetHours:15},WEEKS:[80,90]}},
    util:{num:(v,d)=>Number.isFinite(v)?v:d,isoWeek:()=>47,pad2:String,nowStr:()=>'',esc:String},
    ui:{fold:(_,o)=>o.body},flows:{exec:{metrics:()=>({rate:22})}}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../assets/js/views/data.js'),'utf8'), {window:{ZX}});
  const html = ZX.views.data();
  assert.match(html, /今日达成率<\/span><b>22/);
  assert.match(html, /周达成率暂无数据/);
  assert.doesNotMatch(html, /目标 15|缺口|最新 22%/);
});

test('周报将种子调整标为演示，不声称已写入日程', () => {
  const state = {tasks:[], sessions:[], stats:{actions:['示例调整']}};
  const ZX = {state, util:{num:(v,d)=>Number.isFinite(v)?v:d, isoWeek:()=>1,
    pad2:String, nowStr:()=>'', esc:String}, ui:{fold:()=>''},
    flows:{exec:{metrics:()=>({rate:0})}}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../assets/js/views/data.js'),'utf8'), {window:{ZX}});
  const before = JSON.stringify(state);
  const html = ZX.views.data();
  assert.match(html, /演示预置/);
  assert.doesNotMatch(html, /已执行的动作|下周计划已预置|已经排进日程/);
  assert.equal(JSON.stringify(state), before);
});
