'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('../server/main');
const llm = require('../server/llm.js');
const { ApiError } = require('../server/api/errors.js');

/* ── 环境变量与 fetch 桩的保存/恢复（进程级全局，逐测试还原） ── */
const ENV_KEYS = ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_TIMEOUT_MS'];
const realFetch = globalThis.fetch;

function setLlmEnv() {
  process.env.LLM_BASE_URL = 'https://llm.example.test/api/v4';
  process.env.LLM_API_KEY = 'test-key-123';
  process.env.LLM_MODEL = 'glm-4-flash';
}
function clearLlmEnv() {
  ENV_KEYS.forEach((k) => { delete process.env[k]; });
}
/* OpenAI 兼容响应桩：content 为一段文本；非 LLM 域名（测试自身的 HTTP 调用）直通真 fetch */
function stubFetch(content, capture) {
  globalThis.fetch = (url, opts) => {
    if (String(url).indexOf('llm.example.test') < 0) return realFetch(url, opts);
    if (capture) capture.push({ url: url, body: JSON.parse(opts.body) });
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ choices: [{ message: { content: content } }] }),
      text: () => Promise.resolve('')
    });
  };
}
function restoreFetch() { globalThis.fetch = realFetch; }

function errCode(promise) {
  return promise.then(() => { throw new Error('应当抛错'); }, (e) => e);
}

/* 新增客户端回归全部使用 fetch 桩与虚拟时钟，不连接真实上游。 */
function mockChat(t, fetchImpl) {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]]);
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  setLlmEnv();
  process.env.LLM_TIMEOUT_MS = '3000';
  t.mock.method(globalThis, 'fetch', fetchImpl);
  t.mock.timers.enable({ apis: ['setTimeout'] });
}

test('chat：响应头后读取 body 仍受同一个超时控制，abort 映射 E5011', async (t) => {
  let signal;
  let bodyStarted;
  const started = new Promise((resolve) => { bodyStarted = resolve; });
  mockChat(t, async (url, opts) => {
    signal = opts.signal;
    return {
      ok: true,
      json: () => {
        bodyStarted();
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('secret-body', 'AbortError')), { once: true });
        });
      }
    };
  });
  const result = errCode(llm.chat([]));
  await started;
  t.mock.timers.tick(2999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(signal.aborted, true);
  const e = await result;
  assert.ok(e instanceof ApiError);
  assert.equal(e.code, 'E5011');
  assert.equal(e.message, 'LLM 调用超时（3000 ms）');
});

test('chat：等待响应头也受超时控制', async (t) => {
  mockChat(t, (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(new DOMException('secret-fetch', 'AbortError')), { once: true });
  }));
  const result = errCode(llm.chat([]));
  t.mock.timers.tick(3000);
  const e = await result;
  assert.equal(e.code, 'E5011');
  assert.equal(e.message, 'LLM 调用超时（3000 ms）');
});

test('chat：非 2xx 仅返回状态码，不读取正文并取消响应体', async (t) => {
  let cancelled = false;
  let signal;
  mockChat(t, async (url, opts) => {
    signal = opts.signal;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('secret-upstream test-key-123 https://private.example/token'));
      },
      cancel() { cancelled = true; }
    }), { status: 401 });
  });
  const e = await errCode(llm.chat([]));
  assert.equal(e.code, 'E5011');
  assert.equal(e.message, 'LLM 调用失败：HTTP 401');
  assert.equal(cancelled, true);
  t.mock.timers.tick(3000);
  assert.equal(signal.aborted, false, '失败退出也应释放定时器');
});

test('chat：取消错误响应体失败时 abort 释放请求，仍只返回状态码', async (t) => {
  let signal;
  mockChat(t, async (url, opts) => {
    signal = opts.signal;
    return {
      ok: false, status: 503,
      body: { cancel: async () => { throw new Error('secret-cancel'); } },
      text: () => assert.fail('不应读取上游错误正文'),
      json: () => assert.fail('不应解析上游错误正文')
    };
  });
  const e = await errCode(llm.chat([]));
  assert.equal(e.code, 'E5011');
  assert.equal(e.message, 'LLM 调用失败：HTTP 503');
  assert.equal(signal.aborted, true);
});

for (const stage of ['fetch', 'body']) {
  test('chat：' + stage + ' 网络错误不泄露上游 URL、凭证和错误 message', async (t) => {
    let signal;
    const failure = new TypeError('secret-upstream https://user:pass@private.example/?key=test-key-123');
    mockChat(t, async (url, opts) => {
      signal = opts.signal;
      if (stage === 'fetch') throw failure;
      return { ok: true, json: async () => { throw failure; } };
    });
    const e = await errCode(llm.chat([]));
    assert.ok(e instanceof ApiError);
    assert.equal(e.code, 'E5011');
    assert.equal(e.message, 'LLM 调用失败：网络错误');
    t.mock.timers.tick(3000);
    assert.equal(signal.aborted, false);
  });
}

