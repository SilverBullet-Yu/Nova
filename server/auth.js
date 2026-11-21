'use strict';
/* 诺瓦 Nova · 身份凭证与写接口限流
 *
 * ── 身份模型（最小可上线形态）─────────────────────────────────────────────
 * · 身份只由服务端确立：POST /api/auth/session 随机生成 userId，并签进凭证。
 * · 业务接口一律从 Authorization: Bearer <token> 解析身份，请求体里的 userId 不参与判定。
 * · 不做账号/密码/第三方登录：本期只需要「同一浏览器稳定落到同一服务端分区」。
 *
 * ── 凭证来源、存储位置、过期策略 ──────────────────────────────────────────
 * · 签名密钥：读取进程环境变量 NOVA_AUTH_SECRET（建议 ≥32 字节随机串）。
 *   未配置时，非生产环境生成进程级随机密钥并告警——该密钥随进程重启失效，
 *   因此只能在本地开发/测试使用；生产环境必须显式配置，否则拒绝启动。
 * · 凭证形态：nj1.<payloadBase64url>.<signatureBase64url>
 *   payload = { u: userId, iat: 签发毫秒, exp: 过期毫秒 }，签名算法 HMAC-SHA256。
 * · 过期：7 天（TOKEN_TTL_MS）。服务端每次请求校验签名与 exp，过期返回 401。
 * · 客户端存储：assets/js/api.js 写入 localStorage['zx.auth_token']，
 *   只保存服务端签发的 token 与 expiresAt，不保存任何可自造身份的字段。
 *
 * ── 限流 ──────────────────────────────────────────────────────────────────
 * · 固定窗口，单进程内存，按「身份 + 路由」隔离；未认证路由（签发凭证）按来源 IP 隔离。
 * · 阈值见 WRITE_LIMITS；超限返回 429 + Retry-After，不做排队与自动重试。
 */

const crypto = require('node:crypto');

/** 凭证有效期：7 天 */
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 凭证前缀，便于将来区分算法版本 */
const TOKEN_PREFIX = 'nj1';

/** 生产环境密钥最小长度（字节） */
const SECRET_MIN_BYTES = 32;

function resolveSecret() {
  const env = process.env.NOVA_AUTH_SECRET;
  if (env && Buffer.byteLength(env, 'utf8') >= SECRET_MIN_BYTES) {
    return Buffer.from(env, 'utf8');
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('生产环境必须配置 NOVA_AUTH_SECRET（至少 ' + SECRET_MIN_BYTES + ' 字节）');
  }
  process.stderr.write(
    '[auth] 未配置 NOVA_AUTH_SECRET，已生成进程级临时密钥；' +
    '进程重启后旧凭证全部失效，仅限本地开发与测试\n'
  );
  return crypto.randomBytes(SECRET_MIN_BYTES);
}

const SECRET = resolveSecret();

function sign(payloadB64) {
  return crypto.createHmac('sha256', SECRET).update(payloadB64).digest('base64url');
}

/**
 * 签发新身份凭证
 * @returns {{ token: string, userId: string, expiresAt: number }}
 */
function issueSession() {
  /* userId 由服务端随机生成，客户端无法指定，也不接受请求体中的任何身份字段 */
  const userId = 'u_' + crypto.randomBytes(9).toString('base64url');
  const iat = Date.now();
  const exp = iat + TOKEN_TTL_MS;
  const payloadB64 = Buffer.from(
    JSON.stringify({ u: userId, iat: iat, exp: exp }),
    'utf8'
  ).toString('base64url');
  return {
    token: TOKEN_PREFIX + '.' + payloadB64 + '.' + sign(payloadB64),
    userId: userId,
    expiresAt: exp
  };
}

/**
 * 校验凭证
 * @returns {{ userId: string } | null} 非法/过期返回 null
 */
