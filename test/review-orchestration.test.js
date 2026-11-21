'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/* main.js 的计划复核编排（ZX.reviewPendingPlan）：离线挂起、冲突升级、
   取消即止、本机版本漂移拒绝。装配沿用 sync-status 的最小桩模式。 */
const source = fs.readFileSync(path.join(__dirname, '../assets/js/main.js'), 'utf8');

function setup(env) {
  const toasts = [];
  const reviewCalls = [];
  const elements = { '#form': { addEventListener() {} } };
  const window = {
    ZX: {
      util: { $: key => elements[key], sleep: async () => {} },
      api: {
        isOnline: () => env.online,
        pendingCount: () => 0,
        pendingPlan: () => env.pending || null,
        reviewPlan: (ticket) => {
          reviewCalls.push(ticket || null);
          /* 离线时复核请求必然网络失败，贴合真实降级语义 */
          if (!env.online) return Promise.reject(new Error('offline'));
          return Promise.resolve((env.responses && env.responses.length) ? env.responses.shift() : { status: 'committed', version: 'v-final' });
        }
      },
      state: { tab: 'chat', currentPlanVersion: () => env.planVersion },
      ui: { confirm: async () => env.confirmOk !== false, toast: (t, k) => toasts.push([t, k]) },
      flows: { exec: { metrics: () => ({}) } },
      assistant: { tickTimer() {}, say() {} }
    }
  };
  const document = { readyState: 'loading', addEventListener() {} };
  vm.runInNewContext(source, { window, document });
  const drain = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  return { ZX: window.ZX, toasts, reviewCalls, drain };
}

test('离线且非手动时不触发复核，手动触发失败则提示保留本机', async () => {
  const { ZX, toasts, reviewCalls, drain } = setup({
    online: false, planVersion: 'v1',
    pending: { id: 'p1', input: {}, result: {} }
  });
  ZX.reviewPendingPlan();
  await drain();
  assert.deepEqual(reviewCalls, []);
  assert.deepEqual(toasts, []);

  ZX.reviewPendingPlan(true);
  await drain();
  assert.deepEqual(reviewCalls, [null]);
  assert.deepEqual(toasts, [['计划保留在本机，待联网复核。', 'warn']]);
});

test('冲突携 ticket 升级重交，确认后 committed 提示同步完成', async () => {
  const { ZX, toasts, reviewCalls, drain } = setup({
    online: true, planVersion: 'v1',
    pending: { id: 'p1', input: {}, result: {} },
    responses: [{ status: 'conflict', reason: 'baseline-changed', ticket: 't1' }]
  });
  ZX.reviewPendingPlan(true);
  await drain();
  assert.deepEqual(reviewCalls, [null, 't1']);
  assert.deepEqual(toasts, [['计划基线已同步', 'ok']]);
});

test('冲突后用户取消则不再重交', async () => {
  const { ZX, toasts, reviewCalls, drain } = setup({
    online: true, planVersion: 'v1', confirmOk: false,
    pending: { id: 'p1', input: {}, result: {} },
    responses: [{ status: 'conflict', reason: 'baseline-changed', ticket: 't1' }]
  });
  ZX.reviewPendingPlan(true);
  await drain();
  assert.deepEqual(reviewCalls, [null]);
  assert.deepEqual(toasts, []);
});

test('本机计划版本漂移时拒绝复核并提示重新生成', async () => {
  const { ZX, toasts, reviewCalls, drain } = setup({
    online: true, planVersion: 'v2',
    pending: { id: 'p1', localVersion: 'v1', input: {}, result: {} }
  });
  ZX.reviewPendingPlan(true);
  await drain();
  assert.deepEqual(reviewCalls, []);
  assert.deepEqual(toasts, [['本机计划已变化，请重新生成并确认计划。旧排程未上传。', 'warn']]);
});
