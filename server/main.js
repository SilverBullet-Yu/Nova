'use strict';
/* 诺瓦 Nova · HTTP 入口
 *
 * 契约：docs/HANDOFF.md §5（前缀 /api）
 * 同时静态托管前端：GET / → index.html，/assets/* 与 /shared/* 直出，
 * 因此根路径即可跑完整前端（前后端同源）。
 *
 * 部署适配：
 * - 端口取 PORT 环境变量（部署环境注入），本地默认 8787
 * - 绑定 0.0.0.0 以便反向代理接入；本地收紧可用 HOST=127.0.0.1
 *
 * 零第三方依赖，只用 node: 内置模块。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const { createRouter, ApiError } = require('./api/routes.js');
const store = require('./store/memory.js');

const ROOT = path.resolve(__dirname, '..');
/* 绑定地址：部署环境要求 0.0.0.0 才能被反向代理访问；本地开发可用 HOST=127.0.0.1 收紧。 */
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 8787;
const MAX_BODY_BYTES = 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

/**
 * CORS 策略：
 * 1. 本机来源（127.0.0.1 / localhost / file:// 的 null origin）——支持 file:// 双击打开的前端连后端；
 * 2. 同源来源（Origin 的 host 与请求 Host 一致）——支持云端部署后前端与 API 同源互调。
 * 其余外部站点一律拒绝。
 */
function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin) return {};
  const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin) || origin === 'null';
  let sameOrigin = false;
  if (!local) {
    try {
      const originHost = new URL(origin).host;
      sameOrigin = !!originHost && originHost === req.headers.host;
    } catch (e) { /* origin 非法则不放行 */ }
  }
  if (!local && !sameOrigin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin'
  };
}

function sendJson(res, status, obj, extraHeaders) {
  const payload = JSON.stringify(obj === undefined ? null : obj);
  const headers = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  }, extraHeaders || {});
  res.writeHead(status, headers);
  res.end(payload);
}

function sendError(res, code, message, status) {
  const st = status || 500;
  sendJson(res, st, { error: { code: code, message: message } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        reject(new ApiError('E4002', '请求体超过 ' + MAX_BODY_BYTES + ' 字节上限'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) { resolve({}); return; }
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new ApiError('E1001', '请求体不是合法 JSON'));
      }
    });
    req.on('error', (e) => {
      if (done) return;
      done = true;
      reject(new ApiError('E9001', e && e.message ? e.message : '请求读取失败'));
    });
  });
}

/** 静态资源：仅放行 /、/index.html、/assets/*、/shared/*，并做目录穿越防护 */
function resolveStatic(pathname) {
  let rel = pathname;
  if (rel === '/' || rel === '') rel = '/index.html';
  const allowed = rel === '/index.html'
    || rel.startsWith('/assets/')
    || rel.startsWith('/shared/');
  if (!allowed) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(rel);
  } catch (e) {
    return null;
  }
  const abs = path.resolve(ROOT, '.' + decoded);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  return abs;
}

function serveStatic(res, pathname) {
  const abs = resolveStatic(pathname);
  if (!abs) {
    sendError(res, 'E2001', '静态资源不存在：' + pathname, 404);
    return;
  }
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) {
      sendError(res, 'E2001', '静态资源不存在：' + pathname, 404);
      return;
    }
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(abs).pipe(res);
  });
}

function createServer() {
  const router = createRouter(store);

  return http.createServer((req, res) => {
    let parsed;
    try {
      parsed = new URL(req.url, 'http://' + (req.headers.host || DEFAULT_HOST + ':' + DEFAULT_PORT));
    } catch (e) {
      sendError(res, 'E1001', 'URL 非法', 400);
      return;
    }
    const pathname = parsed.pathname;
    const cors = corsHeaders(req);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendError(res, 'E1001', '静态资源仅支持 GET', 405);
        return;
      }
      serveStatic(res, pathname);
      return;
    }

    readBody(req).then((body) => {
      const ctx = { method: req.method, pathname: pathname, query: parsed.searchParams, body: body, req: req };
      const out = router.handle(ctx);
      sendJson(res, out.status, out.body, cors);
    }).catch((err) => {
      if (err instanceof ApiError) {
        sendError(res, err.code, err.message, err.status);
        return;
      }
      sendError(res, 'E9001', err && err.message ? err.message : '未分类异常', 500);
    });
  });
}

/** 启动服务；port 传 0 表示随机端口（测试用） */
function resolveHost() {
  const env = process.env.HOST;
  if (env) return env;
  return DEFAULT_HOST;
}

function start(port, host) {
  const server = createServer();
  const p = port === undefined || port === null ? DEFAULT_PORT : port;
  const h = host || resolveHost();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(p, h, () => {
      const addr = server.address();
      resolve({
        server: server,
        port: addr.port,
        host: h,
        url: 'http://' + h + ':' + addr.port,
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}

if (require.main === module) {
  const envPort = process.env.PORT ? parseInt(process.env.PORT, 10) : DEFAULT_PORT;
  start(envPort, resolveHost()).then((h) => {
    process.stdout.write('诺瓦 Nova · 服务已启动 http://' + h.host + ':' + h.port + '\n');
    process.stdout.write('  GET  /api/health        健康检查\n');
    process.stdout.write('  GET  /api/state         初始全量状态\n');
    process.stdout.write('  POST /api/feasibility   可行性评估\n');
    process.stdout.write('  POST /api/schedule      排程\n');
    process.stdout.write('  POST /api/replan        四级重排（含快照）\n');
    process.stdout.write('  POST /api/replan/undo   撤销重排\n');
    process.stdout.write('  POST /api/attribute     偏差归因\n');
    process.stdout.write('  POST /api/sessions      打卡上报（幂等）\n');
    process.stdout.write('  GET  /api/sync?since=N  增量拉取\n');
    process.stdout.write('  POST /api/sync/ops      批量上行（≤200）\n');
    process.stdout.write('  GET  /api/reports/weekly 周报\n');
  }).catch((e) => {
    process.stderr.write('启动失败：' + (e && e.message ? e.message : String(e)) + '\n');
    process.exit(1);
  });
}

module.exports = { createServer: createServer, start: start, store: store, ROOT: ROOT, DEFAULT_PORT: DEFAULT_PORT };
