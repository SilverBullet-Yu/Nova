'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const routesPath = require.resolve('../server/api/routes.js');
const store = {
  readSnapshot() { return { revision: 1 }; },
  recordReplan() {}
};

function loadRouter(budget) {
  process.env.NOVA_DRAFT_BUDGET_BYTES = String(budget);
  delete require.cache[routesPath];
  return require(routesPath).createRouter(store, {});
}

function preview(router, id) {
  return router.handle({
    method: 'POST', pathname: '/api/replan', userId: 'budget-user',
    body: {
      tasks: [{ id, est: 60, weight: 1 }],
      week: Array.from({ length: 7 }, (_, i) => ({ date: 'd' + i, minutes: 0, capacity: 0, buffer: 0 }))
    }
  });
}

test('草案字节预算淘汰最旧草案，最新草案仍可确认', async () => {
  const probe = loadRouter(1024 * 1024);
  const sample = (await preview(probe, 'sample')).body;
  const budget = Math.ceil(Buffer.byteLength(JSON.stringify(sample), 'utf8') * 1.2);
  const router = loadRouter(budget);
  const first = (await preview(router, 'first')).body;
  const second = (await preview(router, 'second')).body;
  assert.equal(typeof first.draftId, 'string');
  assert.equal(typeof second.draftId, 'string');
  await assert.rejects(
    router.handle({ method: 'POST', pathname: '/api/replan/confirm', userId: 'budget-user', body: { draftId: first.draftId } }),
    error => error.code === 'E2001'
  );
  const confirmed = await router.handle({
    method: 'POST', pathname: '/api/replan/confirm', userId: 'budget-user', body: { draftId: second.draftId }
  });
  assert.equal(confirmed.body.accepted, true);
});

test('内部 RangeError 不把预算细节返回客户端', async () => {
  delete require.cache[routesPath];
  const { createRouter } = require(routesPath);
  const guarded = createRouter({
    readSnapshot() { throw new RangeError('内部字节预算 123456 / 789000'); },
    recordReplan() {}
  }, {});
  await assert.rejects(preview(guarded, 'guarded'), error =>
    error.code === 'E1001' && error.message === '请求参数非法或缺失');
});

test('已撤销身份映射为 E4030 且不暴露内部细节', async () => {
  delete require.cache[routesPath];
  const { createRouter } = require(routesPath);
  const guarded = createRouter({
    readSnapshot() {
      const error = new Error('用户身份已撤销');
      error.code = 'USER_REVOKED';
      throw error;
    },
    recordReplan() {}
  }, {});
  await assert.rejects(preview(guarded, 'revoked'), error =>
    error.code === 'E4030' && error.message === '用户身份已撤销');
});

test('单条草案超过字节预算时返回 E4002 且不确认', async () => {
  const router = loadRouter(1);
  await assert.rejects(preview(router, 'too-large'), error => error.code === 'E4002');
});