test('chat：损坏的外层 JSON 映射 E5012 且不泄露解析片段', async (t) => {
  let signal;
  mockChat(t, async (url, opts) => {
    signal = opts.signal;
    return new Response('{"secret-upstream":"test-key-123", broken');
  });
  const e = await errCode(llm.chat([]));
  assert.ok(e instanceof ApiError);
  assert.equal(e.code, 'E5012');
  assert.equal(e.message, 'LLM 响应不是合法 JSON');
  t.mock.timers.tick(3000);
  assert.equal(signal.aborted, false);
});

test('chat：已知 ApiError 保留原对象，空内容仍为 E5012', async (t) => {
  const known = new ApiError('E5012', '已知解析错误');
  mockChat(t, async () => ({ ok: true, json: async () => { throw known; } }));
  assert.equal(await errCode(llm.chat([])), known);
  globalThis.fetch = async () => Response.json({ choices: [] });
  const e = await errCode(llm.chat([]));
  assert.equal(e.code, 'E5012');
  assert.equal(e.message, 'LLM 返回内容为空');
});

test('chat：完整读取成功后清除超时并保留合法内容', async (t) => {
  let signal;
  mockChat(t, async (url, opts) => {
    signal = opts.signal;
    return Response.json({ choices: [{ message: { content: '{"reply":"你好"}' } }] });
  });
  assert.equal(await llm.chat([]), '{"reply":"你好"}');
  t.mock.timers.tick(3000);
  assert.equal(signal.aborted, false);
});

test('parseJsonContent：容忍围栏与噪声，拒绝非法输出', () => {
  assert.deepEqual(llm.parseJsonContent('{"reply":"hi"}'), { reply: 'hi' });
  assert.deepEqual(llm.parseJsonContent('```json\n{"reply":"hi"}\n```'), { reply: 'hi' });
  assert.deepEqual(llm.parseJsonContent('好的，结果如下：{"reply":"hi"} 请查收'), { reply: 'hi' });
  return errCode(Promise.resolve().then(() => llm.parseJsonContent('完全没有 JSON'))).then((e) => {
    assert.equal(e.code, 'E5012');
  });
});

test('normalizeProfile：白名单槽位 + 夹紧，未知字段不渗入', () => {
  const p = llm.normalizeProfile({
    goalType: '考研', goalName: ' 2027 考研 ', deadline: '2027-12-25',
    weeklyH: 200, level: '三轮', subjects: ['数学', '', 42, '英语'], preferences: 'x'.repeat(300),
    hackField: '<script>'
  });
  assert.equal(p.weeklyH, 80);              /* 夹到上限 */
  assert.equal(p.level, null);              /* 非法枚举丢弃 */
  assert.deepEqual(p.subjects, ['数学', '英语']);
  assert.equal(p.preferences.length, 200);
  assert.equal('hackField' in p, false);    /* 白名单外字段不透传 */
  assert.deepEqual(llm.profileMissing({ goalName: 'g', deadline: '2027-12-25', weeklyH: 5, goalType: '考研' }), []);
  assert.deepEqual(llm.profileMissing({}), ['goalName', 'deadline', 'weeklyH', 'goalType']);
});

test('clarifyTurn：围栏 JSON 归一；幻觉 done 被强制拉回追问态', async () => {
  setLlmEnv();
  const capture = [];
  stubFetch('```json\n{"reply":"每周能投入多少时间？","goalType":"考研","goalName":"考研","deadline":"2027-12-25","weeklyH":20,"level":null,"subjects":["数学"],"preferences":null,"done":true,"missing":[]}\n```', capture);
  try {
    const r = await llm.clarifyTurn([{ role: 'user', content: '我想考研' }], null);
    assert.equal(r.reply, '每周能投入多少时间？');
    assert.equal(r.done, true);            /* 槽位齐备：done 放行 */
    assert.deepEqual(r.missing, []);
    assert.equal(capture[0].url, 'https://llm.example.test/api/v4/chat/completions');
    assert.equal(capture[0].body.model, 'glm-4-flash');
    assert.equal(capture[0].body.messages[0].role, 'system');

    /* 幻觉兜底：宣称完成但 deadline 缺失 → 强制 done=false */
    stubFetch('{"reply":"好","goalType":"考研","goalName":"考研","done":true}');
    const r2 = await llm.clarifyTurn([{ role: 'user', content: '就这样吧' }], { goalType: '考研', goalName: '考研' });
    assert.equal(r2.done, false);
    assert.ok(r2.missing.includes('deadline'));
  } finally { restoreFetch(); clearLlmEnv(); }
});

