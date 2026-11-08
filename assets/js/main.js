/* =========================================================
   诺瓦 Nova · 引导、事件绑定、启动序列
   ========================================================= */
window.ZX = window.ZX || {};

(function (ZX) {
  'use strict';

  var U = ZX.util;

  var TABS = [
    { id: 'today', label: '今日', icon: '<path d="M2 9.5l4 4 8-9"/>' },
    { id: 'plan',  label: '计划', icon: '<path d="M2.5 4.5h11M2.5 9h8M2.5 13.5h11"/>' },
    { id: 'data',  label: '数据', icon: '<path d="M3 13V7M8 13V3M13 13v-4"/>' },
    { id: 'me',    label: '我的', icon: '<circle cx="8" cy="5.5" r="2.6"/><path d="M2.8 13.6c.6-2.6 2.7-4 5.2-4s4.6 1.4 5.2 4"/>' }
  ];

  var BT_META = {
    today: 'local-first · 读取本地库 8ms',
    plan: 'planner v1.4 · schedule 68ms',
    data: 'insight · 聚合 41ms',
    me: 'identity · 可用时段 7 日网格'
  };

  var CHIPS = ['今天学什么', '这周落下了，帮我重排', '我的计划可行吗', '生成周报', '我有点累'];

  function tabLabel(id) {
    for (var i = 0; i < TABS.length; i++) if (TABS[i].id === id) return TABS[i].label;
    return '';
  }

  /* ---------- 顶栏同步指示器：三态 ---------- */
  function updateSync() {
    var online = ZX.api.isOnline();
    var pending = ZX.api.pendingCount();
    var dot = U.$('#syncDot'), text = U.$('#syncText'), seq = U.$('#syncSeq');
    if (dot && text) {
      if (online) {
        dot.className = 'dot';
        text.textContent = '本地优先 · 已同步';
      } else if (pending > 0) {
        dot.className = 'dot warn';
        text.textContent = '离线 · 待上行 ' + pending;
      } else {
        dot.className = 'dot off';
        text.textContent = '离线 · 本地计算';
      }
      if (seq) seq.textContent = 'seq ' + ZX.state.serverSeq;
    }
    var pDot = U.$('#plannerDot'), pText = U.$('#plannerText');
    if (pDot && pText) {
      pDot.className = online ? 'dot ac' : 'dot off';
      pText.textContent = online ? 'planner 在线' : 'planner 本地';
    }
    var opEl = U.$('#opPending');
    if (opEl) opEl.textContent = pending;
  }

  /* ---------- 工作台 ---------- */
  ZX.renderRail = function () {
    U.$('#rail').innerHTML =
      TABS.map(function (t) {
        return '<button data-act="tab" data-tab="' + t.id + '" class="' + (ZX.state.tab === t.id ? 'on' : '') + '">' +
          '<svg viewBox="0 0 16 16">' + t.icon + '</svg><span>' + t.label + '</span></button>';
      }).join('') +
      '<div class="grow"></div><div class="foot">RHYTHM 1.4</div>';
  };

  ZX.render = function () {
    var S = ZX.state;
    var f = S.feasibility();
    U.$('#ctxR').textContent = 'R ' + f.R.toFixed(2);
    U.$('#btTitle').innerHTML = '<b>' + tabLabel(S.tab) + '</b>';
    U.$('#btMeta').textContent = BT_META[S.tab];
    U.$('#view').innerHTML = ZX.views[S.tab]();
    if (S.running) ZX.assistant.tickTimer();
  };

  ZX.setTab = function (id) {
    ZX.state.tab = id;
    ZX.renderRail();
    ZX.render();
    U.$('#view').scrollTop = 0;
  };

  /* ---------- 事件 ---------- */
  document.addEventListener('click', function (e) {
    if (!e.target || !e.target.closest) return;
    var b = e.target.closest('[data-act]');
    if (!b) return;
    var act = b.dataset.act;

    if (act === 'tab') { ZX.setTab(b.dataset.tab); return; }
    if (act === 'start') { ZX.assistant.startTask(b.dataset.id); return; }
    if (act === 'finish') { ZX.assistant.finishTask(b.dataset.id, false); return; }
    if (act === 'done') { ZX.assistant.finishTask(b.dataset.id, true); return; }
    if (act === 'buffer') { ZX.assistant.bufferWarn(); return; }
    if (act === 'undo') { ZX.assistant.undoReplan(); return; }
    if (act === 'tired') { ZX.assistant.adoptTired(); return; }
    if (act === 'preset') { ZX.assistant.togglePreset(); return; }
    if (act === 'tg') { ZX.assistant.toggleNotif(b.dataset.key); return; }
    if (act === 'export') { ZX.assistant.exportPlan(); return; }
  });

  U.$('#form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var v = U.$('#input').value.trim();
    if (!v) return;
    U.$('#input').value = '';
    ZX.assistant.me(v);
    var t = ZX.assistant.typing();
    await U.sleep(340);
    t.remove();
    ZX.assistant.route(v);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement !== U.$('#input')) {
      e.preventDefault();
      U.$('#input').focus();
    }
  });

  document.addEventListener('click', function (e) {
    if (!e.target || !e.target.closest) return;
    var c = e.target.closest('[data-say]');
    if (!c) return;
    var v = c.dataset.say;
    ZX.assistant.me(v);
    (async function () {
      var t = ZX.assistant.typing();
      await U.sleep(320);
      t.remove();
      ZX.assistant.route(v);
    })();
  });

  /* ---------- 后端探测（启动时 + 每次 API 调用失败时更新状态，不轮询） ---------- */
  function probeBackend() {
    ZX.api.health().then(function () {
      return ZX.api.getState().then(function (payload) {
        /* 静默覆盖：成功后用后端数据替换本地状态并刷新视图 */
        if (payload) {
          var changed = ZX.state.adoptServerState(payload);
          if (changed) ZX.render();
        }
      }, function () {
        /* state 接口失败：本地种子数据保持不变，仅重新确认一次可达性 */
        return ZX.api.health().catch(function () { });
      });
    }).then(function () {
      if (!ZX.api.isOnline()) return;
      return ZX.api.flushQueue().catch(function () { });
    }).catch(function () {
      /* 离线：完全保持本地种子数据，功能走本地降级链路 */
    });
  }

  /* ---------- 启动 ---------- */
  function boot() {
    ZX.api.onStatus(updateSync);

    U.$('#chips').innerHTML = CHIPS.map(function (c) {
      return '<button class="chip" data-act="say" data-say="' + c + '">' + c + '</button>';
    }).join('');

    ZX.renderRail();
    ZX.render();

    ZX.assistant.say('<p>上午好，林清。英语精读已经记录，<b>60 分钟</b>。今天还剩 3 项、<b>3 小时 30 分</b>，20:30 留了一个弹性位。</p>' +
      '<p>数学极限题是今天权重最高的一项（0.92），10:30 是你的高效时段。要先开始，还是先说这周的情况？</p>', 'schedule · 68ms');

    setTimeout(function () {
      ZX.assistant.say('<p style="color:var(--txt3);font-size:11px">提示：右侧工作台会跟随对话变化。点下方快捷语句，或直接输入「重排」「周报」「撤销」「数学多给两小时」。</p>', '');
    }, 520);

    setInterval(function () { if (ZX.state.running) ZX.assistant.tickTimer(); }, 1000);

    updateSync();
    probeBackend();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})(window.ZX);
