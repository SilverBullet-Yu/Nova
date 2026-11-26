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
  function localConfirmReplan(result) { return mustRhythmFn('confirmReplan')(result); }
  function localUndo(snapshot) { return mustRhythmFn('undoReplan')(snapshot); }
  function localAttribute(input) { return mustRhythmFn('attribute')(input); }
  function localSchedule(input) { return mustRhythmFn('schedule')(input); }

  function finite(v) { return typeof v === 'number' && isFinite(v); }
  function okFeas(r) {
    return !!(r && finite(r.T) && finite(r.D) && finite(r.R) && finite(r.margin) &&
      typeof r.verdict === 'string' && r.threshold && typeof r.threshold === 'object');
  }
  function okReplan(r) {
    return !!(r && Array.isArray(r.strategies) && r.strategies.length === 4 &&
      r.strategies.every(function (s) { return s && finite(s.level) && typeof s.name === 'string' && typeof s.applied === 'boolean'; }) &&
      Array.isArray(r.diff) && r.diff.every(function (d) { return d && typeof d.op === 'string' && typeof d.taskId === 'string'; }) &&
      r.guards && typeof r.guards === 'object' && Array.isArray(r.nextTasks) && Array.isArray(r.nextWeek) &&
      Array.isArray(r.nextPlacements) && r.snapshot && Array.isArray(r.snapshot.tasks) && Array.isArray(r.snapshot.week) &&
      (r.loadDelta === null || finite(r.loadDelta)) && typeof r.accepted === 'boolean' && typeof r.needsConfirmation === 'boolean');
  }
  function okSched(r) {
    return !!(r && Array.isArray(r.blocks) && Array.isArray(r.unplanned) && typeof r.version === 'string' &&
      r.blocks.every(function (b) { return b && typeof b.taskId === 'string' && finite(b.startMin) && finite(b.durMin); }) &&
      r.unplanned.every(function (u) { return u && typeof u.taskId === 'string'; }));
  }

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
    /* 业务确认只作用于本机计算结果，不创建或确认服务端草案。 */
    confirmReplan: function (result) {
      return Promise.resolve().then(function () {
        ZX.engine.source = 'local';
        return localConfirmReplan(result);
      });
    },
    undo: function (snapshot) {
      return Promise.resolve().then(function () {
        ZX.engine.source = 'local';
        return localUndo(snapshot);
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

    /* 同步入口：本地确定性纯函数，与后端同语义（渲染路径使用，避免 UI 抖动）。
       attribute / schedule 的消费面（执行记录后的归因、目标生效后的排程）
       都由前端在动作当下调用：归因走本地产物即时出结果，排程走后端优先。 */
    feasibilityNow: function (input) { return localFeasibility(input); },
    attributeNow: function (input) { return localAttribute(input); },

    source: 'local'
  };

})(window.ZX);
