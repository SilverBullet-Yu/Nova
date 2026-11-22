/* =========================================================
   诺瓦 Nova · 重排域 flow（四级重排 / 确认 / 撤销）
   ---------------------------------------------------------
   从 assistant.js 切出的重排全家桶：预览（后端优先 → 本地引擎）、
   草案生命周期（shared/workflow.js）、在线草案确认、快照撤销。
   对话输出仍走 assistant.say；index.html 中本文件在 assistant.js
   与 shared/workflow.js 之后加载。
   C2 要求：卡片上的每一个数值都必须来自引擎返回值，不得硬编码。
   ========================================================= */
window.ZX = window.ZX || {};

(function (ZX) {
  'use strict';

  var U = ZX.util;

  /* 对话输出统一走 assistant。index.html 中 assistant.js 先于 flows 加载，
     正常装配下 ZX.assistant 已就绪；防御包装只为 VM 测试的部分装配兜底 */
  function say(html, eng) {
    if (ZX.assistant && typeof ZX.assistant.say === 'function') ZX.assistant.say(html, eng);
  }

  var pendingDraftId = null;
  var onlineDraft = null;
  var confirmingOnline = false;
  var planFingerprint, planRevision = 0;
  function currentPlan() {
    var s = ZX.state;
    var next = JSON.stringify([s.tasks, s.week, s.locks, s.dayAssign, s.goal, s.avail, s.replanHistory]);
    if (next !== planFingerprint) { planFingerprint = next; planRevision++; }
    return planRevision;
  }
  var REPLAN_RULES_VERSION = 'nova-replan-p0-1';
  var replanWorkflow = window.Rhythm.workflow.createWorkflow({
    tools: { replan: { preview: function (result) { return result; }, commit: applyReplan } },
    version: currentPlan, now: Date.now, rulesVersion: REPLAN_RULES_VERSION,
    traceVersion: function () { return ZX.state.currentPlanVersion ? ZX.state.currentPlanVersion() : null; },
    onSettled: saveReplanTrace
  });
  function saveReplanTrace(event) {
    /* 本地存储不可用时不影响草案结案（appendTrace 内部静默吞错） */
    U.appendTrace('zx.replanTrace', event);
  }
  var previewRequest = 0;
  function replanFlow() {
    if (confirmingOnline) return;
    var S = ZX.state;
    /* 去重按快照时间真实计算 24h 窗口；无时间戳或已过期则允许再次重排 */
    var lastTs = (S.replanned && S.snapshot) ? U.num(S.snapshot.timestamp, 0) : 0;
    if (S.replanned && lastTs && (Date.now() - lastTs) < 24 * 60 * 60 * 1000) {
      say('<p>这周已经重排过一次（' + (U.tsHM(lastTs) || '刚刚') + '）。规则：同类触发 24 小时内去重，避免把重排本身变成新的干扰。</p>' +
          '<p>如需回到重排前的状态，说「撤销」即可，基于快照反向应用，不需要重算。</p>', '重排 · 24h 去重');
      return;
    }

    if (pendingDraftId) replanWorkflow.reject(pendingDraftId);
    pendingDraftId = null;
    onlineDraft = null;
    var request = ++previewRequest;
    var baseline = currentPlan();
    var requestVersion = S.currentPlanVersion ? S.currentPlanVersion() : null;
    var input = S.replanInput();

    /* 计算走统一入口：后端优先，失败自动降级本地引擎 */
    ZX.engine.replan(input).then(function (res) {
      if (request !== previewRequest) return;
      if (currentPlan() !== baseline) { say('<p>计划已变化，请重新生成重排预览。</p>'); return; }
      renderReplanResult(res);
    }, function () {
      if (request !== previewRequest) return;
      saveReplanTrace({ id: 'preview-' + Date.now() + '-' + request, tool: 'replan', at: Date.now(),
        planVersion: requestVersion, rulesVersion: REPLAN_RULES_VERSION, status: 'failed', stage: 'engine' });
      say('<p>暂时无法生成重排预览。现有计划未变更，请稍后重试。</p>', '重排 · 计算失败');
    });
  }

  /* 从引擎结果渲染重排卡片：数值与 diff 全部来自 res，不硬编码 */
  function renderReplanResult(res) {
    var S = ZX.state;
    var strategies = (res && Array.isArray(res.strategies)) ? res.strategies : [];
    var rawDiff = (res && Array.isArray(res.diff)) ? res.diff : [];
    /* 锁定是引擎入参的硬约束：diff 中不会出现锁定任务，这里只统计展示，不做过滤 */
    var locks = (S.locks && typeof S.locks === 'object') ? S.locks : {};
    var lockCount = S.tasks.filter(function (t) { return !t.done && locks[t.id]; }).length;
    var provenance = '<p>用户指令：重排；建议来源：确定性引擎。</p>';
    var diff = rawDiff;
    var needsConfirm = !!(res && res.needsConfirmation === true);
    var loadDelta = res && typeof res.loadDelta === 'number' ? res.loadDelta : 0;
    var guards = (res && res.guards) ? res.guards : {};

    /* 区分连续未改善熔断与逐级校验均未通过。 */
    if (res && res.verdict === 'blocked') {
      var stalled = guards.consecutiveOk === false;
      var reasons = stalled ? strategies.slice(0, 1) : strategies;
      var explanation = reasons.map(function (s) { return s.reason; }).filter(Boolean).join('；');
      say('<div class="ecard">' +
        '<div class="ecard-h"><b>重排已停止</b><span class="tag warn">' + (stalled ? '防雪崩 · 转校准' : '约束未通过') + '</span></div>' +
        '<div class="ecard-b">' + provenance + '<p>' + U.esc(explanation || '当前约束下没有可应用的重排方案。') + '</p>' +
        '<div class="ecard-f"><button class="btn" data-say="新建目标">重新设定目标</button>' +
          '<span class="note">历史计划与记录都保留，不会被清除</span></div></div></div>', '重排 · 熔断');
      ZX.setTab('plan');
      return;
    }

    var sL1 = strategies.find(function (s) { return s.level === 1; });
    var sL2 = strategies.find(function (s) { return s.level === 2; });
    /* 负载增幅取引擎结构化字段 strategies[].growth（0.18 → '18%'），不再解析 reason 文本 */
    var l1Growth = (sL1 && typeof sL1.growth === 'number') ? U.pct(sL1.growth) : null;
    var l2Growth = (sL2 && typeof sL2.growth === 'number') ? U.pct(sL2.growth) : null;

    var deferred = diff.filter(function (d) { return d.op === 'defer'; });
    var compressed = diff.filter(function (d) { return d.op === 'compress'; });
    var abandoned = diff.filter(function (d) { return d.op === 'abandon'; });
    var appliedLevel = 0;
    strategies.forEach(function (s) { if (s.applied && s.level > appliedLevel) appliedLevel = s.level; });

    var unsupportedPlacement = deferred.some(function (d) { return !/^[一二三四五六日]$/.test(d.to); });
    var actionable = !unsupportedPlacement && diff.length > 0 && (needsConfirm || res.accepted === true);
    if (actionable) {
      var draft = replanWorkflow.preview('replan', res);
      pendingDraftId = draft.status === 'pending' ? draft.id : null;
      if (pendingDraftId && typeof res.draftId === 'string') onlineDraft = { id: res.draftId, version: currentPlan() };
    }
    var tagText = pendingDraftId ? '待确认' : '无可提交变更';
    var tagCls = 'warn';

    /* 用任务 ID 关联计划中的标题，区分同科目变更。 */
    var tasksById = new Map(S.tasks.map(function (t) { return [t.id, t]; }));
    var diffHtml = diff.map(function (d, idx) {
      var task = tasksById.get(d.taskId) || {};
      var taskLabel = [d.subject || task.subject || task.s, task.title].filter(Boolean).join(' · ') || d.taskId || '';
      var cls = d.op === 'compress' ? 'cp' : 'mv';
      var label = d.op === 'compress' ? '压缩' : d.op === 'defer' ? '顺延' : d.op === 'abandon' ? '放弃' : d.op;
      var detail = d.op === 'compress'
        ? d.from + ' → ' + d.to + ' min · degraded'
        : (d.detail || (d.from + ' → ' + d.to));
        return '<div class="diff-line sc2-diff" data-diff="' + idx + '" style="--d:' + idx + '"><span class="s ' + cls + '">' + label + '</span>' +
        '<span class="n">' + U.esc(taskLabel) + '</span>' +
        '<span class="d">' + U.esc(detail) + '</span>' + '</div>';
    }).join('');

      var guardNote = [];
      if (sL1 && sL1.applied) guardNote.push('L1 顺延到未来 7 天容量内的空闲时段，负载 +' + (l1Growth === null ? U.pct(loadDelta) : l1Growth) + '，未超单次上限 20%，确认后生效');
      else if (sL1) guardNote.push('L1 ' + U.esc(sL1.reason || '顺延未通过校验，已回退该级'));
      if (sL2 && sL2.applied) guardNote.push('L2 按容量溢出压缩低权重项后复核通过（+' + (l2Growth === null ? U.pct(loadDelta) : l2Growth) + '），因此未进入替代与放弃');
      else if (sL2) guardNote.push('L2 压缩后复核未通过，已进入后续级别');
      if (needsConfirm) guardNote.push('L4 放弃只是建议，确认后才会落库');

    say('<p>收到。先归因，再走四级流水线；任何一级通过防雪崩校验就停，不追求把计划排满。</p>' + provenance +
      '<div class="ecard">' +
      '<div class="ecard-h"><b>' + (pendingDraftId ? '重排待确认' : '重排未应用') + '</b><span class="tag ' + tagCls + '">' + tagText + '</span></div>' +
      '<div class="ecard-b">' +
        '<div class="erow"><span class="k">变更</span><span class="why">延期 ' + deferred.length + ' · 压缩 ' + compressed.length + ' · 放弃 ' + abandoned.length + '</span><span class="v">未来 7 天 ' + (loadDelta >= 0 ? '+' : '') + U.pct(loadDelta) + '</span></div>' +
        (lockCount ? '<div class="erow"><span class="k">锁定</span><span class="why">锁定任务是硬约束，不参与顺延 / 压缩 / 替代 / 放弃</span><span class="v ac">' + lockCount + ' 个锁定块保持原样</span></div>' : '') +
        '<div class="erow"><span class="k">弹性位</span><span class="why">每日 60 min 未被清空</span><span class="v ac">' + (guards.bufferPreserved === false ? '已侵占' : '1 / 1 保留') + '</span></div>' +
        diffHtml +
        (unsupportedPlacement ? '<p>当前计划板不能保存跨日拆分或未知日期；本次不写入，请调整后重新预览。</p>' : '') +
        '<div class="ecard-f"><span class="note">' + guardNote.join('；') + '。' + (lockCount ? '锁定的 ' + lockCount + ' 块保持原工时与原落点。' : '') + '</span></div>' +
        (pendingDraftId ? '<div class="ecard-f"><button class="btn" data-act="confirm-replan" data-draft="' + U.esc(pendingDraftId) + '">确认重排</button><span class="note">未写入；确认后可回复「撤销」恢复快照。</span></div>' : '') +
      '</div></div>', '重排 · 确定性计算');

    ZX.setTab('plan', { skipOverlaySave: true });
  }

  function applyReplan(res) {
    var S = ZX.state;
    var at = Date.now();
    var level = res.needsConfirmation ? 4 : res.strategies.reduce(function (max, item) {
      return item.applied ? Math.max(max, item.level) : max;
    }, 0);
    /* diff 同一任务可有多种操作，按字段合并，不能用最后一条覆盖前面的操作。 */
    var changes = new Map();
    res.diff.forEach(function (d) {
      if (d.op !== 'compress' && d.op !== 'abandon') return;
      var patch = changes.get(d.taskId) || {};
      if (d.op === 'compress') { patch.est = Number(d.to); patch.compressed = true; }
      if (d.op === 'abandon') patch.abandoned = true;
      changes.set(d.taskId, patch);
    });
    /* 替代关系只取引擎的结构化字段；不解析 diff 展示文本，也不覆盖本地标题/时段。 */
    (res.nextTasks || []).forEach(function (next) {
      var patch = changes.get(next.id) || {};
      ['substituted', 'substitutedBy', 'replaces'].forEach(function (key) {
        if (Object.prototype.hasOwnProperty.call(next, key)) patch[key] = next[key];
      });
      changes.set(next.id, patch);
    });
    var tasks = S.tasks.map(function (t) {
      var patch = changes.get(t.id);
      if (!patch || t.done || (S.locks && S.locks[t.id])) return t;
      return Object.assign({}, t, patch);
    });
    var dayAssign = Object.assign({}, S.dayAssign);
    var moved = [];
    res.diff.forEach(function (d) {
      if (d.op !== 'defer' || (S.locks && S.locks[d.taskId])) return;
      if (!S.tasks.some(function (task) { return task.id === d.taskId && !task.done && !task.skipped; })) return;
      var from = dayAssign[d.taskId] || '日';
      if (from === d.to) return;
      if (d.to === '日') delete dayAssign[d.taskId];
      else dayAssign[d.taskId] = d.to;
      moved.push({ taskId: d.taskId, from: from, to: d.to });
    });
    var snapshot = { tasks: U.clone(S.tasks), week: U.clone(S.week), timestamp: at, moved: moved };
    var history = (S.replanHistory || []).concat([{ at: at, loadDelta: U.num(res.loadDelta, 0), appliedLevel: level, undone: false }]);
    Object.assign(S, { snapshot: snapshot, tasks: tasks, dayAssign: dayAssign, replanRecord: res, replanned: true, replanHistory: history });
  }

  function confirmAbandonFlow(expectedId) {
    if (typeof expectedId === 'string' && expectedId !== pendingDraftId) {
      say('<p>这份预览已失效，请在最新预览卡上确认。</p>');
      return;
    }
    if (!pendingDraftId) { say('<p>当前没有待确认的重排建议。</p>'); return; }
    var id = pendingDraftId;
    var remote = onlineDraft;
    pendingDraftId = null;
    onlineDraft = null;
    if (remote && remote.version === currentPlan()) {
      confirmingOnline = true;
      return ZX.engine.confirmReplan(remote.id).then(function (ack) {
        if (!ack || ack.accepted !== true) throw new Error('重排确认无效');
        finishReplanConfirmation(id);
      }).catch(function () {
        replanWorkflow.reject(id);
        say('<p>未收到服务端确认，本机未应用重排。请重新生成预览。</p>');
      }).finally(function () { confirmingOnline = false; });
    }
    finishReplanConfirmation(id);
  }

  function finishReplanConfirmation(id) {
    var S = ZX.state;
    var before = S.currentPlanVersion ? S.currentPlanVersion() : null;
    var result = replanWorkflow.confirm(id);
    if (result.status !== 'committed') { say('<p>未应用重排，请重新生成预览。</p>'); return; }
    var entry = S.replanHistory[S.replanHistory.length - 1];
    var after = S.currentPlanVersion ? S.currentPlanVersion() : null;
    Object.assign(entry, {
      requestId: id, rulesVersion: REPLAN_RULES_VERSION,
      planVersionBefore: before, planVersionAfter: after
    });
    var res = S.replanRecord;
    ZX.render();
    ZX.api.queueOp({ entity: 'plan', entityId: 'replan', field: 'applied', value: { loadDelta: res.loadDelta, diff: res.diff } });
    ZX.state.snapshot.moved.forEach(function (move) { queueReplanMove(move.taskId, move.to); });
    res.diff.forEach(function (d) {
      if (d.op === 'abandon' && !(ZX.state.locks && ZX.state.locks[d.taskId])) {
        ZX.api.queueOp({ entity: 'task', entityId: d.taskId, field: 'abandoned', value: true });
      }
    });
    say('<p>重排已确认。</p><button class="btn" data-act="undo">撤销本次重排</button>', '重排 · 已确认');
  }

  function queueReplanMove(taskId, day) {
    ZX.api.queueOp({ entity: 'plan', entityId: 'dayAssign', field: 'moved', value: { taskId: taskId, day: day } });
  }

  /* ---------- flow：撤销 ---------- */
  function undoReplan() {
    var S = ZX.state;
    if (!S.replanned || !S.snapshot) {
      say('<p>当前没有可撤销的重排。每次重排都会先写快照，撤销即反向应用 diff，保证与重排前完全一致。</p>', '重排 · 无操作');
      return;
    }
    var snap = S.snapshot;
    var snapTs = U.num(snap.timestamp, 0);
    var tasks = Array.isArray(snap.tasks) ? U.clone(snap.tasks) : [];

    /* 立即本地反向应用：与重排前逐条一致，不重算 */
    S.tasks = tasks.map(ZX.state.normTask);
    (snap.moved || []).slice().reverse().forEach(function (move) {
      if ((S.dayAssign[move.taskId] || '日') !== move.to) return;
      if (move.from === '日') delete S.dayAssign[move.taskId];
      else S.dayAssign[move.taskId] = move.from;
      queueReplanMove(move.taskId, move.from);
    });
    S.snapshot = null;
    S.replanned = false;
    /* 撤销计入重排历史：连续撤销会累积「未改善」计数，达到阈值后重排被熔断 */
    for (var i = S.replanHistory.length - 1; i >= 0; i--) {
      var history = S.replanHistory[i];
      if (history && history.undone !== true) {
        history.undone = true;
        history.planVersionAfterUndo = S.currentPlanVersion ? S.currentPlanVersion() : null;
        history.undoneAt = Date.now();
        if (history.requestId) saveReplanTrace({ id: history.requestId, tool: 'replan',
          at: history.undoneAt, planVersion: history.planVersionAfterUndo,
          rulesVersion: history.rulesVersion || null, status: 'undone' });
        break;
      }
    }
    ZX.render();
    say('<p>已撤销。计划恢复到 <span class="mono">' + (U.tsHM(snapTs) || '此前') + '</span> 的快照，未重算，逐条一致。</p>' +
        '<p style="color:var(--txt3);font-size:11px">重排记录保留在 replan_record，不会因为撤销而丢失。</p>', '重排 · 撤销');
    ZX.setTab('plan');

    ZX.api.queueOp({ entity: 'plan', entityId: 'replan', field: 'undone', value: true });

    /* 与引擎对齐（后端优先 → 本地降级）；不一致时以本地快照为准 */
    ZX.engine.undo(snap).then(function (res) {
      var r = res && Array.isArray(res.tasks) ? res.tasks.map(ZX.state.normTask) : null;
      if (r && r.length && JSON.stringify(r) !== JSON.stringify(ZX.state.tasks)) {
        if (window.console && console.warn) console.warn('[zx] undo 结果与快照不一致，保留本地快照');
      }
    }, function () { /* 引擎已降级 */ });
  }

  ZX.flows = ZX.flows || {};
  /* 确认重排走 main.js 的 data-act 委托（confirm-replan / undo），
     计划页「重新安排」按钮由 planedit.js 委托到 replanFlow */
  ZX.flows.replan = {
    replanFlow: replanFlow,
    confirmReplan: confirmAbandonFlow,
    undoReplan: undoReplan,
    queueReplanMove: queueReplanMove
  };

})(window.ZX);
