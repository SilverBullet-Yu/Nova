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
  startAt: now - minutes * 60000, endAt: now, planVersion: 'plan-remote'
});
const plain = value => JSON.parse(JSON.stringify(value));
const payload = sessions => ({ seed: { ...plain(seed), sessions } });

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
  assert.match(csv, new RegExp('记录,t1,英语,.*?,,' + minutes + ',100,done,2026-11-20,plan-remote'));
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

test('无启动 overlay 的远端记录覆盖启动渲染快照，周报和导出可读，刷新仍保留', () => {
  const app = setup();
  app.S.saveOverlay(); // main.boot 的先渲染、后拉取顺序
  assert.equal(app.S.bootOverlayLoaded(), false);
  const remote = [session('remote-record')];
  assert.equal(app.S.adoptServerState(payload(remote)), true);
  if (app.S.bootOverlayLoaded()) app.S.applyOverlay();
  assert.deepEqual(plain(app.S.sessions), remote);
  assertReportAndExport(app, 1, 60);
  app.S.saveOverlay();
  const refreshed = setup({ disk: app.disk });
  assert.deepEqual(plain(refreshed.S.sessions), remote);
  assertReportAndExport(refreshed, 1, 60);
});

test('无本机变更时重复服务端采纳可更新且不会累积重复会话', () => {
  const app = setup();
  const first = [session('remote-a')];
  app.S.adoptServerState(payload(first));
  app.S.adoptServerState(payload(first));
  assert.deepEqual(plain(app.S.sessions), first);
  const next = [...first, session('remote-b', 30)];
  app.S.adoptServerState(payload(next));
  assert.deepEqual(plain(app.S.sessions), next);
});

test('有 overlay 时保守本地优先：同 id 本地值与未上行记录均保留，不猜测缺失是否删除', () => {
  const local = [session('same-id', 30), session('local-only', 15)];
  const disk = new Map([['zx.overlay', JSON.stringify({ sessions: local })]]);
  const app = setup({ disk });
  app.S.adoptServerState(payload([session('same-id', 120), session('remote-only')]));
  assert.deepEqual(plain(app.S.sessions), local);
  app.S.applyOverlay();
  assert.deepEqual(plain(app.S.sessions), local);
  app.S.saveOverlay();
  assert.deepEqual(plain(setup({ disk }).S.sessions), local);
});

test('显式空 overlay 和本地墓碑不被服务端记录复活', () => {
  for (const local of [[], [{ id: 'deleted-id', deleted: true }]]) {
    const app = setup({ disk: new Map([['zx.overlay', JSON.stringify({ sessions: local })]]) });
    app.S.adoptServerState(payload([session('deleted-id')]));
    app.S.applyOverlay();
    assert.deepEqual(plain(app.S.sessions), local);
  }
});

test('启动后、服务端响应前新增或删除记录，不丢未上行记录也不复活本地删除', () => {
  const app = setup();
  app.S.sessions.push(session('local-pending', 15));
  app.S.saveOverlay();
  app.S.adoptServerState(payload([session('remote-record')]));
  assert.deepEqual(plain(app.S.sessions), [session('local-pending', 15)]);
  const deleted = setup({ sessions: [session('old-record')] });
  deleted.S.sessions = [];
  deleted.S.adoptServerState(payload([session('old-record')]));
  assert.deepEqual(plain(deleted.S.sessions), []);
});

test('删除全部数据的回收标记阻止无 overlay 的旧远端会话复活', () => {
  const disk = new Map([['zx.trash', JSON.stringify({ at: now, snapshot: { sessions: [session('deleted')] } })]]);
  const app = setup({ disk });
  app.S.adoptServerState(payload([session('deleted')]));
  assert.deepEqual(plain(app.S.sessions), []);
});

test('dropOverlay 后即使晚到服务端响应也不恢复已清空会话', () => {
  const app = setup();
  app.S.dropOverlay();
  app.S.sessions = [];
  app.S.adoptServerState(payload([session('deleted')]));
  assert.deepEqual(plain(app.S.sessions), []);
});
