/* =========================================================
   诺瓦 Nova · 引擎桥接
   唯一实现：shared/engine/（由 npm run build:engine 生成 assets/js/rhythm.build.js）
   本文件只做「后端优先 → 本地产物」的调用编排，不再内置任何引擎实现。
   契约：docs/HANDOFF.md 第 3 节（引擎 API）+ 第 6 节（降级要求）
   ========================================================= */
window.ZX = window.ZX || {};

(function (ZX) {
  'use strict';

  /* 产物采用 UMD 命名空间形态：Rhythm.<name> = { <name>: fn, ... } */
  function rhythmFn(name) {
    var R = window.Rhythm;
    if (!R) return null;
    var mod = R[name];
    if (typeof mod === 'function') return mod;
    if (mod && typeof mod[name] === 'function') return mod[name];
    if (name === 'undoReplan' && R.replan && typeof R.replan.undoReplan === 'function') return R.replan.undoReplan;
    if (name === 'confirmReplan' && R.replan && typeof R.replan.confirmReplan === 'function') return R.replan.confirmReplan;
    return null;
  }

  /* 产物缺失属于构建问题，不能静默降级成另一套语义 */
  function mustRhythmFn(name) {
    var fn = rhythmFn(name);
    if (!fn) throw new Error('引擎产物缺失：请先运行 npm run build:engine（' + name + '）');
    return fn;
  }

  function localFeasibility(input) { return mustRhythmFn('feasibility')(input); }
  function localReplan(input) { return mustRhythmFn('replan')(input); }
  function localUndo(snapshot) { return mustRhythmFn('undoReplan')(snapshot); }
  function localConfirm(result) { return mustRhythmFn('confirmReplan')(result); }
  function localAttribute(input) { return mustRhythmFn('attribute')(input); }
  function localSchedule(input) { return mustRhythmFn('schedule')(input); }

  function okFeas(r) { return !!(r && typeof r.R === 'number' && typeof r.T === 'number' && r.verdict); }
  function okReplan(r) { return !!(r && Array.isArray(r.strategies) && Array.isArray(r.diff)); }
  function okUndo(r) { return !!(r && Array.isArray(r.tasks)); }
  function okAttr(r) { return !!(r && typeof r.type === 'string'); }
  function okSched(r) { return !!(r && Array.isArray(r.blocks)); }

  ZX.engine = {
    /* 异步入口：后端优先，失败或结构不合约时走同一套本地产物 */
    feasibility: function (input) {
      return ZX.api.feasibility(input).then(function (r) {
        if (!okFeas(r)) { ZX.engine.source = 'local'; return localFeasibility(input); }
        ZX.engine.source = 'backend';
        return r;
      }, function () {
        ZX.engine.source = 'local';
        return localFeasibility(input);
      });
    },
    replan: function (input) {
      return ZX.api.replan(input).then(function (r) {
        if (!okReplan(r)) { ZX.engine.source = 'local'; return localReplan(input); }
        ZX.engine.source = 'backend';
        return r;
      }, function () {
        ZX.engine.source = 'local';
        return localReplan(input);
      });
    },
    /* 确认 L4 放弃建议（确认后才由服务端落库） */
    confirmReplan: function (result) {
      return ZX.api.confirmReplan(result).then(function (r) {
        if (!okReplan(r) || r.accepted !== true) { ZX.engine.source = 'local'; return localConfirm(result); }
        ZX.engine.source = 'backend';
        return r;
      }, function () {
        ZX.engine.source = 'local';
        return localConfirm(result);
      });
    },
    undo: function (snapshot) {
      return ZX.api.undo(snapshot).then(function (r) {
        if (!okUndo(r)) { ZX.engine.source = 'local'; return localUndo(snapshot); }
        ZX.engine.source = 'backend';
        return r;
      }, function () {
        ZX.engine.source = 'local';
        return localUndo(snapshot);
      });
    },
    attribute: function (input) {
      return ZX.api.attribute(input).then(function (r) {
        if (!okAttr(r)) { ZX.engine.source = 'local'; return localAttribute(input); }
        ZX.engine.source = 'backend';
        return r;
      }, function () {
        ZX.engine.source = 'local';
        return localAttribute(input);
      });
    },
    schedule: function (input) {
      return ZX.api.schedule(input).then(function (r) {
        if (!okSched(r)) { ZX.engine.source = 'local'; return localSchedule(input); }
        ZX.engine.source = 'backend';
        return r;
      }, function () {
        ZX.engine.source = 'local';
        return localSchedule(input);
      });
    },

    /* 同步入口：本地确定性纯函数，与后端同语义（渲染路径使用，避免 UI 抖动） */
    feasibilityNow: function (input) { return localFeasibility(input); },
    replanNow: function (input) { return localReplan(input); },
    undoNow: function (snapshot) { return localUndo(snapshot); },
    attributeNow: function (input) { return localAttribute(input); },
    scheduleNow: function (input) { return localSchedule(input); },

    source: 'local'
  };

})(window.ZX);
