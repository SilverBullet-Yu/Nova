'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function fixture() {
  const state = { tab:'today', goal:{name:'synthetic',target:'100',deadline:'2027-12-25'}, feas:{weeks:5,weeklyH:10}, tasks:[{id:'a',title:'A',est:60,weight:.1},{id:'b',title:'B',est:60,weight:.9}], locks:{}, week:[], workedMin:()=>0 };
  let click, preview;
  const ops = [];
  const ZX = { state, render(){}, assistant:{say(){}}, api:{queueOp(op){ops.push(op);}}, ui:{toast(){},footNav(){return "";},flowSheet(o){preview=()=>o.steps[1](1).body;return {render(){},go(){},open(){const x={close:o.onClose,root:{addEventListener(k,v){if(k==='click')click=v;}}};o.bind(x);return x;}};}} };
  const ctx=vm.createContext({window:{ZX},document:{addEventListener(){}}});
  for (const p of ['util.js','flows/rescue.js']) vm.runInContext(fs.readFileSync(require.resolve('../assets/js/'+p),'utf8'),ctx);
  const rescue=ZX.flows.rescue;
  rescue.open();
  return {state,rescue,ops,preview:()=>preview(),act:(sb,v)=>click({target:{closest:()=>({dataset:{sb,v}})}})};
}
test('中断挽救不压缩或放弃锁定任务',()=>{
  const {state,rescue}=fixture();
  state.locks.a=true;
  for(const strategy of ['compress','downgrade']) {
    const option=rescue.optionOf(strategy);
    assert.equal([...option.dropped,...option.items].some(t=>t.id==='a'),false);
  }
});
test('确认页打开后计划变化，拒绝提交旧挽救方案',()=>{
  const {state,act,ops}=fixture();
  act('pick','downgrade');act('next');
  state.tasks[0].weight=1;
  state.locks.b=true;
  const before=JSON.stringify(state);
  act('apply');
  assert.equal(JSON.stringify(state),before);
  assert.equal(ops.length,0);
});
test('未进入确认页不能应用，未变化的确认只提交一次',()=>{
  const {act,ops}=fixture();
  act('pick','downgrade');act('apply');
  assert.equal(ops.length,0);
  act('next');act('apply');act('apply');
  assert.equal(ops.length,1);
  assert.equal(ops[0].value.dropped[0].id,'a');
});

test('全锁定时预览说明保留锁定项且不承诺缺口归零',()=>{
  const {state,rescue,preview}=fixture();
  state.locks={a:true,b:true};
  state.week=[{total:600}];
  state.feas.weeklyH=1;
  rescue.detect(4);
  const html=preview();
  assert.doesNotMatch(html,/都会把它归零|放弃权重最低的 [12] 项/);
  assert.match(html,/锁定任务不压缩、不放弃/);
  assert.match(html,/放弃 0 项/);
});
