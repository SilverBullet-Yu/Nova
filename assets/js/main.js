/* =========================================================
   诺瓦 Nova · 引导、事件绑定、启动序列
   ========================================================= */
window.ZX = window.ZX || {};

(function (ZX) {
  'use strict';

  var U = ZX.util;

  /* 图标 + 文字页签：图标承载各栏的快速区分（用户反馈：纯文字 + 章号区分不足） */
  var TABS = [
    { id: 'chat',  label: '对话', icon: '<path d="M2.6 3.4h10.8a1 1 0 0 1 1 1v5.6a1 1 0 0 1-1 1H7.6L4.8 13.4v-2.4H3.6a1 1 0 0 1-1-1V4.4a1 1 0 0 1 1-1z"/><path d="M5.4 7.4h5.2"/><path d="M5.4 5.4h3.4"/>' },
    { id: 'today', label: '今日', icon: '<path d="M1.9 12.4h12.2"/><path d="M4.1 12.4a3.9 3.9 0 0 1 7.8 0"/><path d="M8 2.3v2.1"/><path d="M3.3 4.9l1.5 1.5"/><path d="M12.7 4.9l-1.5 1.5"/>' },
    { id: 'plan',  label: '计划', icon: '<rect x="2.3" y="3.4" width="11.4" height="10.1" rx="1.3"/><path d="M2.3 6.6h11.4"/><path d="M5.7 2.2v2.4"/><path d="M10.3 2.2v2.4"/><circle cx="8" cy="9.9" r="1"/>' },
    { id: 'data',  label: '数据', icon: '<path d="M1.8 8.6h2.5l1.4-4.2 2.2 7.2 1.7-4.4 1.1 1.4h2.5"/>' },
    { id: 'me',    label: '我的', icon: '<circle cx="8" cy="5.4" r="2.4"/><path d="M3.1 13.5c.5-2.4 2.5-3.8 4.9-3.8s4.4 1.4 4.9 3.8"/>' }
  ];

  var BT_META = {
    chat: '与诺瓦对话 · 自然语言驱动',
    today: '本机优先 · 本地计算',
    plan: '日程已排定 · 本地计算',
    data: '本周回顾 · 本机计算',
    me: '你的节奏 · 可用时段'
  };

  var CHIPS = ['今天怎么安排', '这周太乱，帮我重排', '我断了四天', '我的计划可行吗', '生成周报', '今天有点累'];

  function tabLabel(id) {
    for (var i = 0; i < TABS.length; i++) if (TABS[i].id === id) return TABS[i].label;
    return '';
  }

  /* ---------- 顶栏同步指示器：三态 ---------- */
  function updateSync() {
    var online = ZX.api.isOnline();
    /* ⑧ 离线：状态由顶栏同步指示承担（对话页头部与头像已撤除） */
    var pending = ZX.api.pendingCount();
    var dot = U.$('#syncDot'), text = U.$('#syncText');
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
    }
    var pDot = U.$('#plannerDot'), pText = U.$('#plannerText');
    if (pDot && pText) {
      pDot.className = online ? 'dot ac' : 'dot off';
      pText.textContent = online ? '日程引擎 在线' : '日程引擎 离线';
    }
    var opEl = U.$('#opPending');
    if (opEl) opEl.textContent = pending;
  }

  /* ---------- 工作台 ---------- */
  ZX.renderRail = function () {
    U.$('#rail').innerHTML =
      TABS.map(function (t) {
        var on = ZX.state.tab === t.id;
        return '<button data-act="tab" data-tab="' + t.id + '" class="' + (on ? 'on' : '') + '"' +
          (on ? ' aria-current="page"' : '') + '>' +
          '<svg viewBox="0 0 16 16">' + t.icon + '</svg><span>' + t.label + '</span></button>';
      }).join('');
    renderMnav();
  };

  /* 移动端导航：与桌面同体系（图标上、单字下） */
  function renderMnav() {
    var el = U.$('#sdMnav');
    if (!el) return;
    el.innerHTML = TABS.map(function (t) {
      var on = ZX.state.tab === t.id;
      return '<button data-act="tab" data-tab="' + t.id + '" class="' + (on ? 'on' : '') + '"' +
        (on ? ' aria-current="page"' : '') + '>' +
        '<svg viewBox="0 0 16 16" aria-hidden="true">' + t.icon + '</svg><span>' + t.label + '</span></button>';
    }).join('');
  }

  /* 对话是主页面签：顶栏「诺瓦」入口与底部导航都只是切到该页，无覆盖层状态。
     聊天 DOM 持久（消息历史在 #chat 内），不参与 #view 重绘。 */
  ZX.render = function () {
    var S = ZX.state;
    document.documentElement.dataset.tab = S.tab;
    try {
      var f = S.feasibility();
      var rEl = U.$('#ctxR');
      if (rEl) ZX.ui.countTo(rEl, f.R, function (v) { return 'R ' + v.toFixed(2); });
      U.$('#btTitle').innerHTML = '<b>' + tabLabel(S.tab) + '</b>';
      U.$('#btMeta').textContent = BT_META[S.tab] || '';
      if (S.tab !== 'chat') U.$('#view').innerHTML = ZX.views[S.tab]();
      var gEl = U.$('#ctxGoal');
      if (gEl) gEl.textContent = S.goal.name;
      if (S.running) ZX.assistant.tickTimer();
    } catch (e) {
      /* 单个视图异常不拖垮全局：记录错误并给出可恢复的占位 */
      if (window.console && console.error) console.error('[zx] render failed:', e);
      U.$('#view').innerHTML = '<div class="wrap"><div class="banner">' +
        '<div class="bt">这个视图渲染出错了</div>' +
        '<div class="bs">其他功能不受影响；可切换页签或刷新恢复。</div></div></div>';
    }
    /* 渲染即持久化：任何状态变更后都会走到这里，统一落本地 overlay
       （新目标 / 记录 / 跳过 / 补录跨刷新存活；见 state.js 顶部注释） */
    if (ZX.state.saveOverlay) ZX.state.saveOverlay();
  };

  ZX.setTab = function (id) {
    ZX.state.tab = id;
    ZX.renderRail();
    ZX.render();
    if (id === 'chat') {
      var body = U.$('#chat');
      if (body) body.scrollTop = body.scrollHeight;
      var input = U.$('#input');
      if (input) { try { input.focus(); } catch (e) { /* 忽略 */ } }
    } else {
      U.$('#view').scrollTop = 0;
    }
  };

  /* ---------- 事件 ---------- */
  document.addEventListener('click', function (e) {
    if (!e.target || !e.target.closest) return;
    var b = e.target.closest('[data-act]');
    if (!b) return;
    var act = b.dataset.act;

    if (act === 'tab') { ZX.setTab(b.dataset.tab); return; }
    if (act === 'fold') {
      var box = b.closest ? b.closest('.fold') : null;
      if (!box) return;
      var open = !box.classList.contains('open');
      box.classList.toggle('open', open);
      b.setAttribute('aria-expanded', open ? 'true' : 'false');
      var body = box.querySelector('.fold-b');
      if (body) body.hidden = !open;
      ZX.state.folds = ZX.state.folds || {};
      ZX.state.folds[b.dataset.key] = open;
      ZX.ui.saveFolds(ZX.state.folds);
      return;
    }
    if (act === 'start') { ZX.assistant.startTask(b.dataset.id); return; }
    if (act === 'finish') { ZX.assistant.finishTask(b.dataset.id, false); return; }
    if (act === 'done') { ZX.assistant.finishTask(b.dataset.id, true); return; }
    if (act === 'buffer') { ZX.assistant.bufferWarn(); return; }
    if (act === 'undo') { ZX.assistant.undoReplan(); return; }
    if (act === 'tired') { ZX.assistant.adoptTired(); return; }
    if (act === 'preset') { ZX.assistant.togglePreset(); return; }
    if (act === 'tg') { ZX.assistant.toggleNotif(b.dataset.key); return; }
    if (act === 'pref') { ZX.util.togglePref(b.dataset.key); ZX.render(); return; }

    /* Stage D */
    if (act === 'avail') { ZX.flows.settings.toggle(b.dataset.day, b.dataset.slot); return; }
    if (act === 'avail-bulk') { ZX.flows.settings.bulk(b.dataset.kind); return; }
    if (act === 'export') {
      if (ZX.flows && ZX.flows.settings) ZX.flows.settings.exportCsv();
      else ZX.assistant.exportPlan();
      return;
    }
    if (act === 'wipe') { ZX.flows.settings.confirmWipe(); return; }
    if (act === 'trash-restore') { ZX.flows.settings.restore(); return; }
    if (act === 'font') { ZX.flows.settings.setFont(b.dataset.v); return; }
    if (act === 'cp-open') { ZX.setTab('chat'); return; }
  });

  U.$('#form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var v = U.$('#input').value.trim();
    if (!v) return;
    ZX.assistant.me(v);
    var t = ZX.assistant.typing();
    await U.sleep(340);
    t.remove();
    ZX.assistant.route(v);
  });

  /* 输入聚焦反馈：focus-visible 描边与 caret 已足够（聆听态头像随对话页头部一并撤除） */
  var inputEl = U.$('#input');

  document.addEventListener('keydown', function (e) {
    /* 「/」进入对话页并聚焦输入框：仅在未处于任何输入态、且无弹层时生效 */
    var ae = document.activeElement;
    var typing = !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' ||
      ae.tagName === 'SELECT' || ae.isContentEditable);
    if (e.key === '/' && !typing && !document.querySelector('.ovl')) {
      e.preventDefault();
      if (ZX.state.tab !== 'chat') ZX.setTab('chat');
      else { var input = U.$('#input'); if (input) { try { input.focus(); } catch (err) { /* 忽略 */ } } }
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
          /* 本地优先：本地未上行的 overlay（新目标 / 记录等）在服务端合并后
             仍保持本地视角，最后覆写，避免被服务端旧种子覆盖丢失 */
          ZX.state.applyOverlay();
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
  /* 开场问候：时段、姓名、已记录项、剩余量与权重最高项全部取自当前 state，不写死 */
  function greetingHtml() {
    var S = ZX.state;
    var h = new Date().getHours();
    var greet = h < 11 ? '上午好' : h < 18 ? '下午好' : '晚上好';
    var done = S.tasks.filter(function (t) { return t.done; });
    var todo = S.tasks.filter(function (t) { return !t.done && !t.skipped; });
    /* 剩余量口径与今日页 KPI 同源（exec.metrics 过滤跳过项）；flows 未加载时退回原派生函数 */
    var m = (ZX.flows.exec && ZX.flows.exec.metrics) ? ZX.flows.exec.metrics() : null;
    var p1 = greet + '，' + U.esc(S.user.name) + '。';
    if (done.length) {
      p1 += U.esc(done[0].s) + '「' + U.esc(done[0].title) + '」已记录 <b>' + U.hm(done[0].actual || done[0].est) + '</b>。';
    }
    p1 += '今天还剩 <b>' + todo.length + '</b> 项、<b>' + U.hm(m ? m.remain : S.remainMin()) + '</b>' +
      (S.buffer && S.buffer.time ? '，' + U.esc(S.buffer.time) + ' 留了一个弹性位' : '') + '。';
    var heavy = null;
    todo.forEach(function (t) { if (!heavy || U.num(t.weight, 0) > U.num(heavy.weight, 0)) heavy = t; });
    var p2 = heavy
      ? U.esc(heavy.s) + '是今天权重最高的一项（' + U.num(heavy.weight, 0).toFixed(2) + '）' +
        (heavy.time ? '，' + U.esc(heavy.time.split('–')[0]) + ' 开始' : '') + '。'
      : '';
    return '<img class="msg-mascot" src="assets/img/mascot-v4.svg" width="132" height="116" alt="诺瓦" />' +
      '<p>' + p1 + '</p><p>' + p2 + '要先开始，还是先说这周的情况？</p>';
  }

  function boot() {
    ZX.util.applyPrefs();
    ZX.state.folds = ZX.ui.loadFolds();
    if (ZX.flows && ZX.flows.settings) ZX.flows.settings.init();
    ZX.api.onStatus(updateSync);
    updateSync();   /* 初始同步态：离线时顶栏显示「离线 · 本地计算」 */

    U.$('#chips').innerHTML = CHIPS.map(function (c) {
      return '<button class="chip" data-act="say" data-say="' + c + '">' + c + '</button>';
    }).join('');

    ZX.renderRail();
    ZX.render();

    ZX.assistant.say(greetingHtml(), '日程 · 本地');

    setTimeout(function () {
      ZX.assistant.say('<p style="color:var(--txt3);font-size:11px">提示：说一句话，诺瓦会驱动顶栏的「今日 / 计划 / 数据」工作台。点下方快捷语句，或直接输入「重排」「周报」「撤销」「数学多给两小时」。</p>', '');
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
