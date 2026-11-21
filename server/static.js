'use strict';
/* 诺瓦 Nova · 静态资源托管
 *
 * 白名单仅 /、/index.html、/assets/*、/shared/*（契约：HANDOFF §5），
 * 其余路径一律 404 E2001；含 decodeURIComponent 失败与目录穿越双重防护。
 * 静态资源以 Cache-Control: no-cache 提供——前端离线指示不依赖网络，
 * 但后端可达时必须能拿到最新资产。
 */

const fs = require('node:fs');
const path = require('node:path');
const { sendError } = require('./resp.js');

const ROOT = path.resolve(__dirname, '..');

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

module.exports = { resolveStatic: resolveStatic, serveStatic: serveStatic };
