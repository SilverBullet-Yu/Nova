/* =========================================================
   诺瓦 Nova · GL 内容层：主格分镜台（CSS3DRenderer）
   ---------------------------------------------------------
   页面骨架 = 三段式漫画分格：顶栏格（页签挂线）→ 主格（本层）→ 输入格。
   主格是一个常驻白底墨框分镜格（.gl-frame），五页内容在格内滑台
   （.gl-slide，CSS transition 横向换页）——骨架不动、内容滑，
   格框裁切一切出格内容，页面由此有主干。

   与业务的零改动桥接 = 「语义源树 + 克隆」：
   · #chat / #view 原树照常被业务写入（assistant/main 零改动），GL 模式下
     原树 display:none（保留业务读写），克隆体进 CSS3D 承载视觉与读屏
   · MutationObserver 增量同步：对话流逐条 append/remove（typing 增删 /
     上限淘汰）；工作台 120ms 节流整页重克隆（保留面板 scrollTop）
   · 克隆体剔除 id（防与原树重复劫持 getElementById）

   对话滚动：流 absolute bottom:0（贴底语义同 DOM 版），滚轮驱动
   translateY 上翻；面板滚动走面板内原生 overflow-y。
   挂载 window.ZX_GL_STAGE，经 engine.mount 接入。经典 script。
   ========================================================= */
