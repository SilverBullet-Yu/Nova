'use strict';
require('./isolate-store').isolateStore();
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('../server/main.js');

test('HTTP 服务默认只绑定回环地址', async t => {
  const previous = process.env.HOST;
  delete process.env.HOST;
  t.after(() => {
    if (previous === undefined) delete process.env.HOST;
    else process.env.HOST = previous;
  });
  const handle = await start(0);
  t.after(() => handle.close());
  assert.equal(handle.host, '127.0.0.1');
});

test('CORS 默认拒绝跨源与 null，仅显式白名单放行', async t => {
  const previousOrigins = process.env.NOVA_ALLOWED_ORIGINS;
  const previousNull = process.env.NOVA_ALLOW_NULL_ORIGIN;
  delete process.env.NOVA_ALLOWED_ORIGINS;
  delete process.env.NOVA_ALLOW_NULL_ORIGIN;
  t.after(() => {
    if (previousOrigins === undefined) delete process.env.NOVA_ALLOWED_ORIGINS;
    else process.env.NOVA_ALLOWED_ORIGINS = previousOrigins;
    if (previousNull === undefined) delete process.env.NOVA_ALLOW_NULL_ORIGIN;
    else process.env.NOVA_ALLOW_NULL_ORIGIN = previousNull;
  });
  const handle = await start(0, '127.0.0.1');
  t.after(() => handle.close());
  for (const origin of ['null', 'http://localhost:9999', 'https://attacker.invalid']) {
    const response = await fetch(handle.url + '/api/health', { headers: { Origin: origin } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  process.env.NOVA_ALLOWED_ORIGINS = 'https://app.example.test';
  const allowed = await fetch(handle.url + '/api/health', { headers: { Origin: 'https://app.example.test' } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://app.example.test');
  const notAllowed = await fetch(handle.url + '/api/health', { headers: { Origin: 'https://other.example.test' } });
  assert.equal(notAllowed.headers.get('access-control-allow-origin'), null);
  process.env.NOVA_ALLOW_NULL_ORIGIN = '1';
  const fileOrigin = await fetch(handle.url + '/api/health', { headers: { Origin: 'null' } });
  assert.equal(fileOrigin.headers.get('access-control-allow-origin'), 'null');
});

test('HTTP 服务默认设置 headers/request/keep-alive 超时与最大连接数', async t => {
  const handle = await start(0, '127.0.0.1');
  t.after(() => handle.close());
  assert.equal(handle.server.headersTimeout, 10000);
  assert.equal(handle.server.requestTimeout, 130000);
  assert.equal(handle.server.keepAliveTimeout, 5000);
  assert.equal(handle.server.maxConnections, 128);
  const response = await fetch(handle.url + '/api/health');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

test('HTTP 边界可由环境变量覆盖并做上下限约束', async t => {
  const previous = {};
  const values = {
    NOVA_HTTP_HEADERS_TIMEOUT_MS: '2000',
    NOVA_HTTP_REQUEST_TIMEOUT_MS: '150000',
    NOVA_HTTP_KEEP_ALIVE_TIMEOUT_MS: '3000',
    NOVA_HTTP_MAX_CONNECTIONS: '64'
  };
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const handle = await start(0, '127.0.0.1');
  t.after(() => handle.close());
  assert.equal(handle.server.headersTimeout, 2000);
  assert.equal(handle.server.requestTimeout, 150000);
  assert.equal(handle.server.keepAliveTimeout, 3000);
  assert.equal(handle.server.maxConnections, 64);
});
