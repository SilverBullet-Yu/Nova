'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
function makeHome(tasks) {
  const file = path.join(root, 'assets/js/home-summary.js');
  assert.ok(fs.existsSync(file), '首页摘要模块尚未实现');
  const state = { tasks };
  const window = { ZX: { util: { esc: s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) }, flows: { exec: { activeTasks: () => state.tasks } } } };
  window.window = window;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), window);
  return { home: window.ZX.homeSummary, state };
}
test('首页摘要展示真实未完成任务、原始时间并转义文本', () => {
  const { home } = makeHome([{title:'<计划>', time:'09:00–10:00'}, {title:'已完成', done:true}, {title:'无时间'}]);
  const html = home.render();
  assert.match(html, /&lt;计划&gt;/);
  assert.match(html, /09:00–10:00/);
  assert.match(html, /无时间/);
  assert.doesNotMatch(html, /已完成|<计划>/);
});
test('首页摘要无任务时显示空状态，之后读取最新任务', () => {
  const { home, state } = makeHome([]);
  assert.match(home.render(), /暂无/);
  state.tasks = [{title:'新任务'}];
  assert.match(home.render(), /新任务/);
});
test('首页存在独立摘要区域且在首页以 DOM 展示', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'assets/css/app.css'), 'utf8');
  assert.match(html, /id="homeSummary"/);
  assert.ok(css.includes('html.gl-on[data-tab="chat"] .cp-body{display:flex}'), '首页 GL 模式应显示原始聊天 DOM');
});

test('首页摘要异常不会阻断主渲染和状态保存', () => {
  const elements = {};
  for (const key of ['#form','#input','#ctxR','#ctxGoal','#btTitle b','#btMeta','#view','#chat','#homeSummary']) {
    elements[key] = { dataset:{}, textContent:'', innerHTML:'', addEventListener(){} };
  }
  let saved = 0;
  const ZX = { util: { $: key => elements[key] || null }, state: { tab:'chat', goal:{name:'目标'}, feasibility:()=>null, saveOverlay:()=>saved++ }, homeSummary:{render(){throw new Error('summary failure')}}, assistant:{} };
  const document = { readyState:'loading', documentElement:{dataset:{}}, addEventListener(){} };
  const window = { ZX, document, console:{error(){},warn(){}} };
  vm.runInNewContext(fs.readFileSync(path.join(root,'assets/js/main.js'),'utf8'), {window, document, console:window.console});
  assert.doesNotThrow(()=>ZX.render());
  assert.equal(saved,1);
  assert.equal(elements['#btTitle b'].textContent,'对话');
  assert.match(elements['#homeSummary'].textContent, /暂时无法显示/);
});
