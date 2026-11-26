'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const scripts = ['shared/data/seed.js', ...[
  'rhythm.build', 'util', 'state', 'api', 'engine', 'flows/exec', 'flows/settings'
].map(name => 'assets/js/' + name + '.js')].map(file =>
  new vm.Script(fs.readFileSync(require.resolve('../' + file), 'utf8'), { filename: file }));

test('file 协议离线降级：本地排程、执行记录重载与 CSV 导出', async () => {
  const disk = new Map();
  let attempts = 0;
  function boot() {
    const context = vm.createContext({
      crypto, AbortController, setTimeout, clearTimeout, structuredClone,
      location: { protocol: 'file:', origin: 'null' },
      document: { addEventListener() {} },
      localStorage: { getItem: k => disk.get(k), setItem: (k, v) => disk.set(k, v) },
      fetch: async () => { attempts++; throw new Error('offline'); }
    });
    context.window = context;
    for (const script of scripts) script.runInContext(context);
    return context.ZX;
  }
  const zx = boot();
  const input = {
    tasks: [{ id: 'synthetic', subject: 'math', estMin: 30, weight: 1 }],
    slots: [{ id: 'slot', date: 'Wed', startMin: 480, durMin: 120 }], seed: 1
  };
  const first = await zx.engine.schedule(input);
  const second = await zx.engine.schedule(input);
  assert.equal(attempts, 2);
  assert.equal(zx.engine.source, 'local');
  assert.equal(first.blocks.length, 1);
  assert.equal(JSON.stringify(first), JSON.stringify(second));

  const record = zx.exec.record({ taskId: zx.state.tasks[0].id, minutes: 17 });
  zx.state.saveOverlay();
  const reloaded = boot();
  const restored = reloaded.state.sessions.find(row => row.id === record.id);
  assert.equal(restored?.minutes, 17);
  assert.match(record.planVersion, /^plan-/);
  assert.equal(restored.planVersion, record.planVersion);
  assert.equal(reloaded.api.pendingCount(), 0);
  assert.equal(reloaded.api.legacyPendingCount(), 0);
  assert.equal(disk.has('zx.op_queue'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(await reloaded.api.flushQueue())), {
    status: 'isolated', sent: 0, accepted: [], pending: 0, serverSeq: reloaded.state.serverSeq
  });
  assert.equal(attempts, 2, 'flush 不应发起网络请求');
  assert.equal(disk.has('zx.syncTrace'), false);
  const rows = reloaded.settings.csv().split('\n');
  assert.ok(rows.some(row => row.startsWith('记录,' + record.taskId + ',') &&
    row.endsWith(',' + record.planVersion)));
});