function verifyToken(token) {
  if (typeof token !== 'string' || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;

  const payloadB64 = parts[1];
  const sig = Buffer.from(parts[2], 'base64url');
  const expect = Buffer.from(sign(payloadB64), 'base64url');
  if (sig.length !== expect.length || !crypto.timingSafeEqual(sig, expect)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
  if (!payload || typeof payload.u !== 'string' || !payload.u) return null;
  if (typeof payload.exp !== 'number' || payload.exp <= Date.now()) return null;
  return { userId: payload.u };
}

/** 从请求头读取 Bearer 凭证；缺失或格式不符返回 null */
function readBearer(req) {
  const raw = req && req.headers ? req.headers.authorization : null;
  if (!raw) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(String(raw));
  return m ? m[1] : null;
}

/* ── 写接口限流（单进程固定窗口）──────────────────────────────────────────
 * 阈值含义：同一身份（未认证路由按 IP）在 windowMs 内最多允许 limit 次请求。
 * 触发后返回 429；窗口内不自动续期，也不做滑动窗口平滑。
 * ----------------------------------------------------------------------- */
const WRITE_LIMITS = {
  /* 签发凭证按来源 IP 限制，避免匿名刷身份。
     来源 IP 由 clientIp() 解析：默认取 TCP 对端地址；部署在网关后设 NOVA_TRUST_PROXY=1
     采信 X-Forwarded-For 最后一跳（网关追加的真实客户端 IP），避免全部访客共享同一桶。 */
  'POST /api/auth/session': { limit: 60, windowMs: 60000 },
  'POST /api/sync/ops': { limit: 60, windowMs: 60000 },
  'POST /api/replan': { limit: 12, windowMs: 60000 },
  'POST /api/replan/confirm': { limit: 12, windowMs: 60000 },
  'POST /api/replan/undo': { limit: 12, windowMs: 60000 },
  'POST /api/feasibility': { limit: 30, windowMs: 60000 },
  'POST /api/schedule': { limit: 30, windowMs: 60000 },
  'POST /api/plan/review': { limit: 30, windowMs: 60000 },
  'POST /api/attribute': { limit: 30, windowMs: 60000 }
};

/** key → { count, resetAt } */
const buckets = new Map();

/** 桶数量过大时清理已过期窗口，避免长期运行无限增长 */
function sweep(now) {
  if (buckets.size < 4096) return;
  for (const entry of buckets) {
    if (entry[1].resetAt <= now) buckets.delete(entry[0]);
  }
}

/**
 * 记一次请求并判断是否超限
 * @returns {{ allowed: boolean, retryAfterSec?: number }}
 */
function hitLimit(key, rule) {
  const now = Date.now();
  const cur = buckets.get(key);
  if (!cur || cur.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + rule.windowMs });
    sweep(now);
    return { allowed: true };
  }
  if (cur.count >= rule.limit) {
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((cur.resetAt - now) / 1000))
    };
  }
  cur.count += 1;
  return { allowed: true };
}

/**
 * 限流用来源标识：默认取 TCP 对端地址（不可伪造）。
 * 仅在显式设置 NOVA_TRUST_PROXY=1 时采信 X-Forwarded-For 的最后一跳——
 * 该头可被客户端伪造，前置值不可信；只有网关追加的最后一跳才是真实来源。
 * 无该头或全部为空跳时回落 socket 地址，行为与未开代理模式一致。
 * @param {{socket?: {remoteAddress?: string}, headers?: Object<string,string>}} req
 * @returns {string}
 */
function clientIp(req) {
  const socketAddr = (req && req.socket && req.socket.remoteAddress) || 'unknown';
  if (process.env.NOVA_TRUST_PROXY !== '1') return socketAddr;
  const xff = req && req.headers ? String(req.headers['x-forwarded-for'] || '') : '';
  if (!xff) return socketAddr;
  const hops = xff.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  return hops.length ? hops[hops.length - 1] : socketAddr;
}

module.exports = {
  TOKEN_TTL_MS: TOKEN_TTL_MS,
  issueSession: issueSession,
  verifyToken: verifyToken,
  readBearer: readBearer,
  WRITE_LIMITS: WRITE_LIMITS,
  hitLimit: hitLimit,
  clientIp: clientIp
};
