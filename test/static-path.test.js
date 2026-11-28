'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const nodeFs = require('node:fs');
const { Writable } = require('node:stream');
const { finished } = require('node:stream/promises');
const { resolveStatic, serveStatic } = require('../server/static.js');

const ROOT = path.resolve(__dirname, '..');

/* 直接使用内存响应流，不启动 HTTP 服务，也不让 URL 客户端预先折叠路径。 */
async function responseFor(pathname) {
  const chunks = [];
  const res = new Writable({
    write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); }
  });
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  const done = finished(res);
  serveStatic(res, pathname);
  await done;
  return { status: res.status, headers: res.headers, body: Buffer.concat(chunks) };
}

test('静态路径：编码目录逃逸与非公开目录一律拒绝', async () => {
  const denied = [
    '/assets/..%2fserver/main.js',
    '/assets/%2e%2e%2Fserver/llm.js',
    '/shared/..%2fserver/main.js',
    '/shared/%2E%2E/%2E%2E/secret.txt',
    '/assets/../../Nova/server/main.js',
    '/assets/../assets-private/secret.js',
    '/shared/../shared-private/secret.js',
    '/assets/..%5cserver/main.js',
    '/shared/%2e%2e%5Cserver/main.js',
    '/assets/..\\server\\main.js',
    '/assets\\..\\server/main.js',
    '/assets/%5c%5cserver/share/file.js',
    '/assets/C%3a/secret.js',
    '/index.html%3Asecret',
    '/server/main.js', '/package.json', '/assets', '/shared/'
  ];
  for (const pathname of denied) {
    assert.equal(resolveStatic(pathname), null, pathname);
    const res = await responseFor(pathname);
    assert.equal(res.status, 404, pathname);
    assert.equal(JSON.parse(res.body).error.code, 'E2001', pathname);
  }
});

test('静态路径：畸形编码与 NUL 拒绝且不抛异常', async () => {
  for (const pathname of ['/assets/%', '/assets/%GG', '/assets/%E0%A4%A', '/assets/a%00.js', '/shared/a\0.js']) {
    assert.equal(resolveStatic(pathname), null, pathname);
    assert.equal((await responseFor(pathname)).status, 404, pathname);
  }
});

test('静态资源读取失败时断开响应且不产生未捕获异常', async () => {
  const original = nodeFs.createReadStream;
  const chunks = [];
  const res = new Writable({
    write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); }
  });
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; res.headersSent = true; };
  const closed = new Promise(resolve => res.once('close', resolve));
  nodeFs.createReadStream = (...args) => {
    const stream = original(...args);
    process.nextTick(() => stream.destroy(new Error('synthetic static read failure')));
    return stream;
  };
  try {
    serveStatic(res, '/assets/js/main.js');
    await closed;
  } finally {
    nodeFs.createReadStream = original;
  }
  assert.equal(res.status, 200);
  assert.equal(res.destroyed, true);
  assert.equal(Buffer.concat(chunks).length, 0);
});

test('静态路径：解码和规范化后仍公开的本地资源保持可用', async () => {
  const cases = [
    ['/', 'index.html'], ['', 'index.html'], ['/index.html', 'index.html'],
    ['/%69ndex.html', 'index.html'],
    ['/assets/js/main.js', 'assets/js/main.js'],
    ['/assets/js/%6dain.js', 'assets/js/main.js'],
    ['/assets/js/../js/main.js', 'assets/js/main.js'],
    ['/assets/js%2fmain.js', 'assets/js/main.js'],
    ['/shared/workflow.js', 'shared/workflow.js'],
    ['/shared/engine/../workflow.js', 'shared/workflow.js']
  ];
  for (const [pathname, relative] of cases) {
    const expected = path.join(ROOT, relative);
    assert.equal(resolveStatic(pathname), expected, pathname);
    const res = await responseFor(pathname);
    assert.equal(res.status, 200, pathname);
    assert.equal(res.headers['Cache-Control'], 'no-cache');
    assert.deepEqual(res.body, await fs.readFile(expected), pathname);
  }
});
