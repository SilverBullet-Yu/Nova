/* =========================================================
   诺瓦 Nova · GL 主导航：5 张 3D 页签卡
   ---------------------------------------------------------
   页签从 DOM 迁入 3D 场景：圆角卡（CanvasTexture 绘制图标 + 文字，
   Path2D 复用 main.js TABS 的 SVG path），激活卡 = 薄荷黏土块
   （顶亮内缘 + 底暗内缘模拟 inset 阴影，与 DOM 版页签同一配方）；
   气泡尾巴随清晰线退役（2026-11-22 clay 轮）。
   交互：raycaster 点击切页、hover 浮起；键盘/读屏走 #rail 镜像
   （app.css .gl-on 下 sr-only，focus 事件联动 3D 卡高亮）。
   挂载 window.ZX_GL_NAV，经 engine.mount 接入。经典 script。
   ========================================================= */
window.ZX_GL_NAV = (function () {
  'use strict';

  var api = null;
  var cards = [];                  /* card.userData 列表 */
  var group = null;
  var hovered = -1;
  var active = -1;
  var CARD_W = 92, CARD_H = 42, GAP = 10;
  var scaleK = 1;                  /* 窄视口整组收缩系数 */
  var entering = [];               /* 入场动画队列 */

  /* 卡面纹理：state = 'idle' | 'on'（每卡预生成两张，hover/激活只换材质与位移） */
  function drawCard(tab, state) {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var cv = document.createElement('canvas');
    cv.width = CARD_W * dpr; cv.height = CARD_H * dpr;
    var ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    /* 未激活：完全透明无框（一行轻文字+图标），只有激活卡是「卡」——顶栏层级立刻清爽 */
    var r = 14, w = CARD_W - 4, h = CARD_H - 4, x = 2, y = 2;
    if (state === 'on') {
      /* 薄荷黏土块：主体平涂 + 顶亮/底暗内缘（inset 亮暗模拟，无外描边） */
      ctx.fillStyle = '#8FE3CF';
      ctx.beginPath();
      ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.4)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x + r, y + 1.5); ctx.lineTo(x + w - r, y + 1.5);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(10,50,39,.44)';
      ctx.beginPath();
      ctx.moveTo(x + r, y + h - 1.5); ctx.lineTo(x + w - r, y + h - 1.5);
      ctx.stroke();
    }
    /* 图标：Path2D 复用 TABS 的 SVG path（16 视箱等比 15px） */
    ctx.save();
    ctx.translate(x + 14, y + (CARD_H - 4) / 2 - 7.5);
    ctx.scale(15 / 16, 15 / 16);
    ctx.strokeStyle = state === 'on' ? '#0A1A10' : '#8FB7AA';
    ctx.lineWidth = 1.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    var icon = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg">' + tab.icon + '</svg>', 'image/svg+xml');
    Array.prototype.forEach.call(icon.documentElement.children, function (shape) {
      if (shape.tagName === 'path') ctx.stroke(new Path2D(shape.getAttribute('d')));
      else if (shape.tagName === 'circle') {
        ctx.beginPath();
        ctx.arc(+shape.getAttribute('cx'), +shape.getAttribute('cy'), +shape.getAttribute('r'), 0, Math.PI * 2);
        ctx.stroke();
      } else if (shape.tagName === 'rect') {
        ctx.beginPath();
        ctx.roundRect(+shape.getAttribute('x'), +shape.getAttribute('y'), +shape.getAttribute('width'), +shape.getAttribute('height'), +shape.getAttribute('rx'));
        ctx.stroke();
      }
    });
    ctx.restore();
    ctx.font = '600 13px "PingFang SC","HarmonyOS Sans SC","MiSans","Microsoft YaHei",sans-serif';
    ctx.fillStyle = state === 'on' ? '#0A1A10' : '#B9D9CD';
    ctx.textBaseline = 'middle';
    ctx.fillText(tab.label, x + 36, y + (CARD_H - 4) / 2 + 1);
    var tex = new THREE.CanvasTexture(cv);
    tex.minFilter = THREE.LinearFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  function build(tabs) {
    group = new THREE.Group();
    /* PlaneGeometry：UV 天生 0-1 正确采样 CanvasTexture；圆角与内缘都画在纹理里 */
    var geo = new THREE.PlaneGeometry(CARD_W, CARD_H);
    tabs.forEach(function (tab, i) {
      var matIdle = new THREE.MeshBasicMaterial({ map: drawCard(tab, 'idle'), transparent: true });
      var matOn = new THREE.MeshBasicMaterial({ map: drawCard(tab, 'on'), transparent: true });
      var mesh = new THREE.Mesh(geo, matIdle);
      var card = new THREE.Group();
      card.add(mesh);
      mesh.userData = {
        arg: tab.id,
        onClick: function (id) { if (window.ZX && ZX.setTab) ZX.setTab(id); },
        onHover: function (on) { hovered = on ? i : (hovered === i ? -1 : hovered); }
      };
      api.register(mesh);
      group.add(card);
      cards.push({ tab: tab, group: card, mesh: mesh, matIdle: matIdle, matOn: matOn, i: i, hoverK: 0, baseY: 0 });
      /* 入场：依次从景深弹入落格 */
      entering.push({ g: card, t0: 0.08 + i * 0.07, done: false });
    });
    api.addGL(group);
    layout(api.size().w, api.size().h);
  }

  function layout(w, h) {
    var n = cards.length;
    var totalW = n * CARD_W + (n - 1) * GAP;
    /* 移动单行顶栏（brand 行 50px）：页签卡在 brand 行下方一档；桌面在顶栏 60px 中线。
       5 张卡超出窄视口时整组等比收缩（纹理共用，尺寸靠世界缩放）。
       移动端卡组整体居中——贴左起排会在右侧留出大段空白 */
    var mobile = w <= 860;
    scaleK = mobile ? Math.max(0.55, Math.min(1, (w - 16) / totalW)) : 1;
    var left = mobile
      ? -(totalW * scaleK) / 2 + (CARD_W * scaleK) / 2                       /* 组居中：卡0中心 = 组左缘 + 半卡宽 */
      : Math.min(300, w / 2 - totalW / 2 + 40) - w / 2;
    var topY = h / 2 - (mobile ? 78 : 30);
    cards.forEach(function (c, i) {
      c.group.position.x = left + i * (CARD_W + GAP) * scaleK;
      c.baseY = topY;
    });
  }

  function setActive(id) {
    active = cards.length ? cards.findIndex(function (c) { return c.tab.id === id; }) : -1;
    cards.forEach(function (c, i) {
      var on = i === active;
      c.mesh.material = on ? c.matOn : c.matIdle;
    });
  }

  function mount(engineApi) {
    api = engineApi;
    var tabs = window.ZX && ZX.glTabs ? ZX.glTabs : [];
    if (!tabs.length) return;
    build(tabs);

    api.onFrame.push(function (dt) {
      var motion = api.motion();
      var t = api.time();
      /* 入场级联：0.35s ease-out 落格 */
      for (var i = entering.length - 1; i >= 0; i--) {
        var a = entering[i];
        var k = motion ? Math.min(1, Math.max(0, (t - a.t0) / 0.35)) : 1;
        var e = 1 - Math.pow(1 - k, 3);
        a.g.position.z = 10 - (1 - e) * 240;
        a.g.scale.setScalar(0.6 + e * 0.4);
        if (k >= 1) { a.g.position.z = 10; a.g.scale.setScalar(1); entering.splice(i, 1); }
      }
      cards.forEach(function (c) {
        c.hoverK += ((c.i === hovered ? 1 : 0) - c.hoverK) * (motion ? Math.min(1, dt * 12) : 1);
        c.group.position.y = c.baseY + c.hoverK * 5 + (motion ? Math.sin(t * 1.6 + c.i * 0.9) * 1.2 : 0);
        var press = (c.i === hovered ? 1.05 : 1) * scaleK;
        c.group.scale.x += (press - c.group.scale.x) * (motion ? Math.min(1, dt * 10) : 1);
        c.group.scale.y = c.group.scale.x;
      });
    });

    api.onResize.push(function (w, h) { layout(w, h); });

    /* 镜像页签 focus → 3D 卡高亮（键盘可达联动） */
    var rail = document.getElementById('rail');
    if (rail) {
      rail.addEventListener('focusin', function (e) {
        var b = e.target.closest('[data-tab]');
        hovered = b ? cards.findIndex(function (c) { return c.tab.id === b.dataset.tab; }) : -1;
      });
      rail.addEventListener('focusout', function () { hovered = -1; });
    }

    setActive(window.ZX && ZX.state ? ZX.state.tab : 'chat');
  }

  return {
    mount: mount,
    setActive: setActive
  };
})();
