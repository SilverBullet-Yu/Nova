'use strict';
/* 诺瓦 Nova · HTTP 响应原语
 *
 * JSON 收发与统一错误形状 { error: { code, message } } 的唯一出口；
 * main.js 与 static.js 共用，避免响应逻辑双写。
 */

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

function sendError(res, code, message, status, extraHeaders) {
  const st = status || 500;
  sendJson(res, st, { error: { code: code, message: message } }, extraHeaders);
}

module.exports = { sendJson: sendJson, sendError: sendError };
