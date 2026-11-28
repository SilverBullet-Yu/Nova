'use strict';
/* 诺瓦 Nova · HTTP 入口
 *
 * 契约：docs/HANDOFF.md §5（前缀 /api）
 * 同时静态托管前端：GET / → index.html，/assets/* 与 /shared/* 直出，
 * 因此根路径即可跑完整前端（前后端同源）。
 *
 * 部署适配：
 * - 端口取 PORT 环境变量（部署环境注入），本地默认 8787
 * - 默认仅绑定回环地址；需要局域网或反向代理访问时显式设置 HOST
 *
 * 零第三方依赖，只用 node: 内置模块。
 */

const http = require('node:http');
const { URL } = require('node:url');
const { randomUUID } = require('node:crypto');

const { createRouter, ApiError } = require('./api/routes.js');
const store = require('./store/memory.js');
const auth = require('./auth.js');
const llm = require('./llm.js');
const { sendJson, sendError } = require('./resp.js');
const { serveStatic } = require('./static.js');

/* 默认只监听回环，避免匿名发证与计算接口意外暴露到局域网；部署时显式覆盖 HOST。 */
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * CORS 只接受显式配置的精确 origin；同源浏览器请求不需要 CORS 头。
 * file:// 的 null origin 默认关闭，需要时用 NOVA_ALLOW_NULL_ORIGIN=1 显式开启。
 */
function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin) return {};
  const configured = String(process.env.NOVA_ALLOWED_ORIGINS || '')
    .split(',').map(value => value.trim()).filter(Boolean);
  const allowed = configured.includes(origin) ||
    (origin === 'null' && process.env.NOVA_ALLOW_NULL_ORIGIN === '1');
  if (!allowed) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin'
  };
}

/* JSON 收发与统一错误形状在 server/resp.js；静态托管在 server/static.js。 */

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
        /* 继续消费并丢弃余下数据，避免销毁连接导致错误响应无法送达。 */
        req.resume();
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
      reject(new ApiError('E9001', '请求读取失败'));
    });
  });
}

/* 静态托管与响应原语已拆至 server/static.js 与 server/resp.js；
 * 鉴权与限流的逐路由判定以 routes.js 注册表元数据（public / limit）为单一事实源。 */

function envBound(name, fallback, min, max) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min && value > 0
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}

function createServer() {
  const router = createRouter(store, auth);

  const server = http.createServer((req, res) => {
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

    /* ── 鉴权：身份只从 Bearer 凭证解析，请求体不参与身份判定。
          路由注册表 public === true 的入口（健康检查、凭证签发本身）免鉴权；
          未注册路径与受保护路径同样要求凭证，保持 401 先于 404 的既有行为 ── */
    const routeKey = req.method + ' ' + pathname;
    const entry = router.routes[routeKey];
    let userId = null;
    if (!entry || !entry.public) {
      const identity = auth.verifyToken(auth.readBearer(req));
      if (!identity) {
        sendError(res, 'E4010', '未提供有效凭证，请先调用 POST /api/auth/session', 401,
          Object.assign({ 'WWW-Authenticate': 'Bearer' }, cors));
        return;
      }
      userId = identity.userId;
      if (store.isUserRevoked(userId)) {
        sendError(res, 'E4030', '用户身份已撤销', 403, cors);
        return;
      }
    }

    /* ── 写接口限流：阈值随路由注册表 limit 字段声明；已认证按 userId 隔离，签发凭证按来源 IP 隔离 ── */
    const rule = entry && entry.limit;
    if (rule) {
      const who = userId
        ? 'user:' + userId
        : 'ip:' + auth.clientIp(req);
      const limit = auth.hitLimit(who + ' ' + routeKey, rule);
      if (!limit.allowed) {
        sendError(res, 'E4290',
          '请求过于频繁：' + routeKey + ' 上限 ' + rule.limit + ' 次 / ' +
          Math.round(rule.windowMs / 1000) + ' 秒，请稍后再试',
          429, Object.assign({ 'Retry-After': String(limit.retryAfterSec) }, cors));
        return;
      }
    }

    readBody(req).then((body) => {
      const ctx = {
        method: req.method,
        pathname: pathname,
        query: parsed.searchParams,
        body: body,
        req: req,
        userId: userId
      };
      return router.handle(ctx);
    }).then((out) => {
      sendJson(res, out.status, out.body, cors);
    }).catch((err) => {
      const requestId = randomUUID();
      if (err instanceof ApiError) {
        if (err.code === 'E5001') {
          console.error('[nova] ' + requestId + ' ' + (err.message || '服务内部错误'));
          sendError(res, 'E5001', '服务内部错误', 500, Object.assign({ 'X-Request-Id': requestId }, cors));
          return;
        }
        sendError(res, err.code, err.message, err.status, Object.assign({ 'X-Request-Id': requestId }, cors));
        return;
      }
      console.error('[nova] ' + requestId, err);
      sendError(res, 'E9001', '服务内部错误', 500, Object.assign({ 'X-Request-Id': requestId }, cors));
    });
  });
  server.headersTimeout = envBound('NOVA_HTTP_HEADERS_TIMEOUT_MS', 10000, 1000, 60000);
  server.requestTimeout = envBound('NOVA_HTTP_REQUEST_TIMEOUT_MS', 130000, 1000, 300000);
  server.keepAliveTimeout = envBound('NOVA_HTTP_KEEP_ALIVE_TIMEOUT_MS', 5000, 1000, 60000);
  server.maxConnections = envBound('NOVA_HTTP_MAX_CONNECTIONS', 128, 1, 10000);
  return server;
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
    process.stdout.write('  POST /api/auth/session  签发身份凭证\n');
    process.stdout.write('  GET  /api/state         初始全量状态\n');
    process.stdout.write('  POST /api/feasibility   可行性评估\n');
    process.stdout.write('  POST /api/schedule      排程\n');
    process.stdout.write('  POST /api/plan/review   计划离线复核\n');
    process.stdout.write('  POST /api/replan        四级重排（含快照）\n');
    process.stdout.write('  POST /api/replan/undo   撤销重排\n');
    process.stdout.write('  POST /api/replan/confirm 确认放弃并落库\n');
    process.stdout.write('  POST /api/attribute     偏差归因\n');
    process.stdout.write('  POST /api/sync/ops      批量上行（≤200）\n');
    process.stdout.write('  POST /api/llm/clarify   对话式需求澄清（LLM）\n');
    process.stdout.write('  POST /api/llm/analyze   计划拆解建议（LLM）\n');
    if (!llm.configured()) {
      process.stdout.write('  ⚠ LLM 未配置（LLM_BASE_URL / LLM_API_KEY / LLM_MODEL）：智能澄清不可用，前端自动降级为表单流程\n');
    }
  }).catch((e) => {
    process.stderr.write('启动失败：' + (e && e.message ? e.message : String(e)) + '\n');
    process.exit(1);
  });
}

module.exports = { start: start };
