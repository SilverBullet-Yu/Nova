/* 诺瓦 Nova · 偏差归因引擎（纯函数）
 *
 * 契约：docs/HANDOFF.md §3.4 / §2（UMD 双模）
 * 依赖：无（不读时钟、不读随机数、不做 I/O、不依赖 shared/ 之外的模块）
 *
 * 浏览器：window.Rhythm.attribute.attribute(input)
 * Node   ：require('./attribute.js').attribute(input)
 *
 * 判定顺序固定（顺序即优先级）：
 *   1. 计划过载  planLoadRatio > 1.1 || consecutiveTimeoutCount >= 3
 *   2. 执行中断  consecutiveZeroDays >= 2
 *   3. 效率不足  efficiencyRatio > 1.4 && completion >= 0.6
 *   4. 外部干扰  externalRatio > 0.3
 *   5. 无偏差
 * 先排除计划问题再归因用户侧：把「过载」误判为「执行力不足」，系统就会加压。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.Rhythm = root.Rhythm || {}; root.Rhythm.attribute = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function num(v, dflt) {
    return typeof v === 'number' && isFinite(v) ? v : dflt;
  }

  function clamp01(v) {
    if (v < 0) return 0;
    if (v > 1) return 1;
    return v;
  }

  function round(v, p) {
    var f = Math.pow(10, p);
    return Math.round(v * f) / f;
  }

  function attribute(input) {
    var src = input || {};
    var planLoadRatio = num(src.planLoadRatio, 0);
    var consecutiveZeroDays = num(src.consecutiveZeroDays, 0);
    var consecutiveTimeoutCount = num(src.consecutiveTimeoutCount, 0);
    var efficiencyRatio = num(src.efficiencyRatio, 1);
    var completion = num(src.completion, 0);
    var externalRatio = num(src.externalRatio, 0);

    var evidence = {
      planLoadRatio: planLoadRatio,
      consecutiveZeroDays: consecutiveZeroDays,
      consecutiveTimeoutCount: consecutiveTimeoutCount,
      efficiencyRatio: efficiencyRatio,
      completion: completion,
      externalRatio: externalRatio
    };

    var type;
    var confidence;
    var actions;
    var matched = [];

    if (planLoadRatio > 1.1 || consecutiveTimeoutCount >= 3) {
      type = '计划过载';
      confidence = round(clamp01(
        0.55
        + 0.30 * clamp01((planLoadRatio - 1.1) / 0.5)
        + 0.15 * (consecutiveTimeoutCount >= 3 ? 1 : 0)
      ), 2);
      actions = ['下调密度，提高弹性位比例'];
      if (planLoadRatio > 1.1) matched.push('planLoadRatio > 1.1');
      if (consecutiveTimeoutCount >= 3) matched.push('consecutiveTimeoutCount >= 3');
    } else if (consecutiveZeroDays >= 2) {
      type = '执行中断';
      confidence = round(clamp01(0.60 + 0.40 * clamp01((consecutiveZeroDays - 2) / 3)), 2);
      actions = ['转入恢复流程，不追加任务'];
      matched.push('consecutiveZeroDays >= 2');
    } else if (efficiencyRatio > 1.4 && completion >= 0.6) {
      type = '效率不足';
      confidence = round(clamp01(
        0.50
        + 0.30 * clamp01((efficiencyRatio - 1.4) / 0.6)
        + 0.20 * clamp01((completion - 0.6) / 0.4)
      ), 2);
      actions = ['校准标准工时，建议拆分'];
      matched.push('efficiencyRatio > 1.4 && completion >= 0.6');
    } else if (externalRatio > 0.3) {
      type = '外部干扰';
      confidence = round(clamp01(0.50 + 0.50 * clamp01((externalRatio - 0.3) / 0.4)), 2);
      actions = ['预留缓冲，将干扰时段移出计划'];
      matched.push('externalRatio > 0.3');
    } else {
      type = '无偏差';
      confidence = 0.60;
      actions = ['保持当前节奏，下周不做结构调整'];
      matched.push('无阈值命中');
    }

    evidence.matched = matched;
    evidence.rule = matched;

    return {
      type: type,
      confidence: confidence,
      actions: actions,
      evidence: evidence
    };
  }

  return { attribute: attribute };
}));
