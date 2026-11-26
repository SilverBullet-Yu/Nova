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
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (e) {
    return null;
  }
  /* URL 只接受正斜杠；跨平台拒绝 Windows 分隔符、盘符/数据流与 NUL。 */
  if (/[\\\0:]/.test(decoded)) return null;
  if (decoded === '/' || decoded === '') decoded = '/index.html';
  if (!decoded.startsWith('/')) return null;
  const abs = path.resolve(ROOT, '.' + decoded);
  /* 必须校验解码、规范化后的最终路径，而非原始 URL 或整个项目 ROOT。 */
  const allowed = abs === path.join(ROOT, 'index.html')
    || abs.startsWith(path.join(ROOT, 'assets') + path.sep)
    || abs.startsWith(path.join(ROOT, 'shared') + path.sep);
  if (!allowed) return null;
  try {
    const real = fs.realpathSync(abs);
    const realAllowed = real === path.join(ROOT, 'index.html')
      || real.startsWith(path.join(ROOT, 'assets') + path.sep)
      || real.startsWith(path.join(ROOT, 'shared') + path.sep);
    return realAllowed ? real : null;
  } catch (e) {
    return null;
  }
}

function serveStatic(res, pathname) {
  const abs = resolveStatic(pathname);
  if (!abs) {
    sendError(res, 'E2001', '静态资源不存在：' + pathname, 404);
    return;
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  fs.open(abs, flags, (openErr, fd) => {
    if (openErr) {
      sendError(res, 'E2001', '静态资源不存在：' + pathname, 404);
      return;
    }
    fs.fstat(fd, (statErr, st) => {
      if (statErr || !st.isFile()) {
        fs.close(fd, () => sendError(res, 'E2001', '静态资源不存在：' + pathname, 404));
        return;
      }
      const ext = path.extname(abs).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-cache'
      });
      const stream = fs.createReadStream(abs, { fd: fd, autoClose: true });
      /* 打开后仍可能遇到读取错误；响应头已发出则断开，否则回 500。 */
      stream.on('error', function () {
        if (res.headersSent) res.destroy();
        else sendError(res, 'E5001', '静态资源读取失败：' + pathname, 500);
      });
      stream.pipe(res);
    });
  });
}

module.exports = { resolveStatic: resolveStatic, serveStatic: serveStatic };
