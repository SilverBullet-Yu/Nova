/* 诺瓦 Nova · 可行性评估引擎（纯函数）
 *
 * 契约：docs/HANDOFF.md §3.1 / §2（UMD 双模）
 * 依赖：无（不读时钟、不读随机数、不做 I/O、不依赖 shared/ 之外的模块）
 *
 * 浏览器：window.Rhythm.feasibility.feasibility(input)
 * Node   ：require('./feasibility.js').feasibility(input)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.Rhythm = root.Rhythm || {}; root.Rhythm.feasibility = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 四档阈值（契约硬编码，不可随请求变化） */
  var THRESHOLD = { ample: 1.2, reasonable: 0.9, tight: 0.7 };

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  /**
   * 可行性评估：T = round(weeklyH * weeks * discount)，R = T / D（保留 2 位小数）
   * @param {{weeklyH:number, weeks:number, discount:number, demand:number}} input
   * @returns {{T:number, D:number, R:number, margin:number, verdict:string, threshold:object}}
   */
  function feasibility(input) {
    var src = input || {};
    var weeklyH = src.weeklyH;
    var weeks = src.weeks;
    var discount = src.discount;
    var demand = src.demand;

    if (!isNum(weeklyH) || !isNum(weeks) || !isNum(discount) || !isNum(demand)) {
      throw new TypeError('feasibility: weeklyH / weeks / discount / demand 必须为有限数值');
    }
    if (demand <= 0) {
      throw new TypeError('feasibility: demand 必须大于 0');
    }

    var T = Math.round(weeklyH * weeks * discount);
    var D = demand;
    /* 与现有 demo 保持一致：先按 2 位小数取整再判档 */
    var R = Number((T / D).toFixed(2));
    var margin = T - D;

    var verdict = R >= THRESHOLD.ample ? '充裕'
      : R >= THRESHOLD.reasonable ? '合理'
      : R >= THRESHOLD.tight ? '偏紧'
      : '阻断';

    return {
      T: T,
      D: D,
      R: R,
      margin: margin,
      verdict: verdict,
      threshold: { ample: THRESHOLD.ample, reasonable: THRESHOLD.reasonable, tight: THRESHOLD.tight }
    };
  }

  return { feasibility: feasibility, THRESHOLD: THRESHOLD };
}));