window.ZX_GL_STAGE = (function () {
  'use strict';

  var ZC = window.ZX_CSS3D;
  var api = null;
  var PAGES = ['today', 'plan', 'data', 'me'];
  var ALL = ['chat'].concat(PAGES);

  var frameEl, slideEl, streamEl;
  var frameObj = null;
  var pageEls = {};                /* page → 元素引用（frame 未入 document 前 getElementById 不可用） */
  var frameW = 1080, frameH = 400;
  var chat = { target: 0, cur: 0, contentH: 0, viewH: 1 };
  var clones = [];
  var sourceHtml = [];
  var slide = { cur: 0, tx: 0 };
  var currentPage = 'chat';
  var band = { top: 70, bottom: 0 };

  function cloneClean(node, deep) {
    var c = node.cloneNode(deep !== false);
    c.querySelectorAll && c.querySelectorAll('[id]').forEach(function (el) { el.removeAttribute('id'); });
    c.removeAttribute && c.hasAttribute && c.hasAttribute('id') && c.removeAttribute('id');
    return c;
  }

  /* ---------- 对话流增量同步（与 #chat.children 逐一对齐） ---------- */
  function syncChat() {
    var src = document.getElementById('chat');
    if (!src) return;
    var prevCount = clones.length;
    while (clones.length > src.children.length) {
      var dead = clones.pop();
      sourceHtml.pop();
      dead.parentNode && dead.parentNode.removeChild(dead);
    }
    for (var i = clones.length; i < src.children.length; i++) {
      var c = cloneClean(src.children[i]);
      c.classList.add('gl-in');
      streamEl.appendChild(c);
      clones.push(c);
      sourceHtml.push(src.children[i].outerHTML);
    }
    for (var j = 0; j < clones.length; j++) {
      var html = src.children[j].outerHTML;
      if (sourceHtml[j] !== html) {
        var fresh = cloneClean(src.children[j]);
        fresh.classList.remove('gl-in');
        streamEl.replaceChild(fresh, clones[j]);
        clones[j] = fresh;
        sourceHtml[j] = html;
      }
    }
    var grew = clones.length > prevCount;
    chat.contentH = streamEl.scrollHeight;
    var max = Math.max(0, chat.contentH - chat.viewH);
    /* 新消息到达 → 重新贴底（与 DOM 版 scrollTop=scrollHeight 同语义）；上翻中不抢位 */
    if (grew && !chat.userScrolled) chat.target = 0;
    chat.target = Math.min(max, Math.max(0, chat.target));
    applyChatScroll();
  }

  function applyChatScroll() {
    /* 贴底语义：scroll=0 时流底=格底；向上翻 scroll 增 */
    streamEl.style.transform = 'translateY(' + Math.round(chat.cur) + 'px)';
  }

  /* ---------- 工作台整页重克隆（保留面板滚动位置） ---------- */
  function syncPage(page) {
    var bench = document.getElementById('main');
    var view = document.getElementById('view');
    var pageEl = pageEls[page];
    if (page !== document.documentElement.dataset.tab || !bench || !view || !pageEl || !bench.contains(view)) return;
    var head = bench.querySelector('.bench-head');
    var wrap = view.querySelector('.wrap');
    var inner = pageEl.querySelector('.gl-page-inner');
    var keep = inner.scrollTop;
    inner.innerHTML = '';
    if (head) inner.appendChild(cloneClean(head));
    if (wrap) inner.appendChild(cloneClean(wrap, true));
    inner.scrollTop = keep;
  }

  function observe() {
    var chatEl = document.getElementById('chat');
    new MutationObserver(syncChat).observe(chatEl, { childList: true, subtree: true, characterData: true, attributes: true });

    var bench = document.getElementById('main');
    var pending = false;
    new MutationObserver(function () {
      if (pending) return;
      pending = true;
      setTimeout(function () {
        pending = false;
        syncPage(currentPage);
      }, 120);
    }).observe(bench, { childList: true, characterData: true, subtree: true, attributes: true });

    new MutationObserver(function () {
      var tab = document.documentElement.dataset.tab;
      if (tab && ALL.indexOf(tab) >= 0 && tab !== currentPage) go(tab);
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-tab'] });
  }

  function pageIndex(tab) { return ALL.indexOf(tab); }

  function go(tab) {
    currentPage = tab;
    slide.tx = -pageIndex(tab) * frameW;
    ALL.forEach(function (p) {
      pageEls[p].inert = p !== tab;
      pageEls[p].setAttribute('aria-hidden', p !== tab ? 'true' : 'false');
    });
    if (tab !== 'chat') syncPage(tab);
    if (window.ZX_GL_MASCOT && ZX_GL_MASCOT.show) ZX_GL_MASCOT.show(tab === 'chat');
    api.pulse(0.8);
  }

  /* ---------- 布局 ---------- */
  function layout(w, h) {
    var foot = document.querySelector('.cp-foot');
    var footH = foot && foot.offsetHeight > 0 ? foot.offsetHeight : 150;
    band.bottom = h - footH - 10;
    /* 移动单行顶栏（50px）+ 3D 页签行（卡底约 y96）：主格顶让出页签行，避免格框盖卡 */
    band.top = w <= 860 ? 112 : 70;
    frameW = Math.min(1080, w - (w <= 480 ? 24 : 44));
    slide.cur = slide.tx = -pageIndex(currentPage) * frameW;
    /* 高度优先收进 band：frameH ≥220 的下限在矮视口（如 744×420 横持）会把主格
       顶部顶出 band 压住页签卡、底部压住输入区——改为收进 band.top/bottom，
       只留 120px 极端保底（贴底语义下内容仍完整可见，只是可视行数变少） */
    frameH = Math.max(120, band.bottom - band.top);
    chat.viewH = frameH - 20;
    frameEl.style.width = frameW + 'px';
    frameEl.style.height = frameH + 'px';
    frameObj.position.set(0, bandCenterY(h), 0);
    slideEl.style.width = (ALL.length * frameW) + 'px';
    /* 各页滑轨位：page left = 页序 × 格宽（absolute 不设 left 会全部叠在 0 位） */
    ALL.forEach(function (p, i) {
      /* page 宽必须用像素：百分比相对滑台（5×格宽），会把内容放大滑出格 */
      pageEls[p].style.left = (i * frameW) + 'px';
      pageEls[p].style.width = frameW + 'px';
    });
    chat.contentH = streamEl.scrollHeight;
    chat.cur = chat.target = 0;   /* 贴底：流 bottom:0 天然对齐格底，translateY 恒 0 */
    applyChatScroll();
    /* 诺瓦跨格：主格左缘外、头顶探出格顶（mascot.setFrame 同源公式对齐） */
    if (window.ZX_GL_MASCOT && ZX_GL_MASCOT.setFrame) {
      ZX_GL_MASCOT.setFrame(frameW, w, h, band.top);
    }
  }

  function bandCenterY(h) {
    return h / 2 - (band.top + band.bottom) / 2;
  }

  function mount(engineApi) {
    api = engineApi;

    frameEl = document.createElement('div');
    frameEl.className = 'gl-frame gl-ui';
    slideEl = document.createElement('div');
    slideEl.className = 'gl-slide';
    frameEl.appendChild(slideEl);

    /* chat 页（滑轨 0 位）：格内 scroller 裁切，流贴底 */
    var chatPage = document.createElement('div');
    chatPage.className = 'gl-page';
    pageEls.chat = chatPage;
    var scroller = document.createElement('div');
    scroller.className = 'gl-chat-scroller';
    streamEl = document.createElement('div');
    streamEl.className = 'gl-stream gl-ui';
    scroller.appendChild(streamEl);
    chatPage.appendChild(scroller);
    slideEl.appendChild(chatPage);

    /* 工作台四页 */
    PAGES.forEach(function (page) {
      var el = document.createElement('div');
      el.className = 'gl-page';
      el.innerHTML = '<div class="gl-page-inner gl-ui"></div>';
      slideEl.appendChild(el);
      pageEls[page] = el;
    });

    frameObj = new ZC.CSS3DObject(frameEl);
    api.addCSS(frameObj);

    slide = { cur: 0, tx: 0 };
    var s0 = api.size();
    layout(s0.w, s0.h);
    syncChat();
    go(document.documentElement.dataset.tab || 'chat');

    observe();

    /* 滚轮：对话区上翻（贴底语义）；面板内原生滚动 */
    window.addEventListener('wheel', function (e) {
      if (currentPage !== 'chat') return;
      var t = e.target;
      if (t && t.closest && t.closest('.gl-stream')) {
        e.preventDefault();
        var max = Math.max(0, chat.contentH - chat.viewH);
        chat.target = Math.min(Math.max(0, chat.target + e.deltaY), max);
        chat.userScrolled = chat.target > 0;
      }
    }, { passive: false });

    var touchY = null;
    window.addEventListener('touchstart', function (e) {
      if (currentPage !== 'chat') return;
      var t = e.target;
      if (t && t.closest && t.closest('.gl-stream')) touchY = e.touches[0].clientY;
    }, { passive: true });
    window.addEventListener('touchmove', function (e) {
      if (touchY === null || currentPage !== 'chat') return;
      var dy = touchY - e.touches[0].clientY;
      touchY = e.touches[0].clientY;
      var max = Math.max(0, chat.contentH - chat.viewH);
      chat.target = Math.min(Math.max(0, chat.target + dy), max);
      chat.userScrolled = chat.target > 0;
    }, { passive: true });
    window.addEventListener('touchend', function () { touchY = null; }, { passive: true });

    api.onResize.push(function (w, h) { layout(w, h); syncChat(); });

    api.onFrame.push(function (dt) {
      if (!api.motion()) {
        slide.cur = slide.tx;
        chat.cur = chat.target;
      }
      /* 滑台平移：每帧 lerp 后写 slide 的 transform（不用 CSS transition——
         CSS3D 嵌套层上不可靠；与对话滚动同由引擎驱动）。格框本身恒在原位。 */
      slide.cur += (slide.tx - slide.cur) * Math.min(1, dt * 6);
      if (Math.abs(slide.tx - slide.cur) < 0.5) slide.cur = slide.tx;
      slideEl.style.transform = 'translateX(' + Math.round(slide.cur) + 'px)';   /* slide.cur 已含符号（tx=-页序×格宽） */
      /* 对话滚动平滑（贴底语义：cur=0 贴底，向上翻 cur 增） */
      chat.cur += (chat.target - chat.cur) * Math.min(1, dt * 12);
      if (Math.abs(chat.target - chat.cur) < 0.4) chat.cur = chat.target;
      applyChatScroll();
    });
  }

  return {
    mount: mount,
    go: go,
    pulse: function () { api.pulse(0.6); }
  };
})();
