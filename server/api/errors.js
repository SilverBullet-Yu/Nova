'use strict';
/* 诺瓦 Nova · REST 错误码表与 ApiError
 *
 * 从 routes.js 拆出（2026-11-22）：server/llm.js 与 routes.js 相互引用，
 * ApiError 若留在 routes.js 会形成 require 环。本模块零依赖，供两侧共用；
 * routes.js 原样再导出 ApiError，既有引用面（main.js / 测试）不受影响。
 */

const ERRORS = {
  /* 附录 B 错误码 → HTTP 状态码
   * E1001 参数非法 / 缺失        → 400
   * E2001 资源不存在             → 404
   * E3001 状态冲突               → 409
   * E3002 资源已存在             → 409
   * E4001 幂等键重复（视为成功）  → 200
   * E4002 请求体过大 / 批量超限  → 400
   * E4010 未提供或凭证无效       → 401
   * E4030 越权访问（身份不一致）  → 403
   * E4290 请求过于频繁           → 429
   * E5001 服务内部错误           → 500
   * E5010 LLM 服务未配置         → 503
   * E5011 LLM 调用失败 / 超时    → 502
   * E5012 LLM 输出无法解析       → 502
   * E9001 未分类异常             → 500
   */
  E1001: { status: 400, message: '请求参数非法或缺失' },
  E2001: { status: 404, message: '资源不存在' },
  E3001: { status: 409, message: '状态冲突' },
  E3002: { status: 409, message: '资源已存在' },
  E4001: { status: 200, message: '幂等键重复，已返回首次结果' },
  E4002: { status: 400, message: '请求体过大或单批操作超过上限 200' },
  E4010: { status: 401, message: '未提供有效凭证' },
  E4030: { status: 403, message: '无权访问该用户数据' },
  E4290: { status: 429, message: '请求过于频繁' },
  E5001: { status: 500, message: '服务内部错误' },
  E5010: { status: 503, message: 'LLM 服务未配置' },
  E5011: { status: 502, message: 'LLM 调用失败' },
  E5012: { status: 502, message: 'LLM 输出无法解析' },
  E9001: { status: 500, message: '未分类异常' }
};

class ApiError extends Error {
  constructor(code, message) {
    super(message || (ERRORS[code] ? ERRORS[code].message : '未知错误'));
    this.name = 'ApiError';
    this.code = code;
    this.status = ERRORS[code] ? ERRORS[code].status : 500;
  }
}

module.exports = { ERRORS: ERRORS, ApiError: ApiError };
