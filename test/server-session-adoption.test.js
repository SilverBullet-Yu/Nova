'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const H = require('./helpers');
const { seed } = require('../shared/data/seed');

const now = new Date(2026, 10, 20, 12).getTime();
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
const session = (id, minutes = 60) => ({
  id, taskId: 't1', minutes, status: 'done', completion: 100,
  startAt: now - minutes * 60000, endAt: now, planVersion: 'plan-local'
});
const plain = value => JSON.parse(JSON.stringify(value));

function setup({ disk, sessions } = {}) {
  const store = H.storage(disk);
  const ZX = { api: {}, ui: { fold: (_, options) => options.body } };
  const initial = plain(seed);
  if (sessions !== undefined) initial.sessions = sessions;
  const sandbox = {
    window: { ZX, Rhythm: { seed: { seed: initial } }, localStorage: store.localStorage },
    document: { addEventListener() {} }, Date: FixedDate
  };
  H.installUtil(sandbox);
  for (const file of ['state.js', 'flows/exec.js', 'flows/settings.js', 'views/data.js']) {
    vm.runInNewContext(fs.readFileSync(require.resolve('../assets/js/' + file), 'utf8'), sandbox);
  }
  return { ZX, S: ZX.state, disk: store.disk };
}

function assertReportAndExport(app, hours, minutes) {
  assert.match(app.ZX.views.data(), new RegExp('有效学习 <b class="hl">' + hours + ' 小时'));
  const csv = app.ZX.flows.settings.csv();
  assert.match(csv, new RegExp('记录,t1,英语,.*?,,' + minutes + ',100,done,2026-11-20,plan-local'));
}

test('初始 seed.sessions 归一后完整保留，缺省或非法 sessions 使用空数组', () => {
  const records = [session('seed-record')];
  const app = setup({ sessions: records });
  assert.deepEqual(plain(app.S.sessions), records);
  assertReportAndExport(app, 1, 60);
  for (const sessions of [undefined, null, {}]) {
    assert.deepEqual(plain(setup({ sessions }).S.sessions), []);
  }
});

test('本地主数据不暴露服务端状态采纳入口', () => {
  const app = setup();
  assert.equal(app.S.adoptServerState, undefined);
  app.S.sessions = [session('local-record')];
  app.S.saveOverlay();
  assert.deepEqual(plain(setup({ disk: app.disk }).S.sessions), [session('local-record')]);
});

test('已有 overlay 的会话在刷新后保持本地值，不被服务端 seed 替换', () => {
  const local = [session('same-id', 30), session('local-only', 15)];
  const source = setup({ sessions: local });
  source.S.saveOverlay();
  const app = setup({ disk: source.disk });
  app.S.applyOverlay();
  assert.deepEqual(plain(app.S.sessions), local);
  app.S.saveOverlay();
  assert.deepEqual(plain(setup({ disk: app.disk }).S.sessions), local);
});

test('dropOverlay 后重新加载不会从旧服务端 seed 复活会话', () => {
  const app = setup({ sessions: [session('old-record')] });
  app.S.dropOverlay();
  app.S.sessions = [];
  const refreshed = setup({ disk: app.disk });
  assert.deepEqual(plain(refreshed.S.sessions), []);
});