test('clarifyTurn：画像合并以服务端归一为底，LLM 只补增量', async () => {
  setLlmEnv();
  stubFetch('{"reply":"好","goalType":"考研","goalName":"考研","deadline":"2027-12-25","weeklyH":20,"level":"一轮","subjects":[],"preferences":null,"done":true}');
  try {
    const r = await llm.clarifyTurn([{ role: 'user', content: '对' }],
      { goalType: '考研', goalName: '考研', deadline: '2027-12-25', weeklyH: 20, level: '一轮', subjects: ['数学'], extra: 1 });
    assert.equal(r.done, true);
    assert.deepEqual(r.profile.subjects, ['数学']);
    assert.equal('extra' in r.profile, false);
  } finally { restoreFetch(); clearLlmEnv(); }
});

test('analyzeProfile：画像不齐 E1001；建议夹紧到引擎边界', async () => {
  setLlmEnv();
  try {
    await errCode(llm.analyzeProfile({ goalName: '缺时间' }, null)).then((e) => {
      assert.equal(e.code, 'E1001');
    });
    stubFetch(JSON.stringify({
      summary: 's', demandH: 99999, weeklyH: 300,
      tasks: Array.from({ length: 12 }, (_, i) => ({
        s: '数学', title: '任务 ' + i, est: 300, weight: 9
      })),
      risks: ['r1', 'r2', 'r3', 'r4'], advice: 'a'
    }));
    const sug = await llm.analyzeProfile({
      goalType: '考研', goalName: '2027 考研', deadline: '2027-12-25', weeklyH: 20, level: '一轮', subjects: ['数学']
    }, { weekAchievement: 0.4 });
    assert.equal(sug.demandH, 5000);          /* 夹到上限 */
    assert.equal(sug.weeklyH, 80);
    assert.equal(sug.tasks.length, 8);        /* 上限 8 项 */
    assert.equal(sug.tasks[0].est, 240);      /* 单项夹紧 */
    assert.equal(sug.tasks[0].weight, 1);
    assert.equal(sug.risks.length, 3);
  } finally { restoreFetch(); clearLlmEnv(); }
});

test('未配置环境变量：clarifyTurn 抛 E5010，不发起网络请求', async () => {
  clearLlmEnv();
  let fetched = false;
  globalThis.fetch = () => { fetched = true; return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }); };
  try {
    const e = await errCode(llm.clarifyTurn([{ role: 'user', content: 'hi' }], null));
    assert.equal(e.code, 'E5010');
    assert.equal(fetched, false);
  } finally { restoreFetch(); }
});

test('HTTP 层：401 先于业务；未配置 503 E5010；输出非法 502 E5012', async () => {
  clearLlmEnv();
  const server = await start(0);
  try {
    /* 未带凭证：鉴权先于 LLM 判定 */
    const noAuth = await fetch(server.url + '/api/llm/clarify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [] })
    });
    assert.equal(noAuth.status, 401);

    const session = await (await fetch(server.url + '/api/auth/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    })).json();
    const auth = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.token };

    /* 已配置但上游返回垃圾：E5012 → HTTP 502 */
    setLlmEnv();
    stubFetch('这不是 JSON');
    const bad = await fetch(server.url + '/api/llm/clarify', {
      method: 'POST', headers: auth, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    });
    assert.equal(bad.status, 502);
    const badBody = await bad.json();
    assert.equal(badBody.error.code, 'E5012');

    /* 正常输出 → 200，结构化出参 */
    stubFetch('{"reply":"目标是什么？","goalType":null,"goalName":null,"deadline":null,"weeklyH":null,"level":null,"subjects":[],"preferences":null,"done":false}');
    const ok = await fetch(server.url + '/api/llm/clarify', {
      method: 'POST', headers: auth, body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] })
    });
    assert.equal(ok.status, 200);
    const okBody = await ok.json();
    assert.equal(okBody.reply, '目标是什么？');
    assert.equal(okBody.done, false);
    assert.ok(Array.isArray(okBody.missing));

    /* 未配置 → 503 E5010（同时验证异步 handler 的错误链路） */
    clearLlmEnv();
    const unconf = await fetch(server.url + '/api/llm/clarify', {
      method: 'POST', headers: auth, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    });
    assert.equal(unconf.status, 503);
    assert.equal((await unconf.json()).error.code, 'E5010');

    /* analyze：缺画像字段 → E1001 */
    const noProfile = await fetch(server.url + '/api/llm/analyze', {
      method: 'POST', headers: auth, body: JSON.stringify({})
    });
    assert.equal(noProfile.status, 400);
    assert.equal((await noProfile.json()).error.code, 'E1001');
  } finally {
    restoreFetch();
    clearLlmEnv();
    await server.close();
  }
});
